import { describe, expect, it } from "vitest";
import { buildReviewPrompt, MAX_DIFF_CHARS, type PullRequestRef, truncateDiff } from "./review.js";

const ref: PullRequestRef = { owner: "octocat", repo: "hello-world", prNumber: 42 };

describe("buildReviewPrompt", () => {
  it("includes the PR coordinates and the diff in a fenced block", () => {
    const prompt = buildReviewPrompt("diff --git a/x b/x", ref);
    expect(prompt).toContain("octocat/hello-world#42");
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("diff --git a/x b/x");
  });
});

describe("truncateDiff", () => {
  it("returns the diff unchanged when under the limit", () => {
    const diff = "small diff";
    expect(truncateDiff(diff, MAX_DIFF_CHARS)).toBe(diff);
  });

  it("truncates and marks an over-long diff", () => {
    const diff = "x".repeat(MAX_DIFF_CHARS + 500);
    const result = truncateDiff(diff, MAX_DIFF_CHARS);
    expect(result.length).toBeLessThan(diff.length);
    expect(result).toContain("diff truncated");
  });

  it("respects a custom max length", () => {
    const result = truncateDiff("abcdefgh", 4);
    expect(result.startsWith("abcd")).toBe(true);
    expect(result).toContain("truncated");
  });
});
