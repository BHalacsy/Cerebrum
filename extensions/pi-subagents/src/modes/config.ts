/**
 * Built-in agents, workflows and permission defaults, plus JSON config loading.
 *
 * Override anything in:
 *   ~/.pi/agent/agent-modes.json          (user)
 *   <project>/.pi/agent-modes.json        (project; only when the project is trusted)
 *
 * Run /modes-config to write the full effective config to the user file for editing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Action, mergePermissionSets, type PermissionSet } from "./permissions.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentDef {
	label: string;
	description: string;
	/** Tools activated in this mode (unknown/unregistered names are ignored). */
	tools: string[];
	permissions: PermissionSet;
	/** Mode instructions placed in the system prompt (and handed over on workflow transitions). */
	instructions: string;
	/** Optional "provider/modelId" to switch to while this mode is active. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** After a run in this mode (outside workflows), offer switching to this mode. */
	handoff?: string;
	/** Status words this agent may report in workflows (first = success). */
	statuses?: string[];
}

export interface WorkflowStep {
	agent: string;
	/** Ask the user to approve the phase result before moving on. */
	gate?: boolean;
	/** On a negative report (changes_requested / fail) jump back to this agent's step. */
	onReject?: { goto: string; max?: number };
	/** Extra instructions for this step on top of the agent's own. */
	instructions?: string;
	/** Permission overrides for this step only, merged over the agent's (e.g. no pushing from build). */
	permissions?: PermissionSet;
}

export interface WorkflowDef {
	label: string;
	description: string;
	steps: WorkflowStep[];
}

