import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TuiMouseEvent, TuiMouseEventResult, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CursorStyle, IconGlyphs } from "./shared.ts";
import { findBottomBorderIndex, isEditorBorderLine, sanitizeStatus, stripAnsi } from "./shared.ts";

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

patchCustomEditorForTabCompletion();

function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, Math.max(0, width), "");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${pad}`;
}

const CURSOR_STYLE_SEQUENCES: Partial<Record<CursorStyle, string>> = {
	bar: "\x1b[6 q",
	underline: "\x1b[4 q",
};
const DEFAULT_CURSOR_STYLE_SEQUENCE = "\x1b[0 q";
const EDITOR_FRAME_LEFT_INSET = 2;
const EDITOR_FRAME_HORIZONTAL_CHROME = EDITOR_FRAME_LEFT_INSET * 2;

interface WorkingStatusIndicator {
	renderInBorder(width: number): string;
	renderSpinnerInBorder(width: number): string;
}

export interface InlineFooterLine {
	left: string;
	right: string;
}

export interface InlineFooterRenderer {
	enabled(): boolean;
	render(width: number): { top: InlineFooterLine; bottom: InlineFooterLine } | undefined;
}

interface HiddenThinkingLabelComponent {
	children: unknown[];
	setHiddenThinkingLabel(label: string): void;
	setHideThinkingBlock(hide: boolean): void;
	updateContent(message: unknown, isStreaming?: boolean): void;
}

function isHiddenThinkingLabelComponent(value: object): value is HiddenThinkingLabelComponent {
	const component = value as unknown as Record<string, unknown>;
	return Array.isArray(component.children)
		&& typeof component.setHiddenThinkingLabel === "function"
		&& typeof component.setHideThinkingBlock === "function"
		&& typeof component.updateContent === "function";
}

/** Ponytail until Pi exposes a per-message hidden-thinking label API. */
function findLatestHiddenThinkingLabel(tui: TUI): HiddenThinkingLabelComponent {
	const pending: unknown[] = [tui];
	const visited = new Set<object>();
	let latest: HiddenThinkingLabelComponent | undefined;
	while (pending.length > 0) {
		const value: unknown = pending.pop();
		if (!value || typeof value !== "object" || visited.has(value)) continue;
		visited.add(value);
		if (isHiddenThinkingLabelComponent(value)) latest = value;
		const children = (value as { children?: unknown }).children;
		if (!Array.isArray(children)) continue;
		for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
	}
	if (!latest) throw new Error("Unable to find the active hidden-thinking component");
	return latest;
}

function removeSoftwareCursor(line: string, cursorMarker = ""): string {
	return line.replace(/\x1b\[7m([\s\S]*?)\x1b\[0m/g, (_match, cursor: string) => {
		const replacement = `${cursorMarker}${cursor}`;
		cursorMarker = "";
		return replacement;
	});
}

function configureCursor(tui: TUI, cursorStyle: CursorStyle): void {
	if (cursorStyle === "block") return;
	tui.setShowHardwareCursor(true);
	const sequence = CURSOR_STYLE_SEQUENCES[cursorStyle];
	if (sequence) tui.terminal.write(sequence);
}

function roundedBorder(
	width: number,
	kind: "top" | "bottom",
	paint: (s: string) => string,
	sourceLine?: string,
	indicator?: WorkingStatusIndicator,
): string {
	if (width < 2) return paint(truncateToWidth(kind === "top" ? "╭╮" : "╰╯", width, ""));
	const corners = kind === "top" ? (["╭", "╮"] as const) : (["╰", "╯"] as const);

	if (kind === "top" && indicator) {
		const plain = sourceLine ? stripAnsi(sourceLine) : "";
		const scrollMatch = plain.match(/([↑↓]\s+\d+\s+more)/);
		const contentWidth = width - 2;
		let status = indicator.renderInBorder(Math.max(1, contentWidth - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth > 0) {
			const overflowLabel = scrollMatch ? ` ${scrollMatch[1]} ` : undefined;
			const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
			const overflowStart = Math.floor((contentWidth - overflowLabelWidth) / 2);
			const canFitOverflow = () => overflowLabel !== undefined
				&& overflowLabelWidth + 2 <= contentWidth
				&& overflowStart - (3 + statusWidth + 1) >= 1;
			if (overflowLabel && !canFitOverflow()) {
				status = indicator.renderSpinnerInBorder(contentWidth);
				statusWidth = visibleWidth(status);
			}
			if (canFitOverflow()) {
				const leftBlockWidth = 3 + statusWidth + 1;
				return `${paint(`${corners[0]}── `)}${status}${paint(` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(contentWidth - overflowStart - overflowLabelWidth)}${corners[1]}`)}`;
			}
			if (contentWidth >= statusWidth + 5) {
				return `${paint(`${corners[0]}── `)}${status}${paint(` ${"─".repeat(contentWidth - statusWidth - 4)}${corners[1]}`)}`;
			}
			status = indicator.renderSpinnerInBorder(contentWidth);
			statusWidth = visibleWidth(status);
			const prefixWidth = Math.min(3, Math.max(0, contentWidth - statusWidth));
			return `${paint(`${corners[0]}${"─".repeat(prefixWidth)}`)}${status}${paint(`${"─".repeat(Math.max(0, contentWidth - prefixWidth - statusWidth))}${corners[1]}`)}`;
		}
	}

	if (sourceLine) {
		const plain = stripAnsi(sourceLine);
		const scrollMatch = plain.match(/([↑↓]\s+\d+\s+more)/);
		if (scrollMatch) {
			const label = `─── ${scrollMatch[1]} `;
			const fill = Math.max(0, width - 2 - visibleWidth(label));
			return paint(`${corners[0]}${label}${"─".repeat(fill)}${corners[1]}`);
		}
	}

	return paint(`${corners[0]}${"─".repeat(Math.max(0, width - 2))}${corners[1]}`);
}

function trimTrailingSpaces(text: string): string {
	const ansiSuffix = text.match(/(?:\x1b\[[0-?]*[ -/]*[@-~])+$/)?.[0] ?? "";
	const content = ansiSuffix ? text.slice(0, -ansiSuffix.length) : text;
	return `${content.replace(/ +$/, "")}${ansiSuffix}`;
}

function inlineBorder(
	width: number,
	kind: "top" | "bottom",
	paint: (s: string) => string,
	renderLine: (width: number) => InlineFooterLine | undefined,
	sourceLine?: string,
	indicator?: WorkingStatusIndicator,
): string {
	if (width < 2) return paint(truncateToWidth(kind === "top" ? "╭╮" : "╰╯", width, ""));

	const corners = kind === "top" ? (["╭", "╮"] as const) : (["╰", "╯"] as const);
	const contentWidth = width - 2;
	const plain = sourceLine ? stripAnsi(sourceLine) : "";
	const scrollMatch = plain.match(/([↑↓]\s+\d+\s+more)/);
	const right = scrollMatch ? paint(` ${scrollMatch[1]} `) : "";
	let left = paint("─");

	if (kind === "top" && indicator) {
		const statusBudget = Math.max(1, contentWidth - visibleWidth(right) - 7);
		let status = indicator.renderInBorder(statusBudget);
		if (visibleWidth(status) > statusBudget) status = indicator.renderSpinnerInBorder(statusBudget);
		const leftBudget = Math.max(0, contentWidth - visibleWidth(right) - 1);
		status = truncateToWidth(status, Math.max(0, leftBudget - 4), "");
		if (visibleWidth(status) > 0) left = `${paint("── ")}${status}${paint(" ")}`;
	}

	const lineBudget = Math.max(0, contentWidth - visibleWidth(left) - visibleWidth(right) - 6);
	const line = renderLine(lineBudget);
	if (!line) return roundedBorder(width, kind, paint, sourceLine, indicator);
	const leftContent = trimTrailingSpaces(line.left);
	const rightContent = trimTrailingSpaces(line.right);
	if (visibleWidth(leftContent) === 0 && visibleWidth(rightContent) === 0) {
		return roundedBorder(width, kind, paint, sourceLine, indicator);
	}

	const leftCell = leftContent ? ` ${leftContent} ` : "";
	const rightCell = rightContent ? ` ${rightContent} ` : "";
	const fill = Math.max(1, contentWidth - visibleWidth(left) - visibleWidth(leftCell) - visibleWidth(rightCell) - visibleWidth(right) - 1);
	return `${paint(corners[0])}${left}${leftCell}${paint("─".repeat(fill))}${rightCell}${right}${paint("─")}${paint(corners[1])}`;
}

export class OpenTuiEditor extends CustomEditor {
	readonly embedWorkingStatus = true;
	private readonly getRail: () => string;
	private readonly getBorder: (s: string) => string;
	private embeddedWorkingStatusIndicator: WorkingStatusIndicator | undefined;
	private readonly inlineFooter: InlineFooterRenderer | undefined;
	private cursorStyle: CursorStyle;
	private previewHardwareCursor = false;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		cursorStyle: CursorStyle = "block",
		inlineFooter?: InlineFooterRenderer,
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
		this.cursorStyle = cursorStyle;
		this.inlineFooter = inlineFooter;
		configureCursor(tui, cursorStyle);
		// ponytail: route the frame through this.borderColor so Pi can recolor it
		// via updateEditorBorderColor() — bash mode ("! " prefix → green) and
		// thinking-level borders both flow through this one property.
		this.getRail = () => this.borderColor("│");
		this.getBorder = (s: string) => this.borderColor(s);
	}

	override setPaddingX(_padding: number): void {
		// The custom rail owns the horizontal inset and keeps one stable text gap.
		super.setPaddingX(0);
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.width < EDITOR_FRAME_HORIZONTAL_CHROME) return super.handleMouse(event);

		return super.handleMouse({
			...event,
			x: event.x - EDITOR_FRAME_LEFT_INSET,
			width: event.width - EDITOR_FRAME_HORIZONTAL_CHROME,
		});
	}

	override handleInput(data: string): void {
		if (matchesKey(data, Key.tab)) {
			const isShowingAutocomplete = typeof this.isShowingAutocomplete === "function" && this.isShowingAutocomplete();
			const isEmpty = this.getText().trim().length === 0;
			const handler = (globalThis as any)[TAB_HANDLER_KEY];

			if (isEmpty && !isShowingAutocomplete && typeof handler === "function") {
				Promise.resolve(handler()).catch(() => {});
				return;
			}
		}

		super.handleInput(data);
	}

	setWorkingStatusIndicator(indicator: WorkingStatusIndicator | undefined): void {
		this.embeddedWorkingStatusIndicator = indicator;
		this.tui.requestRender();
	}

	private renderBase(width: number): string[] {
		const renderedLines = super.render(width);
		if (this.cursorStyle === "block") return renderedLines;

		// Pi re-applies settings.showHardwareCursor after session_start (/reload,
		// /new, session switches). Non-block styles have no software cursor left to
		// fall back on, so re-assert the hardware cursor instead of losing it.
		if (!this.tui.getShowHardwareCursor()) configureCursor(this.tui, this.cursorStyle);

		// A focused overlay suppresses the editor's cursor marker. Preserve its
		// position only for the live settings preview, then clear it on refocus.
		let cursorMarker = this.previewHardwareCursor && !this.focused ? CURSOR_MARKER : "";
		if (this.focused) this.previewHardwareCursor = false;
		return renderedLines.map((line) => {
			const rendered = removeSoftwareCursor(line, cursorMarker);
			if (rendered !== line) cursorMarker = "";
			return rendered;
		});
	}

	render(width: number): string[] {
		if (width < EDITOR_FRAME_HORIZONTAL_CHROME) return this.renderBase(width);

		const rail = this.getRail();
		const borderPaint = this.getBorder;
		// ponytail: 1-char rail + 1-char gap on each side = 4 chars of chrome.
		const innerWidth = Math.max(0, width - EDITOR_FRAME_HORIZONTAL_CHROME);
		const baseLines = this.renderBase(innerWidth);
		const bottomIdx = findBottomBorderIndex(baseLines);

		const result: string[] = [];
		const inlineFooter = this.inlineFooter?.enabled() === true;
		const renderInlineLine = (kind: "top" | "bottom", budget: number): InlineFooterLine | undefined =>
			this.inlineFooter?.render(budget)?.[kind];
		result.push(inlineFooter
			? inlineBorder(width, "top", borderPaint, (budget) => renderInlineLine("top", budget), baseLines[0], this.embeddedWorkingStatusIndicator)
			: roundedBorder(width, "top", borderPaint, baseLines[0], this.embeddedWorkingStatusIndicator));

		for (let i = 1; i < bottomIdx; i++) {
			const line = baseLines[i] ?? "";
			if (isEditorBorderLine(line)) {
				result.push(`${rail} ${fillLine("", innerWidth)} ${rail}`);
			} else {
				result.push(`${rail} ${fillLine(line, innerWidth)} ${rail}`);
			}
		}

		result.push(inlineFooter
			? inlineBorder(width, "bottom", borderPaint, (budget) => renderInlineLine("bottom", budget), baseLines[bottomIdx])
			: roundedBorder(width, "bottom", borderPaint, baseLines[bottomIdx]));

		for (let i = bottomIdx + 1; i < baseLines.length; i++) {
			result.push(baseLines[i]!);
		}

		return result.map((line) => truncateToWidth(line, width, ""));
	}
}

export function installEditor(
	ctx: ExtensionContext,
	cursorStyle: CursorStyle = "block",
	inlineFooter?: InlineFooterRenderer,
) {
	let activeTui: TUI | undefined;
	let activeEditor: OpenTuiEditor | undefined;
	let previousHardwareCursor: boolean | undefined;
	let hiddenThinkingTarget: HiddenThinkingLabelComponent | undefined;
	const getActiveTui = (): TUI => {
		if (!activeTui) throw new Error("Open TUI editor is not mounted");
		return activeTui;
	};

	ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
		activeTui = tui;
		hiddenThinkingTarget = undefined;
		previousHardwareCursor = tui.getShowHardwareCursor();
		activeEditor = new OpenTuiEditor(tui, editorTheme, keybindings, cursorStyle, inlineFooter);
		return activeEditor;
	});
	return {
		getViewportWidth(): number {
			const columns = getActiveTui().terminal.columns;
			if (typeof columns !== "number" || !Number.isFinite(columns)) {
				throw new Error("Open TUI editor terminal has an invalid width");
			}
			return Math.max(1, Math.floor(columns));
		},
		setLatestHiddenThinkingLabel(label: string): void {
			const tui = getActiveTui();
			hiddenThinkingTarget ??= findLatestHiddenThinkingLabel(tui);
			hiddenThinkingTarget.setHiddenThinkingLabel(label);
			tui.requestRender();
		},
		resetHiddenThinkingLabelTarget(): void {
			hiddenThinkingTarget = undefined;
		},
		cleanup(): void {
			hiddenThinkingTarget = undefined;
			ctx.ui.setEditorComponent(undefined);
			if (activeTui) {
				if (cursorStyle !== "block") activeTui.terminal.write(DEFAULT_CURSOR_STYLE_SEQUENCE);
				if (previousHardwareCursor !== undefined) activeTui.setShowHardwareCursor(previousHardwareCursor);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Thinking peek: spinner + tail of the running thinking text, rendered by
// Pi inside its native hidden-thinking block.
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_PEEK_LINES = 2;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type PeekPhase = "idle" | "thinking" | "done";

export interface PeekState {
	phase: PeekPhase;
	tail: string;
}

export interface PeekMessageParts {
	thinking: string;
	text: string;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

const normalizePeekLineCount = (lineCount: number): number => Math.max(1, Math.min(MAX_PEEK_LINES, Math.floor(lineCount)));

/**
 * Pure phase machine for one assistant-message update.
 *
 * Thinking text is cumulative: once the answer starts, later updates still
 * carry the full thinking block alongside new text. To keep the spinner honest:
 * - idle + thinking        -> thinking (spinner starts)
 * - idle + thinking + text -> done    (already answered, never spin)
 * - thinking + text        -> done    (answer started: stop spinner)
 * - done + thinking        -> done    (never restart the spinner)
 * - any + text only        -> idle stays idle (plain answer, nothing to peek)
 */
export function reducePeek(prev: PeekState, parts: PeekMessageParts): PeekState {
	const tail = parts.thinking ? peekTail(parts.thinking, MAX_PEEK_LINES) : prev.tail;
	let phase = prev.phase;
	if (parts.thinking && phase === "idle") phase = "thinking";
	if (parts.text && phase === "thinking") phase = "done";
	return { phase, tail };
}

/** Fresh peek state (no task running yet). */
export function createPeekState(): PeekState {
	return { phase: "idle", tail: "" };
}

/**
 * Collect the running thinking text and answer text from an assistant
 * message's content parts. Thinking arrives token-by-token, so re-calling
 * this on every `message_update` yields the cumulative text.
 */
export function collectPeekParts(content: unknown): PeekMessageParts {
	let thinking = "";
	let text = "";
	if (!Array.isArray(content)) return { thinking, text };
	for (const rawPart of content) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as { type?: unknown; thinking?: unknown; text?: unknown };
		if (part.type === "thinking") {
			thinking += stringValue(part.thinking) ?? stringValue(part.text) ?? "";
		} else if (part.type === "text") {
			text += stringValue(part.text) ?? "";
		}
	}
	return { thinking, text };
}

/**
 * Extract the last non-empty logical lines of the thinking text, whitespace-
 * normalized. NOT width-bounded: clipping to the terminal happens at render
 * time in buildPeekLabel/clipTail, so wide terminals get to see more of it.
 */
export function peekTail(fullThinking: string, lineCount = 1): string {
	if (!fullThinking) return "";
	const count = normalizePeekLineCount(lineCount);
	const lines: string[] = [];
	let end = fullThinking.length;
	while (end > 0 && lines.length < count) {
		const start = fullThinking.lastIndexOf("\n", end - 1) + 1;
		const line = fullThinking.slice(start, end).replace(/\s+/g, " ").trim();
		if (line) lines.push(line);
		end = start - 1;
	}
	return lines.reverse().join("\n");
}

/**
 * Clip a tail string to `budget` visible columns, keeping the END (it is a
 * tail view) and prefixing "…" when clipped. Walk backwards over complete
 * graphemes so measurement is limited to the visible suffix.
 */
export function clipTail(text: string, budget: number): string {
	if (!text || budget <= 0) return "";
	const limit = budget - 1; // reserve one column for the ellipsis
	let w = 0;
	let end = text.length;
	let clippedStart = end;
	const segments = graphemeSegmenter.segment(text);
	while (end > 0) {
		const part = segments.containing(end - 1)!;
		w += visibleWidth(part.segment);
		if (w > budget) return "…" + text.slice(clippedStart);
		end = part.index;
		if (w <= limit) clippedStart = end;
	}
	return text;
}

/**
 * Build the label Pi renders in its hidden-thinking block. `width` is a
 * conservative budget that keeps each native Text row within the terminal.
 * In two-line mode, an overflowing latest logical line uses both rows for
 * its continuation instead of retaining the previous logical line.
 */
export function buildPeekLabel(
	state: PeekState,
	frame: number,
	glyphs: IconGlyphs,
	width: number,
	lineCount = 1,
): string {
	const w = Math.max(1, Math.floor(width));
	const prefix = `${glyphs.thinking} think`;
	const count = normalizePeekLineCount(lineCount);
	const fit = (line: string): string => truncateToWidth(line, w, "…");
	switch (state.phase) {
		case "thinking": {
			const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
			// Thinking text is model output (untrusted): strip terminal control
			// sequences before placing it in Pi's native label.
			const marker = `${prefix} ${spin}`;
			const markerWidth = visibleWidth(`${marker} `);
			const contentWidth = Math.max(0, w - markerWidth);
			const thoughtIndent = " ".repeat(markerWidth);
			const safeLines = state.tail
				.split("\n")
				.map((tail) => sanitizeStatus(tail))
				.filter(Boolean)
				.slice(-count);
			const latest = safeLines.at(-1) ?? "";
			const lineWithMarker = (tail: string): string => fit(tail ? `${marker} ${tail}` : marker);
			if (count >= 2) {
				const window = clipTail(latest, contentWidth * count);
				const latestWrapped = wrapTextWithAnsi(window, Math.max(1, contentWidth));
				if (latestWrapped.length > 1) {
					// Word wrapping may add short rows; always retain the newest content.
					const first = latestWrapped.at(-2) ?? "";
					const second = latestWrapped.at(-1) ?? "";
					return `${lineWithMarker(first)}\n${fit(`${thoughtIndent}${second}`)}`;
				}
			}
			const firstTail = clipTail(count >= 2 ? safeLines[0] ?? "" : latest, contentWidth);
			if (count < 2 || safeLines.length < 2) return lineWithMarker(firstTail);
			// Align the latest line with the first line's thinking text, not with
			// the status marker.
			const secondTail = clipTail(latest, contentWidth);
			return `${lineWithMarker(firstTail)}\n${fit(secondTail ? `${thoughtIndent}${secondTail}` : thoughtIndent)}`;
		}
		case "done":
			return fit(`${prefix} ${glyphs.done}`);
		default:
			return fit(`${prefix} ·`);
	}
}
