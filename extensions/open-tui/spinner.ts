/**
 * OpenCode-style scanner working indicator (merged from the opencode-spinner
 * extension): a lit bar sweeping left/right across dim dots.
 */
import type { ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";

const WIDTH = 8;
const TRAIL_LENGTH = WIDTH; // the lit line spans the whole bar
const INTERVAL_MS = 40;
// Holds are derived from the trail so the fade always completes: the trail
// shrinks one cell per frame, so a hold needs >= TRAIL_LENGTH frames to go
// fully dim. The left hold adds an extra pause before the next sweep.
const HOLD_END = TRAIL_LENGTH;
const HOLD_START = TRAIL_LENGTH * 2;

const RESET = "\x1b[0m";
// Ocean palette (themes/ocean.json, cyan #18b3c4 on bg #0a2332), approximated
// with 256-color cube codes. Truecolor escapes (38;2;r;g;b) leak as raw text
// on this terminal, so stick to widely-supported 38;5 codes.
// Teal ramp: bright cyan head fading through the cube's teal column, then the
// last cell drops to grey 237, barely above the 236 dot color.
const DIM = "\x1b[38;5;236m";
const TRAIL_COLORS = [
	"\x1b[38;5;38m",  // Head: RGB(0, 175, 215) — closest vibrant 256-color match to #18b3c4
	"\x1b[38;5;37m",  // RGB(0, 175, 175) — slightly deeper saturated cyan
	"\x1b[38;5;31m",  // RGB(0, 135, 175) — mid-tone muted cyan
	"\x1b[38;5;30m",  // RGB(0, 135, 135) — medium teal
	"\x1b[38;5;24m",  // RGB(0, 95, 135)  — deep slate teal
	"\x1b[38;5;23m",  // RGB(0, 95, 95)   — dark muted sea green/gray
	"\x1b[38;5;238m", // Grayscale ramp: fading dark grey-cyan transition
	"\x1b[38;5;236m", // Tail: barely above the background dot color
];

function colorize(value: string, color: string) {
	return `${color}${value}${RESET}`;
}

type ScannerState = {
	position: number;
	direction: 1 | -1;
	/** Frames elapsed since the head reached its end. Shrinks the trail while holding. */
	holdProgress: number;
};

function scannerState(frame: number): ScannerState {
	const forward = WIDTH;
	const backward = WIDTH - 1;

	if (frame < forward) {
		return { position: frame, direction: 1, holdProgress: 0 };
	}
	if (frame < forward + HOLD_END) {
		return { position: WIDTH - 1, direction: 1, holdProgress: frame - forward };
	}

	const backwardStart = forward + HOLD_END;
	if (frame < backwardStart + backward) {
		return {
			position: WIDTH - 2 - (frame - backwardStart),
			direction: -1,
			holdProgress: 0,
		};
	}
	return {
		position: 0,
		direction: -1,
		holdProgress: frame - backwardStart - backward,
	};
}

function createFrames(): string[] {
	const totalFrames = WIDTH + HOLD_END + (WIDTH - 1) + HOLD_START;
	const frames: string[] = [];

	for (let frame = 0; frame < totalFrames; frame++) {
		const state = scannerState(frame);
		// While holding at an edge the trail collapses toward the head instead of
		// staying frozen, so the bar phases out before the next sweep.
		const trailLength = Math.max(0, TRAIL_LENGTH - state.holdProgress);
		let cells = "";

		for (let index = 0; index < WIDTH; index++) {
			const distance = state.direction === 1 ? state.position - index : index - state.position;
			cells +=
				distance >= 0 && distance < trailLength
					? colorize("■", TRAIL_COLORS[Math.min(distance, TRAIL_COLORS.length - 1)]!)
					: colorize("·", DIM);
		}
		frames.push(cells);
	}
	return frames;
}

const OPENCODE_INDICATOR: WorkingIndicatorOptions = {
	frames: createFrames(),
	intervalMs: INTERVAL_MS,
};

export function applySpinner(ctx: ExtensionContext): void {
	ctx.ui.setWorkingIndicator(OPENCODE_INDICATOR);
}
