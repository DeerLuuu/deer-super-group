import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * O1-3: scheduler/UI must consume the Task DTO (relation-first Store read).
 * Only Store's controlled fallback may mention the legacy column names.
 */
describe("O1-3 read path source boundaries", () => {
  it("keeps legacy owner_id/depends_on reads out of scheduler/UI", () => {
    const files = [
      new URL("./execution/kernel.ts", import.meta.url),
      new URL("./service.ts", import.meta.url),
      new URL("../TaskStarMap.tsx", import.meta.url),
      new URL("../shell/taskWorkspaceData.ts", import.meta.url),
      new URL("../shell/PlanDraftPanel.tsx", import.meta.url),
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file.pathname).not.toMatch(/\b(owner_id|depends_on)\b/);
      expect(source, file.pathname).not.toMatch(/JSON\.parse\([^)]*depends/i);
    }
  });
});
