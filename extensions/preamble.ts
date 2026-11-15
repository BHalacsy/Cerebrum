/**
 * Preamble Override Extension
 *
 * Replaces only the preamble (the first line/block) of Pi's system prompt. The generated
 * <tools>, <rules>, <docs>, <addendum>, <project_context>, <skills> and <cwd> sections are
 * left exactly as Pi builds them, so the tool list stays current and the docs paths keep
 * pointing at the installed version.
 *
 * Text source, first match wins:
 *   1. <cwd>/.pi/PREAMBLE.md   (only when the project is trusted, the same rule SYSTEM.md follows)
 *   2. <agent-dir>/PREAMBLE.md (default: ~/.pi/agent/PREAMBLE.md)
 *
 * The file is read on every run, so edits apply to the next message without /reload.
 * If a custom system prompt is active (SYSTEM.md or --system-prompt), it wins and this
 * extension does nothing.
 *
 * Commands:
 *   /preamble            show the active preamble and where it comes from
 *   /preamble <text>     write <text> to <agent-dir>/PREAMBLE.md
 *   /preamble clear      delete <agent-dir>/PREAMBLE.md
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const FILE_NAME = "PREAMBLE.md";
const PROJECT_CONFIG_DIR = ".pi";

function agentPath(): string {
	return join(getAgentDir(), FILE_NAME);
}

function projectPath(cwd: string): string {
	return join(cwd, PROJECT_CONFIG_DIR, FILE_NAME);
}

/** Trimmed file contents, or undefined when missing, empty, or unreadable. */
function readPreamble(path: string): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const text = readFileSync(path, "utf8").replace(/\r\n?/g, "\n").trim();
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

function resolvePreamble(cwd: string, projectTrusted: boolean): { text: string; path: string } | undefined {
	if (projectTrusted) {
		const path = projectPath(cwd);
		const text = readPreamble(path);
		if (text) return { text, path };
	}
	const path = agentPath();
	const text = readPreamble(path);
	return text ? { text, path } : undefined;
}

/**
 * Replace everything before the first `<section>` with `preamble`. The default preamble is a
 * single line followed by a blank line and `<tools>`; multi-line text works too and becomes
 * the whole preamble block.
 */
function replacePreamble(prompt: string, preamble: string): string {
	const marker = prompt.indexOf("\n\n<");
	return marker === -1 ? preamble : `${preamble}${prompt.slice(marker)}`;
}

export default function preambleExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		// An explicit custom prompt (SYSTEM.md, --system-prompt, forceSystemPrompt) takes precedence.
		if (event.systemPromptOptions.customPrompt) return;

		const resolved = resolvePreamble(event.systemPromptOptions.cwd, ctx.isProjectTrusted());
		if (!resolved) return;

		const next = replacePreamble(event.systemPrompt, resolved.text);
		if (next === event.systemPrompt) return;

		// Returning systemPrompt replaces the prompt for this run only; Pi keeps recording the
		// structured sections in the transcript, so section patches still work.
		return { systemPrompt: next };
	});

	pi.registerCommand("preamble", {
		description: "Show or set the text that replaces the system prompt preamble (/preamble <text>, /preamble clear)",
		handler: async (args, ctx) => {
			const target = args.trim();

			if (target === "clear") {
				rmSync(agentPath(), { force: true });
				ctx.ui.notify(`Deleted ${agentPath()}; the default preamble is back`, "info");
				return;
			}

			if (target) {
				writeFileSync(agentPath(), `${target}\n`);
				ctx.ui.notify(`Preamble set in ${agentPath()}`, "info");
				return;
			}

			const resolved = resolvePreamble(ctx.cwd, ctx.isProjectTrusted());
			ctx.ui.notify(
				resolved
					? `Preamble (${resolved.path}):\n${resolved.text}`
					: "No preamble override; Pi's default first line is used",
				"info",
			);
		},
	});
}
