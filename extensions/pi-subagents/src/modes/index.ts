/**
 * Agent modes, granular permissions and workflows.
 *
 * Modes = agents (explore, plan, build, review, test, security, perf, ship) + workflows (e2e, plan-build, audit) + "off".
 *
 *   /mode [name]            switch mode (selector without args) · ctrl+alt+m cycles `cycle` modes
 *   /workflow …             start <name> <problem> | status | stop | skip
 *   /permissions [check <tool> <arg>]   show effective permissions / test a call
 *   /modes-config           write the effective config to ~/.pi/agent/agent-modes.json for editing
 *   pi --agent-mode plan    start in a mode
 *
 * Each agent defines active tools + allow/ask/deny rules (see permissions.ts). Rules are enforced in
 * `tool_call` (including nested codemode calls) and summarized for the model in the system prompt.
 *
 * Workflows run in the current session: each phase switches the agent (tools, permissions, optional
 * model); the model ends a phase with `workflow_report`, which moves to the next phase, loops back on
 * review/test failures, and asks the user at gates. Dialogs use only select/input so they work over RPC.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CustomEditor, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { type AgentDef, loadConfig, type ModesConfig, USER_CONFIG_PATH, type WorkflowDef } from "./config.ts";
import {
	type Approval,
	approvalMatches,
	type Check,
	evaluate,
	isToolHidden,
	mergePermissionSets,
	type PermissionSet,
	suggestCommandPattern,
	summarize,
} from "./permissions.ts";

const STATE_TYPE = "agent-modes-state";
const SECTION = "agent_mode";
const REPORT_TOOL = "workflow_report";

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

			// If the editor is empty and not showing autocomplete popup, cycle agent modes
			if (isEmpty && !isShowingAutocomplete && typeof handler === "function") {
				Promise.resolve(handler()).catch(() => {});
				return;
			}
		}

		originalHandleInput.call(this, data);
	};
}
/** Tools never gated by mode permissions (asking the user / reporting progress is always safe). */
const ALWAYS_ALLOWED = new Set([REPORT_TOOL, "ask_user"]);
/** Tools allowed in the read-only wrap-up after a workflow finishes mid-run. */
const WRAP_UP_TOOLS = new Set(["read", "grep", "find", "ls", "ask_user"]);
const POSITIVE = new Set(["done", "approved", "pass"]);
const NEGATIVE = new Set(["changes_requested", "fail"]);

/** Status-bar color per mode (theme palette names); unlisted modes get "accent". */
const MODE_COLOR: Record<string, string> = {
	explore: "accent", // cyan
	plan: "customMessageLabel", // violet
	build: "warning", // yellow
	review: "error", // red
	security: "mdLink", // blue
	"safe-build": "warning", // yellow
	test: "success", // green
	perf: "customMessageLabel", // violet
	ship: "success", // green
};
const modeColor = (m: string) => MODE_COLOR[m] ?? "accent";

interface WorkflowState {
	name: string;
	problem: string;
	step: number;
	active: boolean;
	loops: Record<string, number>;
	history: { agent: string; status: string; summary: string }[];
	reported: boolean;
	nudges: number;
	lastFeedback?: string;
	phaseStartTimestamp?: number;
}

interface PersistedState {
	mode: string;
	workflow?: WorkflowState;
	toolsBefore?: string[];
}

