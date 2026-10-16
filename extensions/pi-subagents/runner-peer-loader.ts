import { pathToFileURL } from "node:url";

let aliases: Record<string, string> = {};
let nativeRunner = false;
const redirected = new Set([
	"@earendil-works/pi-tui",
]);

export function initialize(data: { aliases?: Record<string, string>; nativeRunner?: boolean }): void {
	aliases = data?.aliases ?? {};
	nativeRunner = data?.nativeRunner === true;
}

export function resolve(
	specifier: string,
	context: Record<string, unknown>,
	nextResolve: (specifier: string, context: Record<string, unknown>) => unknown,
): unknown {
	const alias = nativeRunner ? aliases[specifier] : redirected.has(specifier) && aliases[specifier];
	if (alias) {
		const target = pathToFileURL(alias).href;
		return nativeRunner ? { url: target, shortCircuit: true } : nextResolve(target, context);
	}
	return nextResolve(specifier, context);
}
