import { describe, expect, it } from "vitest";
import { annotateDiff, parseCommentableLines, truncateDiff } from "./diff.js";

const DIFF = `diff --git a/infra/main.tf b/infra/main.tf
index 1111111..2222222 100644
--- a/infra/main.tf
+++ b/infra/main.tf
@@ -10,3 +10,4 @@ resource "aws_instance" "web" {
   ami           = "ami-123"
-  instance_type = "t3.micro"
+  instance_type = "r6g.4xlarge"
+  count         = 3
 }`;

describe("parseCommentableLines", () => {
  it("collects added and context line numbers on the right side, skipping removals", () => {
    const map = parseCommentableLines(DIFF);
    const lines = map.get("infra/main.tf");
    expect(lines).toBeDefined();
    // Hunk starts at new line 10: ctx(10) ami, +(11) instance_type, +(12) count, ctx(13) }
    expect([...(lines ?? [])].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  });

  it("uses the path from the +++ header without the b/ prefix", () => {
    const map = parseCommentableLines(DIFF);
    expect(map.has("infra/main.tf")).toBe(true);
  });
});

describe("annotateDiff", () => {
  it("prefixes added and context lines with their new-file line number", () => {
    const annotated = annotateDiff(DIFF);
    expect(annotated).toContain('11 \t+  instance_type = "r6g.4xlarge"');
    expect(annotated).toContain("12 \t+  count         = 3");
    // The removed line is annotated with blank padding, not a number.
    expect(annotated).toMatch(/ {6}\t-\s+instance_type = "t3.micro"/);
  });

  it("leaves hunk headers and file headers unchanged", () => {
    const annotated = annotateDiff(DIFF);
    expect(annotated).toContain("@@ -10,3 +10,4 @@");
    expect(annotated).toContain("diff --git a/infra/main.tf b/infra/main.tf");
  });
});

describe("truncateDiff", () => {
  it("keeps short diffs intact and marks long ones", () => {
    expect(truncateDiff("abc", 10)).toBe("abc");
    expect(truncateDiff("abcdef", 3)).toContain("truncated");
  });
});
