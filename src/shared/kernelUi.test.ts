import { describe, expect, it } from "vitest";
import type {
  EventRecord,
  Run,
  SchedulerSnapshot,
  Task,
  TaskStatus,
} from "./types";
import {
  canCancelRun,
  eventSummary,
  filterTaskList,
  formatDuration,
  formatRelative,
  isActiveRunStatus,
  KernelUiError,
  runTimelineEvents,
  schedulerLimitsText,
  schedulerSummaryText,
  statusCounts,
  taskActionState,
  taskAttemptRatioText,
  taskNextStep,
  taskStatusAnnouncements,
  taskStatusSnapshot,
  unwrapKernel,
} from "./kernelUi";

function task(
  id: string,
  status: TaskStatus,
  dependsOn: string[] = [],
  patch: Partial<Task> = {},
): Task {
  return {
    id,
    workspaceId: "ws",
    title: `任务 ${id}`,
    description: "",
    acceptance: [],
    status,
    ownerId: null,
    dependsOn,
    branch: null,
    worktree: null,
    summary: null,
    createdAt: "2026-11-10T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    ...patch,
  };
}

function run(id: string, status: Run["status"], patch: Partial<Run> = {}): Run {
  return {
    id,
    taskId: "t1",
    agentId: "a1",
    status,
    error: null,
    startedAt: "2026-11-10T00:00:00.000Z",
    endedAt: null,
    tokenIn: 0,
    tokenOut: 0,
    ...patch,
  };
}

function event(
  type: string,
  payload: unknown,
  aggregateId = "run-1",
  aggregateType = "run",
): EventRecord {
  return {
    seq: 1,
    id: `e-${type}`,
    aggregateType,
    aggregateId,
    type,
    actor: "kernel",
    payload,
    createdAt: "2026-11-10T00:00:01.000Z",
    occurredAt: "2026-11-10T00:00:01.000Z",
  };
}

describe("kernelUi 时间与 token 口径", () => {
  it("duration 分级显示", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(500)).toBe("<1s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(64_000)).toBe("1m 04s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
  });

  it("relative 时间（注入 now，避免测试依赖系统时钟）", () => {
    const now = Date.parse("2026-11-10T00:05:00.000Z");
    expect(formatRelative("2026-11-10T00:04:55.000Z", now)).toBe("刚刚");
    expect(formatRelative("2026-11-10T00:04:30.000Z", now)).toBe("30 秒前");
    expect(formatRelative("2026-11-10T00:02:00.000Z", now)).toBe("3 分钟前");
    expect(formatRelative("2026-11-09T21:00:00.000Z", now)).toBe("3 小时前");
    expect(formatRelative("2026-11-07T00:00:00.000Z", now)).toBe("3 天前");
  });
});

describe("kernelUi 任务列表与操作约束", () => {
  const tasks = [
    task("t1", "ready"),
    task("t2", "queued"),
    task("t3", "running"),
    task("t4", "blocked", ["t5"]),
    task("t5", "failed"),
    task("t6", "done"),
  ];
  const byId = new Map(tasks.map((item) => [item.id, item]));

  it("状态计数含 8 态与 all", () => {
    const counts = statusCounts(tasks);
    expect(counts.all).toBe(6);
    expect(counts.ready).toBe(1);
    expect(counts.queued).toBe(1);
    expect(counts.running).toBe(1);
    expect(counts.blocked).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.done).toBe(1);
  });

  it("过滤 + 关键字同时生效", () => {
    expect(filterTaskList(tasks, "blocked", "").map((item) => item.id)).toEqual(["t4"]);
    expect(filterTaskList(tasks, "all", "任务 t5").map((item) => item.id)).toEqual(["t5"]);
    expect(filterTaskList(tasks, "all", "  ")).toHaveLength(6);
  });

  it("start 只允许 ready / 依赖已完成的 blocked", () => {
    expect(taskActionState(tasks[0], byId, true).start).toEqual({
      enabled: true,
      reason: "",
    });
    expect(taskActionState(tasks[3], byId, true).start.enabled).toBe(false);
    expect(taskActionState(tasks[3], byId, true).start.reason).toContain("上游依赖未完成");
    expect(taskActionState(task("b", "blocked", ["d"]), new Map([["d", task("d", "done")]]), true).start.enabled).toBe(true);
    expect(taskActionState(tasks[1], byId, true).start.enabled).toBe(false);
    expect(taskActionState(tasks[4], byId, true).start.enabled).toBe(false);
    expect(taskActionState(tasks[0], byId, false).start.reason).toContain("成员");
  });

  it("retry 只允许 failed；cancel 不允许 done/cancelled", () => {
    expect(taskActionState(tasks[4], byId, true).retry.enabled).toBe(true);
    expect(taskActionState(tasks[0], byId, true).retry.enabled).toBe(false);
    expect(taskActionState(tasks[2], byId, true).cancel.enabled).toBe(true);
    expect(taskActionState(tasks[5], byId, true).cancel.enabled).toBe(false);
    expect(taskActionState(task("c", "cancelled"), byId, true).cancel.enabled).toBe(false);
    expect(taskActionState(task("r", "review"), byId, true).review.enabled).toBe(true);
  });

  it("attempt 显示：未运行 / 2/3 / 手动超过 3 次", () => {
    expect(taskAttemptRatioText(task("a", "ready"))).toBe("—");
    expect(taskAttemptRatioText(task("a", "running", [], { attemptCount: 2 }))).toBe("2/3");
    expect(taskAttemptRatioText(task("a", "failed", [], { attemptCount: 5 }))).toBe("5 次");
  });
});

