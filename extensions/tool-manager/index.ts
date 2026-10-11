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
 * Tool selection persists across session reloads and respects branch navigation.
 *
 * Configure dependencies in TOOL_DEPENDENCIES below (tool -> required tools).
 * Use /tools <name> to toggle a single tool directly from the prompt.
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
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
		if (savedTools) {
			enabledTools = new Set(savedTools.filter((t) => known.includes(t)));
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

			// Direct toggle: /tools <name>
			const target = args.trim();
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
