import type { Octokit } from "@octokit/rest";
import { postCostReview } from "./post.js";
import { generateCostReview, type PullRequestRef, type ReviewStatus } from "./review.js";

/**
 * The full review pipeline: fetch the diff, keep only infrastructure changes,
 * generate the structured cost review, and post it as a bundled GitHub review.
 * Shared by the @mention path and the automatic pull_request path.
 *
 * Returns the outcome so callers can react to `no-infra`/`empty` (e.g. skip
 * silently on auto-review, or post a short note on an @mention).
 */
export async function runCostReview(octokit: Octokit, ref: PullRequestRef): Promise<ReviewStatus> {
  const { status, review, diff, grounded } = await generateCostReview(octokit, ref);
  if (status === "reviewed") {
    await postCostReview(octokit, ref, review, diff, grounded);
  }
  return status;
}
