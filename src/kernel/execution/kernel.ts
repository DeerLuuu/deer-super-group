import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  Agent,
  Run,
  RunStatus,
  RunSummary,
  SchedulerSnapshot,
  Task,
} from "../../shared/types.js";
import type { Store } from "../store.js";
import { FakeClock, systemClock, type Clock } from "./clock.js";
import { KernelError, isActiveRunStatus, isTerminalTaskStatus } from "./errors.js";
import {
  assertTransition,
  blockedReasonFor,
  canTransition,
} from "./stateMachine.js";
import { assertKernelEventPayload } from "./eventRegistry.js";
import {
  patchRunProjection,
  patchTaskProjection,
  projectionDigest,
  rebuildProjections,
  upsertRunProjection,
} from "./projections.js";

const LEASE_MS = 60_000;
const HEARTBEAT_EVENT_MS = 30_000;
const DEFAULT_TICK_MS = 250;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;

export interface KernelLimits {
  maxGlobal: number;
  maxWorkspace: number;
  maxPerAgent: number;
}

export const DEFAULT_KERNEL_LIMITS: KernelLimits = {
  maxGlobal: 4,
  // t83 F1 / t76 Q1：Git/worktree 隔离前工作区串行（1），>1 前必须加写租约/文件锁。
  maxWorkspace: 1,
  maxPerAgent: 1,
};

export interface RunExecutionResult {
  summary?: string;
  tokenIn?: number;
  tokenOut?: number;
  steps?: number;
}

export interface RunExecutionContext {
  run: Run;
  task: Task;
  agent: Agent;
  signal: AbortSignal;
  heartbeat: (info?: { tokenIn?: number; tokenOut?: number; steps?: number }) => void;
  checkpoint: (info: { step: number; ref?: string }) => void;
  /** t83 F5：高风险审批/人工输入期间把 Run 标为 waiting_human；结束后 resumeHuman。 */
  waitingHuman: (reason?: string) => void;
  resumeHuman: () => void;
}

export type RunExecutor = (ctx: RunExecutionContext) => Promise<RunExecutionResult | void>;

export interface KernelHooks {
  /** 启动前门禁（预算/看门狗/评测）；同步、快速；默认放行。 */
  beforeStart?: (info: {
    workspaceId: string;
    taskId: string;
    runId: string;
    agentId: string;
    attempt: number;
    priority: number;
  }) => boolean | { allow: boolean; reason?: string };
  onRunFinished?: (info: {
    runId: string;
    taskId: string;
    status: RunStatus;
    errorCode: string | null;
    tokenIn: number;
    tokenOut: number;
    durationMs: number;
  }) => void;
}

export interface ExecutionKernelOptions {
  store: Store;
  executor: RunExecutor;
  clock?: Clock;
  limits?: Partial<KernelLimits>;
  hooks?: KernelHooks;
  autoTick?: boolean;
  tickIntervalMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  dataDir?: string;
  instanceId?: string;
  bootId?: string;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyRunError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const value = error as { code?: unknown; retryable?: unknown } | null;
  const message = errorMessage(error);
  const code = typeof value?.code === "string" ? value.code : "INTERNAL";
  // "aborted" 只在取消竞态出现；取消路径应先写 run.cancelled，这里按不可重试处理。
  const retryable = message === "aborted" ? false : value?.retryable !== false;
  return { code: message === "aborted" ? "USER_CANCELLED" : code, message, retryable };
}

/**
 * t68 执行内核：事件 + 投影 + Task/Run 状态机 + DAG 调度 + 租约/心跳/重试/恢复。
 *
 * 设计要点：
 * - 所有命令在 Store.withTransaction 内完成「事件 + 投影」原子写；
 * - Scheduler.tick 单飞，用 CAS 把 queued 任务置为 running 并创建 Run；
 * - Run 执行异步（executor），结束回调再开事务写终态；
 * - 租约 owner=boot 标识，过期/异主由 recover 回收；
 * - 失败可重试时生成新 Run（attempt+1），绝不重用。
 */
export class ExecutionKernel {
  private readonly store: Store;
  private readonly executor: RunExecutor;
  private readonly clock: Clock;
  private readonly limits: KernelLimits;
  private readonly hooks: KernelHooks;
  private readonly dataDir: string | undefined;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly tickIntervalMs: number;
  private readonly owner: string;
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly lastHeartbeatEventAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private tickAgain = false;
  private disposed = false;

