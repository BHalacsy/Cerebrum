import { isAbsolute, relative, resolve, sep } from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences as stripTerminalSequencesFromTui,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export { truncateToWidth, visibleWidth, wrapTextWithAnsi };

// pi-tui handles the common ANSI/OSC/APC forms. Keep a generic CSI pass for
// valid sequences whose final byte is outside its intentionally narrow set.
const CSI_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
	// Remove CSI first so pi-tui's parser cannot mistake an unsupported CSI
	// final byte for part of a later sequence and swallow intervening text.
	return stripTerminalSequencesFromTui(text.replace(CSI_SEQUENCE, ""));
}

// ---------------------------------------------------------------------------
// Configuration: a read-only snapshot of ~/.pi/agent/open-tui.json. There is
// no settings UI and nothing is ever written back; the file is the sole source
// of values, with built-in defaults for missing or invalid fields.
// ---------------------------------------------------------------------------

export type CursorStyle = "block" | "bar" | "underline";
export type IconMode = "auto" | "nerd" | "unicode" | "ascii";
export type ThinkingPeekLines = 0 | 1 | 2;

export interface FooterSegments {
	cwd: boolean;
	hostname: boolean;
	sessionName: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCommit: boolean;
	runtime: boolean;
	context: boolean;
	tokens: boolean;
	cost: boolean;
	extensionStatuses: boolean;
	capitalizeProviderName: boolean;
}

export interface TelemetryConfig {
	enabled: boolean;
	tps: boolean;
	ttft: boolean;
	duration: boolean;
	tokens: boolean;
	stalls: boolean;
	cost: boolean;
}

export interface OpenTuiConfig {
	enabled: boolean;
	inlineFooter: boolean;
	cursorStyle: CursorStyle;
	icons: {
		mode: IconMode;
	};
	footerSegments: FooterSegments;
	telemetry: TelemetryConfig;
	thinkingPeek: {
		lines: ThinkingPeekLines;
	};
}

export const DEFAULT_CONFIG: OpenTuiConfig = {
	enabled: true,
	inlineFooter: false,
	cursorStyle: "block",
	icons: {
		mode: "ascii",
	},
	footerSegments: {
		cwd: true,
		hostname: false,
		sessionName: false,
		gitBranch: true,
		gitStatus: true,
		gitCommit: false,
		runtime: true,
		context: true,
		tokens: true,
		cost: true,
		extensionStatuses: true,
		capitalizeProviderName: true,
	},
	telemetry: {
		enabled: true,
		tps: true,
		ttft: true,
		duration: true,
		tokens: true,
		stalls: true,
		cost: true,
	},
	thinkingPeek: {
		lines: 2,
	},
};

const CURSOR_STYLES: readonly CursorStyle[] = ["block", "bar", "underline"];
const ICON_MODES: readonly IconMode[] = ["auto", "nerd", "unicode", "ascii"];

