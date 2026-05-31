import type { CostReview, Finding, PullRequestRef, Severity, Verdict } from "./review.js";

const SEVERITY_BADGE: Record<Severity, string> = {
  P1: "🔴 **P1**",
  P2: "🟡 **P2**",
  P3: "🔵 **P3**",
};

const VERDICT_BADGE: Record<Verdict, string> = {
  "no-cost-impact": "✅ No cost impact",
  minor: "🟢 Minor cost impact",
  significant: "🟠 Significant cost impact",
  major: "🔴 Major cost impact",
};

/** Render one finding as the body of an inline review comment. */
export function renderFindingBody(finding: Finding): string {
  const parts = [`${SEVERITY_BADGE[finding.severity]} — ${finding.title}`, "", finding.body];
  if (finding.suggestion?.trim()) {
    parts.push("", "```suggestion", finding.suggestion.replace(/\n+$/, ""), "```");
  }
  return parts.join("\n");
}

/** One bullet describing a finding, used in the summary when not anchored inline. */
function findingBullet(finding: Finding): string {
  return `- ${SEVERITY_BADGE[finding.severity]} \`${finding.path}:${finding.line}\` — ${finding.title}`;
}

/**
 * Render the review summary posted as the body of the GitHub review.
 * `unanchored` findings (whose line couldn't be matched to the diff) are listed
 * here so nothing is lost.
 */
export function renderSummaryBody(
  review: CostReview,
  ref: PullRequestRef,
  unanchored: Finding[],
  grounded: boolean,
): string {
  const counts: Record<Severity, number> = { P1: 0, P2: 0, P3: 0 };
  for (const f of review.findings) counts[f.severity]++;

  const out: string[] = [];
  out.push(`## 💸 Cloud cost review — ${VERDICT_BADGE[review.verdict]}`);
  out.push("");
  out.push(
    `**Estimated monthly delta:** ${review.estimatedMonthlyDelta}  •  ` +
      `**Confidence:** ${review.confidence}/5  •  ` +
      `**Findings:** ${counts.P1} P1 · ${counts.P2} P2 · ${counts.P3} P3`,
  );
  out.push("");
  out.push(review.overview);

  if (review.changedFiles.length > 0) {
    out.push("", "### Changed files", "", "| File | Cost impact |", "| --- | --- |");
    for (const f of review.changedFiles) {
      out.push(`| \`${f.path}\` | ${f.costImpact.replace(/\|/g, "\\|")} |`);
    }
  }

  if (unanchored.length > 0) {
    out.push("", "### Additional findings", "");
    for (const f of unanchored) {
      out.push(findingBullet(f));
      out.push(`  ${f.body.replace(/\n+/g, " ")}`);
    }
  }

  if (review.mermaid?.trim()) {
    out.push("", "```mermaid", review.mermaid.trim(), "```");
  }

  const source = grounded
    ? "prices grounded in **Archera**"
    : "prices are **model estimates** — connect Archera for grounded numbers";
  out.push(
    "",
    `<sub>🤖 Automated cloud-cost review of ${ref.owner}/${ref.repo}#${ref.prNumber} · diff-only · ${source}</sub>`,
  );

  return out.join("\n");
}
