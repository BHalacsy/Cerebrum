/**
 * Node-compatible loader for @oh-my-pi/pi-natives.
 *
 * The package's own JS entry (`native/index.js`) is Bun-only (`import.meta.dir`, `Bun.zstdDecompressSync`)
 * and throws under Node. The addon itself is plain N-API, so we require the platform package's `.node`
 * file directly, picking the AVX2 ("modern") build when the CPU supports it, like the upstream loader.
 *
 * The addon is loaded lazily on first use (~10 ms) and cached. Load failures are cached too, so callers
 * can fall back to built-in implementations cheaply.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type * as NativesModule from "@oh-my-pi/pi-natives";

export type Natives = typeof NativesModule;

const require_ = createRequire(import.meta.url);

let cached: Natives | undefined;
let loadError: Error | undefined;
let loadedFrom: string | undefined;

function hasAvx2(): boolean {
	if (process.arch !== "x64") return false;
	const override = process.env.PI_NATIVE_VARIANT;
	if (override === "modern") return true;
	if (override === "baseline") return false;
	if (process.platform === "linux") {
		try {
			return /\bavx2\b/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"));
		} catch {
			return false;
		}
	}
	// macOS/Windows probing needs a subprocess; baseline is always safe.
	return false;
}

function candidateFiles(): string[] {
	const tag = `${process.platform}-${process.arch}`;
	const pkg = `@oh-my-pi/pi-natives-${tag}`;
	let dir: string;
	try {
		dir = path.dirname(require_.resolve(`${pkg}/package.json`));
	} catch {
		throw new Error(`Platform package ${pkg} is not installed (run npm install in ~/.pi/agent)`);
	}
	const names =
		process.arch === "x64"
			? hasAvx2()
				? [`pi_natives.${tag}-modern.node`, `pi_natives.${tag}-baseline.node`, `pi_natives.${tag}.node`]
				: [`pi_natives.${tag}-baseline.node`, `pi_natives.${tag}.node`]
			: [`pi_natives.${tag}.node`];
	return names.map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
}

/** Load (once) and return the native bindings. Throws if unavailable. */
export function natives(): Natives {
	if (cached) return cached;
	if (loadError) throw loadError;
	const errors: string[] = [];
	try {
		for (const file of candidateFiles()) {
			try {
				const bindings = require_(file) as Natives;
				try {
					(bindings as { __ompInstallTokioRuntime?: () => void }).__ompInstallTokioRuntime?.();
				} catch {
					// Optional: async calls also work with napi's default runtime.
				}
				cached = bindings;
				loadedFrom = file;
				return bindings;
			} catch (e) {
				errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (errors.length === 0) errors.push("no .node file found in platform package");
	} catch (e) {
		errors.push(e instanceof Error ? e.message : String(e));
	}
	loadError = new Error(`pi-natives unavailable: ${errors.join("; ")}`);
	throw loadError;
}

/** Non-throwing variant for fallback paths. */
export function tryNatives(): Natives | undefined {
	try {
		return natives();
	} catch {
		return undefined;
	}
}

export function nativesStatus(): string {
	const n = tryNatives();
	if (!n) return loadError?.message ?? "not loaded";
	const version = (n as { __piNativesBuildVersion?: () => string | null }).__piNativesBuildVersion?.() ?? "unknown";
	return `pi-natives ${version} loaded from ${loadedFrom}`;
}

/** Resolve a tool path argument like pi's built-ins: strip leading "@", expand "~", resolve against cwd. */
export function resolveToolPath(p: string | undefined, cwd: string): string {
	let value = (p ?? ".").trim().replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (value.startsWith("@")) value = value.slice(1);
	if (value === "~") value = os.homedir();
	else if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
	return path.resolve(cwd, value || ".");
}
