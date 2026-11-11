import { describe, expect, it } from "vitest";
import {
  TASK_WORKSPACE_TABS,
  taskWorkspaceNext,
  taskWorkspaceTabForKey,
} from "./taskWorkspaceData.js";

function next(
  status: "review" | "failed" | "done" | "blocked" | "running" | "ready" | "cancelled",
  blockedReason: string | null = null,
) {
  return taskWorkspaceNext({
    task: { status, blockedReason, failureKind: null },
    startEnabled: status === "ready",
    startReason: status !== "ready" ? "不可运行" : "",
    retryEnabled: status === "failed",
    retryReason: status !== "failed" ? "不可重试" : "",
    unfilledDeps: 0,
  });
}

describe("t241 Task Workspace data", () => {
  it("defines five tabs and wraps keyboard navigation", () => {
    expect(TASK_WORKSPACE_TABS.map((tab) => tab.label)).toEqual([
      "概览",
      "运行",
      "评审",
      "Git",
      "历史",
    ]);
    expect(taskWorkspaceTabForKey("overview", "ArrowRight")).toBe("runs");
    expect(taskWorkspaceTabForKey("overview", "ArrowLeft")).toBe("history");
    expect(taskWorkspaceTabForKey("review", "Home")).toBe("overview");
    expect(taskWorkspaceTabForKey("review", "End")).toBe("history");
    expect(taskWorkspaceTabForKey("review", "Enter")).toBeNull();
  });

  it("chooses one primary next step for each delivery stage", () => {
    expect(next("review")).toMatchObject({ key: "review-tab", tab: "review", label: "去评审" });
    expect(next("failed")).toMatchObject({ key: "retry", label: "重试任务" });
    expect(next("done")).toMatchObject({ key: "git-tab", tab: "git" });
    expect(next("running")).toMatchObject({ key: "runs-tab", tab: "runs" });
    expect(next("cancelled")).toMatchObject({ key: "history-tab", tab: "history" });
    expect(next("blocked", "merge conflict")).toMatchObject({
      key: "git-tab",
      tab: "git",
      label: "处理冲突",
    });
    expect(next("ready")).toMatchObject({ key: "run", label: "运行任务" });
  });

  it("shows upstream as the primary for blocked dependencies", () => {
    const result = taskWorkspaceNext({
      task: { status: "blocked", blockedReason: "waiting_dependencies", failureKind: null },
      startEnabled: false,
      startReason: "上游依赖未完成",
      retryEnabled: false,
      retryReason: "只有失败任务可以重试",
      unfilledDeps: 2,
    });
    expect(result.key).toBe("upstream");
    expect(result.detail).toContain("上游依赖");
  });
});
