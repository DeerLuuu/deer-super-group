import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PANEL_LAUNCHER_KEYS, tasksAutoOpenAction, workflowStageNavigation } from "../App.js";
import { CREATE_TARGET_TAB } from "../CommandPalette.js";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("t235 App plan entry contract", () => {
  it("routes Tasks auto-open, WorkflowRail plan and CommandPalette plan to Plan Draft", () => {
    expect(tasksAutoOpenAction("plan")).toBe("planDraft");
    expect(workflowStageNavigation("plan", "task-1")).toEqual({ panel: "planDraft" });
    expect(CREATE_TARGET_TAB.plan).toBe("tasks");
    expect(tasksAutoOpenAction("task")).toBe("compose");
    expect(PANEL_LAUNCHER_KEYS).toContain("planDraft");
  });

  it("keeps the legacy direct-plan UI path out of App", () => {
    expect(appSource).not.toContain("window.deer.plan");
    expect(appSource).not.toContain("function RouterPlanModal");
    expect(appSource).not.toContain("setPlanOpen(true)");
    expect(appSource).toContain("onPlanDraft");
  });
});
