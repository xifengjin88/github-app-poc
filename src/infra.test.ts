import { describe, expect, it } from "vitest";
import { filterDiffToInfra, infraKinds, isInfraFile } from "./infra.js";

describe("isInfraFile", () => {
  it("matches Terraform files", () => {
    expect(isInfraFile("infra/main.tf")).toBe(true);
    expect(isInfraFile("envs/prod/variables.tfvars")).toBe(true);
    expect(isInfraFile("stack.tf.json")).toBe(true);
  });

  it("ignores application/docs/test files", () => {
    expect(isInfraFile("src/app.ts")).toBe(false);
    expect(isInfraFile("README.md")).toBe(false);
    expect(isInfraFile("test/app.test.ts")).toBe(false);
  });
});

describe("infraKinds", () => {
  it("reports which infra kinds were touched", () => {
    expect(infraKinds(["a.tf", "b.ts"])).toEqual(["Terraform"]);
    expect(infraKinds(["b.ts"])).toEqual([]);
  });
});

const MIXED_DIFF = `diff --git a/src/app.ts b/src/app.ts
index aaa..bbb 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const x = 2;
diff --git a/infra/main.tf b/infra/main.tf
index ccc..ddd 100644
--- a/infra/main.tf
+++ b/infra/main.tf
@@ -10,2 +10,2 @@ resource "aws_instance" "web" {
-  instance_type = "t3.micro"
+  instance_type = "r6g.4xlarge"
 }`;

describe("filterDiffToInfra", () => {
  it("keeps only infra file sections and lists them", () => {
    const { diff, files } = filterDiffToInfra(MIXED_DIFF);
    expect(files).toEqual(["infra/main.tf"]);
    expect(diff).toContain("infra/main.tf");
    expect(diff).toContain("r6g.4xlarge");
    expect(diff).not.toContain("src/app.ts");
    expect(diff).not.toContain("const x = 2;");
  });

  it("returns no files when nothing is infra", () => {
    const onlyApp = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const x = 2;`;
    expect(filterDiffToInfra(onlyApp).files).toEqual([]);
  });
});