  constructor(options: ExecutionKernelOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.clock = options.clock ?? systemClock;
    this.limits = { ...DEFAULT_KERNEL_LIMITS, ...options.limits };
    this.hooks = options.hooks ?? {};
    this.dataDir = options.dataDir;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.backoffBaseMs = Math.max(0, options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS);
    this.maxBackoffMs = Math.max(this.backoffBaseMs, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
    this.tickIntervalMs = Math.max(20, options.tickIntervalMs ?? DEFAULT_TICK_MS);
    this.owner = `${options.instanceId ?? randomUUID()}:${options.bootId ?? randomUUID()}`;

    this.recover();
    if (options.autoTick !== false) {
      const timer = setInterval(() => this.tick(), this.tickIntervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.timer = timer;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.activeRuns.values()) controller.abort();
    this.activeRuns.clear();
  }

  get ownerId(): string {
    return this.owner;
  }

  getLimits(): KernelLimits {
    return { ...this.limits };
  }

  // ---------------------------------------------------------------- commands

  /** 入队（ready/blocked→queued），不等待执行。 */
  startTask(taskId: string): Task {
    const task = this.enqueueTask(taskId);
    this.tick();
    return task;
  }

  /** 兼容 service.runTask：入队并等待任务终态（done 正常返回，failed/cancelled 抛错）。 */
  async runTask(taskId: string): Promise<void> {
    this.enqueueTask(taskId);
    const pending = this.waitForTask(taskId);
    this.tick();
    await pending;
    const task = this.store.getTask(taskId);
    if (task?.status === "failed") {
      const runs = this.store.listRunsForTask(taskId);
      const last = runs[runs.length - 1];
      throw new Error(last?.error ?? task.failureKind ?? "task failed");
    }
    if (task?.status === "cancelled") throw new Error("task cancelled");
  }

  retryTask(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.status !== "failed") {
      throw new KernelError(
        "INVALID_TRANSITION",
        `only failed tasks can be retried (current: ${task.status})`,
      );
    }
    const now = this.clock.now();
    this.store.withTransaction(() => {
      const current = this.requireTask(taskId);
      assertTransition(current.status, "queued");
      patchTaskProjection(this.store, taskId, {
        status: "queued",
        queuedAt: iso(now),
        nextRunAt: iso(now),
        failureKind: null,
        endedAt: null,
      });
      this.appendEvent("task.status_changed", "task", taskId, {
        from: "failed",
        to: "queued",
        reason: "manual_retry",
        patch: { nextRunAt: iso(now), failureKind: null },
      });
      this.appendEvent("task.retry_scheduled", "task", taskId, {
        attempt: (current.attemptCount ?? 0) + 1,
        nextRunAt: iso(now),
        reason: "manual_retry",
      });
    });
    this.tick();
    return this.requireTask(taskId);
  }

  cancelTask(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.status === "cancelled") return task;
    if (task.status === "done") {
      throw new KernelError("INVALID_TRANSITION", "cannot cancel a done task");
    }
    const activeRun = this.findActiveRunForTask(taskId);
    const controller = activeRun ? this.activeRuns.get(activeRun.id) : undefined;
    this.store.withTransaction(() => {
      const current = this.requireTask(taskId);
      const now = iso(this.clock.now());
      if (activeRun) {
        this.patchRun(activeRun.id, {
          status: "cancelled",
          endedAt: now,
          error: "cancelled by user",
          errorCode: "USER_CANCELLED",
          retryable: false,
        });
        this.appendEvent("run.cancelled", "run", activeRun.id, {
          reason: "user_cancelled",
          patch: {
            status: "cancelled",
            endedAt: now,
            error: "cancelled by user",
            errorCode: "USER_CANCELLED",
            retryable: false,
          },
        });
      }
      assertTransition(current.status, "cancelled");
      patchTaskProjection(this.store, taskId, {
        status: "cancelled",
        endedAt: now,
        nextRunAt: null,
      });
      this.appendEvent("task.status_changed", "task", taskId, {
        from: current.status,
        to: "cancelled",
        reason: "user_cancelled",
        patch: { endedAt: now },
      });
      if (current.status === "running" && !activeRun) {
        this.appendEvent("task.cancelled", "task", taskId, { reason: "user_cancelled" });
      }
      this.setAgentIdleIfFree(current.ownerId);
    });
    controller?.abort();
    this.rejectWaiters(taskId, new Error("task cancelled"));
    this.refreshDependentTasks(taskId);
    return this.requireTask(taskId);
  }

  cancelRun(runId: string): Run {
    const run = this.requireRun(runId);
    if (!isActiveRunStatus(run.status)) return run;
    const controller = this.activeRuns.get(runId);
    this.store.withTransaction(() => {
      const now = iso(this.clock.now());
      this.patchRun(runId, {
        status: "cancelled",
        endedAt: now,
        error: "cancelled by user",
        errorCode: "USER_CANCELLED",
        retryable: false,
      });
      this.appendEvent("run.cancelled", "run", runId, {
        reason: "user_cancelled",
        patch: {
          status: "cancelled",
          endedAt: now,
          error: "cancelled by user",
          errorCode: "USER_CANCELLED",
          retryable: false,
        },
      });
      const task = this.store.getTask(run.taskId);
      if (task && task.status === "running") {
        patchTaskProjection(this.store, task.id, {
          status: "failed",
          endedAt: now,
          failureKind: "RUN_CANCELLED",
        });
        this.appendEvent("task.status_changed", "task", task.id, {
          from: "running",
          to: "failed",
          reason: "run_cancelled",
          patch: { failureKind: "RUN_CANCELLED", endedAt: now },
        });
      }
      this.setAgentIdleIfFree(run.agentId);
    });
    controller?.abort();
    if (run.taskId) this.rejectWaiters(run.taskId, new Error("run cancelled"));
    return this.requireRun(runId);
  }

  pauseScheduler(workspaceId: string, reason = "user_paused"): SchedulerSnapshot {
    const now = iso(this.clock.now());
    this.store.withTransaction(() => {
      this.store.db
        .prepare(
          "INSERT INTO scheduler_state (workspace_id, paused, paused_reason, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET paused = 1, paused_reason = excluded.paused_reason, updated_at = excluded.updated_at",
        )
        .run(workspaceId, reason, now);
      this.appendEvent("scheduler.paused", "scheduler", workspaceId, { reason });
    });
    return this.getScheduler(workspaceId);
  }

  resumeScheduler(workspaceId: string): SchedulerSnapshot {
    const now = iso(this.clock.now());
    this.store.withTransaction(() => {
      this.store.db
        .prepare(
          "INSERT INTO scheduler_state (workspace_id, paused, paused_reason, updated_at) VALUES (?, 0, NULL, ?) ON CONFLICT(workspace_id) DO UPDATE SET paused = 0, paused_reason = NULL, updated_at = excluded.updated_at",
        )
        .run(workspaceId, now);
      this.appendEvent("scheduler.resumed", "scheduler", workspaceId, {});
    });
    this.tick();
    return this.getScheduler(workspaceId);
  }

  // ----------------------------------------------------------------- queries

  listRuns(taskId: string): Run[] {
    return this.store.listRunsForTask(taskId);
  }

  getRun(runId: string): Run | null {
    return this.store.getRun(runId);
  }

  getScheduler(workspaceId: string): SchedulerSnapshot {
    const pausedRow = this.store.db
      .prepare("SELECT paused, paused_reason FROM scheduler_state WHERE workspace_id = ?")
      .get(workspaceId) as { paused?: number; paused_reason?: string } | undefined;
    const digest = projectionDigest(this.store, workspaceId);
    const queue = this.store.db
      .prepare(
        "SELECT id, title, priority, queued_at, owner_id FROM tasks WHERE workspace_id = ? AND status = 'queued' ORDER BY priority DESC, queued_at ASC, created_at ASC",
      )
      .all(workspaceId) as Array<{
      id?: string;
      title?: string;
      priority?: number;
      queued_at?: string;
      owner_id?: string;
    }>;
    const activeRows = this.store.db
      .prepare(
        `SELECT r.id, r.task_id, r.attempt, r.agent_id, r.status, r.started_at, r.heartbeat_at, r.ended_at, r.error_code
         FROM runs r JOIN tasks t ON t.id = r.task_id
         WHERE t.workspace_id = ? AND r.status IN ('queued','running','waiting_human')
         ORDER BY r.started_at ASC`,
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
    return {
      workspaceId,
      paused: Number(pausedRow?.paused ?? 0) === 1,
      pausedReason: pausedRow?.paused_reason ?? null,
      limits: { ...this.limits },
      counts: digest.tasks,
      activeRuns: activeRows.map((row) => ({
        id: String(row.id),
        taskId: String(row.task_id),
        attempt: Number(row.attempt ?? 1),
        agentId: String(row.agent_id),
        status: String(row.status) as RunStatus,
        startedAt: String(row.started_at),
        heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at),
        endedAt: row.ended_at == null ? null : String(row.ended_at),
        errorCode: row.error_code == null ? null : String(row.error_code),
      })) satisfies RunSummary[],
      queue: queue.map((row) => ({
        taskId: String(row.id),
        title: String(row.title),
        priority: Number(row.priority ?? 50),
        queuedAt: row.queued_at == null ? null : String(row.queued_at),
        ownerId: row.owner_id == null ? null : String(row.owner_id),
      })),
      updatedAt: iso(this.clock.now()),
    };
  }

