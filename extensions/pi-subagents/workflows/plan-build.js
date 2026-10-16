// Plan & Build Workflow
// Phase 1: Explore -> Phase 2: Plan -> Phase 3: Test Spec -> Phase 4: Build -> Phase 5: Verification (No Ship)

const problem = args.problem || "Plan and implement changes";

// Phase 1: Explore
const explore = await runs.run("explore", {
  agent: "explore",
  task: `Explore codebase for:\n${problem}`,
  output: "context.md",
});

// Phase 2: Plan
const plan = await runs.run("plan", {
  agent: "plan",
  task: `Formulate implementation plan and pre-implementation test specification for:\n${problem}\nRead context.md.`,
  output: "plan.md",
});

// Phase 3: TDD Specification (Tests written BEFORE build to set the standard)
const testSpec = await runs.run("test-spec", {
  agent: "tester",
  task: "TDD SPECIFICATION PHASE:\nWrite failing specification tests in the test suite according to plan.md to set the acceptance standard.\nDo NOT edit application source code.\nVerify that the new tests fail for the intended reason (RED).",
});

// Phase 4: Build
const build = await runs.run("build", {
  agent: "build",
  task: "Implement the solution in application code according to plan.md and make the specification tests pass.",
});

// Phase 5: Verification
const [reviewRes, testValidate] = await runs.all([
  {
    key: "review",
    agent: "review",
    task: "Review code changes against plan.md, edge cases, and code quality.",
  },
  {
    key: "test-validate",
    agent: "tester",
    task: "Verify that all specification tests and existing tests pass.",
  },
]);

return {
  problem,
  status: "completed",
  summary: {
    explored: explore.ok,
    planned: plan.ok,
    testSpec: testSpec.ok,
    built: build.ok,
    reviewed: reviewRes.ok,
    tested: testValidate.ok,
  },
  reviewOutput: reviewRes.output,
  testOutput: testValidate.output,
};
