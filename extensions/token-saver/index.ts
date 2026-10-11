/**
 * Token saver: headroom (input) + caveman (output).
 *
 *   /caveman [off|lite|full|ultra]   terse output style (system prompt section)
 *   /headroom [on|off|stats|sweep]   tool-output compression + cache-aware context aging
 *
 * Config: ~/.pi/agent/token-saver.json (written by the commands; edit for fine-tuning).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CAVEMAN_LEVELS, type CavemanLevel, cavemanPrompt } from "./caveman.ts";
import { crushToolOutput, DEFAULT_HEADROOM, type HeadroomConfig, stash, sweepCache } from "./headroom.ts";

interface TokenSaverConfig {
	caveman: CavemanLevel;
	headroom: HeadroomConfig;
}

const CONFIG_PATH = () => path.join(getAgentDir(), "token-saver.json");
const PRUNED_PREFIX = "[headroom: stale";

function loadConfig(): TokenSaverConfig {
	const base: TokenSaverConfig = { caveman: "full", headroom: structuredClone(DEFAULT_HEADROOM) };
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf8")) as Partial<TokenSaverConfig>;
		return {
			caveman: CAVEMAN_LEVELS.includes(raw.caveman as CavemanLevel) ? (raw.caveman as CavemanLevel) : base.caveman,
			headroom: {
				...base.headroom,
				...raw.headroom,
				json: { ...base.headroom.json, ...raw.headroom?.json },
				prune: { ...base.headroom.prune, ...raw.headroom?.prune },
			},
		};
	} catch {
		return base;
	}
}

function saveConfig(cfg: TokenSaverConfig) {
	fs.writeFileSync(CONFIG_PATH(), `${JSON.stringify(cfg, null, "\t")}\n`, "utf8");
}

const fmtTok = (chars: number) => {
	const t = Math.round(chars / 4);
	return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
};

type TextPart = { type: "text"; text: string };
type ContentPart = TextPart | { type: "image"; [k: string]: unknown };

/** Rough verbose-equivalent expansion per caveman level (output chars without caveman ÷ with). */
const CAVEMAN_FACTOR: Record<Exclude<CavemanLevel, "off">, number> = { lite: 1.3, full: 1.8, ultra: 2.5 };

/** Status-line color per caveman level: dim off, blue lite, yellow full, red ultra. */
const CAVEMAN_COLOR: Record<CavemanLevel, "dim" | "accent" | "warning" | "error"> = {
	off: "dim",
	lite: "accent",
	full: "warning",
	ultra: "error",
};