export interface ModesConfig {
	/** Mode active on startup: an agent name, a workflow name, or "off". */
	defaultMode: string;
	/** Modes visited by the cycle shortcut (ctrl+alt+m). */
	cycle: string[];
	/** Rules applied in every mode (including "off"); only explicit matches count. */
	global: PermissionSet;
	agents: Record<string, AgentDef>;
	workflows: Record<string, WorkflowDef>;
	/** Auto-deny "ask" prompts after this many ms (0 = wait forever). */
	askTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Bash rule building blocks
// ---------------------------------------------------------------------------

const rules = (action: Action, patterns: string[]): Record<string, Action> =>
	Object.fromEntries(patterns.map((p) => [p, action]));

/** Commands that only inspect state. */
export const READ_ONLY_BASH = [
	"ls", "ls *", "pwd", "cat *", "head *", "tail *", "less *", "wc *", "file *", "stat *", "du *", "df", "df *",
	"tree", "tree *", "which *", "type *", "whereis *", "echo *", "printf *", "env", "printenv", "printenv *",
	"uname", "uname *", "whoami", "id", "date", "date *", "uptime", "ps", "ps *", "free", "free *",
	"grep *", "egrep *", "rg *", "fd *", "find *", "sort *", "uniq *", "cut *", "tr *", "diff *", "cmp *",
	"jq *", "yq *", "sed -n *", "basename *", "dirname *", "realpath *", "readlink *", "md5sum *", "sha256sum *",
	"git status", "git status *", "git diff", "git diff *", "git log", "git log *", "git show", "git show *",
	"git blame *", "git branch", "git branch -a", "git branch -v*", "git branch --list*", "git branch --show-current",
	"git remote", "git remote -v", "git rev-parse *", "git ls-files*", "git ls-tree *", "git describe*",
	"git config --get *", "git config --list", "git stash list", "git tag", "git tag -l*", "git shortlog*",
	"node --version", "node -v", "npm --version", "npm ls*", "npm list*", "npm view *", "npm outdated*",
	"python --version", "python3 --version", "pip list*", "pip show *", "cargo --version", "go version",
	"tokei*", "cloc *",
	// bare filters (stdin / pipelines / heredocs)
	"cat", "head", "tail", "wc", "sort", "uniq", "cut *", "tr *", "jq", "less", "nl", "column", "column *", "fmt", "rev", "true", "false",
];

/** Escape hatches that can do anything; never auto-allow. */
const FIND_SIDE_EFFECTS = ["find * -delete*", "find * -exec *", "find * -execdir *", "find * -ok *", "fd * -x *", "fd * --exec*"];
const SHELL_ESCAPES = ["bash -c *", "sh -c *", "zsh -c *", "eval *", "xargs *", "sed -i*", "awk *", "perl *", "python -c *", "python3 -c *", "node -e *"];

/** Clearly destructive or system-level commands. */
export const DESTRUCTIVE_BASH = [
	"rm *", "rmdir *", "mv *", "cp *", "mkdir *", "touch *", "chmod *", "chown *", "chgrp *", "ln *", "tee *",
	"truncate *", "dd *", "shred *", "kill *", "pkill *", "killall *", "sudo *", "su", "su *", "reboot*", "shutdown*",
	"systemctl *", "service *", "crontab *", "mkfs*", "mount *", "umount *",
	"git add *", "git commit*", "git push*", "git pull*", "git merge*", "git rebase*", "git reset*", "git checkout*",
	"git switch*", "git restore*", "git clean*", "git stash*", "git cherry-pick*", "git revert*", "git tag *",
	"git branch -d*", "git branch -D*", "git init*", "git clone*", "git rm *", "git mv *",
	"npm install*", "npm i *", "npm ci*", "npm uninstall*", "npm update*", "npm publish*", "npm link*",
	"yarn add*", "yarn remove*", "yarn install*", "pnpm add*", "pnpm remove*", "pnpm install*", "bun add*", "bun install*",
	"pip install*", "pip uninstall*", "uv add*", "uv pip install*", "cargo install*", "go install*",
	"apt *", "apt-get *", "brew *", "dnf *", "pacman *", "docker *", "kubectl *", "terraform apply*", "terraform destroy*",
];

const TEST_RUNNERS = [
	"npm test*", "npm run test*", "npm run lint*", "npm run check*", "npm run typecheck*", "npm run build*", "npx tsc*",
	"npx vitest*", "npx jest*", "npx eslint*", "npx biome*", "npx playwright test*", "yarn test*", "pnpm test*", "bun test*",
	"pytest*", "python -m pytest*", "python3 -m pytest*", "uv run pytest*", "go test*", "go vet*", "cargo test*",
	"cargo check*", "cargo clippy*", "make test*", "make check*", "mvn test*", "gradle test*", "./gradlew test*",
	"ruff *", "mypy *", "tsc*", "eslint *", "vitest*", "jest*",
];

const SECURITY_SCANNERS = [
	"npm audit*", "yarn audit*", "pnpm audit*", "pip-audit*", "safety check*", "bandit *", "semgrep *", "gitleaks *",
	"trufflehog *", "trivy *", "osv-scanner *", "cargo audit*", "govulncheck*", "snyk test*",
];

const PERF_TOOLS = ["hyperfine *", "time *", "/usr/bin/time *", "npx clinic*", "py-spy *", "perf stat *", "go test -bench*", "cargo bench*", "npm run bench*"];

/** Read-only investigation bash policy. */
const readOnlyBash = (extraAllow: string[] = [], fallback: Action = "ask") => ({
	"*": fallback,
	...rules("allow", READ_ONLY_BASH),
	...rules("allow", extraAllow),
	...rules("ask", [...FIND_SIDE_EFFECTS, ...SHELL_ESCAPES]),
	...rules("deny", DESTRUCTIVE_BASH),
});

const READ_TOOLS = { read: "allow", grep: "allow", find: "allow", ls: "allow", ask_user: "allow" } as const;
const NO_WRITES = { edit: "deny", write: "deny" } as const;
/** In workflows that end with a ship phase, building/testing must not commit or push. */
const NO_SHIPPING: PermissionSet = {
	bash: rules("deny", ["git commit*", "git push*", "git tag *", "gh pr create*", "glab mr create*", "npm publish*"]),
};
const NO_SHIPPING_NOTE = "Do not commit or push — the ship phase does that.";

const SECRET_FILES = { "**/.env": "ask", "**/.env.*": "ask", "**/*.pem": "deny", "**/*.key": "deny", "**/id_rsa*": "deny" } as const;

// ---------------------------------------------------------------------------
// Built-in agents
// ---------------------------------------------------------------------------

export const DEFAULT_AGENTS: Record<string, AgentDef> = {
	explore: {
		label: "Explore",
		description: "Read-only codebase reconnaissance; gathers context, asks questions",
		tools: ["read", "grep", "find", "ls", "bash", "ask_user"],
		permissions: { "*": "deny", ...READ_TOOLS, ...NO_WRITES, bash: readOnlyBash() },
		instructions: `You are the EXPLORE agent. Understand the problem and the relevant code; change nothing.
- Locate relevant files with grep/find, read key sections, trace types and call paths.
- If requirements are ambiguous or a decision depends on the user's preference, use ask_user (batch questions).
- Output: problem restatement, relevant files (path:lines + why), key facts/constraints, open questions, risks.`,
		statuses: ["done", "blocked"],
	},
	plan: {
		label: "Plan",
		description: "Designs a concrete implementation plan; may only write plan files",
		tools: ["read", "grep", "find", "ls", "bash", "write", "edit", "ask_user"],
		permissions: {
			"*": "deny",
			...READ_TOOLS,
			bash: readOnlyBash(),
			write: { "*": "deny", ".pi/plans/**": "allow", "**/PLAN.md": "allow" },
			edit: { "*": "deny", ".pi/plans/**": "allow", "**/PLAN.md": "allow" },
		},
		instructions: `You are the PLAN agent. Produce an implementation plan; do not modify source code.
- Ask the user (ask_user) about unclear requirements or trade-offs before committing to a design.
- Plan format: Goal (1 line) · numbered Steps (file + concrete change each) · Files to modify/create · Tests to add/update · Risks.
- Optionally save it to .pi/plans/<slug>.md.`,
		handoff: "build",
		statuses: ["done", "blocked"],
	},
	build: {
		label: "Build",
		description: "Implements changes; full edit access, risky commands need approval",
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "ask_user"],
		permissions: {
			"*": "ask",
			...READ_TOOLS,
			edit: { "*": "allow", "../**": "ask", ".git/**": "deny", ...SECRET_FILES },
			write: { "*": "allow", "../**": "ask", ".git/**": "deny", ...SECRET_FILES },
			bash: {
				"*": "allow",
				...rules("ask", [
					"rm -r*", "rm -f*", "rm -rf*", "sudo *", "git push*", "git reset --hard*", "git clean*", "git checkout -- *",
					"git rebase*", "git branch -D*", "npm publish*", "docker *", "kubectl *", "terraform *",
					// piping into a shell (`curl … | sh`) splits into a bare `sh`/`bash` segment
					"sh", "bash", "zsh", "sh -s*", "bash -s*",
					"chmod -R*", "chown *", "kill *", "pkill *", "dd *",
				]),
				...rules("deny", ["git push --force*", "git push -f*", "rm -rf /", "rm -rf ~*", "mkfs*"]),
			},
		},
		instructions: `You are the BUILD agent. Implement the plan with focused, minimal, correct changes.
- Read before editing; prefer surgical edits; follow existing style.
- Run the project's type-check/lint/tests for touched areas when available.
- If something unexpected blocks you, stop and explain (or use ask_user) instead of hacking around it.
- Finish with: files changed (one line each) and anything left undone.`,
		statuses: ["done", "blocked"],
	},
	review: {
		label: "Review",
		description: "Code review of the current changes; read-only",
		tools: ["read", "grep", "find", "ls", "bash", "ask_user"],
		permissions: { "*": "deny", ...READ_TOOLS, ...NO_WRITES, bash: readOnlyBash() },
		instructions: `You are the REVIEW agent. Review the current changes (start with git diff / git status); change nothing.
- Check correctness, edge cases, error handling, readability, consistency with the codebase, missing tests.
- Report findings as: Critical (must fix) · Warnings (should fix) · Nits, each with file:line and a concrete fix.
- Verdict: "approved" only when nothing Critical or Warning remains.`,
		statuses: ["approved", "changes_requested", "blocked"],
	},
	test: {
		label: "Test",
		description: "Writes/runs tests; may only edit test files",
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "ask_user"],
		permissions: {
			"*": "deny",
			...READ_TOOLS,
			edit: testFileRule(),
			write: testFileRule(),
			bash: {
				...readOnlyBash(TEST_RUNNERS, "ask"),
				...rules("allow", ["mkdir -p *test*", "mkdir -p *spec*"]),
			},
		},
		instructions: `You are the TEST agent. Verify the change works.
- Run the existing test/type-check/lint commands; add or update tests for the new behaviour (test files only).
- Never change non-test source to make tests pass — report the failure instead.
- Report: commands run, pass/fail counts, failing test names with the key error lines.`,
		statuses: ["pass", "fail", "blocked"],
	},
	"safe-build": {
		label: "Safe build",
		description: "Extra-cautious build: reads freely, but every edit, write, and bash command needs approval",
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "ask_user"],
		permissions: {
			"*": "deny",
			...READ_TOOLS,
			edit: { "*": "ask", ...SECRET_FILES },
			write: { "*": "ask", ...SECRET_FILES },
			bash: { "*": "ask", ...rules("allow", READ_ONLY_BASH), ...rules("deny", DESTRUCTIVE_BASH) },
		},
		instructions: `You are the SAFE-BUILD agent. Implement with maximum caution; the user approves every change and command.
- Read/analyze freely. Make one change at a time; approval prompts cover each edit/write/command.
- Never batch risky changes or chain destructive commands.
- Finish with: files changed (one line each) and anything left undone.`,
		statuses: ["done", "blocked"],
	},
	security: {
		label: "Security audit",
		description: "Security & safety audit; read-only plus scanners",
		tools: ["read", "grep", "find", "ls", "bash", "ask_user"],
		permissions: { "*": "deny", ...READ_TOOLS, ...NO_WRITES, bash: readOnlyBash(SECURITY_SCANNERS) },
		instructions: `You are the SECURITY & SAFETY AUDIT agent. Find vulnerabilities and unsafe behaviour; change nothing.
- Check: injection (SQL/shell/path), authn/authz gaps, secrets in code/logs, unsafe deserialization, SSRF, XSS/CSRF,
  insecure defaults, dependency CVEs (use available scanners), unsafe file/process handling, data-loss risks, missing input validation.
- Report each finding: severity (critical/high/medium/low), file:line, exploit scenario, concrete fix.`,
		statuses: ["approved", "changes_requested", "blocked"],
	},
	perf: {
		label: "Performance audit",
		description: "Performance audit; read-only plus profilers/benchmarks (ask)",
		tools: ["read", "grep", "find", "ls", "bash", "ask_user"],
		permissions: {
			"*": "deny",
			...READ_TOOLS,
			...NO_WRITES,
			bash: { ...readOnlyBash(), ...rules("ask", PERF_TOOLS) },
		},
		instructions: `You are the PERFORMANCE AUDIT agent. Find performance problems; change nothing.
- Look for: algorithmic complexity hot spots, N+1 queries, redundant I/O, blocking calls on hot paths, unbounded memory,
  missing caching/batching, large bundle/startup costs. Measure when possible (benchmarks need approval).
- Report each finding: impact (high/med/low), file:line, evidence, concrete fix and expected gain.`,
		statuses: ["approved", "changes_requested", "blocked"],
	},
	ship: {
		label: "Ship",
		description: "Commits and pushes the finished change; push needs approval",
		tools: ["read", "ls", "bash", "ask_user"],
		permissions: {
			"*": "deny",
			read: "allow",
			ls: "allow",
			ask_user: "allow",
			...NO_WRITES,
			bash: {
				"*": "deny",
				...rules("allow", READ_ONLY_BASH),
				...rules("allow", ["git add *", "git commit *", "git checkout -b *", "git switch -c *", "git fetch*", "git stash list"]),
				...rules("ask", ["git push", "git push *", "gh pr create*", "glab mr create*", "git pull --rebase*"]),
				...rules("deny", ["git push --force*", "git push -f*", "git reset*", "git clean*", "git rebase -i*"]),
			},
		},
		instructions: `You are the SHIP agent. Deliver the finished change.
- Check git status/diff; stage only files belonging to this change (never secrets or unrelated files).
- If on the default branch and the repo uses feature branches, create one first.
- Commit with a conventional, descriptive message; then push (the user approves the push).
- Report: branch, commit hash + message, push result / PR link.`,
		statuses: ["done", "blocked"],
	},
};

