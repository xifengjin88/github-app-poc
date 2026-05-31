import { describe, expect, it } from "vitest";
import { renderFindingBody, renderSummaryBody } from "./render.js";
import type { CostReview, Finding, PullRequestRef } from "./review.js";

const ref: PullRequestRef = { owner: "octocat", repo: "infra", prNumber: 7 };

const finding: Finding = {
  path: "infra/main.tf",
  line: 11,
  severity: "P1",
  title: "Oversized RDS instance",
  body: "Switching to r6g.4xlarge adds roughly +$2,100/mo (estimate, us-east-1 on-demand).",
  suggestion: '  instance_type = "r6g.large"',
};

describe("renderFindingBody", () => {
  it("includes the severity badge, title, body and a committable suggestion block", () => {
    const out = renderFindingBody(finding);
    expect(out).toContain("🔴 **P1**");
    expect(out).toContain("Oversized RDS instance");
    expect(out).toContain("+$2,100/mo");
    expect(out).toContain("```suggestion");
    expect(out).toContain('instance_type = "r6g.large"');
  });

  it("omits the suggestion block when there is no suggestion", () => {
    const out = renderFindingBody({ ...finding, suggestion: undefined });
    expect(out).not.toContain("```suggestion");
  });
});

describe("renderSummaryBody", () => {
  const review: CostReview = {
    verdict: "major",
    confidence: 4,
    estimatedMonthlyDelta: "+$2,100/mo",
    overview: "This PR materially increases compute spend.",
    changedFiles: [{ path: "infra/main.tf", costImpact: "Upsizes the web instance" }],
    findings: [finding],
  };

  it("renders the verdict, delta, confidence, severity tally and changed files", () => {
    const out = renderSummaryBody(review, ref, [], true);
    expect(out).toContain("Major cost impact");
    expect(out).toContain("+$2,100/mo");
    expect(out).toContain("Confidence:** 4/5");
    expect(out).toContain("1 P1");
    expect(out).toContain("`infra/main.tf`");
    expect(out).toContain("octocat/infra#7");
  });

  it("lists unanchored findings so nothing is lost", () => {
    const out = renderSummaryBody(review, ref, [finding], true);
    expect(out).toContain("Additional findings");
    expect(out).toContain("`infra/main.tf:11`");
  });

  it("shows the data source: grounded vs estimate", () => {
    expect(renderSummaryBody(review, ref, [], true)).toContain("grounded in **Archera**");
    expect(renderSummaryBody(review, ref, [], false)).toContain("model estimates");
  });
});
