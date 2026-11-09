import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SchedulerBar from "./SchedulerBar";
import RunHistory from "./RunHistory";
import RunPanel from "./RunPanel";
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

// ---------------------------------------------------------------------------
// t107 repair-round-2：SSR 交互断言（F1/F3/F6/F7 证据）
// ---------------------------------------------------------------------------

describe("t107 SSR 交互断言", () => {
  const snapshotBase = {
    workspace: {
      id: "ws",
      name: "WS",
      path: "S:/ws",
      overview: null,
      overviewEnabled: true,
      createdAt: "2026-11-10T00:00:00.000Z",
    },
    agents: [agent],
    tasks: [task()],
    messages: [],
    boardEntries: [],
    settings: {
      baseUrl: "",
      baseUrlEnv: "",
      apiKey: "",
      apiKeyEnv: "",
      providers: [],
      model: "",
      models: [],
      mock: true,
      providersInfo: [],
      apiKeySource: "none",
      apiKeyEnvActive: null,
      apiKeyEnvSet: false,
      baseUrlSource: "local",
      baseUrlEnvActive: null,
      baseUrlEnvSet: false,
      effectiveBaseUrl: "",
    },
  } as unknown as Parameters<typeof RunPanel>[0]["snapshot"];

  it("F7：队列容器始终渲染，关闭时带 hidden；aria-controls 指向唯一 id（useId）", () => {
    // SchedulerBar 默认 queueOpen=false → 容器渲染且 hidden。
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
    // t113：id 改为 useId 生成（前缀 «r…»），按钮 aria-controls 与容器 id 一致。
    const controlMatch = html.match(/aria-controls="([^"]+)"/);
    expect(controlMatch).not.toBeNull();
    const queueId = controlMatch![1];
    expect(html).toContain(`id="${queueId}"`);
    expect(html).toMatch(new RegExp(`<div[^>]*id="${queueId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*hidden`));
  });

  // t113 F4：同一树中双面板同时渲染，队列 id 互不相同（useId 唯一化）。
  it("F4：同一渲染树中两个 SchedulerBar 的队列 id 互不相同", () => {
    const html = renderToStaticMarkup(
      <>
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
        />
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
        />
      </>,
    );
    const ids = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    // 每个按钮的 aria-controls 都指向真实存在的容器 id。
    for (const id of ids) expect(html).toContain(`id="${id}"`);
  });

  // t113 F5：error 态队列按钮与容器都不渲染 → 无悬空 aria-controls。
  it("F5：error 时队列按钮与容器都不渲染，无 aria-controls", () => {
    const html = renderToStaticMarkup(
      <SchedulerBar
        scheduler={null}
        tasks={[task()]}
        agents={[agent]}
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
    expect(html).not.toContain("aria-controls");
    expect(html).not.toContain("scheduler-queue");
  });

  it("F3：RunPanel 操作常驻渲染，不可用时 disabled 并带原因（aria-describedby）", () => {
    const html = renderToStaticMarkup(
      <RunPanel
        snapshot={snapshotBase}
        scheduler={scheduler}
        schedulerLoading={false}
        schedulerError={null}
        runs={[run()]}
        runsLoading={false}
        runsError="读取 Run 失败"
        trace={[event]}
        selectedTaskId="t1"
        selectedRunId="run-1"
        busy={null}
        onSelectTask={noop}
        onSelectRun={noop}
        onOpenRun={noop}
        onOpenTaskPage={noop}
        onOpenTaskChat={noop}
        onStartTask={noop}
        onRetryTask={noop}
        onCancelTask={noop}
        onCancelRun={noop}
        onReviewTask={noop}
        onPause={noop}
        onResume={noop}
        onReloadScheduler={noop}
        onReloadRuns={noop}
        onOpenTasks={noop}
      />,
    );
    // 任务 failed：运行/批准 disabled，重试可用——按钮全部常驻。
    expect(html).toContain("运行任务");
    expect(html).toContain("重试任务");
    expect(html).toContain("批准");
    expect(html).toContain("取消任务");
    expect(html).toContain('id="run-panel-action-hint"');
    expect(html).toContain('aria-describedby="run-panel-action-hint"');
    // Run 错误态 role=alert + 重试按钮。
    expect(html).toContain("读取 Run 失败");
    expect(html).toContain('role="alert"');
    // 窄容器 class 存在（CSS container query 折行）。
    expect(html).toContain("run-panel-body");
  });

  it("F3：RunDetail 取消 Run 常驻渲染，非运行中 disabled + 可见原因", () => {
    const html = renderToStaticMarkup(
      <RunHistory
        task={task()}
        runs={[run({ status: "completed" })]}
        agents={[agent]}
        events={[]}
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
    expect(html).toContain("取消 Run");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*取消 Run/);
    expect(html).toContain("仅运行中（running）的 Run 可以取消");
  });

  // t113 F4：同一树中两个 RunDetail（双面板同屏）的 hint id 不冲突。
  it("F4：同一渲染树中两个 RunDetail 的取消 hint id 互不相同", () => {
    const html = renderToStaticMarkup(
      <>
        <RunHistory
          task={task()}
          runs={[run({ status: "completed" })]}
          agents={[agent]}
          events={[]}
          loading={false}
          error={null}
          selectedRunId="run-1"
          busy={null}
          onRetryLoad={noop}
          onSelectRun={noop}
          onCancelRun={noop}
          onOpenRunPanel={noop}
          onRetryTask={noop}
        />
        <RunHistory
          task={task({ id: "t2" })}
          runs={[run({ id: "run-2", status: "completed" })]}
          agents={[agent]}
          events={[]}
          loading={false}
          error={null}
          selectedRunId="run-2"
          busy={null}
          onRetryLoad={noop}
          onSelectRun={noop}
          onCancelRun={noop}
          onOpenRunPanel={noop}
          onRetryTask={noop}
        />
      </>,
    );
    const ids = [...html.matchAll(/aria-describedby="([^"]*run-cancel-hint[^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(html).toContain(`id="${id}"`);
  });

  it("深链集成：#/tasks?t=&r= 解析出任务与 Run 选择", async () => {
    const { parseHash } = await import("./shared/deeplink");
    const route = parseHash("#/tasks?t=t1&r=run-1");
    expect(route.tab).toBe("tasks");
    expect(route.task).toBe("t1");
    expect(route.run).toBe("run-1");
  });
});

// ---------------------------------------------------------------------------
// t113 repair-round-3：CSS 隐藏规则 / Announcer contextKey / 深链纯函数
// ---------------------------------------------------------------------------

describe("t113 CSS 与 Announcer", () => {
  it("F1：styles.css 含 .scheduler-queue[hidden]{display:none}（display:grid 覆盖 UA hidden 的兜底）", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const css = await readFile(resolve(__dirname, "styles.css"), "utf8");
    expect(css).toMatch(/\.scheduler-queue\[hidden\]\s*\{\s*display:\s*none/);
    // 源规则确实使用 display:grid（证明兜底必要）。
    expect(css).toMatch(/\.scheduler-queue\s*\{[^}]*display:\s*grid/);
  });

  it("F2：KernelAnnouncer 接受 contextKey prop（SSR 渲染不报错）", async () => {
    const { default: KernelAnnouncer } = await import("./KernelAnnouncer");
    const html = renderToStaticMarkup(
      <KernelAnnouncer
        tasks={[task()]}
        scheduler={null}
        runs={[]}
        contextKey="ws:tasks:t1"
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});