function testFileRule(): Record<string, Action> {
	return {
		"*": "deny",
		"**/*.test.*": "allow",
		"**/*.spec.*": "allow",
		"**/*_test.*": "allow",
		"**/test_*.py": "allow",
		"**/test/**": "allow",
		"**/tests/**": "allow",
		"**/__tests__/**": "allow",
		"**/__snapshots__/**": "allow",
		"**/fixtures/**": "allow",
	};
}

// ---------------------------------------------------------------------------
// Built-in workflows
// ---------------------------------------------------------------------------

export const DEFAULT_WORKFLOWS: Record<string, WorkflowDef> = {
	e2e: {
		label: "End to end",
		description: "problem → explore → plan (approve) → test-spec → build ⇄ review → test-validate → ship",
		steps: [
			{ agent: "explore" },
			{ agent: "plan", gate: true },
			{ agent: "test", instructions: "TDD SPECIFICATION: Write failing specification tests first to define the expected behavior. Do not touch application code." },
			{ agent: "build", permissions: NO_SHIPPING, instructions: "Implement the solution to make pre-written specification tests pass. " + NO_SHIPPING_NOTE },
			{ agent: "review", onReject: { goto: "build", max: 3 } },
			{ agent: "test", onReject: { goto: "build", max: 3 }, permissions: NO_SHIPPING, instructions: "TDD VALIDATION: Confirm all specification tests and existing tests pass. " + NO_SHIPPING_NOTE },
			{ agent: "ship" },
		],
	},
	"plan-build": {
		label: "Plan & build",
		description: "explore → plan (approve) → test-spec → build ⇄ review (no push)",
		steps: [
			{ agent: "explore" },
			{ agent: "plan", gate: true },
			{ agent: "test", instructions: "TDD SPECIFICATION: Write failing specification tests first to define the expected behavior. Do not touch application code." },
			{ agent: "build", permissions: NO_SHIPPING, instructions: "Implement the solution to make pre-written specification tests pass; leave changes uncommitted for the user." },
			{ agent: "review", onReject: { goto: "build", max: 3 } },
		],
	},
	audit: {
		label: "Audit",
		description: "explore → security audit → performance audit (report only)",
		steps: [{ agent: "explore" }, { agent: "security" }, { agent: "perf" }],
	},
};

