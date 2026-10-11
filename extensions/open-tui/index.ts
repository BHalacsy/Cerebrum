import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
	AgentSettledEvent,
	AgentStartEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolExecutionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { OpenTuiConfig } from "./shared.ts";
import {
	createInitialState,
	emptyGitStatus,
	finiteOrZero,
	fmtTokens,
	formatDuration,
	formatInputBreakdown,
	getModelMeta,
	invalidateUsageCache,
	loadFixedConfig,
	resolveGlyphs,
	type FooterState,
} from "./shared.ts";
import { installEditor } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { installHeader } from "./header.ts";
import { applySpinner } from "./spinner.ts";
import {
	buildPeekLabel,
	collectPeekParts,
	createPeekState,
	reducePeek,
	type PeekState,
} from "./editor.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

class SessionLifecycle {
	private current = 0;
	private shutDown = false;

	start(): void {
		this.current++;
		this.shutDown = false;
	}

	shutdown(): void {
		this.shutDown = true;
	}

	isCurrent(generation?: number): boolean {
		if (this.shutDown) return false;
		if (generation === undefined) return true;
		return generation === this.current;
	}

	currentGeneration(): number {
		return this.current;
	}
}

// ---------------------------------------------------------------------------
// Git status probing
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 2000;

async function gitExec(args: string[], cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		return stdout;
	} catch {
		return null;
	}
}

async function readGitStatus(
	cwd: string,
	options: { readCommit?: boolean; readTag?: boolean; readCounts?: boolean } = {},
): Promise<ReturnType<typeof emptyGitStatus>> {
	const stdout = await gitExec(
		["status", "--porcelain=v1", "--branch", "--show-stash"],
		cwd,
	);
	if (stdout === null) {
		return emptyGitStatus();
	}

	const status = emptyGitStatus();
	const lines = stdout.split("\n");

	for (const line of lines) {
		if (line.startsWith("## ")) {
			const branchPart = line.slice(3);
			const detached = branchPart.startsWith("HEAD (no branch)");
			if (detached) {
				status.branch = undefined;
				status.commit = { oid: null, detached: true, tag: null };
			} else {
				const branchMatch = branchPart.match(/^(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(ahead|behind) (\d+)\])?$/);
				if (branchMatch) {
					status.branch = branchMatch[1];
					if (branchMatch[3] === "ahead") status.ahead = parseInt(branchMatch[4]!, 10);
					if (branchMatch[3] === "behind") status.behind = parseInt(branchMatch[4]!, 10);
				}
			}
			continue;
		}

		if (line.startsWith("# stash ")) {
			const stashCount = parseInt(line.slice(8).trim(), 10);
			if (!Number.isNaN(stashCount)) {
				status.stashed = stashCount;
			}
			continue;
		}

		// Skip file-entry counting when only branch/commit display is on; the
		// first `git status` call itself can't be split, but the stash fallback
		// below can.
		if (options.readCounts === false) continue;
		if (line.length < 3) continue;
		const x = line[0]!;
		const y = line[1]!;

		if (x === "U" || y === "U" || (x === "C" && y === "C")) status.conflicted++;
		else if (x === "?" && y === "?") status.untracked++;
		else if (x === "R") status.renamed++;
		else if (x === "D" || y === "D") status.deleted++;
		else {
			if (x !== " " && x !== "?") status.staged++;
			if (y === "M" || y === "D") status.modified++;
		}
	}

	if (options.readCounts !== false && status.stashed === 0 && !stdout.includes("# stash")) {
		const stashOut = await gitExec(["stash", "list", "--count"], cwd);
		if (stashOut !== null) {
			const count = parseInt(stashOut.trim(), 10);
			if (!Number.isNaN(count)) status.stashed = count;
		}
	}

	if (options.readCommit && status.commit?.detached) {
		const oid = await gitExec(["rev-parse", "HEAD"], cwd);
		if (oid) {
			status.commit.oid = oid.trim();
		}
		if (options.readTag) {
			const tag = await gitExec(["describe", "--tags", "--exact-match", "HEAD"], cwd);
			if (tag) {
				status.commit.tag = tag.trim();
			}
		}
	}

	return status;
}

