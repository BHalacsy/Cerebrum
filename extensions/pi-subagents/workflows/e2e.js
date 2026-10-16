// E2E Test-Driven Development Workflow
// Phase 1: Explore -> Phase 2: Plan -> Phase 3: Test Spec (RED) -> Phase 4: Build (GREEN) -> Phase 5: Parallel Tri-Review -> Phase 6: Ship

const problem = args.problem || "Analyze and implement solution";

// Phase 1: Codebase exploration and context gathering
const explore = await runs.run("explore", {
  agent: "explore",
  task: `Explore the codebase, relevant architecture, and constraints for:\n${problem}`,
  output: "context.md",
});

// Phase 2: Architecture and Test-First Planning
const plan = await runs.run("plan", {
  agent: "plan",
  task: `Formulate a concrete implementation plan and pre-implementation test specification for:\n${problem}\nRead context.md.`,
  output: "plan.md",
});

// Phase 3: TDD Specification (Tests written BEFORE build to set the standard)
const testSpec = await runs.run("test-spec", {
  agent: "tester",
  task: "TDD SPECIFICATION PHASE:\nWrite failing specification tests in the test suite according to plan.md to set the acceptance standard.\nDo NOT edit application source code.\nVerify that the new tests fail for the intended reason (RED).",
});

// Phase 4 & 5: Build and Parallel Tri-Review Verification Loop
let loop = 0;
let clean = false;
let feedback = "";
let lastBuild = null;

while (!clean && loop < 3) {
  loop++;

  // Build Phase: Implement application changes to satisfy pre-written tests
  lastBuild = await runs.run(`build-${loop}`, {
    agent: "build",
    task: `TDD IMPLEMENTATION PHASE (Loop ${loop}/3):\nImplement the solution in application code according to plan.md and make the specification tests pass.\n${feedback ? `Feedback to address:\n${feedback}` : ""}`,
  });

  // Parallel Verification: Code Review, Security Audit, and Test Suite Validation
  const [reviewRes, secRes, testValidate] = await runs.all([
    {
      key: `review-${loop}`,
      agent: "review",
      task: `Review code changes against plan.md, edge cases, and maintainability (Loop ${loop}).`,
    },
    {
      key: `security-${loop}`,
      agent: "security",
      task: `Security & safety audit of the diff for vulnerabilities, secret leaks, and insecure code (Loop ${loop}).`,
    },
    {
      key: `test-validate-${loop}`,
      agent: "tester",
      task: `TDD VALIDATION PHASE (Loop ${loop}):\nRun the test suite via bash. Verify all specification tests and existing tests pass (GREEN).`,
    },
  ]);

  const reviewText = reviewRes.output || "";
  const secText = secRes.output || "";
  const testText = testValidate.output || "";

  const reviewApproved = reviewText.includes("Verdict: approved") || !reviewText.includes("changes_requested");
  const secApproved = secText.includes("Verdict: approved") || !secText.includes("changes_requested");
  const testPassed = testText.includes("pass") && !testText.includes("Verdict: fail");

  if (reviewApproved && secApproved && testPassed) {
    clean = true;
  } else {
    feedback = [
      reviewApproved ? "" : `[Code Review Findings]:\n${reviewText}`,
      secApproved ? "" : `[Security Audit Findings]:\n${secText}`,
      testPassed ? "" : `[Test Validation Failures]:\n${testText}`,
    ].filter(Boolean).join("\n\n");
  }
}

// Phase 6: Ship (Delivery)
let shipResult = null;
if (clean) {
  shipResult = await runs.run("ship", {
    agent: "ship",
    task: `Stage verified implementation and test files for: ${problem}.\nWrite a descriptive conventional commit.`,
  });
}

return {
  problem,
  status: clean ? "completed" : "verification_failed",
  loops: loop,
  summary: {
    explored: explore.ok,
    planned: plan.ok,
    testSpec: testSpec.ok,
    build: lastBuild?.ok,
    reviewApproved: clean,
    shipped: shipResult?.ok ?? false,
  },
  shipOutput: shipResult?.output ?? null,
};