function booleanFlag(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function segmentFlags(raw: unknown): FooterSegments {
	const fallback = DEFAULT_CONFIG.footerSegments;
	const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const result = { ...fallback };
	for (const key of Object.keys(fallback) as Array<keyof FooterSegments>) {
		result[key] = booleanFlag(source[key], fallback[key]);
	}
	return result;
}

function telemetryFlags(raw: unknown): TelemetryConfig {
	const fallback = DEFAULT_CONFIG.telemetry;
	const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const result = { ...fallback };
	for (const key of Object.keys(fallback) as Array<keyof TelemetryConfig>) {
		result[key] = booleanFlag(source[key], fallback[key]);
	}
	return result;
}

export function loadFixedConfig(notify?: (msg: string, level: "warning" | "info") => void): OpenTuiConfig {
	const path = join(getAgentDir(), "open-tui.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			notify?.(`open-tui config parse error: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
		parsed = {};
	}
	const source = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
	const lines = (source.thinkingPeek as Record<string, unknown> | undefined)?.lines;
	return {
		enabled: booleanFlag(source.enabled, DEFAULT_CONFIG.enabled),
		inlineFooter: booleanFlag(source.inlineFooter, DEFAULT_CONFIG.inlineFooter),
		cursorStyle: CURSOR_STYLES.includes(source.cursorStyle as CursorStyle)
			? source.cursorStyle as CursorStyle
			: DEFAULT_CONFIG.cursorStyle,
		icons: {
			mode: ICON_MODES.includes((source.icons as Record<string, unknown> | undefined)?.mode as IconMode)
				? (source.icons as Record<string, unknown>).mode as IconMode
				: DEFAULT_CONFIG.icons.mode,
		},
		footerSegments: segmentFlags(source.footerSegments),
		telemetry: telemetryFlags(source.telemetry),
		thinkingPeek: {
			lines: lines === 0 || lines === 1 || lines === 2 ? lines : DEFAULT_CONFIG.thinkingPeek.lines,
		},
	};
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

export interface IconGlyphs {
	cwd: string;
	host: string;
	session: string;
	git: string;
	working: string;
	done: string;
	context: string;
	model: string;
	thinking: string;
	input: string;
	output: string;
	cacheHit: string;
	cost: string;
	speed: string;
	latency: string;
	stall: string;
	extensions: string;
	ahead: string;
	behind: string;
	diverged: string;
	conflicted: string;
	stashed: string;
	modified: string;
	staged: string;
	untracked: string;
	renamed: string;
	deleted: string;
}

const NERD_GLYPHS: IconGlyphs = {
	cwd: "",
	host: "",
	session: "",
	git: "",
	working: "",
	done: "",
	context: "",
	model: "",
	thinking: "",
	// client network view: input = upload to API, output = download from API
	input: "",
	output: "",
	cacheHit: "",
	cost: "",
	speed: "󰓅",
	latency: "",
	stall: "",
	extensions: "",
	ahead: "↑",
	behind: "↓",
	diverged: "⇕",
	conflicted: "=",
	stashed: "$",
	modified: "!",
	staged: "+",
	untracked: "?",
	renamed: "»",
	deleted: "✘",
};

// ASCII fallback uses compact symbols (not English words) to keep the footer's
// icon-like feel on non-Nerd-Font terminals. Symbols chosen to avoid collisions
// with the git-status set {= S ! A ? r x ^ v}.
const ASCII_GLYPHS: IconGlyphs = {
	cwd: "*",
	host: "h",
	session: "s",
	git: "*",
	working: "o",
	done: "-",
	context: "#",
	model: "M",
	thinking: "~",
	input: "↑",
	output: "↓",
	cacheHit: "c",
	cost: "$",
	speed: ">",
	latency: "~",
	stall: "!",
	extensions: "C",
	ahead: "^",
	behind: "v",
	diverged: "^v",
	conflicted: "=",
	stashed: "S",
	modified: "!",
	staged: "A",
	untracked: "?",
	renamed: "r",
	deleted: "x",
};

// Portable Unicode icon set for terminals without a Nerd Font. Keeps the
// footer icon-like instead of dropping to letters: emoji glyphs (folder,
// branch, laptop, bulb, floppy, plug, hourglass, bolt) render through the
// client terminal's emoji fallback at 2 columns, which matches
// pi-tui's visibleWidth for RGI emoji; the remaining symbols are
// single-width and covered by DejaVu Sans Mono, JetBrains Mono, Noto Sans
// Mono and Liberation Mono. Glyph choices are easy to adjust per slot.
const UNICODE_GLYPHS: IconGlyphs = {
	cwd: "📁",
	host: "⌂",
	session: "🔖",
	git: "🌿",
	working: "◷",
	done: "✓",
	context: "≡",
	model: "💻",
	thinking: "💡",
	input: "↑",
	output: "↓",
	cacheHit: "💾",
	cost: "$",
	speed: "⚡",
	latency: "⌛",
	stall: "⚠",
	extensions: "🔌",
	ahead: "↑",
	behind: "↓",
	diverged: "↕",
	conflicted: "=",
	stashed: "$",
	modified: "!",
	staged: "+",
	untracked: "?",
	renamed: "→",
	deleted: "✗",
};

function isSshSession(): boolean {
	return Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION);
}

function detectNerdFont(): boolean {
	// TTY and locale checks are the only reliable signals available here. The
	// terminal emulator owns font selection, so auto mode is optimistic once
	// output is an interactive UTF-8 TTY.
	if (process.env.TERM === "dumb" || process.stdout.isTTY !== true) return false;
	const locale = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG].find(Boolean);
	return locale === undefined || /utf-?8/i.test(locale);
}

