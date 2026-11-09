import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SchedulerBar from "./SchedulerBar";
import RunHistory from "./RunHistory";
import type { Agent, EventRecord, Run, SchedulerSnapshot, Task } from "./shared/types";

const agent: Agent = {
  id: "a1",
  workspaceId: "ws",
  name: "Alice",
  role: "engineer",
  systemPrompt: "",
  persona: "",
  agentsMd: "",
  model: null,
  permission: "workspace_write",
  isRouter: false,
  status: "idle",
  createdAt: "2026-11-10T00:00:00.000Z",
};

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    workspaceId: "ws",
    title: "实现登录接口",
    description: "背景",
    acceptance: ["返回 200"],
    status: "failed",
    ownerId: "a1",
    dependsOn: [],
    branch: null,
    worktree: null,
    summary: null,
    createdAt: "2026-11-10T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    attemptCount: 2,
    failureKind: "retry_exhausted",
    ...patch,
  };
}

function run(patch: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    taskId: "t1",
    agentId: "a1",
    status: "failed",
    error: "boom",
    startedAt: "2026-11-10T00:00:00.000Z",
    endedAt: "2026-11-10T00:00:12.000Z",
    tokenIn: 1200,
    tokenOut: 340,
    attempt: 1,
    heartbeatAt: "2026-11-10T00:00:10.000Z",
    leaseOwner: "test:1",
    leaseExpiresAt: "2026-11-10T00:01:00.000Z",
    checkpointStep: 3,
    checkpointRef: "checkpoints/run-1.json",
    errorCode: "LEASE_EXPIRED",
    retryable: true,
    steps: 3,
    ...patch,
  };
}

const event: EventRecord = {
  seq: 1,
  id: "e1",
  aggregateType: "run",
  aggregateId: "run-1",
  type: "run.failed",
  actor: "kernel",
  payload: { patch: { errorCode: "LEASE_EXPIRED", retryable: true } },
  createdAt: "2026-11-10T00:00:12.000Z",
};

const scheduler: SchedulerSnapshot = {
  workspaceId: "ws",
  paused: true,
  pausedReason: "user_paused",
  limits: { maxGlobal: 4, maxWorkspace: 1, maxPerAgent: 1 },
  counts: {
    ready: 1,
    queued: 2,
    running: 1,
    blocked: 0,
    review: 0,
    done: 0,
    failed: 1,
    cancelled: 0,
  },
  activeRuns: [],
  queue: [
    {
      taskId: "t1",
      title: "实现登录接口",
      priority: 50,
      queuedAt: "2026-11-10T00:00:00.000Z",
      ownerId: "a1",
    },
  ],
  updatedAt: "2026-11-10T00:00:10.000Z",
};

const noop = () => undefined;

describe("t69 调度/Run UI 静态渲染", () => {
  it("调度栏展示运行/排队、暂停原因与恢复按钮", () => {
    const html = renderToStaticMarkup(
      <SchedulerBar
        scheduler={scheduler}
        tasks={[task()]}
        agents={[agent]}
        loading={false}
        error={null}
        busy={null}
        onRetryLoad={noop}
        onPause={noop}
        onResume={noop}
        onOpenRuns={noop}
      />,
    );
    expect(html).toContain("运行中 0");
    expect(html).toContain("排队 2");
    expect(html).toContain("已暂停：user_paused");
    expect(html).toContain("恢复调度");
    expect(html).toContain("全局 4 · 每工作区 1 · 每成员 1");
  });

  it("调度栏错误态使用 role=alert 并提供重试", () => {
    const html = renderToStaticMarkup(
      <SchedulerBar
        scheduler={null}
        tasks={[]}
        agents={[]}
        loading={false}
        error="读取失败"
        busy={null}
        onRetryLoad={noop}
        onPause={noop}
        onResume={noop}
        onOpenRuns={noop}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("重试");
  });

  it("Run 历史展示 attempt/状态/心跳/租约/token/错误与事件", () => {
    const html = renderToStaticMarkup(
      <RunHistory
        task={task()}
        runs={[run()]}
        agents={[agent]}
        events={[event]}
        loading={false}
        error={null}
        selectedRunId="run-1"
        busy={null}
        onRetryLoad={noop}
        onSelectRun={noop}
        onCancelRun={noop}
        onOpenRunPanel={noop}
        onRetryTask={noop}
      />,
    );
    expect(html).toContain("Run 历史");
    expect(html).toContain("#1");
    expect(html).toContain("失败");
    expect(html).toContain("租约过期");
    expect(html).toContain("1.2k / 340");
    expect(html).toContain("Run 事件");
    expect(html).toContain("重试任务");
  });

  it("Run 历史空态与加载态可读", () => {
    const empty = renderToStaticMarkup(
      <RunHistory
        task={task({ status: "ready", attemptCount: 0 })}
        runs={[]}
        agents={[]}
        events={[]}
        loading={false}
        error={null}
        selectedRunId={null}
        busy={null}
        onRetryLoad={noop}
        onSelectRun={noop}
        onCancelRun={noop}
        onOpenRunPanel={noop}
        onRetryTask={noop}
      />,
    );
    expect(empty).toContain("还没有执行记录");
    const loading = renderToStaticMarkup(
      <RunHistory
        task={task()}
        runs={[]}
        agents={[]}
        events={[]}
        loading
        error={null}
        selectedRunId={null}
        busy={null}
        onRetryLoad={noop}
        onSelectRun={noop}
        onCancelRun={noop}
        onOpenRunPanel={noop}
        onRetryTask={noop}
      />,
    );
    expect(loading).toContain("正在加载 Run 记录");
  });
});
