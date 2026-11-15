/**
 * Tool Manager Extension
 *
 * Provides a /tools command to enable/disable tools interactively, with
 * dependency awareness:
 *
 * - Dependent tools only appear in the list when all of their dependencies
 *   are enabled ("dependents only show when deps are on").
 * - Enabling a tool automatically enables its dependencies (transitively).
 * - Disabling a tool automatically disables anything that depends on it
 *   (transitively), which removes them from the list.
 *
 * Tool selection persists across session reloads, respects branch navigation, and carries
 * over to fresh sessions through <agent-dir>/tools.json. Branch entries take precedence over
 * that file, so an older session keeps its own selection when resumed or forked.
 *
 * Configure dependencies in TOOL_DEPENDENCIES below (tool -> required tools).
 * Use /tools <name> to toggle a single tool directly from the prompt.
 * Use /tools reset to delete the saved selection so fresh sessions follow defaultTools again.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

/**
 * Dependency map: each key can only be enabled when all of its listed
 * dependencies are enabled. Order doesn't matter; cycles are ignored safely.
 */
const TOOL_DEPENDENCIES: Record<string, string[]> = {
	// Examples (edit to match your tools):
	// "codemode": ["read", "bash"],
	// "tool_search": ["codemode"],
};

// State persisted to session
interface ToolsState {
	enabledTools: string[];
}

// State persisted to the agent directory so fresh sessions inherit the selection.
interface ToolsFile {
	version: 1;
	enabledTools: string[];
}

function toolsFilePath(): string {
	return join(getAgentDir(), "tools.json");
}

/** Read the saved selection, or undefined when there is none or it is unusable. */
function readToolsFile(): string[] | undefined {
	try {
		const path = toolsFilePath();
		if (!existsSync(path)) return undefined;
		const data = JSON.parse(readFileSync(path, "utf8")) as Partial<ToolsFile>;
		const list = data?.enabledTools;
		if (!Array.isArray(list)) return undefined;
		return list.filter((name): name is string => typeof name === "string");
	} catch {
		// A malformed file must not break session start.
		return undefined;
	}
}

/** Write the saved selection atomically. Failures are non-fatal: the session entry still works. */
function writeToolsFile(enabled: string[]): void {
	try {
		const path = toolsFilePath();
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		const data: ToolsFile = { version: 1, enabledTools: [...enabled].sort() };
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
		renameSync(tmp, path);
	} catch {
		// Ignore: persistence across sessions is best-effort.
	}
}

function clearToolsFile(): void {
	try {
		rmSync(toolsFilePath(), { force: true });
	} catch {
		// Ignore.
	}
}

