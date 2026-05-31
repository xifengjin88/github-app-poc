import { splitDiffByFile } from "./diff.js";

/**
 * Which changed files count as "infrastructure" worth cost-reviewing.
 *
 * The bot only sends infra files to the model, so a PR that touches no infra is
 * skipped entirely (no cost, no noise). Start with Terraform; add more matchers
 * (CloudFormation, Kubernetes, Pulumi, Serverless, Helm…) over time.
 */
export interface InfraMatcher {
  /** Human-readable label, e.g. "Terraform". */
  name: string;
  /** True if the repo-relative path is this kind of infra file. */
  matches: (path: string) => boolean;
}

export const INFRA_MATCHERS: InfraMatcher[] = [
  {
    name: "Terraform",
    // .tf, .tf.json, .tfvars, .tfvars.json
    matches: (path) => /\.tf(\.json)?$|\.tfvars(\.json)?$/i.test(path),
  },
  // Add later, e.g.:
  // { name: "CloudFormation", matches: (p) => /(^|\/)(template|.*\.cfn)\.ya?ml$/i.test(p) },
  // { name: "Kubernetes", matches: (p) => /\.ya?ml$/i.test(p) && looksLikeK8s(p) },
  // { name: "Pulumi", matches: (p) => /(^|\/)Pulumi\.ya?ml$/i.test(p) },
];

/** Whether a file path is infrastructure we cost-review. */
export function isInfraFile(path: string): boolean {
  return INFRA_MATCHERS.some((matcher) => matcher.matches(path));
}

/** The matcher labels that apply to a path (for reporting which kinds were seen). */
export function infraKinds(paths: string[]): string[] {
  const kinds = new Set<string>();
  for (const path of paths) {
    for (const matcher of INFRA_MATCHERS) {
      if (matcher.matches(path)) kinds.add(matcher.name);
    }
  }
  return [...kinds];
}

/**
 * Reduce a unified diff to only its infrastructure files. Returns the filtered
 * diff (hunks intact, so line numbers still anchor) and the matched file paths.
 */
export function filterDiffToInfra(diff: string): { diff: string; files: string[] } {
  const infra = splitDiffByFile(diff).filter((file) => isInfraFile(file.path));
  return {
    diff: infra.map((file) => file.patch).join("\n"),
    files: infra.map((file) => file.path),
  };
}
