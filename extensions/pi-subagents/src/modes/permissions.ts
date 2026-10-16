/**
 * Permission engine: "allow" | "ask" | "deny" per tool, optionally refined by glob patterns.
 *
 *   permissions: {
 *     "*":    "ask",                                   // fallback for unlisted tools
 *     read:   "allow",                                 // plain action
 *     bash:   { "*": "ask", "git status*": "allow", "git push*": "deny" },   // command patterns
 *     write:  { "*": "deny", ".pi/plans/**": "allow" }                       // path patterns
 *   }
 *
 * Pattern resolution: the MOST SPECIFIC matching pattern wins (most literal characters);
 * ties resolve to the stricter action. Order in the file does not matter.
 *
 * Several permission sets are combined (global + agent) and the strictest result wins
 * (deny > ask > allow). The global set only has an opinion where it explicitly matches.
 */
import * as os from "node:os";
import * as path from "node:path";

export type Action = "allow" | "ask" | "deny";
export type Rule = Action | Record<string, Action>;
export type PermissionSet = Record<string, Rule>;

export const STRICTNESS: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };
export const PATH_TOOLS = new Set(["read", "edit", "write", "ls", "grep", "find"]);

export function stricter(a: Action | undefined, b: Action | undefined): Action | undefined {
	if (!a) return b;
	if (!b) return a;
	return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

const regexCache = new Map<string, RegExp>();

function escapeRe(s: string): string {
	return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Command globs: `*` matches anything (spaces included), `?` one char. */
function commandGlob(pattern: string): RegExp {
	const key = `c:${pattern}`;
	let re = regexCache.get(key);
	if (!re) {
		const body = pattern
			.split("")
			.map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : escapeRe(ch)))
			.join("");
		re = new RegExp(`^${body}$`, "s");
		regexCache.set(key, re);
	}
	return re;
}

/** Path globs: `**` crosses directories, `*` and `?` do not. */
function pathGlob(pattern: string): RegExp {
	const key = `p:${pattern}`;
	let re = regexCache.get(key);
	if (!re) {
		let body = "";
		for (let i = 0; i < pattern.length; i++) {
			const ch = pattern[i];
			if (ch === "*" && pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					body += "(?:.*/)?";
					i += 2;
				} else {
					body += ".*";
					i += 1;
				}
			} else if (ch === "*") body += "[^/]*";
			else if (ch === "?") body += "[^/]";
			else body += escapeRe(ch);
		}
		re = new RegExp(`^${body}$`);
		regexCache.set(key, re);
	}
	return re;
}

function specificity(pattern: string): number {
	return pattern.replace(/[*?]/g, "").length;
}

function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

export interface PathSubject {
	abs: string;
	rel: string;
}

export function toPathSubject(rawPath: string | undefined, cwd: string): PathSubject {
	const abs = path.resolve(cwd, expandHome((rawPath ?? ".").replace(/^@/, "")));
	const rel = path.relative(cwd, abs) || ".";
	return { abs, rel: rel.split(path.sep).join("/") };
}

function displayPath(ps: PathSubject): string {
	return ps.rel.startsWith("..") ? ps.abs : ps.rel;
}

interface Match {
	action: Action;
	pattern: string;
}

function matchCommand(rules: Record<string, Action>, command: string): Match | undefined {
	let best: Match | undefined;
	let bestScore = -1;
	for (const [pattern, action] of Object.entries(rules)) {
		if (!commandGlob(pattern).test(command)) continue;
		const score = specificity(pattern);
		if (score > bestScore || (score === bestScore && best && STRICTNESS[action] > STRICTNESS[best.action])) {
			best = { action, pattern };
			bestScore = score;
		}
	}
	return best;
}

