import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
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

// ---------------------------------------------------------------------------
// t117：contextKey 重置改为「以当前数据建基线」，切回 tab 后首个变化不被吞
// ---------------------------------------------------------------------------

describe("t117 Announcer 基线重置（纯函数）", () => {
  it("contextKey 切换后基线为当前数据（非 null）：首个任务变化能播报", async () => {
    const { announcerBaseline } = await import("./KernelAnnouncer");
    const { taskStatusAnnouncements } = await import("./shared/kernelUi");
    // tasks 页 → chat → 回 tasks：基线 = 当前任务快照。
    const before = [task({ id: "a", status: "ready" })];
    const baseline = announcerBaseline(before, [], null);
    expect(baseline.tasks).not.toBeNull();
    expect(baseline.tasks.get("a")).toBe("ready");
    // 切回后第一次真实变化（a → queued）：基线非 null ⇒ 正常 diff 播报（t113 版本基线为 null 会吞掉）。
    const after = [task({ id: "a", status: "queued" })];
    const messages = taskStatusAnnouncements(baseline.tasks, after);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("排队中");
    // 对照：previous=null（t113 行为）不播报——证明差异正是本修复点。
    expect(taskStatusAnnouncements(null, after)).toEqual([]);
  });

  it("Run 基线同理：切 tab 后新 Run/状态变化播报；首次挂载（previous=null）不播报", async () => {
    const { announcerBaseline } = await import("./KernelAnnouncer");
    const { runStatusAnnouncements } = await import("./shared/kernelUi");
    const baseline = announcerBaseline([], [run({ id: "r1", status: "running" })], null);
    expect(baseline.runs.get("r1")).toBe("running");
    // 首个变化：r1 running→completed。
    const messages = runStatusAnnouncements(baseline.runs, [
      run({ id: "r1", status: "completed" }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("已完成");
    expect(runStatusAnnouncements(null, [run({ id: "r1", status: "completed" })])).toEqual([]);
  });

  it("切 workspace：基线以新 workspace 数据静默建立，同数据不产生播报", async () => {
    const { announcerBaseline } = await import("./KernelAnnouncer");
    const { taskStatusAnnouncements, schedulerAnnouncement } = await import(
      "./shared/kernelUi"
    );
    // 新 workspace 的当前数据作为基线 → 对同一份数据 diff 为空（不误播报）。
    const wsTasks = [task({ id: "x", status: "ready" })];
    const baseline = announcerBaseline(wsTasks, [], null);
    expect(taskStatusAnnouncements(baseline.tasks, wsTasks)).toEqual([]);
    expect(schedulerAnnouncement(baseline.scheduler, baseline.scheduler)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// t121/t126：KernelAnnouncer 组件 rerender 行为（react-test-renderer）
// 依赖说明：react-test-renderer@19.3.1 为 devDependency（仅测试），版本与 react 精确锁定对齐；
// 不进入生产 bundle（vite build 无引用），符合最小功能原则。
// t126：react-test-renderer 在 React 19 已标记 deprecated（官方推荐 react-dom/testing-library，
// 但后者需要 DOM 测试环境，本项目 vitest 为 node 环境）——故保留 rtr 并：
//   1) 在 describe 前 IS_REACT_ACT_ENVIRONMENT = true（afterAll 恢复），消除 act 警告；
//   2) 版本精确锁定 19.3.1（package.json devDependency 无 ^），风险已在 execution-kernel-ui.md §14/§15 记录。
// ---------------------------------------------------------------------------

describe("t121 KernelAnnouncer rerender 行为", () => {
  // t126：act 环境标志——rtr 在非 DOM 环境需要显式声明，否则 React 19 输出 act 警告。
  const previousActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  afterAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnv;
  });

  // react-test-renderer 未带类型声明（19.x 移除）；仅测试使用，按 any 引入。
  type RtrModule = {
    default: {
      create: (node: React.ReactElement) => {
        root: { findByType: (type: string) => { props: { children: unknown } } };
        update: (node: React.ReactElement) => void;
        unmount: () => void;
      };
    };
    act: (fn: () => Promise<void> | void) => Promise<void>;
  };
  const loadRtr = async (): Promise<RtrModule> => {
    // @ts-expect-error react-test-renderer 19.x 不带类型声明（仅测试依赖，按结构化类型引入）
    const mod = (await import("react-test-renderer")) as RtrModule;
    return mod;
  };

  it("mount → 切 contextKey（同数据）→ 数据变化 → 切 workspace 的完整状态机", async () => {
    const { default: TestRenderer, act } = await loadRtr();
    const { default: KernelAnnouncer } = await import("./KernelAnnouncer");

    const tasksA = () => [task({ id: "a", status: "ready" })];
    let renderer: ReturnType<typeof TestRenderer.create> | null = null;
    const text = () =>
      String((renderer as NonNullable<typeof renderer>).root.findByType("div").props.children ?? "");

    // 1) 首次 mount（在 act 内）：不播报。
    await act(async () => {
      renderer = TestRenderer.create(
        <KernelAnnouncer tasks={tasksA()} scheduler={null} runs={[]} contextKey="ws1:tasks:a" />,
      );
    });
    expect(text()).toBe("");

    // 2) 同 contextKey 数据刷新（同数据）：仍不播报。
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer tasks={tasksA()} scheduler={null} runs={[]} contextKey="ws1:tasks:a" />,
      );
    });
    expect(text()).toBe("");

    // 3) 数据变化（a ready→queued）：播报。
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task({ id: "a", status: "queued" })]}
          scheduler={null}
          runs={[]}
          contextKey="ws1:tasks:a"
        />,
      );
    });
    expect(text()).toContain("排队中");

    // 4) 切 contextKey（tasks → chat，同数据）：message 清空、无新增播报。
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task({ id: "a", status: "queued" })]}
          scheduler={null}
          runs={[]}
          contextKey="ws1:chat:a"
        />,
      );
    });
    expect(text()).toBe("");

    // 5) 切回 tasks（同数据，基线以当前数据静默重建）→ 再数据变化（a queued→running）：播报。
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task({ id: "a", status: "queued" })]}
          scheduler={null}
          runs={[]}
          contextKey="ws1:tasks:a"
        />,
      );
    });
    expect(text()).toBe("");
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task({ id: "a", status: "running" })]}
          scheduler={null}
          runs={[]}
          contextKey="ws1:tasks:a"
        />,
      );
    });
    expect(text()).toContain("进行中");

    // 6) 切 workspace（contextKey 换 ws2 + 全新数据）：静默建基线，零误播报。
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task({ id: "z", status: "ready" })]}
          scheduler={null}
          runs={[]}
          contextKey="ws2:tasks:z"
        />,
      );
    });
    expect(text()).toBe("");

    // 7) 新 workspace 内第一次变化（z ready→done，同 contextKey）照常播报。
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task({ id: "z", status: "done" })]}
          scheduler={null}
          runs={[]}
          contextKey="ws2:tasks:z"
        />,
      );
    });
    expect(text()).toContain("已交付");

    renderer!.unmount();
  });

  it("Run 状态变化在切 tab 后首次变化也能播报", async () => {
    const { default: TestRenderer, act } = await loadRtr();
    const { default: KernelAnnouncer } = await import("./KernelAnnouncer");

    let renderer: ReturnType<typeof TestRenderer.create> | null = null;
    const text = () =>
      String((renderer as NonNullable<typeof renderer>).root.findByType("div").props.children ?? "");

    await act(async () => {
      renderer = TestRenderer.create(
        <KernelAnnouncer
          tasks={[]}
          scheduler={null}
          runs={[run({ id: "r1", status: "running" })]}
          contextKey="ws1:tasks:t1"
        />,
      );
    });
    expect(text()).toBe("");

    // 切 chat 再切回（同数据，基线重建）→ r1 running→completed 播报。
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[]}
          scheduler={null}
          runs={[run({ id: "r1", status: "running" })]}
          contextKey="ws1:chat:t1"
        />,
      );
    });
    expect(text()).toBe("");
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[]}
          scheduler={null}
          runs={[run({ id: "r1", status: "running" })]}
          contextKey="ws1:tasks:t1"
        />,
      );
    });
    expect(text()).toBe("");
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[]}
          scheduler={null}
          runs={[run({ id: "r1", status: "completed" })]}
          contextKey="ws1:tasks:t1"
        />,
      );
    });
    expect(text()).toContain("已完成");
    renderer!.unmount();
  });

  // t126 F2：scheduler 变化（paused/running）在切 contextKey 后首次变化也能播报；
  // contextKey 切换与调度数据变化分帧（与 App 渲染一致——切 tab 独立帧，快照随后到达）。
  it("scheduler：mount paused 基线 → 切 chat（清空）→ 切回 → paused→恢复 播报", async () => {
    const { default: TestRenderer, act } = await loadRtr();
    const { default: KernelAnnouncer } = await import("./KernelAnnouncer");

    const pausedScheduler: SchedulerSnapshot = {
      ...scheduler,
      paused: true,
      pausedReason: "user_paused",
      activeRuns: [],
    };
    const resumedScheduler: SchedulerSnapshot = {
      ...scheduler,
      paused: false,
      pausedReason: null,
    };

    let renderer: ReturnType<typeof TestRenderer.create> | null = null;
    const text = () =>
      String((renderer as NonNullable<typeof renderer>).root.findByType("div").props.children ?? "");

    // 1) mount：scheduler paused 基线，无播报。
    await act(async () => {
      renderer = TestRenderer.create(
        <KernelAnnouncer
          tasks={[task({ id: "a", status: "ready" })]}
          scheduler={pausedScheduler}
          runs={[]}
          contextKey="ws1:tasks:a"
        />,
      );
    });
    expect(text()).toBe("");

    // 2) 切 chat（同 scheduler 数据）：message 清空。
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task({ id: "a", status: "ready" })]}
          scheduler={pausedScheduler}
          runs={[]}
          contextKey="ws1:chat:a"
        />,
      );
    });
    expect(text()).toBe("");

    // 3) 切回 tasks（同数据，基线以当前 scheduler 静默重建）：仍清空。
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task({ id: "a", status: "ready" })]}
          scheduler={pausedScheduler}
          runs={[]}
          contextKey="ws1:tasks:a"
        />,
      );
    });
    expect(text()).toBe("");

    // 4) 调度恢复（paused true→false，同 contextKey 独立帧）：播报「调度已恢复」。
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task({ id: "a", status: "ready" })]}
          scheduler={resumedScheduler}
          runs={[]}
          contextKey="ws1:tasks:a"
        />,
      );
    });
    expect(text()).toContain("调度已恢复");

    renderer!.unmount();
  });

  it("scheduler：running 计数变化在切 tab 后首次变化播报", async () => {
    const { default: TestRenderer, act } = await loadRtr();
    const { default: KernelAnnouncer } = await import("./KernelAnnouncer");

    const running0: SchedulerSnapshot = { ...scheduler, paused: false, activeRuns: [] };
    const running1: SchedulerSnapshot = {
      ...scheduler,
      paused: false,
      activeRuns: [
        {
          id: "run-1",
          taskId: "t1",
          agentId: "a1",
          status: "running",
          startedAt: "2026-11-10T00:00:00.000Z",
          endedAt: null,
          attempt: 1,
          heartbeatAt: null,
          errorCode: null,
        },
      ],
    };

    let renderer: ReturnType<typeof TestRenderer.create> | null = null;
    const text = () =>
      String((renderer as NonNullable<typeof renderer>).root.findByType("div").props.children ?? "");

    await act(async () => {
      renderer = TestRenderer.create(
        <KernelAnnouncer
          tasks={[task()]}
          scheduler={running0}
          runs={[]}
          contextKey="ws1:tasks:t1"
        />,
      );
    });
    expect(text()).toBe("");

    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task()]}
          scheduler={running0}
          runs={[]}
          contextKey="ws1:chat:t1"
        />,
      );
    });
    expect(text()).toBe("");
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task()]}
          scheduler={running0}
          runs={[]}
          contextKey="ws1:tasks:t1"
        />,
      );
    });
    expect(text()).toBe("");

    // running 0→1（activeRuns 增加也被 Announcer 合并进 Run diff）：播报。
    await act(async () => {
      renderer!.update(
        <KernelAnnouncer
          tasks={[task()]}
          scheduler={running1}
          runs={[]}
          contextKey="ws1:tasks:t1"
        />,
      );
    });
    expect(text().length).toBeGreaterThan(0);
    expect(text()).toMatch(/新增|运行中/);

    renderer!.unmount();
  });
});
