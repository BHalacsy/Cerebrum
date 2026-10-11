/**
 * Headroom-style input compression (native re-implementation of the ideas behind
 * github.com/chopratejas/headroom — not the Python proxy itself):
 *
 *  - Tool output crushing: strip ANSI/progress noise, collapse repeated lines and blank runs,
 *    minify + sample large JSON, and head/tail-truncate huge output while keeping error lines.
 *  - CCR (compress-cache-retrieve): whenever content is dropped, the original is stashed in a
 *    cache file and the model is told where to read it, so compression is reversible.
 *  - Cache-aware context aging: old, large tool results are replaced by stubs only when context
 *    usage crosses a threshold, as one batch of append-only context edits — the prompt-cache prefix
 *    changes rarely instead of every turn.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface HeadroomConfig {
	enabled: boolean;
	/** Tool outputs larger than this (chars) are truncated head+tail with CCR. ~4 chars ≈ 1 token. */
	maxToolChars: number;
	/** Tools whose output is never touched (read must stay byte-exact for edits). */
	exemptTools: string[];
	dedupeLines: boolean;
	json: { enabled: boolean; maxArrayItems: number; maxStringChars: number };
	prune: { enabled: boolean; atPercent: number; keepTurns: number; minChars: number };
	/** Optional: route a provider through a real Headroom proxy, e.g. { provider: "openrouter", baseUrl: "http://127.0.0.1:8787/v1" }. */
	proxy?: { provider: string; baseUrl: string } | null;
}

export const DEFAULT_HEADROOM: HeadroomConfig = {
	enabled: true,
	maxToolChars: 12_000,
	exemptTools: ["read", "ask_user", "workflow_report", "edit", "write"],
	dedupeLines: true,
	json: { enabled: true, maxArrayItems: 12, maxStringChars: 600 },
	prune: { enabled: true, atPercent: 55, keepTurns: 6, minChars: 1_500 },
	proxy: null,
};

export const CACHE_DIR = () => path.join(getAgentDir(), "headroom-cache");

export function stash(content: string, label: string): string {
	const dir = CACHE_DIR();
	fs.mkdirSync(dir, { recursive: true });
	const hash = crypto.createHash("sha1").update(content).digest("hex").slice(0, 12);
	const file = path.join(dir, `${label.replace(/[^\w.-]+/g, "_")}-${hash}.txt`);
	if (!fs.existsSync(file)) fs.writeFileSync(file, content, "utf8");
	return file;
}

/** Remove cache files older than `days`. */
export function sweepCache(days = 7) {
	const dir = CACHE_DIR();
	if (!fs.existsSync(dir)) return;
	const cutoff = Date.now() - days * 86_400_000;
	for (const f of fs.readdirSync(dir)) {
		const p = path.join(dir, f);
		try {
			if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
		} catch {
			/* ignore */
		}
	}
}

// ---------------------------------------------------------------------------
// text crushing
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const IMPORTANT = /error|warn|fail|exception|traceback|panic|fatal|denied|not found|cannot|undefined|assert|✗|✘|×|FAIL|ERR!/i;

export function cleanNoise(text: string): string {
	let out = text.replace(ANSI, "");
	// progress bars / spinners: keep only the final state of \r-rewritten lines
	out = out
		.split("\n")
		.map((l) => (l.includes("\r") ? l.slice(l.lastIndexOf("\r", l.length - 2) + 1).replace(/\r$/, "") : l).replace(/[ \t]+$/, ""))
		.join("\n");
	return out.replace(/\n{3,}/g, "\n\n");
}

export function dedupeLines(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; ) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const run = j - i;
		if (run >= 3 && lines[i].trim()) out.push(lines[i], `[… previous line repeated ${run - 1} more times]`);
		else for (let k = i; k < j; k++) out.push(lines[k]);
		i = j;
	}
	return out.join("\n");
}