function matchPath(rules: Record<string, Action>, subject: PathSubject): Match | undefined {
	let best: Match | undefined;
	let bestScore = -1;
	for (const [pattern, action] of Object.entries(rules)) {
		let hit: boolean;
		if (pattern === "*" || pattern === "**") hit = true;
		else {
			const p = expandHome(pattern);
			hit = path.isAbsolute(p) ? pathGlob(p).test(subject.abs) : pathGlob(p).test(subject.rel);
		}
		if (!hit) continue;
		const score = pattern === "*" || pattern === "**" ? 0 : specificity(pattern);
		if (score > bestScore || (score === bestScore && best && STRICTNESS[action] > STRICTNESS[best.action])) {
			best = { action, pattern };
			bestScore = score;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Bash parsing: split compound commands, extract redirections and substitutions
// ---------------------------------------------------------------------------

export interface ParsedBash {
	segments: string[];
	/** Files written via `>`/`>>` redirection. */
	redirects: string[];
}

export function parseBash(command: string): ParsedBash {
	const segments: string[] = [];
	const redirects: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	/** Heredoc delimiters whose bodies start after the next newline (bodies are data, not commands). */
	const heredocs: { delim: string; stripTabs: boolean }[] = [];

	const pushSegment = () => {
		const seg = stripEnvAssignments(current.trim());
		if (seg) segments.push(seg);
		current = "";
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === "\\" && quote === '"') {
				current += ch + (command[i + 1] ?? "");
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			current += ch;
			continue;
		}
		if (ch === "\\") {
			current += ch + (command[i + 1] ?? "");
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		// Command substitution: evaluate the inner command as its own segment(s).
		if ((ch === "$" && command[i + 1] === "(") || ch === "`") {
			const close = ch === "`" ? command.indexOf("`", i + 1) : findClosingParen(command, i + 1);
			if (close > i) {
				const inner = command.slice(ch === "`" ? i + 1 : i + 2, close);
				const nested = parseBash(inner);
				segments.push(...nested.segments);
				redirects.push(...nested.redirects);
				current += "$SUBST";
				i = close;
				continue;
			}
		}
		// Heredoc `<<EOF` / `<<-'EOF'` (not the here-string `<<<`): remember the delimiter.
		if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
			let j = i + 2;
			const stripTabs = command[j] === "-";
			if (stripTabs) j++;
			while (command[j] === " ") j++;
			const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(command.slice(j));
			if (m) {
				heredocs.push({ delim: m[2], stripTabs });
				i = j + m[0].length - 1;
				continue;
			}
		}
		if (ch === "\n" && heredocs.length) {
			pushSegment();
			let pos = i + 1;
			while (heredocs.length && pos <= command.length) {
				const end = command.indexOf("\n", pos);
				const line = command.slice(pos, end === -1 ? command.length : end);
				const { delim, stripTabs } = heredocs[0];
				if ((stripTabs ? line.replace(/^\t+/, "") : line).trim() === delim) heredocs.shift();
				if (end === -1) {
					pos = command.length;
					break;
				}
				pos = end + 1;
			}
			heredocs.length = 0;
			i = pos - 1;
			continue;
		}
		if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
			// keep `2>&1`, `&>` etc. inside redirections intact
			if (ch === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
				current += ch;
				continue;
			}
			pushSegment();
			if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
			continue;
		}
		if (ch === ">") {
			// Output redirection: capture the target file.
			let j = i + 1;
			if (command[j] === ">" || command[j] === "|") j++;
			while (command[j] === " ") j++;
			if (command[j] === "&") {
				// >&2 style, not a file
				current += command.slice(i, j + 2);
				i = j + 1;
				continue;
			}
			let target = "";
			let tq: string | null = null;
			while (j < command.length) {
				const c = command[j];
				if (tq) {
					if (c === tq) tq = null;
					else target += c;
				} else if (c === '"' || c === "'") tq = c;
				else if (/[\s;|&<>()]/.test(c)) break;
				else target += c;
				j++;
			}
			// strip the fd number (e.g. `2>`) from the current segment
			current = current.replace(/\d$/, "");
			if (target && target !== "/dev/null" && !target.startsWith("/dev/std")) redirects.push(target);
			i = j - 1;
			continue;
		}
		current += ch;
	}
	pushSegment();
	return { segments, redirects };
}

function findClosingParen(s: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < s.length; i++) {
		if (s[i] === "(") depth++;
		else if (s[i] === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function stripEnvAssignments(seg: string): string {
	let s = seg.replace(/^[({\s]+|[)}\s]+$/g, "").trim();
	while (/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/.test(s)) {
		s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/, "");
	}
	return s.replace(/^(command|builtin|exec|time|nohup)\s+/, "");
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface Check {
	/** What is being checked, e.g. `bash: git push` or `write: src/a.ts`. */
	label: string;
	tool: string;
	subject: string | undefined;
	action: Action;
	/** Which rule decided it, for explanations. */
	because: string;
}

export interface Decision {
	action: Action;
	checks: Check[];
}

interface NamedSet {
	name: string;
	set: PermissionSet;
	/** If false, the set only has an opinion when it explicitly matches. */
	authoritative: boolean;
}

function decideOne(
	sets: NamedSet[],
	tool: string,
	kind: "command" | "path" | "none",
	subject: string | PathSubject | undefined,
): { action: Action; because: string } {
	let result: Action | undefined;
	let because = "";
	for (const { name, set, authoritative } of sets) {
		const rule = set[tool];
		let action: Action | undefined;
		let why = "";
		if (rule === undefined) {
			if (authoritative) {
				action = (set["*"] as Action | undefined) ?? "ask";
				why = `${name}: default "*"`;
			}
		} else if (typeof rule === "string") {
			action = rule;
			why = `${name}: ${tool}=${rule}`;
		} else {
			let m: Match | undefined;
			if (kind === "command" && typeof subject === "string") m = matchCommand(rule, subject);
			else if (kind === "path" && subject && typeof subject === "object") m = matchPath(rule, subject);
			else if (rule["*"]) m = { action: rule["*"], pattern: "*" };
			if (m) {
				action = m.action;
				why = `${name}: ${tool} "${m.pattern}"`;
			} else if (authoritative) {
				action = (set["*"] as Action | undefined) ?? "ask";
				why = `${name}: no ${tool} pattern matched`;
			}
		}
		if (action && (result === undefined || STRICTNESS[action] > STRICTNESS[result])) {
			result = action;
			because = why;
		}
	}
	// No set had an opinion (only non-authoritative sets present): nothing restricts the call.
	return { action: result ?? "allow", because: because || "no matching rule" };
}

/** A session approval granted from an "ask" prompt. `pattern` "*" approves every call of the tool. */
export interface Approval {
	tool: string;
	pattern: string;
}

export function approvalMatches(approval: Approval, check: Check): boolean {
	if (approval.tool !== check.tool) return false;
	if (approval.pattern === "*") return true;
	if (check.subject === undefined) return false;
	if (check.tool === "bash" || check.tool === "powershell") return commandGlob(approval.pattern).test(check.subject);
	return approval.pattern === check.subject;
}

/** Suggest a reusable approval pattern for a bash segment: first one or two words + `*`. */
export function suggestCommandPattern(segment: string): string {
	const [first, second] = segment.trim().split(/\s+/);
	if (!first) return "*";
	return second && /^[A-Za-z][\w:.-]*$/.test(second) ? `${first} ${second}*` : `${first}*`;
}

/**
 * Evaluate a tool call against permission sets.
 * `sets` order: global first, then the agent's set (the agent set is authoritative).
 */
export function evaluate(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	sets: { name: string; set: PermissionSet; authoritative: boolean }[],
): Decision {
	const checks: Check[] = [];

	if (toolName === "bash" || toolName === "powershell") {
		const command = String(input.command ?? "");
		const parsed = parseBash(command);
		const segs = parsed.segments.length ? parsed.segments : [command.trim()];
		for (const seg of segs) {
			const d = decideOne(sets, toolName, "command", seg);
			checks.push({ label: `${toolName}: ${seg}`, tool: toolName, subject: seg, ...d });
		}
		for (const target of parsed.redirects) {
			const ps = toPathSubject(target, cwd);
			const d = decideOne(sets, "write", "path", ps);
			checks.push({ label: `write (redirect): ${displayPath(ps)}`, tool: "write", subject: ps.rel, ...d });
		}
	} else if (PATH_TOOLS.has(toolName)) {
		const ps = toPathSubject(input.path as string | undefined, cwd);
		const d = decideOne(sets, toolName, "path", ps);
		checks.push({ label: `${toolName}: ${displayPath(ps)}`, tool: toolName, subject: ps.rel, ...d });
	} else {
		const d = decideOne(sets, toolName, "none", undefined);
		checks.push({ label: toolName, tool: toolName, subject: undefined, ...d });
	}

	let action: Action = "allow";
	for (const c of checks) action = stricter(action, c.action) ?? action;
	return { action, checks };
}

/** Top-level visibility: a tool whose agent rule is a plain "deny" is hidden from the model. */
export function isToolHidden(set: PermissionSet, tool: string): boolean {
	const rule = set[tool];
	if (rule === undefined) return set["*"] === "deny";
	if (typeof rule === "string") return rule === "deny";
	return Object.values(rule).every((a) => a === "deny");
}

/** Compact, model-facing summary of a permission set. */
export function summarize(set: PermissionSet, tools: string[], maxPatterns = 10): string {
	const lines: string[] = [];
	const plainAllow: string[] = [];
	const plainAsk: string[] = [];
	for (const tool of tools) {
		const rule = set[tool] ?? set["*"] ?? "ask";
		if (typeof rule === "string") {
			if (rule === "allow") plainAllow.push(tool);
			else if (rule === "ask") plainAsk.push(tool);
			continue;
		}
		const by: Record<Action, string[]> = { allow: [], ask: [], deny: [] };
		for (const [p, a] of Object.entries(rule)) by[a].push(p);
		const part = (["allow", "ask", "deny"] as Action[])
			.filter((a) => by[a].length)
			.map((a) => {
				const list = by[a];
				const shown = list.slice(0, maxPatterns).join(", ");
				return `${a}: ${shown}${list.length > maxPatterns ? `, …(+${list.length - maxPatterns})` : ""}`;
			})
			.join(" | ");
		lines.push(`- ${tool} → ${part}`);
	}
	const out: string[] = [];
	if (plainAllow.length) out.push(`- allowed: ${plainAllow.join(", ")}`);
	if (plainAsk.length) out.push(`- needs user approval: ${plainAsk.join(", ")}`);
	out.push(...lines);
	const denied = Object.entries(set)
		.filter(([k, v]) => k !== "*" && v === "deny")
		.map(([k]) => k);
	if (denied.length) out.push(`- denied: ${denied.join(", ")}`);
	return out.join("\n");
}

export function mergePermissionSets(base: PermissionSet, override: PermissionSet | undefined): PermissionSet {
	if (!override) return { ...base };
	const out: PermissionSet = { ...base };
	for (const [tool, rule] of Object.entries(override)) {
		const prev = out[tool];
		if (typeof rule === "object" && rule && typeof prev === "object" && prev) out[tool] = { ...prev, ...rule };
		else out[tool] = rule;
	}
	return out;
}
