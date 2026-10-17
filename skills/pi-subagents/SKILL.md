---
name: pi-subagents
description: |
  Engine guidance for delegating to subagents: single runs, parallel verification,
  context-passing workflows (e2e, audit, plan-build), and isolated child execution.
---

# Pi Subagents Engine

The subagent extension is an execution and context-passing engine that coordinates focused child Pi sessions.
Delegate only when the operator explicitly requests delegation or runs a workflow.

## Available Subagents

The system defines 7 specialized agents under `agents/`:

| Agent | Role | Tools | Context & Outputs |
| :--- | :--- | :--- | :--- |
| `explore` | Read-only codebase reconnaissance; maps architecture and constraints | read, grep, find, ls, bash, contact_supervisor | Output: `context.md` |
| `plan` | Architecture & TDD pre-implementation test plan | read, grep, find, ls, write, edit, contact_supervisor | Reads: `context.md`; Output: `plan.md` |
| `tester` | Writes failing specification tests (RED) and verifies test suite (GREEN) | read, grep, find, ls, bash, edit, write, contact_supervisor | Reads: `context.md`, `plan.md` |
| `build` | Single-writer implementation satisfying tests and `plan.md` | read, grep, find, ls, bash, edit, write, contact_supervisor | Reads: `context.md`, `plan.md` |
| `review` | Code review verifying git diff against plan, edge cases, and quality | read, grep, find, ls, bash, contact_supervisor | Reads: `plan.md`; Output: `Verdict: approved` or `changes_requested` |
| `security` | Security audit scanning diff and dependencies for vulnerabilities | read, grep, find, ls, bash, contact_supervisor | Output: `Verdict: approved` or `changes_requested` |
| `ship` | Delivery specialist; stages verified changes and creates conventional commits | read, ls, bash, contact_supervisor | Forked context; gated push |

---

## Invocation Patterns

### 1. Single Subagent Run

Launch a single bounded task for a specific agent:

```js
subagent({
  agent: "explore",
  task: "Map authentication flow and token storage in src/auth/",
  output: "context.md"
})
```

### 2. Pre-Defined Workflows

Launch registered workflow scripts by name:

- **E2E Workflow (`e2e`)**: Full TDD pipeline (`explore` -> `plan` -> `tester` RED spec -> `build` GREEN -> parallel tri-review loop -> `ship`):
  ```js
  subagent({
    workflow: "e2e",
    args: { problem: "Implement rate limiting middleware for API routes" }
  })
  ```
- **Plan & Build (`plan-build`)**: Explore -> Plan -> Tester Spec -> Build -> Verification (without commit):
  ```js
  subagent({
    workflow: "plan-build",
    args: { problem: "Refactor session store to Redis" }
  })
  ```
- **Comprehensive Audit (`audit`)**: Explore -> Parallel Security & Code Review:
  ```js
  subagent({
    workflow: "audit",
    args: { problem: "Audit user onboarding flow" }
  })
  ```

### 3. Custom Workflow Scripts

To execute multi-step or conditional orchestration, write a fenced ```` ```js workflow ```` block in the reply and call `subagent({ workflow: true })`:

````markdown
```js workflow
// Phase 1: Explore
const recon = await runs.run("explore", {
  agent: "explore",
  task: "Find how subagent options are sanitized",
  output: "context.md"
});

// Phase 2: Parallel Verification
const [reviewRes, secRes] = await runs.all([
  { key: "review", agent: "review", task: "Review changes against context.md" },
  { key: "sec", agent: "security", task: "Security check on input handling" }
]);

return { ok: recon.ok && reviewRes.ok && secRes.ok };
```
````

Followed in the same turn by:
```json
{
  "workflow": true
}
```

---

## Context Passing & Engine Conventions

1. **Artifact Passing**:
   - Write files using `output: "filename.md"`.
   - Subsequent agents declare `defaultReads: ["context.md", "plan.md"]` and automatically load these files into their session context on launch.
   - Outputs can also be passed via JavaScript variables in workflow scripts (`${explore.output}`).

2. **Session Continuation**:
   - Resume an existing agent session with `resume: runId` or `resume: "previous"`.

3. **Supervisor Dialogue**:
   - Child agents can use `contact_supervisor` with `reason: "need_decision"` when an architectural choice or unknown requires guidance from the orchestrator.
   - Do not make speculative assumptions when a supervisor decision is requested.

4. **Async & Background Execution**:
   - Async is enabled by default (`async: true`). Pi notifies the parent upon completion.
   - Use `bg_wait()` only when a blocking same-turn result is strictly required.
