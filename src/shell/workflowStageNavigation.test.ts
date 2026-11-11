import { describe, expect, it } from "vitest";
import { tasksAutoOpenAction, workflowStageNavigation } from "../App.js";
import { deriveWorkflow } from "./workflowData.js";
import type { Task } from "../shared/types.js";

function task(status: Task["status"], failureKind?: string): Task {
  return {
    id: "f1",
    workspaceId: "ws",
    title: "Failed task",
    description: "",
    acceptance: [],
    status,
    ownerId: null,
    dependsOn: [],
    branch: null,
    worktree: null,
    summary: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    ...(failureKind ? { failureKind } : {}),
  };
}

describe("t228 App-level workflow stage navigation", () => {
  it("failed CTA says 查看失败任务 and navigates to the task, not a fake retry", () => {
    const projection = deriveWorkflow({ tasks: [task("failed")] });
    expect(projection.cta).toEqual({ stage: "run", label: "查看失败任务" });
    expect(workflowStageNavigation(projection.cta!.stage, "f1")).toEqual({
      panel: "tasks",
      taskId: "f1",
    });
  });

  it("review-blocked CTA enters review focus; other stages map to existing surfaces", () => {
    const projection = deriveWorkflow({
      tasks: [task("blocked", "review_rejected")],
    });
    expect(projection.stage).toBe("review");
    expect(projection.cta?.label).toBe("去评审");
    expect(workflowStageNavigation("review", "f1")).toEqual({
      panel: "tasks",
      taskId: "f1",
      review: true,
    });
    expect(workflowStageNavigation("discuss", null)).toEqual({ panel: "chat" });
    expect(workflowStageNavigation("plan", "t1")).toEqual({ panel: "planDraft" });
    expect(workflowStageNavigation("deliver", "t1")).toEqual({ panel: "merge" });
    expect(tasksAutoOpenAction("plan")).toBe("planDraft");
    expect(tasksAutoOpenAction("task")).toBe("compose");
    expect(tasksAutoOpenAction(null)).toBeNull();
    expect(workflowStageNavigation("remember", "t1")).toEqual({ panel: "board" });
  });
});
