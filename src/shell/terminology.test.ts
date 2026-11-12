import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const teamSource = readFileSync(new URL("../TeamDashboard.tsx", import.meta.url), "utf8");

describe("t247 approval terminology", () => {
  it("distinguishes task delivery approval, code review and merge confirmation", () => {
    expect(appSource).toContain("批准任务交付（任务交付 gate");
    expect(appSource).toContain("批准术语说明");
    expect(appSource).toContain("合并确认说明");
    expect(teamSource).toContain("合并确认在此执行");
  });
});