export default function agentModes(pi: ExtensionAPI) {
	patchCustomEditorForTabCompletion();
	let config: ModesConfig;
	let currentCtx: ExtensionContext | undefined;
	let mode = "off";
	let wf: WorkflowState | undefined;
	let toolsBefore: string[] | undefined;
	let modelBefore: ExtensionContext["model"];
	let thinkingBefore: ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined;
	let modelOverridden = false;
	let thinkingOverridden = false;
	let dirty = false;
	/** A workflow finished during the current run: only summarizing is allowed until the run settles. */
	let wrapUp = false;
	const approvals: Approval[] = [];
	let uiQueue: Promise<unknown> = Promise.resolve();

	pi.registerFlag("agent-mode", { description: "Start in an agent mode or workflow (e.g. plan, build, e2e)", type: "string" });

	// -------------------------------------------------------------------------
	// helpers
	// -------------------------------------------------------------------------

	const isWorkflow = (name: string) => !config.agents[name] && !!config.workflows[name];
	const workflowDef = (): WorkflowDef | undefined => (wf ? config.workflows[wf.name] : undefined);

	function currentAgentName(): string | undefined {
		if (wf?.active) {
			const def = workflowDef();
			const step = def?.steps[Math.min(wf.step, (def?.steps.length ?? 1) - 1)];
			if (step) return step.agent;
		}
		if (config.agents[mode]) return mode;
		if (isWorkflow(mode)) return config.workflows[mode].steps[0]?.agent;
		return undefined;
	}
	const currentAgent = (): AgentDef | undefined => {
		const n = currentAgentName();
		return n ? config.agents[n] : undefined;
	};

	function serialized<T>(fn: () => Promise<T>): Promise<T> {
		const p = uiQueue.then(fn, fn);
		uiQueue = p.catch(() => undefined);
		return p;
	}

	function persist() {
		dirty = true;
	}
	function stateSnapshot(): PersistedState {
		return { mode, workflow: wf ? structuredClone(wf) : undefined, toolsBefore };
	}

	function updateStatus(ctx: ExtensionContext) {
		const t = ctx.ui.theme;
		if (mode === "off") {
			ctx.ui.setStatus("agent-mode", undefined);
			return;
		}
		const def = workflowDef();
		if (wf?.active && def) {
			const agent = def.steps[wf.step]?.agent ?? "?";
			const loops = Object.values(wf.loops).reduce((a, b) => a + b, 0);
			const tail = `${agent} ${wf.step + 1}/${def.steps.length}${loops ? ` ↻${loops}` : ""}`;
			ctx.ui.setStatus("agent-mode", t.fg(modeColor(agent), `~ ${wf.name} # ${tail}`));
		} else if (isWorkflow(mode)) {
			ctx.ui.setStatus("agent-mode", t.fg("accent", `~ ${mode}`));
		} else {
			ctx.ui.setStatus("agent-mode", t.fg(modeColor(mode), `- ${mode}`));
		}
	}

	/** Agent permissions, plus the active workflow step's overrides (step rules win per tool/pattern). */
	function effectivePermissions(agentName: string): PermissionSet {
		const base = config.agents[agentName].permissions;
		const step = wf?.active ? workflowDef()?.steps[wf.step] : undefined;
		return step?.agent === agentName && step.permissions ? mergePermissionSets(base, step.permissions) : base;
	}

	function registeredTools(): Set<string> {
		return new Set(pi.getAllTools().filter((t) => t.exposure !== "hidden").map((t) => t.name));
	}

	function toolsFor(agentName: string): string[] {
		const agent = config.agents[agentName];
		const perms = effectivePermissions(agentName);
		const registered = registeredTools();
		const tools = agent.tools.filter((t) => registered.has(t) && (ALWAYS_ALLOWED.has(t) || !isToolHidden(perms, t)));
		if (wf?.active && registered.has(REPORT_TOOL)) tools.push(REPORT_TOOL);
		return [...new Set(tools)];
	}

	async function applyAgent(agentName: string, ctx: ExtensionContext) {
		const agent = config.agents[agentName];
		if (!agent) return;
		if (toolsBefore === undefined) toolsBefore = pi.getActiveTools().filter((t) => t !== REPORT_TOOL);
		if (!modelOverridden) modelBefore = ctx.model;
		if (!thinkingOverridden) thinkingBefore = pi.getThinkingLevel();

		pi.setActiveTools(toolsFor(agentName));

		if (agent.model) {
			const slash = agent.model.indexOf("/");
			const found = slash > 0 ? ctx.modelRegistry.find(agent.model.slice(0, slash), agent.model.slice(slash + 1)) : undefined;
			if (found && (await pi.setModel(found))) modelOverridden = true;
			else ctx.ui.notify(`agent-modes: model ${agent.model} unavailable for ${agentName}`, "warning");
		} else if (modelOverridden && modelBefore) {
			await pi.setModel(modelBefore);
			modelOverridden = false;
		}
		if (agent.thinkingLevel) {
			pi.setThinkingLevel(agent.thinkingLevel);
			thinkingOverridden = true;
		} else if (thinkingOverridden && thinkingBefore) {
			pi.setThinkingLevel(thinkingBefore);
			thinkingOverridden = false;
		}
	}

	async function restoreDefaults(ctx: ExtensionContext) {
		if (toolsBefore) pi.setActiveTools(toolsBefore);
		toolsBefore = undefined;
		if (modelOverridden && modelBefore) await pi.setModel(modelBefore);
		if (thinkingOverridden && thinkingBefore) pi.setThinkingLevel(thinkingBefore);
		modelOverridden = thinkingOverridden = false;
	}

	async function setMode(name: string, ctx: ExtensionContext, quiet = false): Promise<boolean> {
		if (name !== "off" && !config.agents[name] && !config.workflows[name]) {
			ctx.ui.notify(`Unknown mode "${name}". Available: ${allModes().join(", ")}`, "error");
			return false;
		}
		if (wf?.active && name !== wf.name) {
			if (!quiet) ctx.ui.notify(`Workflow "${wf.name}" stopped.`, "info");
		}
		wf = undefined;
		wrapUp = false;
		mode = name;
		if (name === "off") await restoreDefaults(ctx);
		else await applyAgent(currentAgentName()!, ctx);
		persist();
		updateStatus(ctx);
		if (!quiet) {
			const desc = name === "off" ? "default pi, no mode restrictions" : (config.agents[name] ?? config.workflows[name]).description;
			ctx.ui.notify(`Mode: ${name} — ${desc}`, "info");
		}
		return true;
	}

	function allModes(): string[] {
		return ["off", ...Object.keys(config.agents), ...Object.keys(config.workflows).filter((w) => !config.agents[w])];
	}

	// -------------------------------------------------------------------------
	// prompt text
	// -------------------------------------------------------------------------

	function permissionText(agentName: string): string {
		const tools = toolsFor(agentName).filter((t) => !ALWAYS_ALLOWED.has(t));
		return summarize(effectivePermissions(agentName), tools);
	}

	function statusesFor(agent: AgentDef): string {
		return (agent.statuses ?? ["done", "blocked"]).join(" | ");
	}

	function phaseBrief(agentName: string, stepIndex: number, extra?: string): string {
		const agent = config.agents[agentName];
		const def = workflowDef()!;
		const step = def.steps[stepIndex];
		return [
			`## Phase ${stepIndex + 1}/${def.steps.length}: ${agent.label} (${agentName})`,
			agent.instructions,
			step?.instructions ?? "",
			extra ? `\n${extra}` : "",
			`\nPermissions (enforced; denied calls fail — don't retry, choose another way or ask_user):\n${permissionText(agentName)}`,
			`\nWhen this phase is complete call ${REPORT_TOOL} with status (${statusesFor(agent)}) and a concise summary` +
				` (it is handed to later phases). Use status "blocked" if you cannot proceed without the user.` +
				` Do not do later phases' work early.`,
		]
			.filter(Boolean)
			.join("\n");
	}

	function sectionText(): string | undefined {
		const agentName = currentAgentName();
		if (!agentName) return undefined;
		const agent = config.agents[agentName];
		const def = workflowDef() ?? (isWorkflow(mode) ? config.workflows[mode] : undefined);
		if (def && wf?.active) {
			const flow = def.steps.map((s, i) => (i === wf!.step ? `[${s.agent}]` : s.agent)).join(" → ");
			return [
				`Workflow "${def.label}": ${flow}`,
				`Phases change only via ${REPORT_TOOL}; if its result announces a MODE SWITCH, the new phase instructions supersede this section.`,
				phaseBrief(agentName, wf.step),
			].join("\n");
		}
		return [
			`Mode: ${agent.label} (${agentName}) — ${agent.description}`,
			agent.instructions,
			`Permissions (enforced; denied calls fail — don't retry, choose another way or ask_user):\n${permissionText(agentName)}`,
		].join("\n");
	}

	// -------------------------------------------------------------------------
	// workflow engine
	// -------------------------------------------------------------------------

	async function startWorkflow(name: string, problem: string, ctx: ExtensionContext) {
		mode = name;
		wf = {
			name,
			problem,
			step: 0,
			active: true,
			loops: {},
			history: [],
			reported: false,
			nudges: 0,
			lastFeedback: undefined,
			phaseStartTimestamp: Date.now(),
		};
		await applyAgent(config.workflows[name].steps[0].agent, ctx);
		persist();
		updateStatus(ctx);
	}

	async function finishWorkflow(ctx: ExtensionContext, how: "complete" | "stopped") {
		if (!wf) return;
		wf.active = false;
		// Back to plain pi; the finished workflow stays inspectable via /workflow status.
		mode = "off";
		if (ctx.isIdle()) await restoreDefaults(ctx);
		else {
			// Still inside a run: restrict to read-only tools for the final summary; restored on agent_settled.
			wrapUp = true;
			pi.setActiveTools(pi.getActiveTools().filter((t) => WRAP_UP_TOOLS.has(t)));
		}
		persist();
		updateStatus(ctx);
		ctx.ui.notify(`Workflow ${wf.name} ${how}.`, "info");
	}

	function findGotoIndex(def: WorkflowDef, agent: string, before: number): number {
		for (let i = before - 1; i >= 0; i--) if (def.steps[i].agent === agent) return i;
		return def.steps.findIndex((s) => s.agent === agent);
	}

	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

	pi.registerTool({
		name: REPORT_TOOL,
		label: "Workflow report",
		description:
			"Report completion of the current workflow phase. The harness then advances to the next phase (new agent, tools and permissions), loops back for fixes, or asks the user at approval gates.",
		promptSnippet: "Report the result of the current workflow phase",
		parameters: Type.Object({
			status: StringEnum(["done", "approved", "changes_requested", "pass", "fail", "blocked"] as const, {
				description: "Phase outcome. done=finished · approved/changes_requested=review verdict · pass/fail=tests · blocked=need the user",
			}),
			summary: Type.String({ description: "Concise phase result handed to later phases (findings, plan, files changed, failures)" }),
		}),
		exposure: "model-only",
		defaultActive: false,
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!wf?.active) return text("No workflow is running; nothing to report.");
			const def = workflowDef();
			if (!def) return text("Workflow definition missing.");
			const step = def.steps[wf.step];
			const agentName = step.agent;
			const { status, summary } = params;
			wf.history.push({ agent: agentName, status, summary });
			wf.reported = true;
			persist();
			const ask = (title: string, options: string[]) =>
				serialized(() => ctx.ui.select(title, options, { signal }));

			let target: number | undefined;
			let extra: string | undefined;

			if (status === "blocked") {
				if (!ctx.hasUI) {
					await finishWorkflow(ctx, "stopped");
					return text(`Workflow paused (blocked, no UI). Explain to the user: ${summary}`);
				}
				const choice = await ask(`⚙ ${wf.name}: ${agentName} is blocked\n\n${summary}`, [
					"Give guidance…",
					"Retry this phase",
					"Skip to next phase",
					"Stop workflow",
				]);
				if (choice === "Give guidance…") {
					const g = await serialized(() => ctx.ui.input("Guidance for the agent", "", { signal }));
					wf.reported = false;
					wf.history.pop();
					return text(`User guidance: ${g?.trim() || "(none)"}\nContinue the ${agentName} phase, then call ${REPORT_TOOL}.`);
				}
				if (choice === "Retry this phase") {
					wf.reported = false;
					wf.history.pop();
					return text(`Retry the ${agentName} phase, then call ${REPORT_TOOL}.`);
				}
				if (choice === "Skip to next phase") target = wf.step + 1;
				else {
					await finishWorkflow(ctx, "stopped");
					return {
						content: [{ type: "text" as const, text: "User stopped the workflow. Briefly summarize the current state and stop." }],
						details: { phaseTransition: true, stopped: true },
					};
				}
			} else if (POSITIVE.has(status) || !step.onReject || !NEGATIVE.has(status)) {
				if (step.gate && ctx.hasUI) {
					const next = def.steps[wf.step + 1]?.agent ?? "finish";
					const choice = await ask(`⚙ ${wf.name}: approve ${agentName} result → ${next}?\n\n${truncate(summary, 1500)}`, [
						"Approve & continue",
						"Request changes…",
						"Stop workflow",
					]);
					if (choice === "Request changes…") {
						const fb = await serialized(() => ctx.ui.input(`Changes for ${agentName}`, "", { signal }));
						wf.reported = false;
						wf.history.pop();
						return text(`User requested changes: ${fb?.trim() || "(unspecified)"}\nRevise, then call ${REPORT_TOOL} again.`);
					}
					if (choice !== "Approve & continue") {
						await finishWorkflow(ctx, "stopped");
						return {
							content: [{ type: "text" as const, text: "User stopped the workflow. Briefly summarize the current state and stop." }],
							details: { phaseTransition: true, stopped: true },
						};
					}
				}
				target = wf.step + 1;
			} else {
				// negative verdict with a loop-back
				const key = String(wf.step);
				const count = (wf.loops[key] ?? 0) + 1;
				const max = step.onReject.max ?? 3;
				if (count > max) {
					const choice = ctx.hasUI
						? await ask(`⚙ ${wf.name}: ${agentName} still reports ${status} after ${max} loops.\n\n${truncate(summary, 1200)}`, [
								"Allow another iteration",
								"Accept as-is and continue",
								"Stop workflow",
							])
						: "Stop workflow";
					if (choice === "Accept as-is and continue") target = wf.step + 1;
					else if (choice === "Allow another iteration") wf.loops[key] = count - 1;
					else {
						await finishWorkflow(ctx, "stopped");
						return {
							content: [{ type: "text" as const, text: `Loop limit reached; workflow stopped. Summarize remaining issues for the user:\n${summary}` }],
							details: { phaseTransition: true, stopped: true },
						};
					}
				}
				if (target === undefined) {
					wf.loops[key] = (wf.loops[key] ?? 0) + 1;
					target = findGotoIndex(def, step.onReject.goto, wf.step);
					extra = `Fix these findings from ${agentName} (${status}, loop ${wf.loops[key]}/${max}):\n${summary}`;
				}
			}

			if (target === undefined || target < 0 || target >= def.steps.length) {
				await finishWorkflow(ctx, "complete");
				const hist = wf.history.map((h) => `- ${h.agent}: ${h.status}`).join("\n");
				return {
					content: [{ type: "text" as const, text: `Workflow complete.\n${hist}\nGive the user a brief final summary of the outcome.` }],
					details: { phaseTransition: true, completed: true },
				};
			}

			const nextAgent = def.steps[target].agent;
			wf.step = target;
			wf.reported = false;
			wf.nudges = 0;
			wf.lastFeedback = extra;
			wf.phaseStartTimestamp = Date.now();
			await applyAgent(nextAgent, ctx);
			persist();
			updateStatus(ctx);
			return {
				content: [{ type: "text" as const, text: `${agentName} → ${status}. MODE SWITCH.\n\n${phaseBrief(nextAgent, target, extra)}` }],
				details: {
					phaseTransition: true,
					fromAgent: agentName,
					toAgent: nextAgent,
					step: target,
					extra,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("workflow_report ")) + theme.fg("accent", String(args.status ?? "")) +
					theme.fg("muted", ` ${truncate(String(args.summary ?? ""), 80).replace(/\n/g, " ")}`),
				0,
				0,
			);
		},
		renderResult(result, _o, theme) {
			const first = result.content[0];
			const line = first?.type === "text" ? first.text.split("\n").find((l) => l.startsWith("## Phase")) ?? first.text.split("\n")[0] : "";
			return new Text(theme.fg("success", "⚙ ") + theme.fg("muted", line.replace(/^## /, "")), 0, 0);
		},
	});

	// -------------------------------------------------------------------------
	// permission enforcement
	// -------------------------------------------------------------------------

	function permissionSets(): { name: string; set: PermissionSet; authoritative: boolean }[] {
		const sets = [{ name: "global", set: config.global, authoritative: false }];
		const agentName = currentAgentName();
		if (agentName && mode !== "off") sets.push({ name: agentName, set: effectivePermissions(agentName), authoritative: true });
		return sets;
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!config) return;
		if (wrapUp && !WRAP_UP_TOOLS.has(event.toolName)) {
			return { block: true, reason: "The workflow has finished. Do not make further changes; only summarize the outcome for the user." };
		}
		if (ALWAYS_ALLOWED.has(event.toolName)) return;
		const input = event.input as Record<string, unknown>;
		const decision = evaluate(event.toolName, input, ctx.cwd, permissionSets());
		const who = currentAgentName() && mode !== "off" ? currentAgentName()! : "global";

		if (decision.action === "deny") {
			const denied = decision.checks.filter((c) => c.action === "deny");
			return {
				block: true,
				reason: `Denied by ${who} permissions: ${denied.map((c) => `${c.label} (${c.because})`).join("; ")}. Do not retry this; use an allowed approach or ask the user.`,
			};
		}
		if (decision.action === "allow") return;

		const pending = () => decision.checks.filter((c) => c.action === "ask" && !approvals.some((a) => approvalMatches(a, c)));
		if (pending().length === 0) return;
		if (!ctx.hasUI) {
			return { block: true, reason: `Needs user approval (${pending().map((c) => c.label).join("; ")}) but no UI is available.` };
		}

		return serialized(async () => {
			const open = pending(); // re-check: an earlier dialog may have approved these
			if (open.length === 0) return undefined;
			const patterns = open.map((c) => sessionPattern(c));
			const samePattern = [...new Set(patterns.map((p) => p.label))].join(", ");
			const tools = [...new Set(open.map((c) => c.tool))];
			const options = [
				"Allow once",
				`Allow ${samePattern} for this session`,
				`Allow all ${tools.join("/")} for this session`,
				"Deny",
				"Deny with feedback…",
			];
			const title = `🔐 [${who}] approval needed\n\n${open.map((c) => `${c.label}\n   rule: ${c.because}`).join("\n")}`;
			const choice = await ctx.ui.select(title, options, {
				signal: ctx.signal,
				timeout: config.askTimeoutMs > 0 ? config.askTimeoutMs : undefined,
			});
			if (choice === options[0]) return undefined;
			if (choice === options[1]) {
				for (const p of patterns) approvals.push(p.approval);
				return undefined;
			}
			if (choice === options[2]) {
				for (const t of tools) approvals.push({ tool: t, pattern: "*" });
				return undefined;
			}
			if (choice === options[4]) {
				const fb = await ctx.ui.input("Why / what instead?", "", { signal: ctx.signal });
				return { block: true, reason: `User denied ${open.map((c) => c.label).join("; ")}. Feedback: ${fb?.trim() || "(none)"}` };
			}
			return { block: true, reason: `User denied ${open.map((c) => c.label).join("; ")}.` };
		});
	});

	function sessionPattern(c: Check): { label: string; approval: Approval } {
		if ((c.tool === "bash" || c.tool === "powershell") && c.subject) {
			const pattern = suggestCommandPattern(c.subject);
			return { label: `"${pattern}"`, approval: { tool: c.tool, pattern } };
		}
		if (c.subject) return { label: `${c.tool} ${c.subject}`, approval: { tool: c.tool, pattern: c.subject } };
		return { label: c.tool, approval: { tool: c.tool, pattern: "*" } };
	}

	// -------------------------------------------------------------------------
	// lifecycle
	// -------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		const loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		config = loaded.config;
		for (const e of loaded.errors) ctx.ui.notify(`agent-modes: ${e}`, "warning");

		let restored: PersistedState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) restored = entry.data as PersistedState;
		}
		const flag = pi.getFlag("agent-mode");
		if (typeof flag === "string" && flag) {
			await setMode(flag, ctx, true);
		} else if (restored && (restored.mode === "off" || config.agents[restored.mode] || config.workflows[restored.mode])) {
			mode = restored.mode;
			wf = restored.workflow;
			toolsBefore = restored.toolsBefore;
			if (mode !== "off" && currentAgentName()) await applyAgent(currentAgentName()!, ctx);
		} else if (config.defaultMode !== "off") {
			await setMode(config.defaultMode, ctx, true);
		}
		dirty = false;
		updateStatus(ctx);
	});

	async function endWrapUp(ctx: ExtensionContext) {
		if (!wrapUp) return;
		wrapUp = false;
		if (mode === "off") await restoreDefaults(ctx);
	}

	pi.on("agent_settled", async (_event, ctx) => endWrapUp(ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		currentCtx = ctx;
		if (!config) return;
		await endWrapUp(ctx);
		if (isWorkflow(mode) && !wf?.active) {
			await startWorkflow(mode, event.prompt, ctx);
			ctx.ui.notify(`Workflow ${mode} started.`, "info");
		}
		const section = sectionText();
		if (section && mode !== "off") event.systemPromptOptions.sections[SECTION] = section;
		else delete event.systemPromptOptions.sections[SECTION];
	});

	function isTransitionMessage(m: AgentMessage): boolean {
		if (m.role !== "toolResult") return false;
		const tr = m as { toolName?: string; details?: unknown; content?: { type: string; text?: string }[] };
		if (tr.toolName !== REPORT_TOOL) return false;
		const details = tr.details as { phaseTransition?: boolean } | undefined;
		if (details?.phaseTransition) return true;
		const first = tr.content?.[0];
		if (first && first.type === "text" && first.text?.includes("MODE SWITCH")) return true;
		return false;
	}

	function buildKickoffMessage(def: WorkflowDef, agent: AgentDef, agentName: string): AgentMessage {
		const stepIndex = wf!.step;
		const step = def.steps[stepIndex];

		const historySections = wf!.history
			.map((h, i) => `### Phase ${i + 1}: ${h.agent} (${h.status})\n${h.summary.trim()}`)
			.join("\n\n");

		const parts = [
			`# Workflow: ${def.label} (${wf!.name})`,
			`**Goal:**\n${wf!.problem}`,
			`\n## Previous Phase Results:\n${historySections}`,
		];

		if (wf!.lastFeedback) {
			parts.push(`\n## Feedback to address:\n${wf!.lastFeedback}`);
		}

		parts.push(
			`\n---\n## Current Phase: ${agent.label} (${agentName})`,
			agent.instructions,
			step?.instructions ? `\nStep instructions:\n${step.instructions}` : "",
			`\nPermissions (enforced; denied calls fail — don't retry, choose another way or ask_user):\n${permissionText(agentName)}`,
			`\nWhen this phase is complete, call ${REPORT_TOOL} with status (${statusesFor(agent)}) and a concise summary to hand off to subsequent phases. Do not do later phases' work early.`,
		);

		return {
			role: "user",
			content: parts.filter(Boolean).join("\n"),
			timestamp: Date.now(),
		};
	}

	function buildWrapUpMessage(def: WorkflowDef): AgentMessage {
		const historySections = wf!.history
			.map((h, i) => `### Phase ${i + 1}: ${h.agent} (${h.status})\n${h.summary.trim()}`)
			.join("\n\n");

		const parts = [
			`# Workflow: ${def.label} (${wf!.name}) — Completed`,
			`**Goal:**\n${wf!.problem}`,
			`\n## Completed Phase Summaries:\n${historySections}`,
			`\n---\nAll workflow phases have completed. Please provide the user with a concise final summary of the outcome and changes made.`,
		];

		return {
			role: "user",
			content: parts.join("\n"),
			timestamp: Date.now(),
		};
	}

	pi.on("context", async (event) => {
		if (!wf) return;
		if (!wf.active && !wrapUp) return;
		const def = workflowDef();
		if (!def) return;

		let lastTransitionIdx = -1;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			if (isTransitionMessage(event.messages[i])) {
				lastTransitionIdx = i;
				break;
			}
		}

		if (lastTransitionIdx === -1) return;

		const rawPhaseMessages = event.messages.slice(lastTransitionIdx + 1);
		const currentPhaseMessages = wf.phaseStartTimestamp
			? rawPhaseMessages.filter((m) => (m.timestamp ?? 0) >= wf.phaseStartTimestamp!)
			: rawPhaseMessages;

		if (wrapUp || !wf.active) {
			return {
				messages: [buildWrapUpMessage(def), ...currentPhaseMessages],
			};
		}

		const agentName = currentAgentName();
		if (!agentName) return;
		const agent = config.agents[agentName];
		if (!agent) return;

		return {
			messages: [buildKickoffMessage(def, agent, agentName), ...currentPhaseMessages],
		};
	});

	pi.on("turn_end", async (event) => {
		if (!dirty) return;
		dirty = false;
		return { entries: [...event.entries, { type: "custom", customType: STATE_TYPE, data: stateSnapshot() }] };
	});

	// Nudge once if a workflow phase ended without a report.
	pi.on("agent_before_settle", async (event) => {
		const entries = [...event.entries];
		if (dirty) {
			dirty = false;
			entries.push({ type: "custom", customType: STATE_TYPE, data: stateSnapshot() });
		}
		if (wf?.active && !wf.reported && event.outcome === "completed" && wf.nudges < 1) {
			// (event.context.canContinue is false here because the context ends with the assistant reply;
			// the nudge message appended below is what makes continuation valid.)
			wf.nudges++;
			entries.push({
				type: "custom_message",
				customType: "agent-modes-nudge",
				display: false,
				content: `[workflow] Phase "${currentAgentName()}" has not been reported. Finish it and call ${REPORT_TOOL}. If you need the user, call ask_user or report status "blocked".`,
			});
			return { entries, continue: true };
		}
		return { entries };
	});

	// Offer the agent's handoff mode (e.g. plan → build) after a normal run.
	pi.on("agent_end", async (event, ctx) => {
		currentCtx = ctx;
		if (!config || wf?.active || !ctx.hasUI || !config.agents[mode]?.handoff) return;
		const last = [...event.messages].reverse().find((m) => m.role === "assistant") as { stopReason?: string } | undefined;
		if (!last || last.stopReason === "aborted" || last.stopReason === "error" || last.stopReason === "toolUse") return;
		const target = config.agents[mode].handoff!;
		if (!config.agents[target]) return;
		const go = `Switch to ${target} and continue`;
		const choice = await ctx.ui.select(`${config.agents[mode].label} finished. Next?`, [go, `Stay in ${mode}`]);
		if (choice === go) {
			const from = mode;
			await setMode(target, ctx, true);
			pi.sendUserMessage(`Continue from the ${from} result above in ${target} mode.`, { deliverAs: "followUp" });
		}
	});

	pi.on("session_shutdown", async () => {
		(globalThis as any)[TAB_HANDLER_KEY] = undefined;
		currentCtx = undefined;
		approvals.length = 0;
	});

	// -------------------------------------------------------------------------
	// commands
	// -------------------------------------------------------------------------

	const modeCompletions = (prefix: string) =>
		allModes()
			.filter((m) => m.startsWith(prefix))
			.map((m) => ({ value: m, label: m, description: m === "off" ? "default pi" : (config.agents[m] ?? config.workflows[m]).description }));

	pi.registerCommand("mode", {
		description: "Switch agent mode / workflow (explore, plan, build, review, test, security, perf, ship, e2e, …)",
		getArgumentCompletions: (prefix) => (config ? modeCompletions(prefix.trim()) : null),
		handler: async (args, ctx) => {
			const name = args.trim();
			if (name) {
				await setMode(name, ctx);
				return;
			}
			const labels = allModes().map((m) => {
				const desc = m === "off" ? "default pi, no mode restrictions" : (config.agents[m] ?? config.workflows[m]).description;
				return `${m === mode ? "● " : "  "}${m}${isWorkflow(m) ? " (workflow)" : ""} — ${desc}`;
			});
			const choice = await ctx.ui.select("Select mode", labels);
			if (!choice) return;
			await setMode(allModes()[labels.indexOf(choice)], ctx);
		},
	});

	(globalThis as any)[TAB_HANDLER_KEY] = () => {
		if (!currentCtx || !config) return;
		const cycle = config.cycle.filter((m) => m === "off" || config.agents[m] || config.workflows[m]);
		if (!cycle.length) return;
		const next = cycle[(cycle.indexOf(mode) + 1) % cycle.length];
		void setMode(next, currentCtx);
	};

	pi.registerShortcut(Key.ctrlAlt("m"), {
		description: "Cycle agent modes",
		handler: async (ctx) => {
			const cycle = config.cycle.filter((m) => m === "off" || config.agents[m] || config.workflows[m]);
			if (!cycle.length) return;
			const next = cycle[(cycle.indexOf(mode) + 1) % cycle.length];
			await setMode(next, ctx);
		},
	});

	pi.registerCommand("workflow", {
		description: "Workflows: start <name> <problem> | status | stop | skip",
		getArgumentCompletions: (prefix) => {
			if (!config) return null;
			const items = ["start", "status", "stop", "skip", ...Object.keys(config.workflows)];
			return items.filter((i) => i.startsWith(prefix.trim())).map((i) => ({ value: i, label: i }));
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/);
			if (sub === "status") {
				if (!wf) {
					ctx.ui.notify(`No workflow. Available: ${Object.entries(config.workflows).map(([n, w]) => `${n} (${w.description})`).join("; ")}`, "info");
					return;
				}
				const def = workflowDef()!;
				const lines = def.steps.map((s, i) => `${i === wf!.step && wf!.active ? "▶" : i < wf!.step ? "✓" : "·"} ${s.agent}${s.gate ? " (gate)" : ""}${wf!.loops[i] ? ` ↻${wf!.loops[i]}` : ""}`);
				const hist = wf.history.map((h) => `  ${h.agent}: ${h.status} — ${truncate(h.summary, 80).replace(/\n/g, " ")}`);
				ctx.ui.notify(`${wf.name} ${wf.active ? "running" : "finished"}\n${lines.join("\n")}${hist.length ? `\nhistory:\n${hist.join("\n")}` : ""}`, "info");
				return;
			}
			if (sub === "stop") {
				if (wf?.active) await finishWorkflow(ctx, "stopped");
				return;
			}
			if (sub === "skip") {
				if (!wf?.active) return;
				const def = workflowDef()!;
				const skippedAgent = def.steps[wf.step].agent;
				wf.history.push({ agent: skippedAgent, status: "skipped", summary: "(Skipped by user)" });
				if (wf.step + 1 >= def.steps.length) {
					await finishWorkflow(ctx, "complete");
					return;
				}
				wf.step++;
				wf.reported = false;
				wf.lastFeedback = undefined;
				wf.phaseStartTimestamp = Date.now();
				await applyAgent(def.steps[wf.step].agent, ctx);
				persist();
				updateStatus(ctx);
				ctx.ui.notify(`Skipped to ${def.steps[wf.step].agent}. Send a message to continue.`, "info");
				return;
			}
			let name = sub === "start" ? rest.shift() : sub;
			if (!name || !config.workflows[name]) {
				const names = Object.keys(config.workflows);
				name = await ctx.ui.select("Workflow", names);
				if (!name) return;
			}
			let problem = rest.join(" ").trim();
			if (!problem) problem = (await ctx.ui.editor(`Problem for ${name}`, ""))?.trim() ?? "";
			if (!problem) return;

			const scriptPath = path.join(getAgentDir(), "workflows", `${name}.js`);
			if (fs.existsSync(scriptPath)) {
				const choice = await ctx.ui.select(`Run "${name}" via:`, [
					"subagents (Isolated fresh contexts, worktree safety, parallel review)",
					"in-session (Single linear transcript)",
				]);
				if (!choice) return;
				if (choice.startsWith("subagents")) {
					ctx.ui.notify(`Dispatching ${name} workflow via pi-subagents...`, "info");
					pi.sendUserMessage(
						`Execute the "${name}" workflow via subagents for:\n${problem}\n\nCall:\nsubagent({ workflow: "${scriptPath}", args: { problem: ${JSON.stringify(problem)} } })`
					);
					return;
				}
			}

			mode = name;
			wf = undefined; // before_agent_start starts it with this prompt
			await applyAgent(config.workflows[name].steps[0].agent, ctx);
			updateStatus(ctx);
			pi.sendUserMessage(problem);
		},
	});

	pi.registerCommand("permissions", {
		description: "Show effective permissions for the current mode, or `check <tool> <command|path>`",
		handler: async (args, ctx) => {
			const [sub, tool, ...rest] = args.trim().split(/\s+/);
			if (sub === "check" && tool) {
				const arg = rest.join(" ");
				const input = tool === "bash" ? { command: arg } : { path: arg };
				const d = evaluate(tool, input, ctx.cwd, permissionSets());
				ctx.ui.notify(`${d.action.toUpperCase()}\n${d.checks.map((c) => `${c.action.padEnd(5)} ${c.label}  (${c.because})`).join("\n")}`, "info");
				return;
			}
			const agent = currentAgent();
			const parts = [`Mode: ${mode}${agent && mode !== "off" ? ` → agent ${currentAgentName()}` : ""}`];
			if (agent && mode !== "off") parts.push(`Active tools: ${pi.getActiveTools().join(", ")}`, permissionText(currentAgentName()!));
			parts.push(`Global rules:\n${summarize(config.global, Object.keys(config.global))}`);
			if (approvals.length) parts.push(`Session approvals: ${approvals.map((a) => `${a.tool}:${a.pattern}`).join(", ")}`);
			ctx.ui.notify(parts.join("\n"), "info");
		},
	});

	pi.registerCommand("modes-config", {
		description: "Write the effective agent-modes config to ~/.pi/agent/agent-modes.json for editing",
		handler: async (_args, ctx) => {
			const file = USER_CONFIG_PATH();
			if (fs.existsSync(file) && !(await ctx.ui.confirm("Overwrite?", `${file} exists. Overwrite with the full effective config?`))) return;
			fs.writeFileSync(file, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
			ctx.ui.notify(`Wrote ${file}. Edit it, then run /modes-reload.`, "info");
		},
	});

	pi.registerCommand("modes-reload", {
		description: "Reload agent-modes config",
		handler: async (_args, ctx) => {
			const loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			config = loaded.config;
			for (const e of loaded.errors) ctx.ui.notify(`agent-modes: ${e}`, "warning");
			if (mode !== "off" && !config.agents[mode] && !config.workflows[mode]) await setMode("off", ctx, true);
			else if (mode !== "off" && currentAgentName()) await applyAgent(currentAgentName()!, ctx);
			updateStatus(ctx);
			ctx.ui.notify("agent-modes config reloaded.", "info");
		},
	});
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
