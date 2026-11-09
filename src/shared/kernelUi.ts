import type {
  EventRecord,
  KernelErrorCode,
  KernelResult,
  Run,
  RunStatus,
  SchedulerSnapshot,
  Task,
  TaskStatus,
} from "./types";
import {
  BLOCKED_REASON_LABEL,
  FAILURE_KIND_LABEL,
  KERNEL_ERROR_LABEL,
  RUN_STATUS_LABEL,
  TASK_STATUS_LABEL,
} from "./copy";

/**
 * t69 调度/Run 可观测 UI 的纯视图逻辑。
 *
 * 所有函数都是无副作用的纯函数，方便单元测试；组件只负责排版与交互。
 * 原则：状态文案统一走 shared/copy；内核错误码不解析 message；时间/耗时/attempt
 * 展示口径在任务页、团队页与 Run 面板之间保持一致。
 */

export const MAX_AUTO_ATTEMPTS = 3;

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "waiting_human",
];

export function isActiveRunStatus(status: RunStatus | string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

/** 稳定错误码 + 可读 message：UI 用 code 选文案，不依赖 message 文本。 */
export class KernelUiError extends Error {
  readonly code: KernelErrorCode;
  readonly details?: unknown;

  constructor(error: { code: KernelErrorCode; message: string; details?: unknown }) {
    super(kernelErrorText(error));
    this.name = "KernelUiError";
    this.code = error.code;
    this.details = error.details;
  }
}

export function kernelErrorText(error: {
  code: KernelErrorCode;
  message: string;
}): string {
  const label = KERNEL_ERROR_LABEL[error.code];
  if (!label) return error.message;
  return error.message ? `${label}：${error.message}` : label;
}

export function unwrapKernel<T>(result: KernelResult<T>): T {
  if (!result.ok) throw new KernelUiError(result.error);
  return result.value;
}

export function runStatusLabel(status: RunStatus | string): string {
  return RUN_STATUS_LABEL[status as RunStatus] ?? status;
}

export function blockedReasonText(reason: string | null | undefined): string {
  if (!reason) return "等待依赖";
  return BLOCKED_REASON_LABEL[reason] ?? reason;
}

export function failureKindText(kind: string | null | undefined): string {
  if (!kind) return "未知失败";
  return FAILURE_KIND_LABEL[kind] ?? kind;
}

// --------------------------------------------------------------- time / number

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

export function formatClockTime(iso: string | null | undefined): string {
  const value = parseTime(iso);
  if (value === null) return "—";
  try {
    return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return iso ?? "—";
  }
}

export function formatDateTime(iso: string | null | undefined): string {
  const value = parseTime(iso);
  if (value === null) return "—";
  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso ?? "—";
  }
}

