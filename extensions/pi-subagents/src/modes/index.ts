/**
 * Agent Modes — Direct Subagent & Workflow Dispatcher.
 *
 * When a mode is active, user prompts are intercepted before reaching the LLM
 * and dispatched directly to the isolated subagent engine (via runSlashSubagent).
 *
 *   /mode [name]            switch mode (or interactive selector without args)
 *   ctrl+alt+m / Tab        cycle active modes
 *   /e2e <problem>          direct shortcut to run e2e workflow
 *   /plan-build <problem>   direct shortcut to run plan-build workflow
 *   /audit <problem>        direct shortcut to run audit workflow
 *   pi --agent-mode e2e     start pi in a specific mode
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runSlashSubagent } from "../slash/slash-commands.ts";
import type { SubagentParamsLike } from "../shared/types.ts";

export interface ModeDef {
	label: string;
	description: string;
	color: string;
	type: "workflow" | "agent";
}

export const MODE_DEFS: Record<string, ModeDef> = {
	e2e: {
		label: "E2E TDD",
		description: "End-to-end TDD: explore → plan → test → build ⇄ review → ship",
		color: "success",
		type: "workflow",
	},
	"plan-build": {
		label: "Plan & Build",
		description: "Explore → plan → test → build ⇄ review (uncommitted working tree)",
		color: "warning",
		type: "workflow",
	},
	audit: {
		label: "Audit",
		description: "Explore → parallel security & performance audit",
		color: "mdLink",
		type: "workflow",
	},
	explore: {
		label: "Explore",
		description: "Codebase reconnaissance; outputs context.md",
		color: "accent",
		type: "agent",
	},
	plan: {
		label: "Plan",
		description: "Architecture & TDD pre-implementation plan; outputs plan.md",
		color: "customMessageLabel",
		type: "agent",
	},
	build: {
		label: "Build",
		description: "Single-writer implementation satisfying plan and tests",
		color: "warning",
		type: "agent",
	},
	tester: {
		label: "Tester",
		description: "Specification tests (RED) and test suite validation (GREEN)",
		color: "success",
		type: "agent",
	},
	review: {
		label: "Review",
		description: "Code review verifying git diff against plan and edge cases",
		color: "error",
		type: "agent",
	},
	security: {
		label: "Security",
		description: "Security audit scanning diff and dependencies for vulnerabilities",
		color: "mdLink",
		type: "agent",
	},
	ship: {
		label: "Ship",
		description: "Delivery specialist: stages files and creates conventional commits",
		color: "success",
		type: "agent",
	},
};

const DEFAULT_CYCLE = [
	"off",
	"e2e",
	"plan-build",
	"audit",
	"explore",
	"plan",
	"build",
	"tester",
	"review",
	"security",
	"ship",
];

const TAB_PATCH_KEY = Symbol.for("pi.customEditor.tabAutocompletePatched");
const TAB_HANDLER_KEY = Symbol.for("pi.customEditor.emptyTabHandler");

function patchCustomEditorForTabCompletion(): void {
	if (typeof CustomEditor === "undefined" || !CustomEditor.prototype) return;
	if ((CustomEditor.prototype as any)[TAB_PATCH_KEY]) return;
	(CustomEditor.prototype as any)[TAB_PATCH_KEY] = true;

	const originalHandleInput = CustomEditor.prototype.handleInput;
	CustomEditor.prototype.handleInput = function (data: string): void {
		if (matchesKey(data, Key.tab)) {
			const isShowingAutocomplete = typeof this.isShowingAutocomplete === "function" && this.isShowingAutocomplete();
			const isEmpty = this.getText().trim().length === 0;
			const handler = (globalThis as any)[TAB_HANDLER_KEY];

			if (isEmpty && !isShowingAutocomplete && typeof handler === "function") {
				Promise.resolve(handler()).catch(() => {});
				return;
			}
		}
		originalHandleInput.call(this, data);
	};
}

const CONFIG_FILE = () => path.join(getAgentDir(), "agent-modes.json");

function loadSavedDefaultMode(): string {
	try {
		const filePath = CONFIG_FILE();
		if (fs.existsSync(filePath)) {
			const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			if (typeof raw?.defaultMode === "string" && (raw.defaultMode === "off" || MODE_DEFS[raw.defaultMode])) {
				return raw.defaultMode;
			}
		}
	} catch {
		// Ignore read error
	}
	return "off";
}

function saveDefaultMode(mode: string): void {
	try {
		const filePath = CONFIG_FILE();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		let data: Record<string, unknown> = {};
		if (fs.existsSync(filePath)) {
			try {
				data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			} catch {}
		}
		data.defaultMode = mode;
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
	} catch {
		// Ignore write error
	}
}

function resolveWorkflowScriptPath(mode: string): string {
	const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../workflows", `${mode}.js`);
	return fs.existsSync(candidate) ? candidate : mode;
}

export default function registerModesExtension(pi: ExtensionAPI): void {
	patchCustomEditorForTabCompletion();

	let currentMode = "off";
	let currentCtx: ExtensionContext | undefined;
	const cycleList = [...DEFAULT_CYCLE];

	pi.registerFlag("agent-mode", {
		description: "Start in an agent mode or workflow (e.g. e2e, explore, plan)",
		type: "string",
	});

	function allModes(): string[] {
		return ["off", ...Object.keys(MODE_DEFS)];
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const t = ctx.ui.theme;
		if (currentMode === "off") {
			ctx.ui.setStatus("agent-mode", undefined);
		} else {
			const def = MODE_DEFS[currentMode];
			const color = def?.color ?? "accent";
			ctx.ui.setStatus("agent-mode", t.fg(color, `- ${currentMode}`));
		}
	}

	async function setMode(name: string, ctx: ExtensionContext, quiet = false): Promise<boolean> {
		const normalized = name.toLowerCase().trim();
		if (normalized !== "off" && !MODE_DEFS[normalized]) {
			ctx.ui.notify(`Unknown mode "${name}". Available: ${allModes().join(", ")}`, "error");
			return false;
		}
		currentMode = normalized;
		updateStatus(ctx);
		saveDefaultMode(currentMode);

		if (!quiet && ctx.hasUI) {
			const desc = currentMode === "off" ? "default Pi, direct conversation" : MODE_DEFS[currentMode].description;
			ctx.ui.notify(`Mode: ${currentMode} — ${desc}`, "info");
		}
		return true;
	}

	function buildParamsForMode(mode: string, text: string): SubagentParamsLike {
		const def = MODE_DEFS[mode];
		if (def?.type === "workflow") {
			const useWorktree = text.includes("--worktree");
			const cleanProblem = text.replace(/--worktree\b/g, "").trim();
			return {
				workflow: resolveWorkflowScriptPath(mode),
				args: { problem: cleanProblem },
				...(useWorktree ? { worktree: true } : {}),
			};
		}
		const agentName = mode === "test" ? "tester" : mode;
		return {
			agent: agentName,
			task: text,
			output: agentName === "explore" ? "context.md" : agentName === "plan" ? "plan.md" : undefined,
		};
	}

	async function executeSubagentForMode(mode: string, text: string, ctx: ExtensionContext): Promise<void> {
		currentCtx = ctx;
		const params = buildParamsForMode(mode, text);

		try {
			pi.sendMessage({
				customType: "mode-prompt",
				content: `**[${mode.toUpperCase()}]** ${text}`,
				display: true,
			});
		} catch {
			// Best-effort message display
		}

		await runSlashSubagent(pi, ctx, params);
	}

	// -------------------------------------------------------------------------
	// Session lifecycle
	// -------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		const flag = pi.getFlag("agent-mode");
		if (typeof flag === "string" && (flag === "off" || MODE_DEFS[flag.toLowerCase()])) {
			await setMode(flag.toLowerCase(), ctx, true);
		} else {
			const saved = loadSavedDefaultMode();
			await setMode(saved, ctx, true);
		}
	});

	// -------------------------------------------------------------------------
	// Deterministic Input Intercept (Approach A)
	// -------------------------------------------------------------------------

	pi.on("input", async (event, ctx) => {
		currentCtx = ctx;
		if (currentMode === "off") return { action: "continue" };

		const text = event.text.trim();
		if (!text) return { action: "continue" };

		// Let slash commands pass through untouched
		if (text.startsWith("/")) return { action: "continue" };

		try {
			await executeSubagentForMode(currentMode, text, ctx);
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Subagent execution failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}

		// Input was completely handled by the subagent run; do not invoke main LLM
		return { action: "handled" };
	});

	// -------------------------------------------------------------------------
	// Mode Cycling & Navigation
	// -------------------------------------------------------------------------

	(globalThis as any)[TAB_HANDLER_KEY] = () => {
		if (!currentCtx) return;
		const currentIndex = cycleList.indexOf(currentMode);
		const nextIndex = (currentIndex + 1) % cycleList.length;
		void setMode(cycleList[nextIndex], currentCtx);
	};

	pi.registerShortcut(Key.ctrlAlt("m"), {
		description: "Cycle agent modes & workflows",
		handler: async (ctx) => {
			currentCtx = ctx;
			const currentIndex = cycleList.indexOf(currentMode);
			const nextIndex = (currentIndex + 1) % cycleList.length;
			await setMode(cycleList[nextIndex], ctx);
		},
	});

	// -------------------------------------------------------------------------
	// Slash Commands
	// -------------------------------------------------------------------------

	const modeCompletions = (prefix: string) =>
		allModes()
			.filter((m) => m.startsWith(prefix))
			.map((m) => ({
				value: m,
				label: m,
				description: m === "off" ? "default Pi, direct conversation" : MODE_DEFS[m].description,
			}));

	pi.registerCommand("mode", {
		description: "Switch agent mode or workflow (explore, plan, build, e2e, plan-build, audit, off)",
		getArgumentCompletions: (prefix) => modeCompletions(prefix.trim()),
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const name = args.trim();
			if (name) {
				await setMode(name, ctx);
				return;
			}
			const labels = allModes().map((m) => {
				const desc = m === "off" ? "default Pi, direct conversation" : MODE_DEFS[m].description;
				return `${m === currentMode ? "● " : "  "}${m} — ${desc}`;
			});
			const choice = await ctx.ui.select("Select mode", labels);
			if (!choice) return;
			const chosenIndex = labels.indexOf(choice);
			if (chosenIndex >= 0) {
				await setMode(allModes()[chosenIndex], ctx);
			}
		},
	});

	// Direct convenience commands
	pi.registerCommand("e2e", {
		description: "Run the E2E TDD workflow: /e2e <problem>",
		handler: async (args, ctx) => {
			const problem = args.trim();
			if (!problem) {
				ctx.ui.notify("Usage: /e2e <problem description>", "warning");
				return;
			}
			await executeSubagentForMode("e2e", problem, ctx);
		},
	});

	pi.registerCommand("plan-build", {
		description: "Run the Plan & Build workflow: /plan-build <problem>",
		handler: async (args, ctx) => {
			const problem = args.trim();
			if (!problem) {
				ctx.ui.notify("Usage: /plan-build <problem description>", "warning");
				return;
			}
			await executeSubagentForMode("plan-build", problem, ctx);
		},
	});

	pi.registerCommand("audit", {
		description: "Run the Audit workflow: /audit <target>",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) {
				ctx.ui.notify("Usage: /audit <target or problem>", "warning");
				return;
			}
			await executeSubagentForMode("audit", target, ctx);
		},
	});
}
