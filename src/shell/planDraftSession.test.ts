import { describe, expect, it } from "vitest";
import { resolvePlanGoal } from "../App.js";
import {
  isPlanDraftDirty,
  isPlanDraftSourceChanged,
  PlanPreviewGate,
  planDraftLeaveDisposition,
  planDraftLeaveMessage,
} from "./planDraftSession.js";
import { buildPlanSource } from "../shared/planDraft.js";

describe("t237 plan draft session", () => {
  it("invalidates late previews regardless of preview=true/false", () => {
    const gate = new PlanPreviewGate();
    const first = gate.start();
    expect(gate.isCurrent(first)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(first)).toBe(false);
    const second = gate.start();
    expect(gate.isCurrent(second)).toBe(true);
  });

  it("distinguishes undefined goal override from an explicit empty string", () => {
    expect(resolvePlanGoal(undefined, "composer goal", "last user")).toBe("composer goal");
    expect(resolvePlanGoal(undefined, "", "last user")).toBe("last user");
    expect(resolvePlanGoal("", "composer goal", "last user")).toBe("");
    expect(resolvePlanGoal("  ", "composer", null)).toBe("");
  });

  it("marks captured/edited drafts dirty and preserves the session on Dock close", () => {
    const source = buildPlanSource({ goal: "goal", messages: [] });
    expect(isPlanDraftDirty(null, null)).toBe(false);
    expect(isPlanDraftDirty(source, null)).toBe(true);
    expect(isPlanDraftDirty(buildPlanSource({ goal: "", messages: [] }), null)).toBe(false);
    expect(planDraftLeaveDisposition("close")).toBe("preserve");
    expect(planDraftLeaveDisposition("cancel")).toBe("discard");
    expect(planDraftLeaveDisposition("deep-link")).toBe("discard");
    expect(planDraftLeaveDisposition("workspace")).toBe("discard");
    expect(planDraftLeaveDisposition("replace")).toBe("discard");
    expect(planDraftLeaveMessage("deep-link")).toContain("离开");
    expect(planDraftLeaveMessage("workspace")).toContain("切换工作区");
    expect(planDraftLeaveMessage("replace")).toContain("重新规划");
    expect(planDraftLeaveMessage("close")).toContain("保留");
    const draft = { source, tasks: [] };
    expect(isPlanDraftSourceChanged(draft, source)).toBe(false);
    expect(
      isPlanDraftSourceChanged(draft, buildPlanSource({ goal: "changed", messages: [] })),
    ).toBe(true);
  });
});
