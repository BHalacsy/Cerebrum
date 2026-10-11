import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";

interface ContextSnapshot {
	capturedAt?: string;
	requestPayload?: string;
	messages?: string;
	promptOptions?: string;
	promptBeforeRequest?: string;
	activeTools?: string[];
	toolCatalog?: string;
}

const TABS = ["Summary", "System", "Chat", "Tools", "Agents", "Skills", "Wire"] as const;
type Tab = (typeof TABS)[number];

function serialize(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch (error) {
		return `[Could not serialize value: ${error instanceof Error ? error.message : String(error)}]`;
	}
}

function parseJson(value: string | undefined): unknown {
	if (!value) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stripTerminalControls(value: string): string {
	return value
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
}

function formatSystemMessage(message: Record<string, unknown>): string {
	const parts: string[] = [];
	const content = message.content;
	if (typeof content === "string" && content.length > 0) parts.push(content);
	else if (content !== undefined && content !== null) parts.push(serialize(content));

	const sections = asRecord(message.sections);
	if (sections) {
		for (const [name, text] of Object.entries(sections)) {
			parts.push(`--- ${name} ---\n${typeof text === "string" ? text : serialize(text)}`);
		}
	}
	return parts.length > 0 ? parts.join("\n\n") : serialize(message);
}

function buildPanels(snapshot: ContextSnapshot, ctx: ExtensionCommandContext): Record<Tab, string> {
	const messages = asArray(parseJson(snapshot.messages));
	const systemMessages = messages
		.map(asRecord)
		.filter((message): message is Record<string, unknown> => message?.role === "system");
	const chatMessages = messages
		.map(asRecord)
		.filter((message): message is Record<string, unknown> => !!message && message.role !== "system");
	const options = asRecord(parseJson(snapshot.promptOptions));
	const skills = asArray(options?.skills);
	const allTools = asArray(parseJson(snapshot.toolCatalog));
	const activeTools = snapshot.activeTools ?? [];
	const toolList = allTools
		.map(asRecord)
		.filter((tool): tool is Record<string, unknown> => !!tool)
		.map((tool) => ({ ...tool, active: activeTools.includes(String(tool.name)) }));
	const sections = {
		...(asRecord(options?.sections) ?? {}),
		...Object.assign({}, ...systemMessages.map((message) => asRecord(message.sections) ?? {})),
	};
	const contextFiles = asArray(options?.contextFiles)
		.map(asRecord)
		.filter((file): file is Record<string, unknown> => !!file);
	const agentSections = Object.fromEntries(Object.entries(sections).filter(([name]) => /agent|mode|workflow|phase/i.test(name)));
	const agentContextFiles = contextFiles.filter((file) => /(^|\/)AGENTS\.md$/i.test(String(file.path ?? "")));
	const usage = ctx.getContextUsage();
	const messageRoles = messages.reduce<Record<string, number>>((counts, raw) => {
		const role = asRecord(raw)?.role;
		if (typeof role === "string") counts[role] = (counts[role] ?? 0) + 1;
		return counts;
	}, {});

	const promptText = systemMessages.length > 0
		? systemMessages.map((message, index) => `=== System message ${index + 1} ===\n${formatSystemMessage(message)}`).join("\n\n")
		: snapshot.promptBeforeRequest ?? "No system prompt snapshot captured yet. It appears after the next agent request starts.";

	return {
		Summary: [
			"Latest captured model request",
			"",
			`Captured: ${snapshot.capturedAt ?? "no provider request captured yet"}`,
			`Context usage: ${usage?.tokens == null ? "unknown" : `${usage.tokens.toLocaleString()} tokens`} / ${usage?.contextWindow?.toLocaleString() ?? "unknown"}${usage?.percent == null ? "" : ` (${usage.percent.toFixed(1)}%)`}`,
			`Transcript messages: ${messages.length ? Object.entries(messageRoles).map(([role, count]) => `${role} ${count}`).join(", ") : "not captured yet"}`,
			`Active tools: ${activeTools.length ? activeTools.join(", ") : "none captured"}`,
			`Available skills: ${skills.length}`,
			`Provider payload: ${snapshot.requestPayload ? "captured (Wire tab)" : "not captured yet"}`,
			"",
			"System and Chat show Pi's structured messages immediately before the provider call.",
			"Wire shows the complete serialized request payload Pi handed to the provider adapter.",
			"Snapshots stay in memory only; this extension does not write prompt or conversation data to disk.",
		].join("\n"),
		System: promptText,
		Chat: chatMessages.length > 0
			? serialize(chatMessages)
			: "No conversation messages captured yet. Send a message to populate the context viewer.",
		Tools: [
			`Active tool declarations: ${activeTools.length ? activeTools.join(", ") : "none"}`,
			"",
			"The catalog below includes each registered tool's schema and whether it was active for the latest request.",
			"For provider-specific tool declarations as sent on the wire, see the Wire tab.",
			"",
			serialize(toolList),
		].join("\n"),
		Agents: [
			"Active agent / mode instructions included in the prompt",
			"Inactive agent definitions are not normally sent to the model; this view focuses on instructions present in this request.",
			"",
			agentSections && Object.keys(agentSections).length > 0
				? serialize(agentSections)
				: "No prompt section named for an agent, mode, workflow, or phase was captured. The System tab shows the complete system message.",
			"",
			"Project agent context files (AGENTS.md)",
			"",
			agentContextFiles.length > 0
				? serialize(agentContextFiles)
				: "No AGENTS.md context file was present in the captured prompt options.",
		].join("\n"),
		Skills: skills.length > 0
			? [
				"Loaded skills (name, description, source path, and invocation settings)",
				"Pi normally sends skill descriptions and paths in the system prompt; a skill's full instructions are sent only when that skill is invoked/loaded, then they appear in Chat.",
				"",
				serialize(skills),
			].join("\n")
			: "No skills were present in the captured system-prompt options. Skills disabled for model invocation are still shown if Pi loaded them.",
		Wire: snapshot.requestPayload
			? snapshot.requestPayload
			: "No provider request payload captured yet. Make a model request, then reopen /context.",
	};
}

export default function contextViewer(pi: ExtensionAPI) {
	const snapshot: ContextSnapshot = {};

	pi.on("session_start", () => {
		delete snapshot.capturedAt;
		delete snapshot.requestPayload;
		delete snapshot.messages;
		delete snapshot.promptOptions;
		delete snapshot.promptBeforeRequest;
		delete snapshot.activeTools;
		delete snapshot.toolCatalog;
	});

	pi.on("before_agent_start", (event) => {
		snapshot.promptOptions = serialize(event.systemPromptOptions);
		snapshot.promptBeforeRequest = event.systemPrompt;
	});

	pi.on("context_with_system", (event) => {
		snapshot.messages = serialize(event.messages);
	});

	pi.on("before_provider_request", (event) => {
		snapshot.requestPayload = serialize(event.payload);
		snapshot.capturedAt = new Date().toLocaleString();
		snapshot.activeTools = pi.getActiveTools();
		snapshot.toolCatalog = serialize(pi.getAllTools());
	});

	pi.registerCommand("context", {
		description: "Inspect the latest complete model context and provider request",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/context requires interactive TUI mode", "warning");
				return;
			}

			const panels = buildPanels(snapshot, ctx);
			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				let selectedTab = 0;
				let scrollOffset = 0;
				let cachedWidth = 0;
				let cachedLines: string[] = [];

				const component = {
					render(width: number): string[] {
						if (width !== cachedWidth) {
							cachedWidth = width;
							cachedLines = new Text(stripTerminalControls(panels[TABS[selectedTab]!]), 1, 0).render(width);
						}
						const titleLines = new Text(theme.fg("accent", theme.bold("Context Window")), 0, 0).render(width);
						const tabText = TABS.map((tab, index) => index === selectedTab
							? theme.fg("accent", theme.bold(`[${tab}]`))
							: theme.fg("muted", ` ${tab} `)).join(theme.fg("dim", "│"));
						const tabLines = new Text(tabText, 0, 0).render(width);
						const footerLines = new Text(
							theme.fg("muted", "←/→ Tab switch · ↑/↓ PgUp/PgDn scroll · Esc close"),
							0,
							0,
						).render(width);
						const terminalRows = process.stdout.rows || 24;
						const visibleRows = Math.max(1, terminalRows - titleLines.length - tabLines.length - footerLines.length);
						const maxOffset = Math.max(0, cachedLines.length - visibleRows);
						scrollOffset = Math.min(scrollOffset, maxOffset);
						return [
							...titleLines,
							...tabLines,
							...cachedLines.slice(scrollOffset, scrollOffset + visibleRows),
							...footerLines,
						];
					},
					invalidate() {
						cachedWidth = 0;
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(undefined);
							return;
						}
						if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
							selectedTab = (selectedTab + 1) % TABS.length;
							scrollOffset = 0;
							cachedWidth = 0;
						} else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
							selectedTab = (selectedTab + TABS.length - 1) % TABS.length;
							scrollOffset = 0;
							cachedWidth = 0;
						} else if (matchesKey(data, Key.up)) {
							scrollOffset = Math.max(0, scrollOffset - 1);
						} else if (matchesKey(data, Key.down)) {
							scrollOffset++;
						} else if (matchesKey(data, Key.pageUp)) {
							scrollOffset = Math.max(0, scrollOffset - Math.max(1, (process.stdout.rows || 24) - 6));
						} else if (matchesKey(data, Key.pageDown)) {
							scrollOffset += Math.max(1, (process.stdout.rows || 24) - 6);
						} else if (matchesKey(data, Key.home)) {
							scrollOffset = 0;
						} else if (matchesKey(data, Key.end)) {
							scrollOffset = cachedLines.length;
						}
						tui.requestRender();
					},
				};
				return component;
			});
		},
	});
}
