import type { Octokit } from "@octokit/rest";
import { postCostReview, postStatusComment, updateComment } from "./post.js";
import {
  analyzeInfraDiff,
  collectInfraDiff,
  type PullRequestRef,
  type ReviewStatus,
} from "./review.js";

/**
 * The full review pipeline:
 *  1. fetch the diff and keep only infrastructure changes (fast, no LLM),
 *  2. post an "in progress" status comment so the PR shows activity immediately,
 *  3. run the cost analysis,
 *  4. edit the status comment into the summary report + post inline findings.
 *
 * Shared by the @mention and automatic pull_request paths. Returns the outcome
 * so callers can react to `no-infra`/`empty` (skip silently, or post a note).
 */
export async function runCostReview(
  octokit: Octokit,
  ref: PullRequestRef,
  installationId?: number,
): Promise<ReviewStatus> {
  const { status, diff, files } = await collectInfraDiff(octokit, ref);
  if (status !== "reviewed") return status;

  const fileWord = files.length === 1 ? "file" : "files";
  const statusCommentId = await postStatusComment(
    octokit,
    ref,
    `⏳ **Reviewing infrastructure changes for cloud-cost impact…** (${files.length} Terraform ${fileWord})`,
  );

  try {
    const { review, grounded } = await analyzeInfraDiff(diff, ref, installationId);
    await postCostReview(octokit, ref, review, diff, grounded, statusCommentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateComment(
      octokit,
      ref,
      statusCommentId,
      `⚠️ Cloud-cost review failed: ${message}`,
    ).catch(() => {});
    throw error;
  }

  return status;
}
