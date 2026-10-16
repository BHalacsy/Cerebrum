// Comprehensive Audit Workflow
// Phase 1: Explore -> Phase 2: Parallel Security Audit & Code Review

const problem = args.problem || "Perform comprehensive codebase audit";

// Phase 1: Explore
const explore = await runs.run("explore", {
  agent: "explore",
  task: `Explore codebase architecture, entry points, and dependencies for audit scope:\n${problem}`,
  output: "context.md",
});

// Phase 2: Parallel Security Audit & Quality Review
const [securityRes, reviewRes] = await runs.all([
  {
    key: "security",
    agent: "security",
    task: "Audit codebase for security vulnerabilities, secret leaks, injection flaws, and dependency CVEs.",
  },
  {
    key: "review",
    agent: "review",
    task: "Review codebase quality, architecture consistency, dead code, and maintainability risks.",
  },
]);

return {
  problem,
  status: "completed",
  summary: {
    explored: explore.ok,
    securityAudited: securityRes.ok,
    codeReviewed: reviewRes.ok,
  },
  securityOutput: securityRes.output,
  reviewOutput: reviewRes.output,
};