function crushValue(v: unknown, cfg: HeadroomConfig["json"], depth = 0): unknown {
	if (typeof v === "string") return v.length > cfg.maxStringChars ? `${v.slice(0, cfg.maxStringChars)}…[+${v.length - cfg.maxStringChars} chars]` : v;
	if (Array.isArray(v)) {
		if (v.length <= cfg.maxArrayItems) return v.map((x) => crushValue(x, cfg, depth + 1));
		const head = Math.max(1, cfg.maxArrayItems - 2);
		const sample = v.slice(0, head).map((x) => crushValue(x, cfg, depth + 1));
		const keys = v[0] && typeof v[0] === "object" && !Array.isArray(v[0]) ? ` keys: ${Object.keys(v[0] as object).slice(0, 15).join(",")}` : "";
		// keep anomalies: items that look like errors
		const anomalies = v.slice(head, -1).filter((x) => IMPORTANT.test(JSON.stringify(x) ?? "")).slice(0, 3);
		return [...sample, ...anomalies.map((x) => crushValue(x, cfg, depth + 1)), `[… ${v.length - head - 1 - anomalies.length} more items${keys}]`, crushValue(v[v.length - 1], cfg, depth + 1)];
	}
	if (v && typeof v === "object") {
		return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, crushValue(x, cfg, depth + 1)]));
	}
	return v;
}

/** Minify and sample JSON output; returns undefined if the text is not JSON. */
export function crushJson(text: string, cfg: HeadroomConfig["json"]): { text: string; lossy: boolean } | undefined {
	const t = text.trim();
	if (!(t.startsWith("{") || t.startsWith("[")) || t.length < 400) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(t);
	} catch {
		return undefined;
	}
	const minified = JSON.stringify(parsed);
	const crushed = JSON.stringify(crushValue(parsed, cfg));
	return { text: crushed, lossy: crushed !== minified };
}

/** Keep head and tail, plus important lines from the middle, within `max` chars. */
export function smartTruncate(text: string, max: number): { text: string; omitted: number } {
	if (text.length <= max) return { text, omitted: 0 };
	const lines = text.split("\n");
	const headBudget = Math.floor(max * 0.45);
	const tailBudget = Math.floor(max * 0.35);
	const midBudget = max - headBudget - tailBudget;

	const head: string[] = [];
	let used = 0;
	let i = 0;
	for (; i < lines.length && used + lines[i].length + 1 <= headBudget; i++) {
		head.push(lines[i]);
		used += lines[i].length + 1;
	}
	const tail: string[] = [];
	used = 0;
	let j = lines.length - 1;
	for (; j > i && used + lines[j].length + 1 <= tailBudget; j--) {
		tail.unshift(lines[j]);
		used += lines[j].length + 1;
	}
	const mid: string[] = [];
	used = 0;
	for (let k = i; k <= j; k++) {
		if (IMPORTANT.test(lines[k]) && used + lines[k].length + 1 <= midBudget) {
			mid.push(`${k + 1}: ${lines[k].slice(0, 400)}`);
			used += lines[k].length + 1;
		}
	}
	const omitted = j - i + 1 - mid.length;
	// a single giant line (minified file etc.) still needs a hard cap
	const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
	const parts = [cap(head.join("\n"), headBudget)];
	if (mid.length) parts.push(`[… headroom: ${omitted} lines omitted; important lines kept:]`, ...mid);
	else parts.push(`[… headroom: ${omitted} lines omitted]`);
	parts.push(cap(tail.join("\n"), tailBudget));
	return { text: parts.join("\n"), omitted };
}

export interface CrushResult {
	text: string;
	lossy: boolean;
	note?: string;
}

export function crushToolOutput(text: string, toolName: string, cfg: HeadroomConfig): CrushResult {
	let out = cleanNoise(text);
	if (cfg.dedupeLines) out = dedupeLines(out);
	let lossy = false;
	if (cfg.json.enabled) {
		const j = crushJson(out, cfg.json);
		if (j) {
			out = j.text;
			lossy = j.lossy;
		}
	}
	if (out.length > cfg.maxToolChars) {
		out = smartTruncate(out, cfg.maxToolChars).text;
		lossy = true;
	}
	if (!lossy) return { text: out, lossy };
	const file = stash(text, toolName);
	return { text: out, lossy, note: `[headroom: output compressed; full original at ${file} — read it with offset/limit if you need the omitted parts]` };
}