export default function tokenSaver(pi: ExtensionAPI) {
	let cfg = loadConfig();
	const stats = {
		compressedChars: 0,
		prunedChars: 0,
		compressions: 0,
		prunes: 0,
		// caveman: actual output tokens + estimated chars saved vs a verbose-equivalent baseline
		outputTokens: 0,
		cavemanTurns: 0,
		cavemanSavedChars: 0,
	};
	const textParts = (content: unknown): string =>
		Array.isArray(content)
			? (content as { type?: string; text?: string }[]).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n")
			: "";

	// Optional: send a provider's traffic through a real Headroom proxy (python `headroom proxy`).
	if (cfg.headroom.enabled && cfg.headroom.proxy?.provider && cfg.headroom.proxy.baseUrl) {
		pi.registerProvider(cfg.headroom.proxy.provider, { baseUrl: cfg.headroom.proxy.baseUrl });
	}

	function updateStatus(ctx: ExtensionContext) {
		const theme = ctx.ui.theme;
		const parts: string[] = [];
		parts.push(
			theme.fg(
				CAVEMAN_COLOR[cfg.caveman],
				`[CAVEMAN : ${cfg.caveman.toUpperCase()}]${stats.cavemanSavedChars > 0 ? ` ↓ -${fmtTok(stats.cavemanSavedChars)}` : ""}`,
			),
		);
		let headroomText: string;
		if (cfg.headroom.enabled) {
			const saved = stats.compressedChars + stats.prunedChars;
			headroomText = saved > 0 ? `[HEADROOM : ON] ↑ -${fmtTok(saved)}` : "[HEADROOM : ON]";
		} else {
			headroomText = "[HEADROOM : OFF]";
		}
		parts.push(theme.fg(cfg.headroom.enabled ? "success" : "dim", headroomText));
		ctx.ui.setStatus("token-saver", parts.join(" "));
	}

	pi.on("session_start", async (_e, ctx) => {
		cfg = loadConfig();
		try {
			sweepCache(7);
		} catch {
			/* ignore */
		}
		updateStatus(ctx);
	});

	// ---------------------------------------------------------------- caveman
	pi.on("before_agent_start", async (event) => {
		const prompt = cavemanPrompt(cfg.caveman);
		if (prompt) event.systemPromptOptions.sections.caveman = prompt;
		else delete event.systemPromptOptions.sections.caveman;
	});

	pi.registerCommand("caveman", {
		description: "Terse output style: off | lite | full | ultra",
		getArgumentCompletions: (prefix) =>
			CAVEMAN_LEVELS.filter((l) => l.startsWith(prefix.trim())).map((l) => ({ value: l, label: l })),
		handler: async (args, ctx) => {
			let level = args.trim() as CavemanLevel;
			if (!CAVEMAN_LEVELS.includes(level)) {
				const choice = await ctx.ui.select(`Caveman level (now: ${cfg.caveman})`, CAVEMAN_LEVELS);
				if (!choice) return;
				level = choice as CavemanLevel;
			}
			cfg.caveman = level;
			saveConfig(cfg);
			updateStatus(ctx);
			ctx.ui.notify(`Caveman: ${level} (applies from the next prompt)`, "info");
		},
	});

	// --------------------------------------------------------------- headroom
	pi.on("tool_result", async (event) => {
		const h = cfg.headroom;
		if (!h.enabled || event.parentToolCallId || h.exemptTools.includes(event.toolName)) return;
		const content = event.content as ContentPart[];
		let changed = false;
		let saved = 0;
		const next: ContentPart[] = [];
		for (const part of content) {
			if (part.type !== "text" || part.text.length < 200) {
				next.push(part);
				continue;
			}
			const r = crushToolOutput(part.text, event.toolName, h);
			const newText = r.note ? `${r.text}\n${r.note}` : r.text;
			if (newText.length < part.text.length * 0.95) {
				saved += part.text.length - newText.length;
				next.push({ type: "text", text: newText });
				changed = true;
			} else next.push(part);
		}
		if (!changed) return;
		stats.compressedChars += saved;
		stats.compressions++;
		return event.structuredContent !== undefined
			? { content: next as typeof event.content, structuredContent: event.structuredContent }
			: { content: next as typeof event.content };
	});

	// Caveman output accounting: actual output tokens from usage, plus an estimated verbose-
	// equivalent baseline (text chars × level factor) so savings = baseline − actual.
	pi.on("turn_end", async (event, ctx) => {
		const msg = event.message as { role?: string; content?: unknown; usage?: { output?: number } } | undefined;
		if (msg?.role !== "assistant" || typeof msg.usage?.output !== "number") return;
		stats.outputTokens += msg.usage.output;
		if (cfg.caveman === "off") return;
		const text = textParts(msg.content);
		if (!text) return;
		stats.cavemanTurns++;
		stats.cavemanSavedChars += Math.max(0, Math.round(text.length * CAVEMAN_FACTOR[cfg.caveman]) - text.length);
		updateStatus(ctx);
	});

	// Cache-aware context aging: only when usage crosses the threshold, prune all old large tool
	// results in one batch of append-only context edits (originals stashed for retrieval).
	pi.on("turn_end", async (event, ctx) => {
		const p = cfg.headroom.prune;
		if (!cfg.headroom.enabled || !p.enabled) return;
		const usage = ctx.getContextUsage();
		if (!usage?.percent || usage.percent < p.atPercent) return;

		const entries = event.context.contextEntries;
		let assistants = 0;
		const turnOf: number[] = [];
		for (const e of entries) {
			if (e.messages.some((m) => m.role === "assistant")) assistants++;
			turnOf.push(assistants);
		}
		const cutoff = assistants - p.keepTurns;
		if (cutoff <= 0) return;

		const drafts: { type: "context_edit"; targetId: string; replacement: { content: TextPart[] } }[] = [];
		let saved = 0;
		entries.forEach((e, idx) => {
			if (turnOf[idx] > cutoff || e.sourceEntry.type !== "message") return;
			const msg = e.messages[0] as { role?: string; toolName?: string; content?: ContentPart[] } | undefined;
			if (msg?.role !== "toolResult" || !Array.isArray(msg.content)) return;
			if (msg.toolName === "ask_user" || msg.toolName === "workflow_report") return;
			const text = msg.content.filter((c): c is TextPart => c.type === "text").map((c) => c.text).join("\n");
			if (text.length < p.minChars || text.startsWith(PRUNED_PREFIX)) return;
			const file = stash(text, `${msg.toolName ?? "tool"}-old`);
			const stub = `${PRUNED_PREFIX} ${msg.toolName} output pruned (${text.split("\n").length} lines, ~${fmtTok(text.length)} tok). Original: ${file}. Re-run or read it if still needed.]`;
			drafts.push({ type: "context_edit", targetId: e.sourceEntry.id, replacement: { content: [{ type: "text", text: stub }] } });
			saved += text.length - stub.length;
		});
		if (!drafts.length) return;
		stats.prunedChars += saved;
		stats.prunes += drafts.length;
		updateStatus(ctx);
		return { entries: [...event.entries, ...drafts] };
	});

	pi.on("agent_end", async (_e, ctx) => updateStatus(ctx));

	pi.registerCommand("headroom", {
		description: "Tool-output compression & context aging: on | off | stats | sweep",
		getArgumentCompletions: (prefix) =>
			["on", "off", "stats", "sweep"].filter((l) => l.startsWith(prefix.trim())).map((l) => ({ value: l, label: l })),
		handler: async (args, ctx) => {
			const sub = args.trim() || "stats";
			if (sub === "on" || sub === "off") {
				cfg.headroom.enabled = sub === "on";
				saveConfig(cfg);
				ctx.ui.notify(`Headroom ${sub}${cfg.headroom.proxy ? " (proxy change needs /reload)" : ""}`, "info");
			} else if (sub === "sweep") {
				sweepCache(0);
				ctx.ui.notify("Headroom cache cleared.", "info");
			} else {
				const usage = ctx.getContextUsage();
				ctx.ui.notify(
					[
						`Headroom ${cfg.headroom.enabled ? "on" : "off"} · caveman ${cfg.caveman}`,
						`compressed ${stats.compressions} tool outputs, saved ~${fmtTok(stats.compressedChars)} tok`,
						`pruned ${stats.prunes} stale outputs, saved ~${fmtTok(stats.prunedChars)} tok`,
						`caveman: ${stats.cavemanTurns} terse turns, ${stats.outputTokens.toLocaleString()} output tokens` +
							(stats.cavemanSavedChars > 0 ? ` · saved ~${fmtTok(stats.cavemanSavedChars)} tok (est., verbose-equivalent ×${CAVEMAN_FACTOR[cfg.caveman]})` : ""),
						`context: ${usage?.percent != null ? `${usage.percent.toFixed(0)}%` : "?"} (prune at ${cfg.headroom.prune.atPercent}%, keep last ${cfg.headroom.prune.keepTurns} turns)`,
						`config: ${CONFIG_PATH()}`,
					].join("\n"),
					"info",
				);
			}
			updateStatus(ctx);
		},
	});
}
