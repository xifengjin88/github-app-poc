import type { Octokit } from "@octokit/rest";
import { parseCommentableLines } from "./diff.js";
import { renderFindingBody, renderSummaryBody } from "./render.js";
import type { CostReview, Finding, PullRequestRef } from "./review.js";

interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

/** Split findings into those we can anchor to a diff line and those we can't. */
export function splitFindings(
  findings: Finding[],
  commentable: Map<string, Set<number>>,
): { anchored: ReviewComment[]; unanchored: Finding[] } {
  const anchored: ReviewComment[] = [];
  const unanchored: Finding[] = [];
  for (const finding of findings) {
    if (commentable.get(finding.path)?.has(finding.line)) {
      anchored.push({
        path: finding.path,
        line: finding.line,
        side: "RIGHT",
        body: renderFindingBody(finding),
      });
    } else {
      unanchored.push(finding);
    }
  }
  return { anchored, unanchored };
}

/** Post an in-progress status comment on the PR; returns its comment id to edit later. */
export async function postStatusComment(
  octokit: Octokit,
  ref: PullRequestRef,
  body: string,
): Promise<number> {
  const { data } = await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.prNumber,
    body,
  });
  return data.id;
}

/** Edit a previously-posted comment in place (e.g. status → final summary). */
export async function updateComment(
  octokit: Octokit,
  ref: PullRequestRef,
  commentId: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.updateComment({
    owner: ref.owner,
    repo: ref.repo,
    comment_id: commentId,
    body,
  });
}

/**
 * Post the cost review. The summary report goes into `statusCommentId` (edited
 * in place from the in-progress placeholder, CodeRabbit-style); the inline
 * findings are posted as a bundled GitHub review. When no status comment is
 * given, the summary is posted as the review body instead. Findings whose line
 * can't be matched to the diff are folded into the summary so nothing is lost.
 */
export async function postCostReview(
  octokit: Octokit,
  ref: PullRequestRef,
  review: CostReview,
  diff: string,
  grounded: boolean,
  statusCommentId?: number,
): Promise<void> {
  const commentable = parseCommentableLines(diff);
  const { anchored, unanchored } = splitFindings(review.findings, commentable);
  const summary = renderSummaryBody(review, ref, unanchored, grounded);

  if (statusCommentId !== undefined) {
    // Replace the "in progress" placeholder with the summary report.
    await updateComment(octokit, ref, statusCommentId, summary);
    if (anchored.length > 0) {
      await octokit.rest.pulls
        .createReview({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.prNumber,
          event: "COMMENT",
          body: "🤖 Cloud-cost review — see the summary comment above.",
          comments: anchored,
        })
        .catch((error) => console.error("[postCostReview] inline review failed", error));
    }
    return;
  }

  // No status comment: put the summary in the review body.
  try {
    await octokit.rest.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.prNumber,
      event: "COMMENT",
      body: summary,
      comments: anchored,
    });
  } catch (error) {
    console.error("[postCostReview] createReview failed; falling back to a PR comment", error);
    await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.prNumber,
      body: summary,
    });
  }
}
