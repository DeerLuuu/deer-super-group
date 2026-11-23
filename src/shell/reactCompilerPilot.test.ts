import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REACT_COMPILER_ALLOWLIST } from "./reactCompilerBoundary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PILOTS = [
  "src/shell/SkipLink.tsx",
  "src/shell/ApprovalTerms.tsx",
  "src/shell/TaskContractChips.tsx",
  "src/shell/TaskWorkspaceTabs.tsx",
] as const;

describe("t520 annotation pilot directives", () => {
  it("marks exactly the four non-Dock pilots with an explicit use memo", () => {
    expect(REACT_COMPILER_ALLOWLIST).toEqual(PILOTS);
    for (const file of PILOTS) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source).toContain('"use memo";');
      expect(source).not.toContain('"use no memo";');
    }
  });
});
