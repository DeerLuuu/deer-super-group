import { describe, expect, it } from "vitest";
import {
  buildPlanSource,
  parsePlanDraft,
  planDraftFingerprint,
  planSourceIssues,
  validatePlanDraft,
  type PlanDraft,
  type PlanDraftTask,
} from "./planDraft.js";

function task(id: string, extra: Partial<PlanDraftTask> = {}): PlanDraftTask {
  return {
    id,
    title: id,
    description: "",
    acceptance: ["done"],
    dependsOn: [],
    ownerId: null,
    priority: 50,
    risks: [],
    unknowns: [],
    ...extra,
  };
}

describe("t231 plan draft data", () => {
  it("builds a digest and blocks source over 12k/empty", () => {
    const source = buildPlanSource({
      goal: "实现健康检查",
      messages: [{ role: "user", content: "约束：不要改权限" }],
      overview: "workspace",
    });
    expect(source.digest).toMatch(/^[0-9a-f]{8}$/);
    expect(source.characterCount).toBeGreaterThan(0);
    expect(planSourceIssues(source)).toEqual([]);
    expect(planSourceIssues({ ...source, characterCount: 12_001 })).toEqual([
      expect.objectContaining({ code: "SOURCE_TOO_LARGE", severity: "error" }),
    ]);
    expect(
      planSourceIssues({ ...source, goal: "", messages: [] }),
    ).toEqual([expect.objectContaining({ code: "SOURCE_EMPTY", severity: "error" })]);
  });

  it("parses fenced JSON and rejects unparseable text", () => {
    const parsed = parsePlanDraft(
      '```json\n{"tasks":[{"title":"A","description":"","acceptance":["x"],"dependsOn":[],"priority":30},{"title":"B","dependsOn":[0]}]}\n```',
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.priority).toBe(30);
    expect(parsed[1]?.dependsOn).toEqual(["draft-1"]);
    expect(() => parsePlanDraft("not json")).toThrow("PLAN_UNPARSEABLE");
  });

  it("validates empty/cycle/missing/self/owner/acceptance", () => {
    expect(validatePlanDraft([])).toEqual([
      expect.objectContaining({ code: "PLAN_EMPTY", severity: "error" }),
    ]);
    const cycle = validatePlanDraft([
      task("a", { dependsOn: ["b"] }),
      task("b", { dependsOn: ["a"] }),
    ]);
    expect(cycle).toContainEqual(expect.objectContaining({ code: "PLAN_CYCLE", severity: "error" }));
    const missing = validatePlanDraft([task("a", { dependsOn: ["nope"] })]);
    expect(missing).toContainEqual(
      expect.objectContaining({ code: "TASK_DEPENDENCY_MISSING", severity: "error" }),
    );
    const self = validatePlanDraft([task("a", { dependsOn: ["a"] })]);
    expect(self).toContainEqual(
      expect.objectContaining({ code: "TASK_SELF_DEPENDENCY", severity: "error" }),
    );
    const warnings = validatePlanDraft([task("a", { acceptance: [] })]);
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "TASK_OWNER_EMPTY", severity: "warning" }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "TASK_ACCEPTANCE_EMPTY", severity: "warning" }),
    );
  });

  it("fingerprint changes with draft edits and is stable across equivalent objects", () => {
    const source = buildPlanSource({ goal: "g", messages: [] });
    const draft: PlanDraft = { source, tasks: [task("a")] };
    const first = planDraftFingerprint(draft);
    expect(planDraftFingerprint({ ...draft })).toBe(first);
    expect(
      planDraftFingerprint({ ...draft, tasks: [task("a", { title: "changed" })] }),
    ).not.toBe(first);
  });
});