export default function toolManagerExtension(pi: ExtensionAPI) {
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	// --- dependency helpers -------------------------------------------------

	const depsOf = (name: string): string[] => TOOL_DEPENDENCIES[name] ?? [];

	/** Direct dependents of a tool (tools that list it as a dependency). */
	function directDependentsOf(name: string): string[] {
		return Object.entries(TOOL_DEPENDENCIES)
			.filter(([, deps]) => deps.includes(name))
			.map(([dependent]) => dependent);
	}

	/** Transitive closure: everything required to enable `name`. */
	function requiredFor(name: string, seen = new Set<string>()): string[] {
		if (seen.has(name)) return [];
		seen.add(name);
		const out: string[] = [];
		for (const dep of depsOf(name)) {
			out.push(dep, ...requiredFor(dep, seen));
		}
		return out;
	}

	/** Transitive closure: everything that breaks if `name` is disabled. */
	function dependentsOf(name: string, seen = new Set<string>()): string[] {
		if (seen.has(name)) return [];
		seen.add(name);
		const out: string[] = [];
		for (const dependent of directDependentsOf(name)) {
			out.push(dependent, ...dependentsOf(dependent, seen));
		}
		return out;
	}

	/** A tool is visible in the list only when all its deps are enabled. */
	function isListable(name: string): boolean {
		return depsOf(name).every((dep) => enabledTools.has(dep));
	}

	// --- state --------------------------------------------------------------

	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
		// Also save to the agent directory so fresh sessions start from this selection.
		writeToolsFile(Array.from(enabledTools));
	}

	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	function enable(name: string) {
		// Auto-enable dependencies first.
		for (const dep of requiredFor(name)) {
			enabledTools.add(dep);
		}
		enabledTools.add(name);
	}

	function disable(name: string) {
		enabledTools.delete(name);
		// Auto-disable dependents so the list stays consistent.
		for (const dependent of dependentsOf(name)) {
			enabledTools.delete(dependent);
		}
	}

	function toggle(name: string): string {
		if (enabledTools.has(name)) {
			disable(name);
			return `disabled ${name}` + (dependentsOf(name).length ? ` (and: ${dependentsOf(name).join(", ")})` : "");
		}
		const missing = requiredFor(name).filter((dep) => !enabledTools.has(dep));
		enable(name);
		return `enabled ${name}` + (missing.length ? ` (with deps: ${missing.join(", ")})` : "");
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();

		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		const known = allTools.map((t) => t.name);
		let source = savedTools;
		if (!source) {
			// Fresh session: inherit the selection saved in the agent directory, unless Pi started
			// with no tools at all (an explicit --no-tools run must stay empty).
			const persisted = readToolsFile();
			if (persisted && pi.getActiveTools().length > 0) source = persisted;
		}

		if (source) {
			enabledTools = new Set(source.filter((t) => known.includes(t)));
			// Drop anything whose dependencies are no longer satisfied.
			for (const tool of enabledTools) {
				if (!isListable(tool)) enabledTools.delete(tool);
			}
		} else {
			// No saved state - sync with currently active tools.
			enabledTools = new Set(pi.getActiveTools());
		}
		applyTools();
	}

	// --- UI -----------------------------------------------------------------

	pi.registerCommand("tools", {
		description: "Enable/disable tools (dependencies auto-resolved; /tools <name> toggles one directly)",
		handler: async (args, ctx) => {
			allTools = pi.getAllTools();

			const target = args.trim();

			// /tools reset - forget the saved across-session selection.
			if (target === "reset" && !allTools.some((t) => t.name === "reset")) {
				clearToolsFile();
				ctx.ui.notify("Cleared saved tool selection; fresh sessions follow defaultTools again", "info");
				return;
			}

			// Direct toggle: /tools <name>
			if (target) {
				const name = allTools.find((t) => t.name === target)?.name;
				if (!name) {
					ctx.ui.notify(`Unknown tool: ${target}`, "error");
					return;
				}
				ctx.ui.notify(toggle(name), "info");
				applyTools();
				persistState();
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [
								theme.fg("accent", theme.bold("Tool Configuration")),
								theme.fg("dim", "Enabling a tool also enables its dependencies; disabling hides dependents."),
								"",
							];
						}
						invalidate() {}
					})(),
				);

				let settingsList!: SettingsList;

				const buildList = () => {
					// Only show tools whose dependencies are all enabled.
					const visible = allTools.filter((t) => isListable(t.name));
					const items: SettingItem[] = visible.map((tool) => ({
						id: tool.name,
						label: tool.name,
						currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
						values: ["enabled", "disabled"],
					}));

					settingsList = new SettingsList(
						items,
						Math.min(items.length + 2, 15),
						getSettingsListTheme(),
						(id, newValue) => {
							const message = toggle(id);
							applyTools();
							persistState();
							ctx.ui.notify(message, "info");
							// Rebuild so newly un/hidden dependent tools appear immediately.
							container.removeChild(settingsList);
							buildList();
							container.addChild(settingsList);
						},
						() => done(undefined),
					);
				};

				buildList();
				container.addChild(settingsList);

				const component = {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
