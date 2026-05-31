/**
 * Unified-diff helpers.
 *
 * GitHub's review API can only attach a comment to a line that appears in the
 * diff, addressed by its line number in the NEW version of the file (the right
 * side). These helpers (a) compute which (path, line) pairs are commentable and
 * (b) annotate the diff with those line numbers so the model targets them.
 */

/** Truncate an over-long diff, appending a marker so the model knows it was cut. */
export function truncateDiff(diff: string, max: number): string {
  if (diff.length <= max) return diff;
  return `${diff.slice(0, max)}\n\n... [diff truncated at ${max} characters — review reflects only the portion above]`;
}

/** Strip the leading `a/` or `b/` git prefix from a diff path. */
function stripGitPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/** One file's section of a unified diff. */
export interface FileDiff {
  path: string;
  patch: string;
}

/** The repo-relative path a file patch applies to (new path, or old path if deleted). */
function pathOfPatch(patch: string): string {
  const plus = /^\+\+\+ (.+)$/m.exec(patch)?.[1]?.trim();
  if (plus && plus !== "/dev/null") return stripGitPrefix(plus);
  const minus = /^--- (.+)$/m.exec(patch)?.[1]?.trim();
  if (minus && minus !== "/dev/null") return stripGitPrefix(minus);
  const header = /^diff --git a\/.+? b\/(.+)$/m.exec(patch)?.[1]?.trim();
  return header ?? "";
}

/** Split a unified diff into one section per file (each starts at `diff --git`). */
export function splitDiffByFile(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: string[] | null = null;

  const flush = () => {
    if (current) {
      const patch = current.join("\n");
      files.push({ path: pathOfPatch(patch), patch });
    }
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return files;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Map each file path to the set of NEW-file line numbers that can receive an
 * inline review comment (added `+` lines and unchanged context lines). Deleted
 * lines are excluded since they don't exist on the right side of the diff.
 */
export function parseCommentableLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let path: string | null = null;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      path = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      path = target === "/dev/null" ? null : stripGitPrefix(target);
      if (path && !result.has(path)) result.set(path, new Set());
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !path) continue;

    if (line.startsWith("+")) {
      result.get(path)?.add(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      // Removed line: exists only on the old side, not commentable here.
    } else if (line.startsWith(" ")) {
      result.get(path)?.add(newLine);
      newLine++;
    }
    // Anything else (e.g. "\ No newline at end of file") doesn't advance.
  }

  return result;
}

/** Left-pad a line number to a fixed width for tidy annotation. */
function pad(n: number): string {
  return String(n).padStart(5, " ");
}

/**
 * Prefix each commentable diff line with its NEW-file line number, e.g.
 * `   41 \t+  doSomething();`. The model is told to use that number as the
 * comment `line`, which makes inline anchoring far more reliable.
 */
export function annotateDiff(diff: string): string {
  const out: string[] = [];
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      inHunk = false;
      out.push(line);
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      out.push(line);
      continue;
    }
    if (!inHunk) {
      out.push(line);
      continue;
    }

    if (line.startsWith("+")) {
      out.push(`${pad(newLine)} \t${line}`);
      newLine++;
    } else if (line.startsWith("-")) {
      out.push(`      \t${line}`);
    } else if (line.startsWith(" ")) {
      out.push(`${pad(newLine)} \t${line}`);
      newLine++;
    } else {
      out.push(line);
    }
  }

  return out.join("\n");
}
