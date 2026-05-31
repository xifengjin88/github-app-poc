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

/**
 * Post the cost review to the PR as a single bundled GitHub review: a summary
 * body plus inline comments anchored to the relevant lines. Findings whose line
 * can't be matched to the diff are folded into the summary. Falls back to a plain
 * PR comment if the review API rejects the request.
 */
export async function postCostReview(
  octokit: Octokit,
  ref: PullRequestRef,
  review: CostReview,
  diff: string,
  grounded: boolean,
): Promise<void> {
  const commentable = parseCommentableLines(diff);
  const { anchored, unanchored } = splitFindings(review.findings, commentable);
  const body = renderSummaryBody(review, ref, unanchored, grounded);

  try {
    await octokit.rest.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.prNumber,
      event: "COMMENT",
      body,
      comments: anchored,
    });
  } catch (error) {
    console.error("[postCostReview] createReview failed; falling back to a PR comment", error);
    await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.prNumber,
      body,
    });
  }
}