export function resolveIconMode(mode: IconMode): "nerd" | "unicode" | "ascii" {
	if (mode === "nerd") return "nerd";
	if (mode === "ascii") return "ascii";
	if (mode === "unicode") return "unicode";
	if (!detectNerdFont()) return "ascii";
	// Auto cannot know whether the terminal that renders this session ships a
	// Nerd Font (see #38). Local terminals usually do; SSH clients usually do
	// not, because the font lives on the client device, so portable Unicode
	// symbols are the safer default there. Terminals that do have a Nerd Font
	// can opt back in with an explicit icons.mode of "nerd".
	if (isSshSession()) return "unicode";
	return "nerd";
}

export function resolveGlyphs(mode: IconMode): IconGlyphs {
	const resolved = resolveIconMode(mode);
	if (resolved === "unicode") return UNICODE_GLYPHS;
	return resolved === "nerd" ? NERD_GLYPHS : ASCII_GLYPHS;
}

const RUNTIME_SYMBOLS: Record<string, string> = {
	nodejs: "\uE718",
	rust: "\uE7A8",
	go: "\uE626",
	python: "\uE73C",
	ruby: "\uE739",
	java: "\uE256",
	cpp: "\uE61D",
	c: "\uE61E",
	swift: "\uE755",
	kotlin: "\uE634",
	deno: "\uE7FB",
	bun: "\uE76F",
	php: "\uE73D",
	haskell: "\uE777",
	julia: "\uE624",
	lua: "\uE620",
	elixir: "\uE62B",
	erlang: "\uE7B1",
	gleam: "\uE6B4",
	crystal: "\uE62F",
	dart: "\uE7C0",
	nim: "\uE677",
	zig: "\uE6A9",
	ocaml: "\uE67A",
	clojure: "\uE76A",
	scala: "\uE747",
	perl: "\uE769",
	r: "\uE68A",
	elm: "\uE62C",
	haxe: "\uE7B7",
	vagrant: "\uE21A",
	terraform: "\uE1A5",
};

const RUNTIME_ASCII_SYMBOLS: Record<string, string> = {
	nodejs: "node",
	rust: "rs",
	go: "go",
	python: "py",
	ruby: "rb",
	java: "java",
	swift: "swift",
	kotlin: "kt",
	cpp: "c++",
	c: "c",
	deno: "deno",
	bun: "bun",
	php: "php",
	haskell: "hs",
	julia: "jl",
	lua: "lua",
	elixir: "ex",
	erlang: "erl",
	gleam: "gleam",
	crystal: "cr",
	dart: "dart",
	nim: "nim",
	zig: "zig",
	ocaml: "ml",
	clojure: "clj",
	scala: "scala",
	perl: "pl",
	r: "R",
	elm: "elm",
	haxe: "hx",
	vagrant: "vag",
	terraform: "tf",
};

export function runtimeSymbol(name: string, mode: IconMode): string {
	if (resolveIconMode(mode) !== "nerd") return RUNTIME_ASCII_SYMBOLS[name] ?? name;
	return RUNTIME_SYMBOLS[name] ?? "";
}

// ---------------------------------------------------------------------------
// Text formatting helpers
// ---------------------------------------------------------------------------

export function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const insideHome =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