// ---------------------------------------------------------------------------
// Runtime (language / toolchain) probing
// ---------------------------------------------------------------------------

const VERSION_TIMEOUT_MS = 2500;

interface RuntimeDef {
	name: string;
	files: readonly string[];
	folders?: readonly string[];
	extensions?: readonly string[];
	env?: string;
	versionCommand?: { cmd: string; args?: string[]; pattern?: RegExp };
}

const RUNTIMES: readonly RuntimeDef[] = [
	{ name: "bun", files: ["bun.lock", "bun.lockb"], versionCommand: { cmd: "bun", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "nodejs", files: ["package.json", ".nvmrc", ".node-version"], versionCommand: { cmd: "node", args: ["--version"], pattern: /v(\d+\.\d+\.\d+)/ } },
	{ name: "rust", files: ["Cargo.toml"], versionCommand: { cmd: "rustc", args: ["--version"], pattern: /rustc\s+(\d+\.\d+\.\d+)/ } },
	{ name: "go", files: ["go.mod"], versionCommand: { cmd: "go", args: ["version"], pattern: /go(\d+\.\d+\.\d+)/ } },
	{ name: "python", files: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", ".python-version"], versionCommand: { cmd: "python3", args: ["--version"], pattern: /Python\s+(\d+\.\d+\.\d+)/ } },
	{ name: "ruby", files: ["Gemfile", ".ruby-version"], versionCommand: { cmd: "ruby", args: ["--version"], pattern: /ruby\s+(\d+\.\d+\.\d+)/ } },
	{ name: "java", files: ["pom.xml", "build.gradle", "build.gradle.kts", ".java-version"], versionCommand: { cmd: "java", args: ["-version"], pattern: /version\s+"(\d+\.\d+[\.\d]*)"/ } },
	{ name: "swift", files: ["Package.swift"], versionCommand: { cmd: "swift", args: ["--version"], pattern: /Swift\s+(\d+\.\d+)/ } },
	{ name: "kotlin", files: ["build.gradle.kts", "settings.gradle.kts"] },
	{ name: "cpp", files: ["CMakeLists.txt", "Makefile"] },
	{ name: "c", files: ["Makefile", "CMakeLists.txt"] },
	{ name: "deno", files: ["deno.json", "deno.jsonc", "deno.lock"], versionCommand: { cmd: "deno", args: ["--version"], pattern: /deno\s+(\d+\.\d+\.\d+)/ } },
	{ name: "php", files: ["composer.json"], versionCommand: { cmd: "php", args: ["--version"], pattern: /PHP\s+(\d+\.\d+\.\d+)/ } },
	{ name: "haskell", files: ["stack.yaml", "cabal.project", ".cabal"], versionCommand: { cmd: "ghc", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "julia", files: ["Project.toml", "Manifest.toml"], versionCommand: { cmd: "julia", args: ["--version"], pattern: /julia\s+(\d+\.\d+\.\d+)/ } },
	{ name: "lua", files: ["stylua.toml", ".luarc.json"], versionCommand: { cmd: "lua", args: ["-v"], pattern: /Lua\s+(\d+\.\d+)/ } },
	{ name: "elixir", files: ["mix.exs"], versionCommand: { cmd: "elixir", args: ["--version"], pattern: /Elixir\s+(\d+\.\d+\.\d+)/ } },
	{ name: "erlang", files: ["rebar.config", "erlang.mk"] },
	{ name: "gleam", files: ["gleam.toml"], versionCommand: { cmd: "gleam", args: ["--version"], pattern: /gleam\s+(\d+\.\d+\.\d+)/ } },
	{ name: "crystal", files: ["shard.yml"], versionCommand: { cmd: "crystal", args: ["--version"], pattern: /Crystal\s+(\d+\.\d+\.\d+)/ } },
	{ name: "dart", files: ["pubspec.yaml"], versionCommand: { cmd: "dart", args: ["--version"], pattern: /Dart\s+SDK\s+version:\s+(\d+\.\d+\.\d+)/ } },
	{ name: "nim", files: ["nim.cfg", ".nimble"] },
	{ name: "zig", files: ["build.zig"], versionCommand: { cmd: "zig", args: ["version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "ocaml", files: [".opam", "dune", "dune-project"] },
	{ name: "clojure", files: ["project.clj", "deps.edn"] },
	{ name: "scala", files: ["build.sbt", ".scala", ".metals"] },
	{ name: "perl", files: ["Makefile.PL", "cpanfile"] },
	{ name: "r", files: [".Rproj", "DESCRIPTION"] },
	{ name: "elm", files: ["elm.json"] },
	{ name: "haxe", files: ["haxelib.json", ".haxerc"] },
	{ name: "vagrant", files: ["Vagrantfile"] },
	{ name: "terraform", files: ["main.tf", "variables.tf"], folders: [".terraform"] },
	{ name: "helm", files: ["Chart.yaml", "helmfile.yaml"] },
	{ name: "solidity", files: [], extensions: [".sol"] },
	{ name: "fortran", files: ["fpm.toml"], extensions: [".f", ".f90", ".f95"] },
	{ name: "mojo", files: [], extensions: [".mojo"] },
	{ name: "red", files: [], extensions: [".red", ".reds"] },
	{ name: "raku", files: ["META6.json"], extensions: [".raku", ".rakumod"] },
	{ name: "purescript", files: ["spago.dhall", "spago.yaml"] },
	{ name: "fennel", files: [], extensions: [".fnl"] },
	{ name: "odin", files: [], extensions: [".odin"] },
	{ name: "v", files: ["v.mod", "vpkg.json"], extensions: [".v"] },
	{ name: "xmake", files: ["xmake.lua"] },
	{ name: "gradle", files: ["build.gradle", "build.gradle.kts"], folders: ["gradle"] },
	{ name: "maven", files: ["pom.xml"] },
	{ name: "cmake", files: ["CMakeLists.txt", "CMakeCache.txt"] },
	{ name: "meson", files: ["meson.build"], env: "MESON_DEVENV" },
	{ name: "nix", files: ["flake.nix", "shell.nix"], env: "IN_NIX_SHELL" },
	{ name: "guix", files: [], env: "GUIX_ENVIRONMENT" },
	{ name: "conda", files: [], env: "CONDA_DEFAULT_ENV" },
	{ name: "pixi", files: ["pixi.toml", "pixi.lock"], env: "PIXI_ENVIRONMENT_NAME" },
	{ name: "spack", files: [], env: "SPACK_ENV" },
	{ name: "pulumi", files: ["Pulumi.yaml", "Pulumi.yml"] },
	{ name: "typst", files: ["template.typ"], extensions: [".typ"] },
	{ name: "buf", files: ["buf.yaml", "buf.gen.yaml", "buf.work.yaml"] },
	{ name: "dotnet", files: [".csproj", ".fsproj", "global.json", "Directory.Build.props"] },
	{ name: "cobol", files: [], extensions: [".cbl", ".cob"] },
];

interface CacheEntry {
	fingerprint: string;
	runtime: { name: string; version?: string } | null;
}

const runtimeCache = new Map<string, CacheEntry>();
const CACHE_MAX = 32;

function fingerprint(cwd: string, def: RuntimeDef): string {
	const parts: string[] = [];
	for (const f of def.files) {
		try {
			const stat = statSync(join(cwd, f));
			parts.push(`${f}:${stat.mtimeMs}`);
		} catch { /* ignore */ }
	}
	if (def.extensions || def.folders) {
		try {
			const entries = readdirSync(cwd);
			parts.push(...entries.slice().sort());
		} catch { /* ignore */ }
	}
	if (def.env && process.env[def.env]) {
		parts.push(`${def.env}=${process.env[def.env]}`);
	}
	return parts.join("\0");
}

function matchesDef(cwd: string, def: RuntimeDef): boolean {
	if (def.env && process.env[def.env]) return true;
	if (def.files.some((f) => existsSync(join(cwd, f)))) return true;
	if (def.folders?.some((f) => existsSync(join(cwd, f)))) return true;
	if (def.extensions) {
		try {
			const entries = readdirSync(cwd);
			if (entries.some((e) => def.extensions!.some((ext) => e.endsWith(ext)))) return true;
		} catch { /* ignore */ }
	}
	return false;
}

async function fetchVersion(def: RuntimeDef, cwd: string): Promise<string | undefined> {
	if (!def.versionCommand) return undefined;
	try {
		const { stdout } = await execFileAsync(def.versionCommand.cmd, def.versionCommand.args ?? [], {
			cwd,
			timeout: VERSION_TIMEOUT_MS,
			maxBuffer: 64 * 1024,
		});
		if (def.versionCommand.pattern) {
			const match = stdout.match(def.versionCommand.pattern);
			return match?.[1];
		}
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function readRuntimeInfo(cwd: string): Promise<{ name: string; version?: string } | null> {
	for (const def of RUNTIMES) {
		if (!matchesDef(cwd, def)) continue;
		const fp = fingerprint(cwd, def);
		const cacheKey = `${cwd}\0${def.name}`;
		const cached = runtimeCache.get(cacheKey);
		if (cached && cached.fingerprint === fp) {
			return cached.runtime;
		}

		for (const key of runtimeCache.keys()) {
			if (key === cacheKey || key.startsWith(`${cwd}\0`)) runtimeCache.delete(key);
		}

		const version = await fetchVersion(def, cwd);
		const info: { name: string; version?: string } = {
			name: def.name,
			version,
		};
		runtimeCache.set(cacheKey, { fingerprint: fp, runtime: info });
		while (runtimeCache.size > CACHE_MAX) {
			const oldest = runtimeCache.keys().next().value;
			if (oldest === undefined) break;
			runtimeCache.delete(oldest);
		}
		return info;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Turn telemetry (TPS / TTFT / stalls / cost-rate) shown after each agent task
// ---------------------------------------------------------------------------

const STALL_THRESHOLD_MS = 1000;

type TelemetryEvent =
	| AgentStartEvent
	| AgentSettledEvent
	| TurnStartEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| TurnEndEvent;
type AgentMessage = MessageStartEvent["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

interface MessageTiming {
	lastUpdateMs: number;
	firstOutputMs: number | null;
	inStall: boolean;
}

interface TurnTiming {
	startMs: number;
	firstTokenMs: number | null;
	currentMessage: MessageTiming | null;
	messages: AssistantMessage[];
	generationMs: number;
	stallMs: number;
	stallCount: number;
}

export interface TurnTelemetry {
	tps: number | null;
	ttftMs: number;
	totalMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	stallMs: number;
	stallCount: number;
	rateUsdPerMTokens: number | null;
	generationMs: number;
	totalTokens: number;
	costUsd: number;
	measurementMs: number | null;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

class TurnTelemetryTracker {
	private readonly now: () => number;
	private turn: TurnTiming | undefined;
	private agentStartMs: number | null = null;
	private agentTurns: TurnTelemetry[] = [];

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	handle(event: TelemetryEvent): TurnTelemetry | undefined {
		switch (event.type) {
			case "agent_start":
				if (this.agentStartMs === null) {
					this.agentStartMs = this.now();
					this.agentTurns = [];
				}
				return;
			case "agent_settled":
				return this.endAgent();
			case "turn_start":
				this.startTurn();
				return;
			case "message_start":
				this.startMessage(event.message);
				return;
			case "message_update":
				this.updateMessage(event);
				return;
			case "message_end":
				this.endMessage(event.message);
				return;
			case "tool_execution_start":
				return;
			case "turn_end":
				return this.endTurnAndCollect();
		}
	}

	private startTurn(): void {
		this.turn = {
			startMs: this.now(),
			firstTokenMs: null,
			currentMessage: null,
			messages: [],
			generationMs: 0,
			stallMs: 0,
			stallCount: 0,
		};
	}

	private startMessage(message: AgentMessage): void {
		if (!this.turn || !isAssistantMessage(message)) return;
		const now = this.now();
		this.turn.currentMessage = {
			lastUpdateMs: now,
			firstOutputMs: null,
			inStall: false,
		};
	}

	private updateMessage(event: MessageUpdateEvent): void {
		const turn = this.turn;
		const current = turn?.currentMessage;
		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type !== "text_delta" &&
			streamEvent.type !== "thinking_delta" &&
			streamEvent.type !== "toolcall_delta"
		) return;
		if (streamEvent.delta.length === 0) return;
		const message = event.message;
		if (!turn || !current || !isAssistantMessage(message)) return;

		const now = this.now();
		if (current.firstOutputMs === null) {
			current.firstOutputMs = now;
			turn.firstTokenMs ??= now;
			current.lastUpdateMs = now;
			return;
		}

		const gap = now - current.lastUpdateMs;
		if (gap >= STALL_THRESHOLD_MS) {
			if (!current.inStall) turn.stallCount++;
			current.inStall = true;
			turn.stallMs += gap;
		} else {
			current.inStall = false;
		}
		current.lastUpdateMs = now;
	}

	private endMessage(message: AgentMessage): void {
		const turn = this.turn;
		if (!turn || !isAssistantMessage(message)) return;

		const current = turn.currentMessage;
		if (current) {
			const endMs = this.now();
			turn.generationMs = endMs - turn.startMs;
			if (current.firstOutputMs === null && finiteOrZero(message.usage?.output) > 0) {
				turn.firstTokenMs ??= endMs;
			}
			turn.currentMessage = null;
		}
		turn.messages.push(message);
	}

	private endTurnAndCollect(): TurnTelemetry | undefined {
		const telemetry = this.endTurn();
		if (telemetry && this.agentStartMs !== null) this.agentTurns.push(telemetry);
		return telemetry;
	}

	private endTurn(): TurnTelemetry | undefined {
		const turn = this.turn;
		this.turn = undefined;
		if (!turn || turn.firstTokenMs === null || turn.messages.length === 0) return;

		const endMs = this.now();
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let totalTokens = 0;
		let costUsd = 0;
		for (const message of turn.messages) {
			// match /session's "uncached" total: cacheWrite is fresh, near-full-price
			// content; only cacheRead is discounted repeat content.
			inputTokens += finiteOrZero(message.usage?.input) + finiteOrZero(message.usage?.cacheWrite);
			outputTokens += finiteOrZero(message.usage?.output);
			cacheReadTokens += finiteOrZero(message.usage?.cacheRead);
			totalTokens += finiteOrZero(message.usage?.totalTokens);
			costUsd += finiteOrZero(message.usage?.cost?.total);
		}

		const measurementMs = outputTokens > 0 && turn.generationMs > 0 ? turn.generationMs : null;
		const tps = measurementMs === null
			? null
			: round(outputTokens / (measurementMs / 1000), 1);
		const validCost = Number.isFinite(costUsd) && costUsd > 0;
		const validTokens = Number.isFinite(totalTokens) && totalTokens > 0;
		return {
			tps,
			ttftMs: turn.firstTokenMs - turn.startMs,
			totalMs: endMs - turn.startMs,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			stallMs: turn.stallMs,
			stallCount: turn.stallCount,
			rateUsdPerMTokens: validCost && validTokens
				? round(costUsd / (totalTokens / 1_000_000), 2)
				: null,
			generationMs: turn.generationMs,
			totalTokens,
			costUsd: validCost ? costUsd : 0,
			measurementMs,
		};
	}

	private endAgent(): TurnTelemetry | undefined {
		const startMs = this.agentStartMs;
		const turns = this.agentTurns;
		this.agentStartMs = null;
		this.agentTurns = [];
		if (startMs === null || turns.length === 0) return;

		const outputTokens = turns.reduce((sum, turn) => sum + turn.outputTokens, 0);
		const inputTokens = turns.reduce((sum, turn) => sum + turn.inputTokens, 0);
		const cacheReadTokens = turns.reduce((sum, turn) => sum + turn.cacheReadTokens, 0);
		const totalTokens = turns.reduce((sum, turn) => sum + turn.totalTokens, 0);
		const costUsd = turns.reduce((sum, turn) => sum + turn.costUsd, 0);
		const stallMs = turns.reduce((sum, turn) => sum + turn.stallMs, 0);
		const stallCount = turns.reduce((sum, turn) => sum + turn.stallCount, 0);
		const generationMs = turns.reduce((sum, turn) => sum + turn.generationMs, 0);
		const measurementMs = outputTokens > 0 && generationMs > 0 ? generationMs : null;
		const tps = measurementMs === null
			? null
			: round(outputTokens / (measurementMs / 1000), 1);
		const validRate = costUsd > 0 && totalTokens > 0;
		return {
			tps,
			ttftMs: turns[0]!.ttftMs,
			totalMs: this.now() - startMs,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			stallMs,
			stallCount,
			rateUsdPerMTokens: validRate ? round(costUsd / (totalTokens / 1_000_000), 2) : null,
			generationMs,
			totalTokens,
			costUsd,
			measurementMs,
		};
	}
}

function formatTurnDuration(ms: number): string {
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms);
}

function formatTurnTelemetry(
	telemetry: TurnTelemetry,
	theme: Theme,
	config: OpenTuiConfig["telemetry"],
	iconMode: OpenTuiConfig["icons"]["mode"],
): string {
	const glyphs = resolveGlyphs(iconMode);
	const parts: string[] = [];
	if (config.tps) {
		const value = telemetry.tps === null ? "—" : `${telemetry.tps.toFixed(1)} tok/s`;
		parts.push(theme.fg(telemetry.tps === null ? "muted" : "accent", `${glyphs.speed} TPS ${value}`));
	}
	if (config.ttft) {
		parts.push(theme.fg("text", `${glyphs.latency} TTFT ${formatTurnDuration(telemetry.ttftMs)}`));
	}
	if (config.duration) {
		parts.push(theme.fg("success", `${glyphs.done} ${formatTurnDuration(telemetry.totalMs)}`));
	}
	if (config.tokens) {
		parts.push(theme.fg("accent", `${glyphs.input} ${formatInputBreakdown(telemetry.inputTokens, telemetry.cacheReadTokens)}`));
		parts.push(theme.fg("success", `${glyphs.output} ${fmtTokens(telemetry.outputTokens)}`));
	}
	if (config.stalls && telemetry.stallMs > 0) {
		parts.push(theme.fg("warning", `${glyphs.stall} stall ${telemetry.stallCount}x / ${formatTurnDuration(telemetry.stallMs)}`));
	}
	if (config.cost && telemetry.rateUsdPerMTokens !== null) {
		parts.push(theme.fg("warning", `${glyphs.cost} $${telemetry.rateUsdPerMTokens.toFixed(2)}/M`));
	}
	return parts.join(` ${theme.fg("dim", "|")} `);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const HIDDEN_THINKING_HORIZONTAL_PADDING = 2;
// Pi's fullscreen transcript can reserve one more column for its scrollbar.
const HIDDEN_THINKING_SCROLLBAR_RESERVE = 1;

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	const sessionLifecycle = new SessionLifecycle();
	const state: FooterState = createInitialState();
	const turnTelemetry = new TurnTelemetryTracker();

	let config: OpenTuiConfig = loadFixedConfig();
	let active = false;
	let lastCtx: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let cleanupHeader: (() => void) | undefined;
	let cleanupFooter: (() => void) | undefined;
	let editor: ReturnType<typeof installEditor> | undefined;

	// thinking-peek state (rendered by Pi inside its hidden-thinking block)
	const peek: PeekState = createPeekState();
	let peekFrame = 0;
	let peekSettleTimer: ReturnType<typeof setTimeout> | undefined;
	let peekTaskEpoch = 0; // bumped at every agent task boundary
	let peekLabelActive = false;

	const getThinkingLevel = () => (sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : "off");

	/** True while the agent is running (false during session-restore replay). */
	const isAgentIdle = (ctx: ExtensionContext): boolean => {
		try {
			return (ctx as ExtensionContext & { isIdle?: () => boolean }).isIdle?.() === true;
		} catch {
			return false;
		}
	};

	/** Pi decides whether this label is visible; our toggle only controls updates. */
	const isPeekEnabled = () => sessionLifecycle.isCurrent() && config.enabled && config.thinkingPeek.lines > 0 && active;

	/** Keep each native hidden-thinking label row within Pi's narrowest transcript width. */
	const hiddenThinkingLabelWidth = (): number => {
		if (!editor) throw new Error("Open TUI editor is not installed");
		return Math.max(
			1,
			editor.getViewportWidth() - HIDDEN_THINKING_HORIZONTAL_PADDING - HIDDEN_THINKING_SCROLLBAR_RESERVE,
		);
	};

	const setPeekLabel = (ctx?: ExtensionContext): void => {
		if (!isPeekEnabled() || peek.phase === "idle") return;
		const target = ctx ?? lastCtx;
		if (!target || !isTuiContext(target)) return;
		if (!editor) throw new Error("Open TUI editor is not installed");
		editor.setLatestHiddenThinkingLabel(
			buildPeekLabel(
				peek,
				peekFrame,
				resolveGlyphs(config.icons.mode),
				hiddenThinkingLabelWidth(),
				config.thinkingPeek.lines,
			),
		);
		peekLabelActive = true;
	};

	const clearPeekLabel = (ctx?: ExtensionContext): void => {
		if (!peekLabelActive) return;
		const target = ctx ?? lastCtx;
		if (!target || !isTuiContext(target)) return;
		// The global reset is safe here: every completed message returns to Pi's native label.
		target.ui.setHiddenThinkingLabel();
		peekLabelActive = false;
	};

	/** Reset peek state to idle and cancel any scheduled cleanup. */
	const resetPeek = () => {
		peek.phase = "idle";
		peek.tail = "";
		editor?.resetHiddenThinkingLabelTarget();
		if (peekSettleTimer) {
			clearTimeout(peekSettleTimer);
			peekSettleTimer = undefined;
		}
	};

	const applyUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		if (!active) {
			cleanupHeader = installHeader(pi, ctx);
			const footer = installFooter(
				ctx,
				() => state,
				() => config,
				() => getModelMeta(ctx, getThinkingLevel, config.footerSegments.capitalizeProviderName),
				{
					setRequestRender: (fn) => {
						requestFooterRender = fn ?? undefined;
					},
					scheduleGitRefresh: () => {
						void scheduleGitRefresh(ctx);
					},
				},
			);
			cleanupFooter = footer.cleanup;
			editor = installEditor(
				ctx,
				config.cursorStyle,
				{
					enabled: () => config.inlineFooter,
					render: footer.renderInline,
				},
			);
			active = true;
		}
	};

	const uninstallUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (active) {
			cleanupHeader?.();
			cleanupFooter?.();
			editor?.cleanup();
			cleanupHeader = undefined;
			cleanupFooter = undefined;
			editor = undefined;
			requestFooterRender = undefined;
			resetPeek();
			clearPeekLabel(ctx);
			active = false;
		}
	};

	const scheduleGitRefresh = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const segs = config.footerSegments;
		if (!segs.gitBranch && !segs.gitStatus && !segs.gitCommit) {
			state.git = emptyGitStatus();
			requestFooterRender?.();
			return;
		}
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const git = await readGitStatus(cwd, {
			readCommit: true,
			readTag: segs.gitCommit,
			readCounts: segs.gitStatus,
		});
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.git = git;
		requestFooterRender?.();
	};

	const refreshRuntime = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const runtime = await readRuntimeInfo(cwd);
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.runtime = runtime;
		requestFooterRender?.();
	};

	const refreshInteractiveState = (ctx: ExtensionContext, project = false) => {
		if (!sessionLifecycle.isCurrent() || !ctx.hasUI) return;
		if (project) {
			void scheduleGitRefresh(ctx);
			void refreshRuntime(ctx);
		}
		requestFooterRender?.();
	};

	const startWorkingTimer = () => {
		stopWorkingTimer();
		const tick = () => {
			if (!sessionLifecycle.isCurrent() || !active) return;
			requestFooterRender?.();
		};
		tick();
		workingTimer = setInterval(tick, 250);
		workingTimer.unref?.();
	};

	const stopWorkingTimer = () => {
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionLifecycle.start();
		lastCtx = ctx;
		state.sessionStartEpoch = Date.now();
		state.workingSince = undefined;
		state.lastDoneIn = undefined;
		invalidateUsageCache();

		// Re-read the (never written) config file so manual edits take effect on
		// the next session without a process restart.
		config = loadFixedConfig((msg, level) => ctx.ui.notify(msg, level));
		clearPeekLabel(ctx);

		if (isTuiContext(ctx)) applySpinner(ctx);

		applyUi(ctx);

		refreshInteractiveState(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionLifecycle.shutdown();
		stopWorkingTimer();
		if (active) {
			uninstallUi(ctx);
		}
		lastCtx = undefined;
	});

	pi.on("agent_start", (event, _ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		// agent_start also covers custom-message and continuation-triggered tasks
		// that do not emit a user message_start event.
		peekTaskEpoch++;
		state.workingSince = Date.now();
		state.lastDoneIn = undefined;
		startWorkingTimer();
	});

	pi.on("agent_end", (_event, _ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		stopWorkingTimer();
		if (state.workingSince !== undefined) {
			state.lastDoneIn = Date.now() - state.workingSince;
			state.workingSince = undefined;
		}
		requestFooterRender?.();
	});

	pi.on("turn_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_start", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent() || isAgentIdle(ctx)) return;
		const role = event.message?.role;
		if (role === "user") {
			// Restore Pi's native label until real thinking arrives. The task epoch is
			// advanced by agent_start so custom/no-user tasks are covered too.
			resetPeek();
			clearPeekLabel(ctx);
		} else if (role === "assistant") {
			resetPeek();
			clearPeekLabel(ctx);
		}
	});

	pi.on("message_update", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent() || isAgentIdle(ctx)) return;
		if (!isPeekEnabled()) return;
		const message = event.message;
		if (!message || message.role !== "assistant") return;
		if (peek.phase === "done") return;
		const parts = collectPeekParts(message.content);
		const next = reducePeek(peek, parts);
		const changed = next.phase !== peek.phase || next.tail !== peek.tail;
		peek.phase = next.phase;
		peek.tail = next.tail;
		if (!changed) return;
		if (peek.phase === "thinking") {
			peekFrame++;
			setPeekLabel(ctx);
		} else if (peek.phase === "done") {
			setPeekLabel(ctx);
		}
	});

	pi.on("tool_execution_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("turn_end", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("agent_settled", (event, ctx) => {
		const telemetry = turnTelemetry.handle(event);
		if (telemetry && config.enabled && config.telemetry.enabled && isTuiContext(ctx)) {
			const message = formatTurnTelemetry(telemetry, ctx.ui.theme, config.telemetry, config.icons.mode);
			if (message) ctx.ui.notify(message, "info");
		}
		// Only clear the peek label when this task is still the current one.
		const settleEpoch = peekTaskEpoch;
		if (peekSettleTimer) clearTimeout(peekSettleTimer);
		peekSettleTimer = setTimeout(() => {
			peekSettleTimer = undefined;
			if (!sessionLifecycle.isCurrent() || peekTaskEpoch !== settleEpoch) return;
			resetPeek();
			clearPeekLabel(ctx);
		}, 300);
	});

	pi.on("model_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		if (event.message?.role === "assistant" && peek.phase === "thinking") {
			// Sub-message finished (answer text or a tool call): freeze the peek line.
			peek.phase = "done";
			setPeekLabel(ctx);
		}
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});
}