  rebuildProjections(): ReturnType<typeof rebuildProjections> {
    return rebuildProjections(this.store);
  }

  // --------------------------------------------------------------- scheduler

  /** 单飞 tick：回收过期租约 + 启动 queued 任务。 */
  tick(): void {
    if (this.disposed) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      const now = this.clock.now();
      // t83 F2：本实例 active Run 也受 watchdog 约束；心跳/租约过期必须 abort+fail。
      this.watchdogActiveRuns(now);
      this.recoverExpiredLeases();
      const active = this.listActiveRuns();
      let globalCount = active.length;
      const workspaceCounts = new Map<string, number>();
      const agentCounts = new Map<string, number>();
      for (const run of active) {
        const task = this.store.getTask(run.taskId);
        if (!task) continue;
        workspaceCounts.set(task.workspaceId, (workspaceCounts.get(task.workspaceId) ?? 0) + 1);
        agentCounts.set(run.agentId, (agentCounts.get(run.agentId) ?? 0) + 1);
      }

      const candidates = this.store.db
        .prepare(
          "SELECT id FROM tasks WHERE status = 'queued' ORDER BY priority DESC, queued_at ASC, created_at ASC, id ASC",
        )
        .all() as Array<{ id?: string }>;

      for (const row of candidates) {
        if (globalCount >= this.limits.maxGlobal) break;
        const taskId = String(row.id);
        const task = this.store.getTask(taskId);
        if (!task || task.status !== "queued") continue;
        if (task.nextRunAt && Date.parse(task.nextRunAt) > now) continue;
        if (this.isSchedulerPaused(task.workspaceId)) continue;
        if (this.findActiveRunForTask(taskId)) continue;

        // 依赖在入队后可能变化：不满足则退回 blocked（防调度误执行）。
        const reason = blockedReasonFor(task, (id) => this.store.getTask(id));
        if (reason) {
          this.store.withTransaction(() => {
            const current = this.store.getTask(taskId);
            if (!current || current.status !== "queued") return;
            if (!canTransition("queued", "blocked")) return;
            patchTaskProjection(this.store, taskId, {
              status: "blocked",
              blockedReason: reason,
            });
            this.appendEvent("task.status_changed", "task", taskId, {
              from: "queued",
              to: "blocked",
              reason,
              patch: { blockedReason: reason },
            });
          });
          continue;
        }

        const workspaceActive = workspaceCounts.get(task.workspaceId) ?? 0;
        if (workspaceActive >= this.limits.maxWorkspace) continue;
        const agent = this.selectAgent(task);
        if (!agent) continue;
        if ((agentCounts.get(agent.id) ?? 0) >= this.limits.maxPerAgent) continue;

        const attempt = (task.attemptCount ?? 0) + 1;
        const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const hookResult = this.hooks.beforeStart?.({
          workspaceId: task.workspaceId,
          taskId,
          runId,
          agentId: agent.id,
          attempt,
          priority: task.priority ?? 50,
        });
        const allowed =
          hookResult === undefined
            ? true
            : typeof hookResult === "boolean"
              ? hookResult
              : hookResult.allow;
        if (!allowed) {
          this.store.withTransaction(() => {
            this.appendEvent("scheduler.rejected", "scheduler", task.workspaceId, {
              taskId,
              reason:
                hookResult && typeof hookResult === "object"
                  ? hookResult.reason ?? "hook_rejected"
                  : "hook_rejected",
            });
          });
          continue;
        }

        const started = this.startRun(task, agent, attempt, runId);
        if (!started) continue;
        globalCount += 1;
        workspaceCounts.set(task.workspaceId, workspaceActive + 1);
        agentCounts.set(agent.id, (agentCounts.get(agent.id) ?? 0) + 1);
      }
    } finally {
      this.ticking = false;
      if (this.tickAgain) {
        this.tickAgain = false;
        queueMicrotask(() => this.tick());
      }
    }
  }

  private startRun(task: Task, agent: Agent, attempt: number, runId: string): boolean {
    const now = this.clock.now();
    const nowIso = iso(now);
    const run: Run = {
      id: runId,
      taskId: task.id,
      agentId: agent.id,
      status: "running",
      error: null,
      startedAt: nowIso,
      endedAt: null,
      tokenIn: 0,
      tokenOut: 0,
      attempt,
      modelProfileId: null,
      modelId: null,
      permissionSnapshot: agent.permission,
      sandboxId: `workspace:${task.workspaceId}`,
      retryOfRunId: attempt > 1 ? this.store.listRunsForTask(task.id).slice(-1)[0]?.id ?? null : null,
      heartbeatAt: nowIso,
      leaseOwner: this.owner,
      leaseExpiresAt: iso(now + LEASE_MS),
      checkpointRef: null,
      checkpointStep: 0,
      costUsd: 0,
      errorCode: null,
      retryable: false,
      steps: 0,
    };
    let started = false;
    const workspace = this.store.getWorkspace(task.workspaceId);
    this.store.withTransaction(() => {
      const current = this.store.getTask(task.id);
      if (!current || current.status !== "queued") return;
      if (this.findActiveRunForTask(task.id)) return;
      // CAS：只有 queued 才能进 running。
      const changed = this.store.db
        .prepare("UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'queued'")
        .run(task.id);
      if (Number(changed.changes) !== 1) return;
      const executionFields = {
        ownerId: agent.id,
        startedAt: nowIso,
        attemptCount: attempt,
        nextRunAt: null,
        failureKind: null,
        worktree: workspace?.path ?? task.worktree,
        branch: task.branch ?? `deer/${task.id}`,
      };
      patchTaskProjection(this.store, task.id, executionFields);
      upsertRunProjection(this.store, run);
      this.appendEvent(
        "task.status_changed",
        "task",
        task.id,
        {
          from: "queued",
          to: "running",
          reason: "scheduler",
          runId,
          patch: executionFields,
        },
        `task:${task.id}:attempt:${attempt}:running`,
      );
      this.appendEvent(
        "run.started",
        "run",
        run.id,
        { run },
        `run:${task.id}:attempt:${attempt}:started`,
      );
      this.appendEvent("scheduler.admitted", "scheduler", task.workspaceId, {
        taskId: task.id,
        runId,
        attempt,
      });
      this.store.db.prepare("UPDATE agents SET status = 'running' WHERE id = ?").run(agent.id);
      started = true;
    });
    if (!started) return false;

    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);
    void this.executeRun(run.id, task.id, agent.id, controller);
    return true;
  }

  private async executeRun(
    runId: string,
    taskId: string,
    agentId: string,
    controller: AbortController,
  ): Promise<void> {
    if (this.disposed) return;
    try {
      const run = this.store.getRun(runId);
      const task = this.store.getTask(taskId);
      const agent = this.store.getAgent(agentId);
      if (!run || !task || !agent) return;
      const result = await this.executor({
        run,
        task,
        agent,
        signal: controller.signal,
        heartbeat: (info) => this.heartbeat(runId, info),
        checkpoint: (info) => this.checkpoint(runId, info),
        waitingHuman: (reason) => this.enterWaitingHuman(runId, reason),
        resumeHuman: () => this.resumeFromHuman(runId),
      });
      if (controller.signal.aborted) return;
      const current = this.store.getRun(runId);
      if (!current || current.status !== "running" && current.status !== "waiting_human") return;
      this.completeRun(runId, result ?? {});
    } catch (error) {
      if (this.disposed) return;
      const current = this.store.getRun(runId);
      if (!current || current.status === "cancelled" || controller.signal.aborted) return;
      this.failRun(runId, error);
    } finally {
      this.activeRuns.delete(runId);
      if (!this.disposed) this.tick();
    }
  }

  private completeRun(runId: string, result: RunExecutionResult): void {
    const now = this.clock.now();
    const nowIso = iso(now);
    this.store.withTransaction(() => {
      const run = this.store.getRun(runId);
      if (!run || !isActiveRunStatus(run.status)) return;
      if (run.leaseOwner !== this.owner) {
        // t90 F2：旧 owner 的终态写入被 fencing，记录丢弃审计。
        this.auditDiscarded(runId, "complete");
        return;
      }
      const patch = {
        status: "completed" as RunStatus,
        endedAt: nowIso,
        error: null,
        errorCode: null,
        retryable: false,
        tokenIn: result.tokenIn ?? run.tokenIn,
        tokenOut: result.tokenOut ?? run.tokenOut,
        steps: result.steps ?? run.steps ?? 0,
      };
      if (!this.casRunPatch(runId, patch, ["running", "waiting_human"])) {
        this.auditDiscarded(runId, "complete");
        return;
      }
      this.appendEvent("run.completed", "run", runId, { patch });
      const task = this.store.getTask(run.taskId);
      if (task && task.status === "running") {
        const summary = result.summary?.trim() || "任务完成。";
        const reviewPolicy = this.getReviewPolicy();
        if (reviewPolicy === "required") {
          assertTransition(task.status, "review");
          patchTaskProjection(this.store, task.id, {
            status: "review",
            summary,
            failureKind: null,
          });
          this.appendEvent("task.status_changed", "task", task.id, {
            from: "running",
            to: "review",
            reason: "review_required",
            runId,
            patch: { summary, failureKind: null },
          });
          this.appendEvent("task.review_requested", "task", task.id, {
            runId,
            policy: "required",
          });
        } else {
          assertTransition(task.status, "done");
          patchTaskProjection(this.store, task.id, {
            status: "done",
            summary,
            endedAt: nowIso,
            failureKind: null,
          });
          this.appendEvent("task.status_changed", "task", task.id, {
            from: "running",
            to: "done",
            reason: "run_completed",
            runId,
            patch: { summary, endedAt: nowIso, failureKind: null },
          });
        }
      }
      this.setAgentIdleIfFree(run.agentId);
      this.hooks.onRunFinished?.({
        runId,
        taskId: run.taskId,
        status: "completed",
        errorCode: null,
        tokenIn: patch.tokenIn,
        tokenOut: patch.tokenOut,
        durationMs: now - Date.parse(run.startedAt),
      });
    });
    this.resolveWaiters(runId);
    const completedTask = this.store.getTask(this.store.getRun(runId)?.taskId ?? "");
    if (completedTask) this.refreshDependentTasks(completedTask.id);
  }

  private failRun(
    runId: string,
    error: unknown,
    override?: { code: string; message: string; retryable: boolean },
  ): void {
    const classified = override ?? classifyRunError(error);
    const now = this.clock.now();
    const nowIso = iso(now);
    let retryQueued = false;
    let applied = false;
    this.store.withTransaction(() => {
      const run = this.store.getRun(runId);
      if (!run || !isActiveRunStatus(run.status)) return;
      if (run.leaseOwner !== this.owner) {
        this.auditDiscarded(runId, "fail");
        return;
      }
      const patch = {
        status: "failed" as RunStatus,
        endedAt: nowIso,
        error: classified.message,
        errorCode: classified.code,
        retryable: classified.retryable,
      };
      if (!this.casRunPatch(runId, patch, ["running", "waiting_human"])) {
        this.auditDiscarded(runId, "fail");
        return;
      }
      applied = true;
      this.appendEvent("run.failed", "run", runId, { patch });
      const task = this.store.getTask(run.taskId);
      if (task && task.status === "running") {
        const attempt = run.attempt ?? 1;
        const canRetry = classified.retryable && attempt < this.maxAttempts;
        if (canRetry) {
          const nextAt = now + this.backoffFor(attempt);
          patchTaskProjection(this.store, task.id, {
            status: "queued",
            nextRunAt: iso(nextAt),
            failureKind: classified.code,
          });
          this.appendEvent("task.status_changed", "task", task.id, {
            from: "running",
            to: "queued",
            reason: "retry_scheduled",
            runId,
            patch: { nextRunAt: iso(nextAt), failureKind: classified.code },
          });
          this.appendEvent("task.retry_scheduled", "task", task.id, {
            attempt: attempt + 1,
            nextRunAt: iso(nextAt),
            errorCode: classified.code,
          });
          retryQueued = true;
        } else {
          patchTaskProjection(this.store, task.id, {
            status: "failed",
            endedAt: nowIso,
            failureKind: classified.retryable ? "retry_exhausted" : classified.code,
          });
          this.appendEvent("task.status_changed", "task", task.id, {
            from: "running",
            to: "failed",
            reason: "run_failed",
            runId,
            patch: {
              endedAt: nowIso,
              failureKind: classified.retryable ? "retry_exhausted" : classified.code,
            },
          });
          if (classified.retryable) {
            this.appendEvent("task.retry_exhausted", "task", task.id, {
              attempts: attempt,
              lastErrorCode: classified.code,
            });
          }
        }
      }
      this.setAgentIdleIfFree(run.agentId);
      this.hooks.onRunFinished?.({
        runId,
        taskId: run.taskId,
        status: "failed",
        errorCode: classified.code,
        tokenIn: run.tokenIn,
        tokenOut: run.tokenOut,
        durationMs: now - Date.parse(run.startedAt),
      });
    });
    if (!retryQueued) {
      const finished = this.store.getRun(runId);
      if (applied && finished) this.rejectWaiters(finished.taskId, new Error(classified.message));
    }
    const failedTask = this.store.getRun(runId)?.taskId;
    if (failedTask) this.refreshDependentTasks(failedTask);
  }

  // ------------------------------------------------------------------- lease

  heartbeat(
    runId: string,
    info: { tokenIn?: number; tokenOut?: number; steps?: number } = {},
  ): void {
    if (!this.activeRuns.has(runId)) return;
    const now = this.clock.now();
    const run = this.store.getRun(runId);
    if (!run || !isActiveRunStatus(run.status)) return;
    if (run.leaseOwner !== this.owner) {
      this.store.withTransaction(() => this.auditDiscarded(runId, "heartbeat"));
      return;
    }
    const patch = {
      heartbeatAt: iso(now),
      leaseExpiresAt: iso(now + LEASE_MS),
      ...(typeof info.tokenIn === "number" ? { tokenIn: info.tokenIn } : {}),
      ...(typeof info.tokenOut === "number" ? { tokenOut: info.tokenOut } : {}),
      ...(typeof info.steps === "number" ? { steps: info.steps } : {}),
    };
    const last = this.lastHeartbeatEventAt.get(runId) ?? 0;
    this.store.withTransaction(() => {
      if (!this.casRunPatch(runId, patch, ["running", "waiting_human"])) {
        this.auditDiscarded(runId, "heartbeat");
        return;
      }
      if (now - last >= HEARTBEAT_EVENT_MS) {
        this.appendEvent("run.heartbeat", "run", runId, { patch });
        this.lastHeartbeatEventAt.set(runId, now);
      }
    });
  }

  /** t83 F5：进入人工等待（审批/评审），独立租约 keeper 由 watchdog 续租。 */
  enterWaitingHuman(runId: string, reason = "human_input"): void {
    if (!this.activeRuns.has(runId)) return;
    const now = this.clock.now();
    const run = this.store.getRun(runId);
    if (!run || !isActiveRunStatus(run.status)) return;
    if (run.leaseOwner !== this.owner) {
      this.store.withTransaction(() => this.auditDiscarded(runId, "enter_waiting_human"));
      return;
    }
    this.store.withTransaction(() => {
      const patch = {
        status: "waiting_human" as RunStatus,
        heartbeatAt: iso(now),
        leaseExpiresAt: iso(now + LEASE_MS),
      };
      if (!this.casRunPatch(runId, patch, ["running"])) {
        this.auditDiscarded(runId, "enter_waiting_human");
        return;
      }
      this.appendEvent("run.waiting_human", "run", runId, { reason, patch });
    });
  }

  /** t83 F5：人工等待结束，Run 回到 running 继续执行。 */
  resumeFromHuman(runId: string, reason = "human_resolved"): void {
    const now = this.clock.now();
    const run = this.store.getRun(runId);
    if (!run || !isActiveRunStatus(run.status)) return;
    if (run.leaseOwner !== this.owner) {
      this.store.withTransaction(() => this.auditDiscarded(runId, "resume"));
      return;
    }
    this.store.withTransaction(() => {
      const patch = {
        status: "running" as RunStatus,
        heartbeatAt: iso(now),
        leaseExpiresAt: iso(now + LEASE_MS),
      };
      if (!this.casRunPatch(runId, patch, ["waiting_human"])) {
        this.auditDiscarded(runId, "resume");
        return;
      }
      this.appendEvent("run.resumed", "run", runId, { reason, patch });
    });
  }

  checkpoint(runId: string, info: { step: number; ref?: string }): void {
    if (!this.activeRuns.has(runId)) return;
    const run = this.store.getRun(runId);
    if (!run || run.status !== "running") return;
    if (run.leaseOwner !== this.owner) {
      this.store.withTransaction(() => this.auditDiscarded(runId, "checkpoint"));
      return;
    }
    const ref = info.ref ?? this.writeCheckpointFile(runId, info.step);
    const patch = { checkpointRef: ref, checkpointStep: info.step };
    this.store.withTransaction(() => {
      if (!this.casRunPatch(runId, patch, ["running"])) {
        this.auditDiscarded(runId, "checkpoint");
        return;
      }
      this.appendEvent("run.checkpoint", "run", runId, { ...patch, patch });
    });
  }

  /**
   * t83 F2：本实例 active Run 的 watchdog。
   * - running 且 heartbeat/lease 过期 → abort controller + failRun(LEASE_EXPIRED) + 审计；
   * - waiting_human 且租约过期 → 独立 keeper 续租（审批 120s > lease 60s 不被回收）。
   */
  private watchdogActiveRuns(now: number): void {
    for (const [runId, controller] of [...this.activeRuns.entries()]) {
      const run = this.store.getRun(runId);
      if (!run || !isActiveRunStatus(run.status) || run.leaseOwner !== this.owner) continue;
      const leaseExpired = !run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= now;
      const heartbeatAt = run.heartbeatAt ? Date.parse(run.heartbeatAt) : Number.NaN;
      const heartbeatStale = Number.isNaN(heartbeatAt) || now - heartbeatAt >= LEASE_MS;
      if (!leaseExpired && !heartbeatStale) continue;
      if (run.status === "waiting_human") {
        this.store.withTransaction(() => {
          this.casRunPatch(
            runId,
            { heartbeatAt: iso(now), leaseExpiresAt: iso(now + LEASE_MS) },
            ["waiting_human"],
          );
        });
        continue;
      }
      controller.abort();
      this.failRun(
        runId,
        new Error("lease expired while running"),
        {
          code: "LEASE_EXPIRED",
          message: "lease expired while running",
          retryable: true,
        },
      );
      this.appendEvent("kernel.recovered", "kernel", runId, {
        runId,
        taskId: run.taskId,
        action: "lease_expired",
        source: "watchdog",
        attempt: run.attempt ?? 1,
      });
      this.activeRuns.delete(runId);
    }
  }

  private writeCheckpointFile(runId: string, step: number): string {
    if (!this.dataDir) return `checkpoints/${runId}.json`;
    try {
      const dir = path.join(this.dataDir, "checkpoints");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, `${runId}.json`),
        JSON.stringify({ runId, step, updatedAt: iso(this.clock.now()) }),
        "utf8",
      );
      return `checkpoints/${runId}.json`;
    } catch {
      return `checkpoints/${runId}.json`;
    }
  }

  private recoverExpiredLeases(reclaimForeign = false): void {
    const now = this.clock.now();
    const active = this.listActiveRuns();
    for (const run of active) {
      if (this.activeRuns.has(run.id)) continue; // 本实例正在执行
      const task = this.store.getTask(run.taskId);
      const orphaned = !task || isTerminalTaskStatus(task.status);
      const expired = !run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= now;
      const foreign = run.leaseOwner !== this.owner;
      // t90：周期 tick 不抢占“异主但租约仍有效”的 Run（可能属于另一个活实例）；
      // 启动/recover() 才允许回收异主 Run。
      if (!orphaned && !expired && !(foreign && reclaimForeign)) continue;
      if (orphaned) {
        this.store.withTransaction(() => {
          const nowIso = iso(now);
          this.patchRun(run.id, {
            status: "cancelled",
            endedAt: nowIso,
            error: "orphaned run",
            errorCode: "ORPHANED",
            retryable: false,
          });
          this.appendEvent("run.cancelled", "run", run.id, {
            reason: "orphaned",
            patch: {
              status: "cancelled",
              endedAt: nowIso,
              error: "orphaned run",
              errorCode: "ORPHANED",
              retryable: false,
            },
          });
          this.appendEvent("kernel.recovered", "kernel", run.id, {
            runId: run.id,
            taskId: run.taskId,
            action: "orphan_cancelled",
          });
        });
        continue;
      }
      this.recoverRun(run, task);
    }
  }

  private recoverRun(run: Run, task: Task): void {
    const now = this.clock.now();
    const nowIso = iso(now);
    const attempt = run.attempt ?? 1;
    this.store.withTransaction(() => {
      const current = this.store.getRun(run.id);
      if (!current || !isActiveRunStatus(current.status)) return;
      this.patchRun(run.id, {
        status: "failed",
        endedAt: nowIso,
        error: "lease expired; run recovered after crash",
        errorCode: "LEASE_EXPIRED",
        retryable: true,
      });
      this.appendEvent("run.failed", "run", run.id, {
        patch: {
          status: "failed",
          endedAt: nowIso,
          error: "lease expired; run recovered after crash",
          errorCode: "LEASE_EXPIRED",
          retryable: true,
        },
      });
      if (task.status === "running") {
        const canRetry = attempt < this.maxAttempts;
        patchTaskProjection(this.store, task.id, {
          status: canRetry ? "queued" : "failed",
          nextRunAt: canRetry ? iso(now) : null,
          failureKind: canRetry ? "LEASE_EXPIRED" : "retry_exhausted",
          endedAt: canRetry ? null : nowIso,
        });
        this.appendEvent("task.status_changed", "task", task.id, {
          from: "running",
          to: canRetry ? "queued" : "failed",
          reason: "lease_expired",
          runId: run.id,
          patch: {
            nextRunAt: canRetry ? iso(now) : null,
            failureKind: canRetry ? "LEASE_EXPIRED" : "retry_exhausted",
            endedAt: canRetry ? null : nowIso,
          },
        });
      }
      this.setAgentIdleIfFree(run.agentId);
      this.appendEvent("kernel.recovered", "kernel", run.id, {
        runId: run.id,
        taskId: run.taskId,
        action: "lease_expired",
        attempt,
      });
    });
    this.rejectWaiters(run.taskId, new Error("run recovered after lease expiry"));
  }

  /** 启动恢复：租约/Foreign/孤儿 + running/queued 任务状态归一（幂等）。 */
  recover(): void {
    this.recoverExpiredLeases(true);
    const now = iso(this.clock.now());
    this.store.withTransaction(() => {
      const runningTasks = this.store.db
        .prepare("SELECT id FROM tasks WHERE status = 'running'")
        .all() as Array<{ id?: string }>;
      for (const row of runningTasks) {
        const taskId = String(row.id);
        if (this.findActiveRunForTask(taskId)) continue;
        const task = this.store.getTask(taskId);
        if (!task) continue;
        const canRetry = (task.attemptCount ?? 0) < this.maxAttempts;
        patchTaskProjection(this.store, taskId, {
          status: canRetry ? "queued" : "failed",
          nextRunAt: canRetry ? now : null,
          failureKind: canRetry ? "LEASE_EXPIRED" : "INTERNAL",
          endedAt: canRetry ? null : now,
        });
        this.appendEvent("task.status_changed", "task", taskId, {
          from: "running",
          to: canRetry ? "queued" : "failed",
          reason: "recovery_running_without_run",
          patch: { nextRunAt: canRetry ? now : null, failureKind: canRetry ? "LEASE_EXPIRED" : "INTERNAL" },
        });
        if (task.ownerId) this.setAgentIdleIfFree(task.ownerId);
      }

      const queuedTasks = this.store.db
        .prepare("SELECT id FROM tasks WHERE status = 'queued'")
        .all() as Array<{ id?: string }>;
      for (const row of queuedTasks) {
        const taskId = String(row.id);
        const task = this.store.getTask(taskId);
        if (!task) continue;
        const reason = blockedReasonFor(task, (id) => this.store.getTask(id));
        if (!reason) continue;
        patchTaskProjection(this.store, taskId, {
          status: "blocked",
          blockedReason: reason,
        });
        this.appendEvent("task.status_changed", "task", taskId, {
          from: "queued",
          to: "blocked",
          reason: "recovery_dependencies",
          patch: { blockedReason: reason },
        });
      }

      const blockedTasks = this.store.db
        .prepare("SELECT id FROM tasks WHERE status = 'blocked'")
        .all() as Array<{ id?: string }>;
      for (const row of blockedTasks) {
        const taskId = String(row.id);
        const task = this.store.getTask(taskId);
        if (!task) continue;
        const reason = blockedReasonFor(task, (id) => this.store.getTask(id));
        if (reason) {
          if (task.blockedReason !== reason) {
            patchTaskProjection(this.store, taskId, { blockedReason: reason });
            // t83 F7 / t76 T22：仅原因更新，不改状态；写 task.blocked 审计。
            this.appendEvent(
              "task.blocked",
              "task",
              taskId,
              { reason, previousReason: task.blockedReason ?? undefined },
              this.blockedReasonKey(taskId, reason),
            );
          }
          continue;
        }
        patchTaskProjection(this.store, taskId, { status: "ready", blockedReason: null });
        this.appendEvent("task.status_changed", "task", taskId, {
          from: "blocked",
          to: "ready",
          reason: "recovery_dependencies_done",
          patch: { blockedReason: null },
        });
      }
    });
  }

  /**
   * 依赖状态变化后刷新直接下游：
   * - 依赖 failed/cancelled → 下游 blocked(dependency_failed|cancelled)；
   * - 依赖仍运行/排队 → 下游 blocked(waiting_dependencies)（原因更新）；
   * - 依赖全部 done → 下游 blocked → ready。
   * 只更新直接下游；更远下游由各自依赖事件触发（下一次刷新自然级联）。
   */
  private refreshDependentTasks(changedTaskId: string): void {
    const changed = this.store.getTask(changedTaskId);
    if (!changed) return;
    const dependents = this.store
      .listTasks(changed.workspaceId)
      .filter((task) => task.dependsOn.includes(changedTaskId));
    if (!dependents.length) return;
    this.store.withTransaction(() => {
      for (const dependent of dependents) {
        const current = this.store.getTask(dependent.id);
        if (!current) continue;
        if (current.status !== "blocked" && current.status !== "ready" && current.status !== "queued") {
          continue;
        }
        const reason = blockedReasonFor(current, (id) => this.store.getTask(id));
        if (reason) {
          if (current.status === "blocked") {
            if (current.blockedReason !== reason) {
              patchTaskProjection(this.store, current.id, { blockedReason: reason });
              // t83 F7 / t76 T22：blocked(reasonA)→blocked(reasonB) 只写 task.blocked 审计。
              this.appendEvent(
                "task.blocked",
                "task",
                current.id,
                { reason, previousReason: current.blockedReason ?? undefined },
                this.blockedReasonKey(current.id, reason),
              );
            }
            continue;
          }
          if (!canTransition(current.status, "blocked")) continue;
          patchTaskProjection(this.store, current.id, { status: "blocked", blockedReason: reason });
          this.appendEvent("task.status_changed", "task", current.id, {
            from: current.status,
            to: "blocked",
            reason,
            patch: { blockedReason: reason },
          });
          continue;
        }
        if (current.status === "blocked") {
          patchTaskProjection(this.store, current.id, { status: "ready", blockedReason: null });
          this.appendEvent("task.status_changed", "task", current.id, {
            from: "blocked",
            to: "ready",
            reason: "dependencies_done",
            patch: { blockedReason: null },
          });
        }
      }
    });
  }

  // ----------------------------------------------------------------- helpers

  private enqueueTask(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.status === "running") throw new Error("task is already running");
    if (task.status === "done") throw new Error("task is already done");
    if (task.status === "cancelled") throw new Error("task is cancelled");
    if (task.status === "queued") return task;
    if (task.status === "review") {
      throw new KernelError("INVALID_TRANSITION", "task is waiting for review");
    }
    if (task.status === "failed") {
      throw new KernelError("INVALID_TRANSITION", "task has failed; use retryTask");
    }
    if (task.status !== "ready" && task.status !== "blocked") {
      throw new KernelError("INVALID_TRANSITION", `cannot start task from ${task.status}`);
    }
    const reason = blockedReasonFor(task, (id) => this.store.getTask(id));
    if (reason) {
      const firstBlocked = task.dependsOn
        .map((id) => this.store.getTask(id))
        .find((dependency) => dependency && dependency.status !== "done");
      throw new Error(`dependency is not done: ${firstBlocked?.title ?? "unknown"}`);
    }
    const now = iso(this.clock.now());
    this.store.withTransaction(() => {
      const current = this.requireTask(taskId);
      if (current.status === "blocked") {
        assertTransition("blocked", "ready");
        patchTaskProjection(this.store, taskId, { status: "ready", blockedReason: null });
        this.appendEvent("task.status_changed", "task", taskId, {
          from: "blocked",
          to: "ready",
          reason: "dependencies_done",
          patch: { blockedReason: null },
        });
      }
      assertTransition("ready", "queued");
      patchTaskProjection(this.store, taskId, {
        status: "queued",
        queuedAt: now,
        nextRunAt: now,
        failureKind: null,
      });
      this.appendEvent("task.status_changed", "task", taskId, {
        from: current.status === "blocked" ? "ready" : "ready",
        to: "queued",
        reason: "user_start",
        patch: { queuedAt: now, nextRunAt: now, failureKind: null },
      });
    });
    return this.requireTask(taskId);
  }

  private selectAgent(task: Task): Agent | null {
    const candidates: Agent[] = [];
    if (task.ownerId) {
      const owner = this.store.getAgent(task.ownerId);
      if (owner && !owner.isRouter && owner.status !== "offline") candidates.push(owner);
    }
    for (const agent of this.store.listAgents(task.workspaceId)) {
      if (agent.isRouter || agent.status === "offline") continue;
      if (candidates.some((item) => item.id === agent.id)) continue;
      candidates.push(agent);
    }
    for (const agent of candidates) {
      if (this.agentActiveCount(agent.id) >= this.limits.maxPerAgent) continue;
      return agent;
    }
    return null;
  }

  private agentActiveCount(agentId: string): number {
    const row = this.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM runs WHERE agent_id = ? AND status IN ('queued','running','waiting_human')",
      )
      .get(agentId) as { count?: number };
    return Number(row.count ?? 0);
  }

  private findActiveRunForTask(taskId: string): Run | null {
    const row = this.store.db
      .prepare(
        "SELECT * FROM runs WHERE task_id = ? AND status IN ('queued','running','waiting_human') ORDER BY attempt DESC LIMIT 1",
      )
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.store.getRun(String(row.id));
  }

  private listActiveRuns(): Run[] {
    const rows = this.store.db
      .prepare("SELECT id FROM runs WHERE status IN ('queued','running','waiting_human') ORDER BY started_at ASC")
      .all() as Array<{ id?: string }>;
    return rows
      .map((row) => this.store.getRun(String(row.id)))
      .filter((run): run is Run => Boolean(run));
  }

  private isSchedulerPaused(workspaceId: string): boolean {
    const row = this.store.db
      .prepare("SELECT paused FROM scheduler_state WHERE workspace_id = ?")
      .get(workspaceId) as { paused?: number } | undefined;
    return Number(row?.paused ?? 0) === 1;
  }

  /**
   * t83 F5：reviewPolicy=required 的批准/拒绝。
   * approve: review→done；reject: review→failed(REVIEW_REJECTED)；均写审计事件。
   */
  reviewTask(
    taskId: string,
    decision: "approve" | "reject",
    options: { reviewer?: string; notes?: string } = {},
  ): Task {
    const task = this.requireTask(taskId);
    if (task.status !== "review") {
      throw new KernelError(
        "INVALID_TRANSITION",
        `only review tasks can be reviewed (current: ${task.status})`,
      );
    }
    const nowIso = iso(this.clock.now());
    this.store.withTransaction(() => {
      const current = this.requireTask(taskId);
      if (decision === "approve") {
        assertTransition(current.status, "done");
        patchTaskProjection(this.store, taskId, {
          status: "done",
          endedAt: nowIso,
          failureKind: null,
        });
        this.appendEvent("task.review_approved", "task", taskId, {
          reviewer: options.reviewer,
          notes: options.notes,
        });
        this.appendEvent("task.status_changed", "task", taskId, {
          from: "review",
          to: "done",
          reason: "review_approved",
          patch: { endedAt: nowIso, failureKind: null },
        });
      } else {
        assertTransition(current.status, "failed");
        patchTaskProjection(this.store, taskId, {
          status: "failed",
          endedAt: nowIso,
          failureKind: "REVIEW_REJECTED",
        });
        this.appendEvent("task.review_rejected", "task", taskId, {
          reviewer: options.reviewer,
          notes: options.notes,
        });
        this.appendEvent("task.status_changed", "task", taskId, {
          from: "review",
          to: "failed",
          reason: "review_rejected",
          patch: { endedAt: nowIso, failureKind: "REVIEW_REJECTED" },
        });
      }
    });
    if (decision === "approve") this.resolveTaskWaiters(taskId);
    else this.rejectWaiters(taskId, new Error("review rejected"));
    this.refreshDependentTasks(taskId);
    return this.requireTask(taskId);
  }

  private getReviewPolicy(): "auto" | "required" {
    return this.store.getSetting("kernel.reviewPolicy") === "required" ? "required" : "auto";
  }

  /** t90 F2：CAS/owner 校验失败时记录丢弃审计，不改变投影或 Run 状态。 */
  private auditDiscarded(
    runId: string,
    action:
      | "heartbeat"
      | "checkpoint"
      | "enter_waiting_human"
      | "resume"
      | "complete"
      | "fail",
  ): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    this.appendEvent("run.result_discarded", "run", runId, {
      runId,
      action,
      owner: run.leaseOwner ?? null,
      reason: "stale_owner_or_cas_failed",
    });
  }

  private casRunPatch(
    runId: string,
    patch: Record<string, unknown>,
    statuses: RunStatus[],
  ): boolean {
    const columns: Record<string, string> = {
      status: "status",
      endedAt: "ended_at",
      error: "error",
      errorCode: "error_code",
      retryable: "retryable",
      tokenIn: "token_in",
      tokenOut: "token_out",
      steps: "steps",
      heartbeatAt: "heartbeat_at",
      leaseExpiresAt: "lease_expires_at",
      checkpointRef: "checkpoint_ref",
      checkpointStep: "checkpoint_step",
    };
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      const value = patch[key];
      sets.push(`${column} = ?`);
      params.push(
        value === null || value === undefined
          ? null
          : typeof value === "boolean"
            ? value
              ? 1
              : 0
            : (value as string | number),
      );
    }
    if (!sets.length) return false;
    const placeholders = statuses.map(() => "?").join(",");
    params.push(runId, this.owner, ...statuses);
    const result = this.store.db
      .prepare(
        `UPDATE runs SET ${sets.join(", ")} WHERE id = ? AND lease_owner = ? AND status IN (${placeholders})`,
      )
      .run(...params);
    return Number(result.changes) === 1;
  }

  private patchTask(taskId: string, patch: Record<string, unknown>): void {
    patchTaskProjection(this.store, taskId, patch);
  }

  private patchRun(runId: string, patch: Record<string, unknown>): void {
    patchRunProjection(this.store, runId, patch);
  }

  private setAgentIdleIfFree(agentId: string | null): void {
    if (!agentId) return;
    if (this.agentActiveCount(agentId) > 0) return;
    this.store.db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agentId);
  }

  private appendEvent(
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): void {
    // t83 F4：新内核事件显式 schemaVersion=2；旧调用方（store.appendEvent）默认 1。
    assertKernelEventPayload(type, payload, 2);
    this.store.appendEventIdempotent({
      aggregateType,
      aggregateId,
      type,
      actor: "system",
      payload,
      schemaVersion: 2,
      idempotencyKey: idempotencyKey ?? null,
    });
  }

  private blockedReasonKey(taskId: string, reason: string): string {
    const row = this.store.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE aggregate_id = ?")
      .get(taskId) as { seq?: number };
    return `task:${taskId}:blocked:${reason}:${Number(row.seq ?? 0) + 1}`;
  }

  private backoffFor(attempt: number): number {
    const base = Math.min(this.backoffBaseMs * 2 ** Math.max(0, attempt - 1), this.maxBackoffMs);
    // 确定性抖动：按 attempt 固定 ±20%，便于测试复现。
    const jitter = 0.8 + ((attempt * 37) % 41) / 100;
    return Math.round(base * jitter);
  }

  private requireTask(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new KernelError("NOT_FOUND", `task not found: ${taskId}`);
    return task;
  }

  private requireRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new KernelError("NOT_FOUND", `run not found: ${runId}`);
    return run;
  }

  private waitForTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) return Promise.reject(new KernelError("NOT_FOUND", `task not found: ${taskId}`));
    if (task.status === "done") return Promise.resolve();
    if (task.status === "failed") {
      return Promise.reject(new Error("task failed"));
    }
    if (task.status === "cancelled") return Promise.reject(new Error("task cancelled"));
    return new Promise<void>((resolve, reject) => {
      const list = this.waiters.get(taskId) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(taskId, list);
    });
  }

  private resolveWaiters(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    const task = this.store.getTask(run.taskId);
    if (!task || task.status !== "done") return;
    this.resolveTaskWaiters(task.id);
  }

  private resolveTaskWaiters(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task || task.status !== "done") return;
    const list = this.waiters.get(taskId) ?? [];
    this.waiters.delete(taskId);
    for (const waiter of list) waiter.resolve();
  }

  private rejectWaiters(taskId: string, error: Error): void {
    const list = this.waiters.get(taskId) ?? [];
    this.waiters.delete(taskId);
    for (const waiter of list) waiter.reject(error);
  }
}

export { FakeClock };