/** 毫秒 → 12s / 3m 04s / 1h 02m；<=0 显示 <1s。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 0) return "—";
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours}h ${String(restMinutes).padStart(2, "0")}m`;
}

export function durationBetween(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  now = Date.now(),
): number | null {
  const start = parseTime(startIso);
  if (start === null) return null;
  const end = endIso ? parseTime(endIso) : now;
  if (end === null) return null;
  return Math.max(0, end - start);
}

export function runDuration(run: Run | null | undefined, now = Date.now()): number | null {
  if (!run) return null;
  return durationBetween(run.startedAt, run.endedAt, now);
}

/** 相对时间：刚刚 / 12 秒前 / 3 分钟前 / 2 小时前 / 3 天前。 */
export function formatRelative(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  const value = parseTime(iso);
  if (value === null) return "—";
  const diff = now - value;
  if (diff < 0) return "刚刚";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function runTokenText(run: Run | null | undefined): string {
  if (!run) return "—";
  return `${formatTokens(run.tokenIn)} / ${formatTokens(run.tokenOut)}`;
}

// --------------------------------------------------------------------- task

export function taskAttemptText(task: Task | null | undefined): string {
  const count = task?.attemptCount ?? 0;
  if (count <= 0) return "未运行";
  return `第 ${count} 次`;
}

/** 设计 §9.4 的 attempt/max；手动重试超过 3 次时只显示次数，避免误导。 */
export function taskAttemptRatioText(task: Task | null | undefined): string {
  const count = task?.attemptCount ?? 0;
  if (count <= 0) return "—";
  if (count <= MAX_AUTO_ATTEMPTS) return `${count}/${MAX_AUTO_ATTEMPTS}`;
  return `${count} 次`;
}

export function statusCounts(tasks: Task[]): Record<TaskStatus | "all", number> {
  const counts: Record<TaskStatus | "all", number> = {
    all: tasks.length,
    ready: 0,
    queued: 0,
    running: 0,
    blocked: 0,
    review: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}

export function filterTaskList(
  tasks: Task[],
  filter: TaskStatus | "all",
  keyword: string,
): Task[] {
  const trimmed = keyword.trim().toLowerCase();
  return tasks.filter((task) => {
    const statusOk = filter === "all" || task.status === filter;
    if (!statusOk) return false;
    if (!trimmed) return true;
    return (
      task.title.toLowerCase().includes(trimmed) ||
      task.id.toLowerCase().includes(trimmed) ||
      (task.summary ?? "").toLowerCase().includes(trimmed) ||
      (task.description ?? "").toLowerCase().includes(trimmed)
    );
  });
}

export function unfinishedDependencies(
  task: Task,
  tasksById: Map<string, Task>,
): Task[] {
  return task.dependsOn
    .map((id) => tasksById.get(id))
    .filter((item): item is Task => Boolean(item) && item!.status !== "done");
}

export type ActionGate = { enabled: boolean; reason: string };

function gate(enabled: boolean, reason: string): ActionGate {
  return { enabled, reason: enabled ? "" : reason };
}

export interface TaskActionState {
  start: ActionGate;
  retry: ActionGate;
  cancel: ActionGate;
  review: ActionGate;
}

/**
 * 任务操作约束（与 t68 内核命令一致，UI 只做前置解释，最终以内核错误为准）：
 * - start：ready 或「依赖已完成的 blocked」；失败请用重试；queued/running/review/done/cancelled 不可；
 * - retry：仅 failed；
 * - cancel：done/cancelled 之外的任何状态（内核允许 failed→cancelled）；
 * - review：仅 review（reviewPolicy=required 时）。
 */
export function taskActionState(
  task: Task,
  tasksById: Map<string, Task>,
  hasWorker: boolean,
): TaskActionState {
  const deps = unfinishedDependencies(task, tasksById);
  const depReason = deps.length
    ? `上游依赖未完成：${deps.map((item) => item.title).join("、")}`
    : "";
  let start: ActionGate;
  if (!hasWorker) start = gate(false, "还没有成员，请先到「团队」创建成员");
  else if (task.status === "ready") start = gate(true, "");
  else if (task.status === "blocked") {
    start = deps.length ? gate(false, depReason) : gate(true, "");
  } else if (task.status === "queued") start = gate(false, "任务已在队列中");
  else if (task.status === "running") start = gate(false, "任务正在运行");
  else if (task.status === "review") start = gate(false, "任务正在等待评审");
  else if (task.status === "failed") start = gate(false, "失败任务请使用「重试」");
  else start = gate(false, "任务已结束");

  const retry =
    task.status === "failed"
      ? gate(true, "")
      : gate(false, "只有失败任务可以重试");

  const cancel =
    task.status === "done" || task.status === "cancelled"
      ? gate(false, "任务已结束，无需取消")
      : gate(true, "");

  const review =
    task.status === "review"
      ? gate(true, "")
      : gate(false, "只有评审中的任务可以批准/拒绝");

  return { start, retry, cancel, review };
}

export interface TaskNextStep {
  kind: "start" | "retry" | "review" | "wait" | "none";
  label: string;
  detail: string;
}

/** 失败/阻塞/排队/运行中状态的「下一步」解释（空态与错误态之外的可读性兜底）。 */
export function taskNextStep(
  task: Task,
  tasksById: Map<string, Task>,
  hasWorker: boolean,
): TaskNextStep {
  const deps = unfinishedDependencies(task, tasksById);
  switch (task.status) {
    case "blocked":
      return {
        kind: "wait",
        label: "等待上游依赖",
        detail: deps.length
          ? `${blockedReasonText(task.blockedReason)}：${deps
              .map((item) => `${item.title}（${TASK_STATUS_LABEL[item.status]}）`)
              .join("、")}`
          : blockedReasonText(task.blockedReason),
      };
    case "failed":
      return {
        kind: "retry",
        label: "失败原因",
        detail: `${failureKindText(task.failureKind)}。确认原因后可人工重试（会新建一次 attempt）。`,
      };
    case "queued":
      return {
        kind: "wait",
        label: "已进入调度队列",
        detail: `等待空闲成员与并发配额；当前工作区同一时刻只运行 1 个任务。`,
      };
    case "running":
      return {
        kind: "wait",
        label: "正在运行",
        detail: "可在下方 Run 历史查看 attempt、心跳、tokens 与事件；取消会中止当前 Run。",
      };
    case "review":
      return {
        kind: "review",
        label: "等待评审",
        detail: "内核 reviewPolicy=required；批准后交付，拒绝会标记 REVIEW_REJECTED。",
      };
    case "ready":
      return hasWorker
        ? { kind: "start", label: "可以运行", detail: "点击「运行任务」入队；默认手动入队。" }
        : { kind: "none", label: "缺少成员", detail: "请先到「团队」创建至少一个成员。" };
    case "done":
      return { kind: "none", label: "已交付", detail: "如需重跑，请新建任务或先复制任务描述。" };
    case "cancelled":
      return { kind: "none", label: "已取消", detail: "取消是终态，不能重新运行；可新建任务。" };
    default:
      return { kind: "none", label: "—", detail: "" };
  }
}

// ---------------------------------------------------------------- scheduler

export function schedulerTaskCounts(
  scheduler: SchedulerSnapshot | null,
  tasks: Task[],
): Record<TaskStatus, number> {
  if (scheduler) return scheduler.counts;
  const counts = statusCounts(tasks);
  return {
    ready: counts.ready,
    queued: counts.queued,
    running: counts.running,
    blocked: counts.blocked,
    review: counts.review,
    done: counts.done,
    failed: counts.failed,
    cancelled: counts.cancelled,
  };
}

export function schedulerActiveCount(scheduler: SchedulerSnapshot | null): number {
  return scheduler?.activeRuns.length ?? 0;
}

export function schedulerQueueCount(scheduler: SchedulerSnapshot | null): number {
  return scheduler?.queue.length ?? 0;
}

export function schedulerSummaryText(
  scheduler: SchedulerSnapshot | null,
  tasks: Task[],
): string {
  const counts = schedulerTaskCounts(scheduler, tasks);
  const running = scheduler ? schedulerActiveCount(scheduler) : counts.running;
  return `运行中 ${running} · 排队 ${counts.queued}`;
}

export function schedulerLimitsText(scheduler: SchedulerSnapshot | null): string {
  if (!scheduler) return "并发上限未知";
  const { maxGlobal, maxWorkspace, maxPerAgent } = scheduler.limits;
  return `全局 ${maxGlobal} · 每工作区 ${maxWorkspace} · 每成员 ${maxPerAgent}`;
}

export function schedulerPauseText(scheduler: SchedulerSnapshot | null): string {
  if (!scheduler?.paused) return "";
  return scheduler.pausedReason
    ? `调度已暂停（${scheduler.pausedReason}）`
    : "调度已暂停";
}

// --------------------------------------------------------------------- runs

export function runTitle(run: Run | null | undefined): string {
  if (!run) return "Run";
  return `Run #${run.attempt ?? 1}`;
}

export function runStatusHint(run: Run): string {
  switch (run.status) {
    case "queued":
      return "已创建但尚未开始执行";
    case "running":
      return "执行器正在运行；心跳与 tokens 会实时更新";
    case "waiting_human":
      return "等待人工审批/输入；等待期间租约由独立 keeper 续租";
    case "completed":
      return "正常结束；success 后任务可能进入 done 或 review";
    case "failed":
      return `失败：${failureKindText(run.errorCode)}${run.retryable ? "（可重试）" : "（不可重试）"}`;
    case "cancelled":
      return "已被人工取消";
    default:
      return "";
  }
}

export function canCancelRun(run: Run | null | undefined): boolean {
  return Boolean(run && isActiveRunStatus(run.status));
}

export function runTimelineEvents(events: EventRecord[], runId: string): EventRecord[] {
  return events.filter((event) => event.aggregateId === runId);
}

export function taskTimelineEvents(events: EventRecord[], taskId: string): EventRecord[] {
  return events.filter(
    (event) => event.aggregateType === "task" && event.aggregateId === taskId,
  );
}

export function eventTime(event: EventRecord): string {
  return event.occurredAt ?? event.createdAt;
}

const EVENT_LABELS: Record<string, string> = {
  "task.created": "任务创建",
  "task.updated": "任务更新",
  "task.status_changed": "任务状态",
  "task.blocked": "任务阻塞",
  "task.unblocked": "任务解阻",
  "task.review_requested": "请求评审",
  "task.review_approved": "评审通过",
  "task.review_rejected": "评审拒绝",
  "task.retry_scheduled": "安排重试",
  "task.retry_exhausted": "重试耗尽",
  "task.cancelled": "任务取消",
  "run.started": "Run 启动",
  "run.heartbeat": "心跳",
  "run.checkpoint": "Checkpoint",
  "run.waiting_human": "等待人工",
  "run.resumed": "恢复运行",
  "run.completed": "Run 完成",
  "run.failed": "Run 失败",
  "run.cancelled": "Run 取消",
  "run.result_discarded": "旧租约结果丢弃",
  "scheduler.paused": "调度暂停",
  "scheduler.resumed": "调度恢复",
  "scheduler.admitted": "调度准入",
  "scheduler.rejected": "调度拒绝",
  "scheduler.tick": "调度 tick",
  "kernel.legacy_snapshot": "旧数据基线",
  "kernel.migrated": "库迁移",
  "kernel.recovered": "内核恢复",
  "kernel.rebuild": "投影重建",
  "kernel.command_rejected": "命令拒绝",
  "run.step": "执行步骤",
  "assistant.message": "模型输出",
  "tool.call": "工具调用",
  "tool.result": "工具结果",
  usage: "Token 用量",
};

export function eventTypeLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

export function eventTone(type: string): "ok" | "warn" | "error" | "info" {
  if (type.includes("failed") || type === "task.retry_exhausted" || type === "kernel.command_rejected") {
    return "error";
  }
  if (
    type.includes("blocked") ||
    type.includes("waiting_human") ||
    type === "scheduler.paused" ||
    type === "scheduler.rejected" ||
    type === "run.result_discarded"
  ) {
    return "warn";
  }
  if (type.includes("completed") || type.includes("approved") || type === "scheduler.resumed") {
    return "ok";
  }
  return "info";
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return null;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function short(value: unknown, max = 120): string {
  const raw = text(value);
  if (!raw) return "";
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/** 事件一行摘要：只抽取 UI 关心的字段，避免把 64KB payload 全塞进时间线。 */
export function eventSummary(event: EventRecord): string {
  const payload = asRecord(event.payload);
  if (!payload) return "";
  const from = text(payload.from);
  const to = text(payload.to);
  const reason = short(payload.reason, 80);
  switch (event.type) {
    case "task.status_changed":
      return [
        `${TASK_STATUS_LABEL[from as TaskStatus] ?? from} → ${
          TASK_STATUS_LABEL[to as TaskStatus] ?? to
        }`,
        reason,
      ]
        .filter(Boolean)
        .join(" · ");
    case "task.blocked":
      return `原因：${short(payload.reason, 80)}`;
    case "task.unblocked":
      return reason ? `原因：${reason}` : "依赖已满足";
    case "task.retry_scheduled":
      return `第 ${text(payload.attempt)} 次 · 下次 ${formatClockTime(
        text(payload.nextRunAt),
      )}`;
    case "task.retry_exhausted":
      return `共 ${text(payload.attempts)} 次 · ${failureKindText(
        text(payload.lastErrorCode),
      )}`;
    case "task.review_requested":
      return `policy=${text(payload.policy)}`;
    case "task.review_approved":
    case "task.review_rejected": {
      const reviewer = short(payload.reviewer, 40);
      const notes = short(payload.notes, 100);
      return [reviewer ? `评审人 ${reviewer}` : "", notes].filter(Boolean).join(" · ");
    }
    case "run.started": {
      const run = asRecord(payload.run);
      return run
        ? `attempt ${text(run.attempt)} · ${short(run.agentId, 40)}`
        : "";
    }
    case "run.heartbeat": {
      const patch = asRecord(payload.patch);
      if (!patch) return "";
      const parts: string[] = [];
      if (patch.steps !== undefined) parts.push(`step ${text(patch.steps)}`);
      if (patch.tokenIn !== undefined || patch.tokenOut !== undefined) {
        parts.push(`token ${text(patch.tokenIn ?? 0)}/${text(patch.tokenOut ?? 0)}`);
      }
      if (patch.heartbeatAt) parts.push(`心跳 ${formatClockTime(text(patch.heartbeatAt))}`);
      return parts.join(" · ");
    }
    case "run.checkpoint":
      return `step ${text(payload.checkpointStep)} · ${short(payload.checkpointRef, 80)}`;
    case "run.waiting_human":
      return `等待：${reason || "人工处理"}`;
    case "run.resumed":
      return reason || "已恢复";
    case "run.completed": {
      const patch = asRecord(payload.patch);
      return patch
        ? `token ${text(patch.tokenIn ?? 0)}/${text(patch.tokenOut ?? 0)} · step ${text(
            patch.steps ?? 0,
          )}`
        : "";
    }
    case "run.failed": {
      const patch = asRecord(payload.patch);
      if (!patch) return "";
      const retryable = patch.retryable === true ? "可重试" : "不可重试";
      return `${failureKindText(text(patch.errorCode))} · ${retryable}`;
    }
    case "run.cancelled":
      return reason || "已取消";
    case "run.result_discarded":
      return `${text(payload.action)} · owner=${short(payload.owner, 40) || "—"}`;
    case "scheduler.paused":
    case "scheduler.rejected":
      return reason;
    case "scheduler.admitted":
      return `task ${short(payload.taskId, 40)} · attempt ${text(payload.attempt)}`;
    case "scheduler.tick": {
      const counts = asRecord(payload.counts);
      if (!counts) return "";
      return Object.entries(counts)
        .slice(0, 4)
        .map(([key, value]) => `${key}=${text(value)}`)
        .join(" · ");
    }
    case "kernel.recovered":
      return `${text(payload.action)}${payload.attempt ? ` · attempt ${text(payload.attempt)}` : ""}`;
    case "tool.call":
      return `${short(payload.name, 40)} ${short(payload.arguments, 120)}`;
    case "tool.result":
      return `${short(payload.name, 40)} → ${payload.ok === false ? "error" : "ok"}`;
    case "assistant.message":
      return short(payload.text, 120);
    case "run.step":
      return `step ${text(payload.step)}`;
    case "usage":
      return `in ${text(payload.inputTokens)} · out ${text(payload.outputTokens)}`;
    default:
      return short(event.payload, 120);
  }
}

export function eventActor(event: EventRecord): string {
  return event.actor || "—";
}

// ------------------------------------------------------------- announcements

export type TaskStatusSnapshot = Map<string, TaskStatus>;

export function taskStatusSnapshot(tasks: Task[]): TaskStatusSnapshot {
  return new Map(tasks.map((task) => [task.id, task.status]));
}

/** 两次快照之间任务状态变化的播报文本（最多 3 条，避免刷屏）。 */
export function taskStatusAnnouncements(
  previous: TaskStatusSnapshot | null,
  tasks: Task[],
): string[] {
  if (!previous) return [];
  const messages: string[] = [];
  for (const task of tasks) {
    const before = previous.get(task.id);
    if (before && before !== task.status) {
      messages.push(`「${task.title}」${TASK_STATUS_LABEL[task.status]}`);
      if (messages.length >= 3) break;
    }
  }
  return messages;
}

export function runStatusAnnouncements(
  previous: Map<string, RunStatus> | null,
  runs: Run[],
): string[] {
  if (!previous) return [];
  const messages: string[] = [];
  for (const run of runs) {
    const before = previous.get(run.id);
    if (before && before !== run.status) {
      messages.push(`${runTitle(run)} ${runStatusLabel(run.status)}`);
      if (messages.length >= 3) break;
    }
  }
  return messages;
}

export interface SchedulerAnnouncementState {
  paused: boolean;
  running: number;
  queued: number;
}

export function schedulerAnnouncementState(
  scheduler: SchedulerSnapshot | null,
  tasks: Task[],
): SchedulerAnnouncementState {
  const counts = schedulerTaskCounts(scheduler, tasks);
  return {
    paused: Boolean(scheduler?.paused),
    running: scheduler ? scheduler.activeRuns.length : counts.running,
    queued: counts.queued,
  };
}

export function schedulerAnnouncement(
  previous: SchedulerAnnouncementState | null,
  next: SchedulerAnnouncementState,
): string | null {
  if (!previous) return null;
  if (previous.paused !== next.paused) {
    return next.paused ? "调度已暂停" : "调度已恢复";
  }
  if (previous.running !== next.running) {
    return `运行中 ${next.running} 个`;
  }
  if (previous.queued !== next.queued) {
    return `排队 ${next.queued} 个`;
  }
  return null;
}
