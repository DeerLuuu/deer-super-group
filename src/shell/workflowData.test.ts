import { describe, expect, it } from "vitest";
import type { MergeQueueItem } from "../git/types.js";
import type { Task } from "../shared/types.js";
import type { WatchdogSnapshot } from "../shared/watchdog.js";
import { deriveNeedsMe, deriveWorkflow, needsListNavigation } from "./workflowData.js";

function task(id: string, status: Task["status"], title = id): Task {
  return {
    id,
    workspaceId: "ws",
    title,
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
  };
}

function mergeItem(
  id: string,
  state: MergeQueueItem["state"],
  taskId = "t1",
): MergeQueueItem {
  return {
    id,
    workspaceId: "ws",
    taskId,
    taskTitle: `Merge ${id}`,
    provider: "local",
    prNumber: null,
    prUrl: null,
    branch: "b",
    state,
    position: 1,
    headSha: "a",
    baseSha: "b",
    approvedHeadSha: null,
    checks: { state: "passed", summary: "" },
    checksWaived: false,
    retryAt: null,
    review: "",
    conflictTaskId: null,
    lastError: null,
    mergeCommitSha: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function watchdog(partial: {
  alerts?: WatchdogSnapshot["alerts"];
  ratio?: number;
}): WatchdogSnapshot {
  return {
    workspaceId: "ws",
    enabled: true,
    deadman: false,
    pausedBy: null,
    health: { lastTickAt: null, lastPatrolAt: null, stale: false, enabled: true, deadman: false },
    alerts: partial.alerts ?? [],
    interventions: [],
    holds: [],
    budgets: {
      task: { taskId: null, spentUsd: 0, limitUsd: 1, ratio: 0 },
      agentDay: { agentId: null, spentUsd: 0, limitUsd: 1, ratio: 0 },
      workspaceDay: { spentUsd: 1, limitUsd: 1, ratio: partial.ratio ?? 1 },
      softRatio: 0.8,
      hardAction: "pause",
      pricingKnown: true,
    },
    fallback: { workspaceId: "ws", agentId: null, models: [], maxSwitches: 0, onQuota: false, onErrors: false },
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function alert(
  id: string,
  kind: WatchdogSnapshot["alerts"][number]["kind"],
  status: WatchdogSnapshot["alerts"][number]["status"] = "open",
): WatchdogSnapshot["alerts"][number] {
  return {
    id,
    workspaceId: "ws",
    taskId: null,
    runId: null,
    kind,
    severity: "warning",
    status,
    title: `Alert ${id}`,
    detail: {},
    dedupeKey: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    ackedAt: null,
    resolvedAt: null,
    actor: null,
  };
}

describe("t222 WorkflowRail projection", () => {
  it("derives six-stage current stage from existing task/run/queue states", () => {
    expect(deriveWorkflow({ tasks: [] }).stage).toBe("discuss");
    expect(deriveWorkflow({ tasks: [task("t1", "ready")] })).toMatchObject({
      stage: "plan",
      cta: { stage: "plan", label: "去规划" },
      focusTaskId: "t1",
    });
    expect(
      deriveWorkflow({
        tasks: [task("t1", "queued")],
        scheduler: { queue: [{}], activeRuns: [] } as never,
      }),
    ).toMatchObject({ stage: "run", focusTaskId: "t1" });
    expect(deriveWorkflow({ tasks: [task("f1", "failed")] })).toMatchObject({
      stage: "run",
      cta: { stage: "run", label: "重试失败任务" },
      focusTaskId: "f1",
    });
    const reviewBlocked = {
      ...task("rb1", "blocked"),
      failureKind: "review_rejected",
    };
    expect(deriveWorkflow({ tasks: [reviewBlocked] })).toMatchObject({
      stage: "review",
      cta: { stage: "review", label: "去评审" },
      focusTaskId: "rb1",
    });
    expect(deriveWorkflow({ tasks: [task("b1", "blocked")] })).toMatchObject({
      stage: "run",
      cta: { stage: "run", label: "处理阻塞" },
    });
    expect(deriveWorkflow({ tasks: [task("t1", "review")] })).toMatchObject({
      stage: "review",
      cta: { stage: "review", label: "去评审" },
    });
    expect(
      deriveWorkflow({ tasks: [task("t1", "done")], mergeQueue: [mergeItem("m1", "ready")] }),
    ).toMatchObject({ stage: "deliver", focusTaskId: "t1" });
    expect(deriveWorkflow({ tasks: [task("t1", "done")], mergeQueue: [] })).toMatchObject({
      stage: "remember",
      cta: { stage: "remember", label: "去沉淀" },
    });
  });

  it("distinguishes unknown/failed/empty/pending MergeQueue states", () => {
    // 未加载/失败 = null：不能把 done 推断成记忆，也不能伪造无待合并。
    expect(deriveWorkflow({ tasks: [task("t1", "done")], mergeQueue: null })).toEqual({
      stage: "unknown",
      cta: null,
      focusTaskId: null,
    });
    // 已知空：可以进入记忆。
    expect(deriveWorkflow({ tasks: [task("t1", "done")], mergeQueue: [] }).stage).toBe(
      "remember",
    );
    // 有 pending：优先交付。
    expect(
      deriveWorkflow({ tasks: [task("t1", "done")], mergeQueue: [mergeItem("m1", "queued")] })
        .stage,
    ).toBe("deliver");
    // failed 任务仍明确归 run。
    expect(deriveWorkflow({ tasks: [task("f1", "failed")] })).toMatchObject({
      stage: "run",
      cta: { stage: "run", label: "重试失败任务" },
    });
  });

  it("unknown/cancelled does not fabricate a CTA", () => {
    const unknown = deriveWorkflow({ tasks: [task("t1", "cancelled")] });
    expect(unknown).toEqual({ stage: "unknown", cta: null, focusTaskId: null });
    expect(deriveWorkflow({ tasks: [task("t1", "done")], mergeQueue: null }).stage).toBe(
      "unknown",
    );
  });
});

describe("t222 NeedsMe aggregation", () => {
  it("aggregates failed/blocked/review/merge/alert/budget and dedupes", () => {
    const duplicateAlert = alert("a1", "deadman");
    const items = deriveNeedsMe({
      tasks: [
        task("f1", "failed", "Failed task"),
        task("b1", "blocked", "Blocked task"),
        task("r1", "review", "Review task"),
        task("f1", "failed", "Duplicate failed"),
      ],
      mergeQueue: [
        mergeItem("m1", "ready"),
        mergeItem("m2", "merged"),
        mergeItem("m3", "blocked"),
      ],
      watchdog: watchdog({
        ratio: 1,
        alerts: [duplicateAlert, { ...duplicateAlert }, alert("a2", "budget_hard"), alert("a3", "deadman", "resolved")],
      }),
    });
    expect(items.map((item) => item.kind)).toEqual([
      "failed",
      "blocked",
      "review",
      "merge",
      "merge",
      "alert",
      "alert",
    ]);
    expect(items.filter((item) => item.id === "task:failed:f1")).toHaveLength(1);
    expect(items.some((item) => item.id === "merge:m2")).toBe(false);
    expect(items.some((item) => item.id === "budget:workspace")).toBe(false); // budget alert wins
    expect(items.find((item) => item.id === "task:failed:f1")?.taskId).toBe("f1");
  });

  it("categorizes review-blocked tasks as review and keeps null queue unknown", () => {
    const reviewBlocked = {
      ...task("rb1", "blocked"),
      failureKind: "review_rejected",
    };
    const items = deriveNeedsMe({
      tasks: [reviewBlocked],
      mergeQueue: null,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "review", taskId: "rb1" });
    expect(items.some((item) => item.kind === "merge")).toBe(false);
  });

  it("returns empty for no actionable state; budget without alert is one item", () => {
    expect(deriveNeedsMe({ tasks: [] })).toEqual([]);
    const items = deriveNeedsMe({
      tasks: [task("t1", "done")],
      watchdog: watchdog({ alerts: [] }),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "budget:workspace", kind: "budget" });
  });

  it("supports listbox Arrow/Home/End navigation", () => {
    expect(needsListNavigation(0, "ArrowDown", 3)).toBe(1);
    expect(needsListNavigation(0, "ArrowUp", 3)).toBe(2);
    expect(needsListNavigation(1, "Home", 3)).toBe(0);
    expect(needsListNavigation(1, "End", 3)).toBe(2);
    expect(needsListNavigation(1, "Enter", 3)).toBeNull();
    expect(needsListNavigation(0, "ArrowDown", 0)).toBeNull();
  });
});
