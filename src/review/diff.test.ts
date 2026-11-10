import { describe, expect, it } from "vitest";
import { pageLines, parseFileLines, parseUnifiedDiff } from "./diff.js";

const patch = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;

describe("review unified diff parser", () => {
  it("parses add/del/context, files, binary and lines", () => {
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(3);
    expect(files[0].path).toBe("src/a.ts");
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[1].changeType).toBe("A");
    expect(files[2].isBinary).toBe(true);
    const lines = parseFileLines(files[0].patchText);
    expect(lines.map((line) => line.kind)).toEqual(["context", "del", "add", "add", "context"]);
    expect(lines[1]).toMatchObject({ oldLine: 2, newLine: null, text: "const b = 2;" });
    expect(lines[2]).toMatchObject({ oldLine: null, newLine: 2, text: "const b = 3;" });
  });

  it("pages lines and clamps bounds", () => {
    const lines = parseFileLines(parseUnifiedDiff(patch)[0].patchText);
    const page = pageLines(lines, 1, 2);
    expect(page.lines).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(true);
    expect(pageLines(lines, 999, 10)).toMatchObject({ lines: [], offset: 5, hasMore: false });
  });

  it("parses rename metadata without losing old/new paths", () => {
    const files = parseUnifiedDiff(
      `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
`,
    );
    expect(files[0]).toMatchObject({ changeType: "R", path: "src/new.ts", oldPath: "src/old.ts" });
  });

  it("marks oversized file patch truncated", () => {
    const body = Array.from({ length: 2100 }, (_, index) => `+line ${index}`).join("\n");
    const files = parseUnifiedDiff(`diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1,2100 @@\n${body}\n`);
    expect(files[0].truncated).toBe(true);
    expect(files[0].lineCount).toBe(2100);
  });
});
