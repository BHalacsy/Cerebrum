import { runInspector } from "./src/inspectors/inspector-runner.ts";

try {
	runInspector();
} catch (cause) {
	process.stderr.write(`Inspector failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
	process.exitCode = 1;
}