export const DEFAULT_GLOBAL: PermissionSet = {
	bash: rules("deny", ["rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf ~/*", "sudo rm -rf *", ":(){*", "mkfs*", "dd * of=/dev/*"]),
	write: rules("deny", ["~/.ssh/**", "~/.gnupg/**", "~/.pi/agent/auth.json"]),
	edit: rules("deny", ["~/.ssh/**", "~/.gnupg/**", "~/.pi/agent/auth.json"]),
	read: rules("ask", ["~/.ssh/**", "~/.gnupg/**", "~/.pi/agent/auth.json", "**/.env", "**/.env.*"]),
};

export function defaultConfig(): ModesConfig {
	return {
		defaultMode: "off",
		cycle: ["off", "explore", "plan", "build", "test", "safe-build", "review", "security", "e2e"],
		global: structuredClone(DEFAULT_GLOBAL),
		agents: structuredClone(DEFAULT_AGENTS),
		workflows: structuredClone(DEFAULT_WORKFLOWS),
		askTimeoutMs: 0,
	};
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type PartialConfig = Partial<Omit<ModesConfig, "agents" | "workflows">> & {
	agents?: Record<string, Partial<AgentDef> | null>;
	workflows?: Record<string, WorkflowDef | null>;
};

export const USER_CONFIG_PATH = () => path.join(getAgentDir(), "agent-modes.json");
export const PROJECT_CONFIG_PATH = (cwd: string) => path.join(cwd, CONFIG_DIR_NAME, "agent-modes.json");

function readJson(file: string, errors: string[]): PartialConfig | undefined {
	if (!fs.existsSync(file)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as PartialConfig;
	} catch (e) {
		errors.push(`${file}: ${(e as Error).message}`);
		return undefined;
	}
}

function apply(cfg: ModesConfig, over: PartialConfig) {
	if (over.defaultMode) cfg.defaultMode = over.defaultMode;
	if (over.cycle) cfg.cycle = over.cycle;
	if (typeof over.askTimeoutMs === "number") cfg.askTimeoutMs = over.askTimeoutMs;
	if (over.global) cfg.global = mergePermissionSets(cfg.global, over.global);
	for (const [name, a] of Object.entries(over.agents ?? {})) {
		if (a === null) {
			delete cfg.agents[name];
			continue;
		}
		const prev = cfg.agents[name];
		cfg.agents[name] = {
			label: a.label ?? prev?.label ?? name,
			description: a.description ?? prev?.description ?? "",
			tools: a.tools ?? prev?.tools ?? ["read", "grep", "find", "ls", "ask_user"],
			permissions: mergePermissionSets(prev?.permissions ?? { "*": "ask" }, a.permissions),
			instructions: a.instructions ?? prev?.instructions ?? "",
			model: a.model ?? prev?.model,
			thinkingLevel: a.thinkingLevel ?? prev?.thinkingLevel,
			handoff: a.handoff ?? prev?.handoff,
			statuses: a.statuses ?? prev?.statuses,
		};
	}
	for (const [name, w] of Object.entries(over.workflows ?? {})) {
		if (w === null) delete cfg.workflows[name];
		else cfg.workflows[name] = w;
	}
}

export function loadConfig(cwd: string, projectTrusted: boolean): { config: ModesConfig; errors: string[] } {
	const errors: string[] = [];
	const config = defaultConfig();
	const user = readJson(USER_CONFIG_PATH(), errors);
	if (user) apply(config, user);
	if (projectTrusted) {
		const project = readJson(PROJECT_CONFIG_PATH(cwd), errors);
		if (project) apply(config, project);
	}
	for (const [wname, wf] of Object.entries(config.workflows)) {
		for (const step of wf.steps) {
			if (!config.agents[step.agent]) errors.push(`workflow "${wname}": unknown agent "${step.agent}"`);
		}
		if (config.agents[wname]) errors.push(`"${wname}" is both an agent and a workflow; the agent wins`);
	}
	return { config, errors };
}