export function basenamePath(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** Truncate branch names from the end so prefixes like `fix/` stay visible. */
export function truncateBranch(branch: string, maxLen: number): string {
	if (branch.length <= maxLen) return branch;
	if (maxLen <= 3) return "...".slice(0, maxLen);
	return `${branch.slice(0, maxLen - 3)}...`;
}

export function truncatePath(path: string, maxLen: number): string {
	// `maxLen` is a terminal-column budget, so every comparison here must use
	// display width. Comparing String.length let wide (CJK) paths stay wider than
	// the budget: for a basename of 4 characters but 8 columns, `truncatePath`
	// returned it unchanged, so fitSegmentsByPriority's `while (totalW() > maxW)`
	// loop never made progress and livelocked the renderer at 100% CPU.
	if (visibleWidth(path) <= maxLen) return path;
	if (maxLen <= 3) return "...".slice(0, maxLen);
	const sepChar = path.includes("/") ? "/" : "\\";
	const parts = path.split(/[\\/]/);
	if (parts.length <= 2) return truncateToWidth(path, maxLen, "...");
	// Keep first segment (e.g. ~) and as many trailing segments as fit.
	const tail: string[] = [];
	let tailLen = 0;
	for (let i = parts.length - 1; i >= 1; i--) {
		const seg = parts[i]!;
		if (tailLen + visibleWidth(seg) + 4 > maxLen) break;
		tail.unshift(seg);
		tailLen += visibleWidth(seg) + 1;
	}
	const head = parts[0]!;
	const result = `${head}${sepChar}...${sepChar}${tail.join(sepChar)}`;
	return visibleWidth(result) > maxLen ? truncateToWidth(result, maxLen, "...") : result;
}

export function finiteOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function fmtTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

export function formatInputBreakdown(uncached: number, cacheRead: number): string {
	const total = fmtTokens(uncached + cacheRead);
	return cacheRead > 0
		? `${total} (U ${fmtTokens(uncached)} + R ${fmtTokens(cacheRead)})`
		: total;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const s = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${s}s`;
	const m = totalMinutes % 60;
	const h = Math.floor(totalMinutes / 60);
	return `${h}h ${m}m ${s}s`;
}

export function formatModelLabel(model: { provider?: string; id?: string } | null | undefined): string {
	if (!model?.id) return "no-model";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

export function formatProviderLabel(provider: string | undefined, capitalize: boolean): string {
	if (!provider) return "Unknown";
	return capitalize ? provider.charAt(0).toUpperCase() + provider.slice(1) : provider;
}

export function alignRight(left: string, right: string, width: number, theme: Theme): string {
	const rightW = visibleWidth(right);
	if (rightW > width) {
		right = truncateToWidth(right, width, theme.fg("dim", "..."));
	}
	const leftW = visibleWidth(left);
	const rightW2 = visibleWidth(right);
	const pad = width - leftW - rightW2;
	if (pad >= 1) {
		return left + " ".repeat(pad) + right;
	}
	const availableForLeft = Math.max(0, width - rightW2 - 1);
	const truncatedLeft =
		availableForLeft > 0 ? truncateToWidth(left, availableForLeft, theme.fg("dim", "...")) : "";
	return truncatedLeft ? truncatedLeft + " " + right : right;
}

export type PrioritizedSegment = {
	text: string;
	priority: number;
	/** Compact form swapped in before any segment is truncated or dropped. */
	compactText?: string;
	/** Segment-aware truncation replacing the generic truncateToWidth. */
	truncate?: (text: string, maxWidth: number, ellipsis: string) => string;
};

/**
 * Pack segments into maxWidth: compact segments first, then shrink/drop the
 * lowest-priority segments (higher priority = survives longer). Returns the
 * surviving segment texts in original order, space-joined.
 */
export function fitSegmentsByPriority(
	segs: readonly PrioritizedSegment[],
	maxW: number,
	ellipsis = "...",
): string[] {
	const items = segs.map((s) => ({
		text: s.text,
		compactText: s.compactText,
		priority: s.priority,
		truncate: s.truncate,
		w: visibleWidth(s.text),
	}));
	const totalW = () => {
		const active = items.filter((it) => it.text !== "");
		return active.reduce((a, it) => a + it.w, 0) + Math.max(0, active.length - 1);
	};
	// Compact (e.g. cwd -> basename) before sacrificing any segment content.
	if (totalW() > maxW) {
		for (const item of items) {
			if (!item.compactText || visibleWidth(item.compactText) >= item.w) continue;
			item.text = item.compactText;
			item.w = visibleWidth(item.text);
			if (totalW() <= maxW) break;
		}
	}
	// A segment whose `truncate` cannot actually shrink would otherwise spin here
	// forever and block the render timer. Require each pass to make progress, and
	// drop the worst segment when it does not, so layout always terminates.
	let lastTotal = Infinity;
	while (totalW() > maxW) {
		const nowTotal = totalW();
		if (nowTotal >= lastTotal) {
			let worst = -1;
			for (let i = 0; i < items.length; i++) {
				if (items[i].text !== "" && (worst === -1 || items[i].priority < items[worst].priority)) {
					worst = i;
				}
			}
			if (worst === -1) break;
			items[worst].text = "";
			items[worst].w = 0;
			continue;
		}
		lastTotal = nowTotal;
		let target = -1;
		for (let i = 0; i < items.length; i++) {
			if (items[i].text !== "" && (target === -1 || items[i].priority < items[target].priority)) {
				target = i;
			}
		}
		if (target === -1) break;
		const others = items.filter((_, i) => i !== target && items[i].text !== "");
		const otherW = others.reduce((a, it) => a + it.w, 0) + Math.max(0, others.length - 1);
		const avail = maxW - otherW - (others.length > 0 ? 1 : 0);
		if (avail <= visibleWidth(ellipsis)) {
			items[target].text = "";
			items[target].w = 0;
		} else if (avail < items[target].w) {
			const truncate = items[target].truncate;
			items[target].text = truncate
				? truncate(items[target].text, avail, ellipsis)
				: truncateToWidth(items[target].text, avail, ellipsis);
			items[target].w = visibleWidth(items[target].text);
		} else {
			break;
		}
	}
	return items.filter((it) => it.text !== "").map((it) => it.text);
}

export function stressColor(value: number, warn = 70, danger = 90): ThemeColor {
	if (value >= danger) return "error";
	if (value >= warn) return "warning";
	return "accent";
}

export function cacheHitColor(value: number): ThemeColor {
	if (value < 30) return "error";
	if (value < 70) return "warning";
	return "success";
}

export function providerColor(provider: string): ThemeColor {
	switch (provider.toLowerCase()) {
		case "anthropic":
			return "accent";
		case "openai":
		case "openai-codex":
			return "success";
		case "google":
		case "google-vertex":
			return "warning";
		case "amazon-bedrock":
			return "thinkingHigh";
		case "github-copilot":
			return "mdLink";
		case "deepseek":
			return "thinkingLow";
		case "xai":
		case "groq":
			return "error";
		default:
			return "muted";
	}
}

export function effortColor(level: ThinkingLevel | string | undefined): ThemeColor {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		default:
			return "thinkingMedium";
	}
}

export function isEditorBorderLine(line: string): boolean {
	if (typeof line !== "string") return false;
	const plain = stripAnsi(line);
	if (/^─+$/.test(plain)) return true;
	if (/^─*\s*[↑↓]\s+\d+\s+more\s*─*$/.test(plain)) return true;
	return false;
}

export function findBottomBorderIndex(lines: string[]): number {
	for (let i = lines.length - 1; i >= 1; i--) {
		const line = lines[i];
		if (line !== undefined && isEditorBorderLine(line)) return i;
	}
	return Math.max(0, lines.length - 1);
}

export function padRight(text: string, width: number, ellipsis = ""): string {
	const clipped = truncateToWidth(text, width, ellipsis);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function center(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "...");
	return `${" ".repeat(Math.floor((width - w) / 2))}${text}`;
}

export function sanitizeStatus(text: string): string {
	return stripAnsi(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

// One status token is an SGR sequence, another escape sequence, or one control
// character. SGR carries colours. Everything else moves the cursor or rewrites
// the terminal, so it must never reach the footer row.
const STATUS_TOKEN = /(?:\x1b\[|\x9b)[0-?]*[ -/]*m|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1bP|\x90|\x1bX|\x98|\x1b\^|\x9e|\x1b_|\x9f)[\s\S]*?(?:\x1b\\|\x9c|$)|(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|\x1b[@-Z\\_]|[\u0000-\u001f\u007f-\u009f]/g;
const SGR_TOKEN = /^(?:\x1b\[|\x9b)[0-9;:]*m$/;
const SGR_SEQUENCE = /(?:\x1b\[|\x9b)[0-9;:]*m/;

/**
 * Sanitize a status text the same way {@link sanitizeStatus} does, but keep the
 * SGR sequences the extension set. Extensions colour their own status text with
 * `ctx.ui.theme.fg()`. Stripping those codes renders every status grey.
 */
export function sanitizeStatusPreservingStyles(text: string): string {
	const cleaned = text.replace(STATUS_TOKEN, (token) => (SGR_TOKEN.test(token) ? token : " "));
	return cleaned.replace(/ {2,}/g, " ").trim();
}

/** True when the text carries SGR colour or style sequences. */
export function hasAnsiStyles(text: string): boolean {
	return SGR_SEQUENCE.test(text);
}

export function formatThinkingLabel(level: string): string {
	if (level === "off") return "thinking off";
	return `${level} effort`;
}

export const PI_BUILTIN_SLASH_COMMAND_NAMES = [
	"settings",
	"model",
	"scoped-models",
	"export",
	"import",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"tree",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
] as const;

export function collectPiCommandNames(sessionCommands: readonly { name: string }[]): string[] {
	const names = new Set<string>(PI_BUILTIN_SLASH_COMMAND_NAMES);
	for (const command of sessionCommands) {
		if (command.name) names.add(command.name);
	}
	return [...names];
}

export function pickSlashCommandTips(
	availableNames: readonly string[],
	options: {
		count?: number;
		exclude?: readonly string[];
		random?: () => number;
	} = {},
): string[] {
	const count = options.count ?? 3;
	const exclude = new Set(options.exclude ?? []);
	const random = options.random ?? Math.random;

	const pool = [...new Set(availableNames.map((n) => n.trim()).filter(Boolean))].filter(
		(name) => !exclude.has(name),
	);

	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const tmp = pool[i]!;
		pool[i] = pool[j]!;
		pool[j] = tmp;
	}

	return pool.slice(0, Math.max(0, count)).map((name) => (name.startsWith("/") ? name : `/${name}`));
}

export const MIN_LEFT_WIDTH = 28;
export const MIN_TIPS_WIDTH = 16;
export const MAX_TIPS_WIDTH = 28;
const COLUMN_GAP = 3;

export function headerColumnWidths(
	innerWidth: number,
	minTipsWidth = MIN_TIPS_WIDTH,
	maxTipsWidth = MAX_TIPS_WIDTH,
	minLeftWidth = MIN_LEFT_WIDTH,
): { leftWidth: number; rightWidth: number; useTips: boolean } {
	if (innerWidth <= 0) {
		return { leftWidth: 0, rightWidth: 0, useTips: false };
	}

	const gap = COLUMN_GAP;
	if (innerWidth < minLeftWidth + gap + minTipsWidth) {
		return { leftWidth: innerWidth, rightWidth: 0, useTips: false };
	}

	let rightWidth = Math.min(maxTipsWidth, Math.max(minTipsWidth, Math.round(innerWidth * 0.28)));
	let leftWidth = innerWidth - gap - rightWidth;

	if (leftWidth < minLeftWidth) {
		leftWidth = minLeftWidth;
		rightWidth = innerWidth - gap - leftWidth;
	}

	if (leftWidth <= rightWidth) {
		leftWidth = Math.ceil((innerWidth - gap) * 0.65);
		rightWidth = innerWidth - gap - leftWidth;
	}

	if (rightWidth < minTipsWidth || leftWidth < minLeftWidth) {
		return { leftWidth: innerWidth, rightWidth: 0, useTips: false };
	}

	return { leftWidth, rightWidth, useTips: true };
}

// ---------------------------------------------------------------------------
// Git / runtime status types
// ---------------------------------------------------------------------------

export interface GitCommitInfo {
	oid: string | null;
	detached: boolean;
	tag: string | null;
}

export interface GitStatus {
	branch: string | undefined;
	ahead: number;
	behind: number;
	modified: number;
	untracked: number;
	staged: number;
	stashed: number;
	conflicted: number;
	renamed: number;
	deleted: number;
	commit: GitCommitInfo | null;
}

export function emptyGitStatus(): GitStatus {
	return {
		branch: undefined,
		ahead: 0,
		behind: 0,
		modified: 0,
		untracked: 0,
		staged: 0,
		stashed: 0,
		conflicted: 0,
		renamed: 0,
		deleted: 0,
		commit: null,
	};
}

export interface RuntimeInfo {
	name: string;
	version?: string;
}

// ---------------------------------------------------------------------------
// Footer state & session usage totals
// ---------------------------------------------------------------------------

export interface FooterState {
	git: GitStatus;
	runtime: RuntimeInfo | null;
	sessionStartEpoch: number;
	workingSince: number | undefined;
	lastDoneIn: number | undefined;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

let usageCache: { key: string; totals: UsageTotals } | undefined;

function entriesKey(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	const last = entries.at(-1);
	return `${entries.length}:${last?.id ?? ""}:${last?.timestamp ?? ""}`;
}

export function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const key = entriesKey(ctx);
	if (usageCache && usageCache.key === key) return usageCache.totals;

	const totals: UsageTotals = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
		latestCacheHitRate: undefined,
	};
	for (const entry of ctx.sessionManager.getEntries()) {
		let u: Usage | undefined;
		let updateCacheHitRate = false;
		if (entry.type === "message" && entry.message.role === "assistant") {
			u = entry.message.usage;
			updateCacheHitRate = true;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			u = entry.message.usage;
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			u = entry.usage;
		}
		if (!u) continue;
		const input = finiteOrZero(u.input);
		const cacheRead = finiteOrZero(u.cacheRead);
		const cacheWrite = finiteOrZero(u.cacheWrite);
		// input matches /session's "uncached" total: cacheWrite is billed near full
		// price (fresh content), only cacheRead is discounted repeat content.
		totals.input += input + cacheWrite;
		totals.output += finiteOrZero(u.output);
		totals.cacheRead += cacheRead;
		totals.cacheWrite += cacheWrite;
		totals.cost += finiteOrZero(u.cost?.total);
		if (updateCacheHitRate) {
			const promptTokens = input + cacheRead + cacheWrite;
			totals.latestCacheHitRate = promptTokens > 0
				? (cacheRead / promptTokens) * 100
				: undefined;
		}
	}
	usageCache = { key, totals };
	return totals;
}

export function invalidateUsageCache(): void {
	usageCache = undefined;
}

export function createInitialState(): FooterState {
	return {
		git: emptyGitStatus(),
		runtime: null,
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
	};
}

export interface ModelMeta {
	provider: string;
	model: string;
	effort: string | undefined;
}

export function getModelMeta(
	ctx: ExtensionContext,
	getThinkingLevel: () => string,
	capitalizeProviderName: boolean,
): ModelMeta {
	const provider = formatProviderLabel(ctx.model?.provider, capitalizeProviderName);
	const model = ctx.model?.name ?? ctx.model?.id ?? "no-model";
	const reasoning = ctx.model?.reasoning ?? false;
	const effort = reasoning ? getThinkingLevel() : undefined;
	return { provider, model, effort };
}
