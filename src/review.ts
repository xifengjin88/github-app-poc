import { anthropic } from "@ai-sdk/anthropic";
import type { Octokit } from "@octokit/rest";
import { generateObject, generateText, stepCountIs } from "ai";
import { z } from "zod";
import { connectArchera } from "./archera.js";
import { annotateDiff, truncateDiff } from "./diff.js";
import { filterDiffToInfra } from "./infra.js";

/** A GitHub pull request to review. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  prNumber: number;
}

/** Diffs larger than this are truncated before being sent to the model. */
export const MAX_DIFF_CHARS = 100_000;

const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Severity by magnitude / risk of the cost impact. */
export const SeveritySchema = z.enum(["P1", "P2", "P3"]);
export type Severity = z.infer<typeof SeveritySchema>;

/** Overall cost verdict for the PR. */
export const VerdictSchema = z.enum(["no-cost-impact", "minor", "significant", "major"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const FindingSchema = z.object({
  path: z.string().describe("Repo-relative file path the finding applies to."),
  line: z
    .number()
    .int()
    .describe(
      "The NEW-file line number to attach the comment to. Use the number prefixed on the diff line (added or context lines only).",
    ),
  severity: SeveritySchema.describe(
    "P1 = large/risky cost increase (e.g. >$500/mo or unbounded scaling); P2 = moderate; P3 = minor or an optimization opportunity.",
  ),
  title: z.string().describe("Short headline, e.g. 'Oversized RDS instance'."),
  body: z
    .string()
    .describe(
      "Explanation of the cost impact, including an estimated monthly $ delta (state it's an estimate; assume us-east-1 on-demand unless the diff says otherwise).",
    ),
  suggestion: z
    .string()
    .optional()
    .describe(
      "Only if a concrete cheaper drop-in exists: the exact replacement code for that line (a committable GitHub suggestion). Omit otherwise.",
    ),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CostReviewSchema = z.object({
  verdict: VerdictSchema,
  confidence: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("Your confidence in this cost assessment, 1 (low) to 5 (high)."),
  estimatedMonthlyDelta: z
    .string()
    .describe(
      "Human-readable estimated change in monthly cloud spend, e.g. '+$2,100/mo', '-$300/mo', or 'negligible'.",
    ),
  overview: z.string().describe("1-3 sentence summary of the PR's overall cloud-cost impact."),
  changedFiles: z
    .array(
      z.object({
        path: z.string(),
        costImpact: z.string().describe("One line on this file's cost relevance, or 'none'."),
      }),
    )
    .describe("Every changed file with a one-line cost note."),
  findings: z
    .array(FindingSchema)
    .describe("Cost-relevant findings. Empty if the PR has no cost impact."),
  mermaid: z
    .string()
    .optional()
    .describe(
      "Optional Mermaid diagram (no fences) showing cost-affecting resource flow, only if it adds clarity. Omit otherwise.",
    ),
});
export type CostReview = z.infer<typeof CostReviewSchema>;

const SYSTEM_PROMPT = `You are a cloud FinOps reviewer. You review a pull request's unified git diff and assess its impact on cloud spend (AWS, GCP, Azure). Review ONLY the changes shown.

Look for changes that affect cost, especially in infrastructure-as-code (Terraform, CloudFormation, CDK, Pulumi, Serverless, Kubernetes manifests, Helm):
- New or removed billable resources (compute, databases, load balancers, NAT gateways, caches, search clusters, GPUs).
- Instance type / size / family changes (e.g. on-demand vs Graviton, x86 vs ARM).
- Counts, replicas, desired capacity, and autoscaling min/max — especially unbounded scaling.
- Storage class/size/IOPS (gp2 vs gp3, provisioned IOPS, retention, snapshots, cross-region replication).
- Data transfer / NAT / egress, always-on vs scheduled resources, managed-service tiers.
- Logging/metrics retention and sampling.

Severity:
- P1: large or risky monthly increase (roughly >$500/mo, or unbounded/uncapped scaling).
- P2: moderate increase or notable inefficiency.
- P3: minor cost or a small optimization opportunity.

Rules:
- Estimate the monthly $ delta where you reasonably can; say so explicitly that it's an estimate and assume us-east-1 on-demand pricing unless the diff specifies a region. If you cannot estimate, say "unknown".
- Do NOT invent prices precisely; ranges are fine. Do NOT flag changes with no plausible cost impact.
- Provide a 'suggestion' only when there's a concrete, cheaper, drop-in replacement for that exact line (e.g. a smaller/Graviton instance, gp3 instead of gp2, adding a lifecycle/retention policy). The suggestion must be valid replacement code for that line.
- 'line' MUST be a line number shown in the prefix of the diff (added or context lines only).
- If the PR has no cloud-cost impact (e.g. pure application/docs/test changes), return verdict "no-cost-impact", an empty findings array, and a brief overview saying so.`;

/** Build the user prompt sent to the model. Pure function — unit tested. */
export function buildReviewPrompt(diff: string, ref: PullRequestRef): string {
  return `Pull request: ${ref.owner}/${ref.repo}#${ref.prNumber}

Each changed line below is prefixed with its NEW-file line number and a tab. Use that number for a finding's "line". Comment only on lines that have a number prefix.

\`\`\`diff
${diff}
\`\`\``;
}

export { truncateDiff };

/** A neutral review used when there's nothing to analyze. */
export function emptyReview(overview: string): CostReview {
  return {
    verdict: "no-cost-impact",
    confidence: 5,
    estimatedMonthlyDelta: "negligible",
    overview,
    changedFiles: [],
    findings: [],
  };
}

const GROUNDING_SYSTEM = `${SYSTEM_PROMPT}

You have Archera tools that return REAL cloud prices and savings for the connected account. For any cost-affecting resource in the diff, look up the actual on-demand price and any reservation/commitment savings before judging impact. Note the concrete numbers you find (price, region, monthly cost, savings %). Be efficient: only look up resources that actually appear in the diff.`;

/** Format an analysis (grounded or not) into the structured schema. */
async function structureReview(
  model: string,
  annotatedDiff: string,
  ref: PullRequestRef,
  groundingNotes: string | null,
): Promise<CostReview> {
  const notes = groundingNotes
    ? `\n\nUse these REAL Archera pricing/savings findings (prefer them over your own price estimates):\n${groundingNotes}`
    : "";
  const { object } = await generateObject({
    model: anthropic(model),
    schema: CostReviewSchema,
    maxOutputTokens: 4000,
    system: SYSTEM_PROMPT,
    prompt: `${buildReviewPrompt(annotatedDiff, ref)}${notes}`,
  });
  return object;
}

/** Outcome of a review attempt. `no-infra` means the PR changed no infra files. */
export type ReviewStatus = "reviewed" | "no-infra" | "empty";

export interface ReviewResult {
  status: ReviewStatus;
  review: CostReview;
  /** The infra-only diff the poster uses to anchor inline comments. */
  diff: string;
  grounded: boolean;
  /** Infra files that were reviewed. */
  files: string[];
}

/**
 * Fetch a PR's diff, keep only the infrastructure files, and produce a
 * structured cloud-cost review with Claude. When Archera is configured, the
 * model first looks up real prices/savings via Archera's MCP tools, then those
 * numbers are folded into the structured review.
 *
 * Returns a status so callers can skip posting when there's nothing to review.
 */
export async function generateCostReview(
  octokit: Octokit,
  ref: PullRequestRef,
): Promise<ReviewResult> {
  const { data } = await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.prNumber,
    mediaType: { format: "diff" },
  });

  // With `format: "diff"` GitHub returns the raw diff as a string in `data`,
  // even though the static type still says it's the PR object.
  const raw = (data as unknown as string) ?? "";
  if (!raw.trim()) {
    return {
      status: "empty",
      review: emptyReview("No changes found in this PR."),
      diff: "",
      grounded: false,
      files: [],
    };
  }

  // Only review infrastructure changes (Terraform today; extensible in infra.ts).
  const { diff: infraDiff, files } = filterDiffToInfra(raw);
  if (files.length === 0) {
    return {
      status: "no-infra",
      review: emptyReview("No infrastructure changes to cost-review."),
      diff: "",
      grounded: false,
      files: [],
    };
  }

  const diff = truncateDiff(infraDiff, MAX_DIFF_CHARS);
  const annotated = annotateDiff(diff);
  const model = process.env.REVIEW_MODEL ?? DEFAULT_MODEL;

  // Best-effort: if Archera can't connect, degrade to an ungrounded estimate.
  const archera = await connectArchera().catch((error) => {
    console.error("[archera] connection failed; producing an ungrounded review", error);
    return null;
  });

  try {
    if (archera) {
      const grounding = await generateText({
        model: anthropic(model),
        tools: archera.tools,
        stopWhen: stepCountIs(8),
        maxOutputTokens: 2000,
        system: GROUNDING_SYSTEM,
        prompt: `${buildReviewPrompt(annotated, ref)}\n\nLook up real prices/savings for the cost-affecting resources in this diff, then summarize the concrete numbers you found.`,
      });
      const review = await structureReview(model, annotated, ref, grounding.text);
      return { status: "reviewed", review, diff, grounded: true, files };
    }

    const review = await structureReview(model, annotated, ref, null);
    return { status: "reviewed", review, diff, grounded: false, files };
  } finally {
    await archera?.close().catch(() => {});
  }
}