describe("kernelUi 下一步解释", () => {
  const dep = task("d", "running");
  const blocked = task("b", "blocked", ["d"], { blockedReason: "waiting_dependencies" });
  const byId = new Map([[dep.id, dep], [blocked.id, blocked]]);

  it("blocked 给出原因与依赖名", () => {
    const next = taskNextStep(blocked, byId, true);
    expect(next.kind).toBe("wait");
    expect(next.detail).toContain("等待上游依赖完成");
    expect(next.detail).toContain(dep.title);
  });

  it("failed 指向人工重试", () => {
    const failed = task("f", "failed", [], { failureKind: "retry_exhausted" });
    const next = taskNextStep(failed, new Map([[failed.id, failed]]), true);
    expect(next.kind).toBe("retry");
    expect(next.detail).toContain("自动重试已耗尽");
  });

  it("queued 说明并发配额", () => {
    const queued = task("q", "queued");
    expect(taskNextStep(queued, new Map([[queued.id, queued]]), true).kind).toBe("wait");
  });
});

describe("kernelUi 调度器快照", () => {
  const tasks = [task("t1", "running"), task("t2", "queued"), task("t3", "queued")];
  const scheduler: SchedulerSnapshot = {
    workspaceId: "ws",
    paused: true,
    pausedReason: "user_paused",
    limits: { maxGlobal: 4, maxWorkspace: 1, maxPerAgent: 1 },
    counts: {
      ready: 0,
      queued: 2,
      running: 1,
      blocked: 0,
      review: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    },
    activeRuns: [
      {
        id: "r1",
        taskId: "t1",
        attempt: 1,
        agentId: "a1",
        status: "running",
        startedAt: "2026-11-10T00:00:00.000Z",
        heartbeatAt: null,
        endedAt: null,
        errorCode: null,
      },
    ],
    queue: [
      {
        taskId: "t2",
        title: "任务 t2",
        priority: 50,
        queuedAt: null,
        ownerId: null,
      },
    ],
    updatedAt: "2026-11-10T00:00:02.000Z",
  };

  it("摘要优先使用 scheduler，缺失时退回任务统计", () => {
    expect(schedulerSummaryText(scheduler, tasks)).toBe("运行中 1 · 排队 2");
    expect(schedulerSummaryText(null, [task("a", "running"), task("b", "queued")])).toBe(
      "运行中 1 · 排队 1",
    );
    expect(schedulerLimitsText(scheduler)).toBe("全局 4 · 每工作区 1 · 每成员 1");
  });
});

describe("kernelUi Run 时间线与事件摘要", () => {
  it("timeline 只保留 aggregateId=runId 的事件", () => {
    const events = [
      event("run.started", { run: { attempt: 1 } }),
      event("task.status_changed", { from: "ready", to: "queued" }, "t1", "task"),
      event("run.failed", { patch: { errorCode: "INTERNAL", retryable: true } }),
    ];
    expect(runTimelineEvents(events, "run-1").map((item) => item.type)).toEqual([
      "run.started",
      "run.failed",
    ]);
  });

  it("关键事件摘要可读且不输出整段 payload", () => {
    expect(
      eventSummary(
        event("task.status_changed", {
          from: "ready",
          to: "queued",
          reason: "user_start",
        }, "t1", "task"),
      ),
    ).toContain("排队中");
    expect(
      eventSummary(event("run.failed", { patch: { errorCode: "LEASE_EXPIRED", retryable: true } })),
    ).toContain("租约过期");
    expect(
      eventSummary(event("run.failed", { patch: { errorCode: "LEASE_EXPIRED", retryable: true } })),
    ).toContain("可重试");
  });

  it("Run 活跃状态与取消约束", () => {
    expect(isActiveRunStatus("running")).toBe(true);
    expect(isActiveRunStatus("waiting_human")).toBe(true);
    expect(isActiveRunStatus("completed")).toBe(false);
    expect(canCancelRun(run("r1", "running"))).toBe(true);
    expect(canCancelRun(run("r2", "completed"))).toBe(false);
  });
});

describe("kernelUi 内核结果与 aria 播报", () => {
  it("unwrap 成功取值，失败抛带 code 的 KernelUiError", () => {
    expect(unwrapKernel({ ok: true, value: 42 })).toBe(42);
    try {
      unwrapKernel({ ok: false, error: { code: "PAUSED", message: "paused" } });
      throw new Error("should not reach");
    } catch (error) {
      expect(error).toBeInstanceOf(KernelUiError);
      expect((error as KernelUiError).code).toBe("PAUSED");
      expect((error as KernelUiError).message).toContain("调度器已暂停");
    }
  });

  it("任务状态变化播报最多 3 条，首次快照不播报", () => {
    const before = [task("a", "ready"), task("b", "ready")];
    const previous = taskStatusSnapshot(before);
    expect(taskStatusAnnouncements(null, before)).toEqual([]);
    const after = [task("a", "queued"), task("b", "running"), task("c", "failed")];
    const messages = taskStatusAnnouncements(previous, after);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("排队中");
    expect(messages[1]).toContain("进行中");
  });
});
