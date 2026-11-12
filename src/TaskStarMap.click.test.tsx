// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (node: unknown) => node };
});

import type { Agent, Snapshot, Task } from "./shared/types.js";
import TaskStarMap from "./TaskStarMap.js";
import TeamDashboard from "./TeamDashboard.js";

// node 测试环境缺 DOM API：星图布局/浮窗只在纯计算层用到它们，安全 stub。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { HTMLElement?: unknown }).HTMLElement = class {};
(globalThis as { document?: unknown }).document = {
  activeElement: null,
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { style: {} },
  documentElement: { style: {} },
  querySelector: () => null,
  querySelectorAll: () => [],
};
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: () => void) => {
  cb();
  return 0;
};

const { act, create } = TestRenderer as unknown as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAll: (predicate: (node: { props: Record<string, unknown> }) => boolean) => Array<{
        props: Record<string, unknown>;
      }>;
      findAllByType: (type: string) => Array<{ props: Record<string, unknown> }>;
    };
    toJSON: () => unknown;
    unmount: () => void;
  };
};

const owner: Agent = {
  id: "a1",
  workspaceId: "ws",
  name: "Ren",
  role: "Engineer",
  systemPrompt: "",
  persona: "",
  agentsMd: "",
  model: "deepseek-flash",
  permission: "workspace_write",
  isRouter: false,
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const taskA: Task = {
  id: "t1",
  workspaceId: "ws",
  title: "基础接口",
  description: "先实现基础接口",
  acceptance: [],
  status: "ready",
  ownerId: "a1",
  dependsOn: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as Task;

const taskB: Task = {
  id: "t2",
  workspaceId: "ws",
  title: "补充测试",
  description: "",
  acceptance: [],
  status: "running",
  ownerId: "a1",
  dependsOn: ["t1"],
  createdAt: "2026-01-01T00:01:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
} as unknown as Task;

type StarNode = { props: Record<string, unknown> };

function findNode(root: ReturnType<typeof create>["root"], taskId: string): StarNode | undefined {
  return root
    .findAll((node) => Boolean(node.props["data-star-node"]))
    .find((node) => String(node.props["aria-label"] ?? "").startsWith(labelPrefix(taskId)));
}

function labelPrefix(taskId: string): string {
  return taskId === "t1" ? "基础接口" : "补充测试";
}

const noopMap = {
  selectedTaskId: null,
  focus: null,
  workspaceId: "ws",
  memberFilterId: null,
  onFilterMember: () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("t419 G6 星图单击/双击语义", () => {
  it("单击：只选中 + 打开概览浮窗，不调用 onOpen / onOpenTaskPage", async () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const onOpenTaskPage = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TaskStarMap
          {...noopMap}
          tasks={[taskA, taskB]}
          agents={[owner]}
          onSelect={onSelect}
          onOpen={onOpen}
          onOpenTaskPage={onOpenTaskPage}
        />,
      );
      await Promise.resolve();
    });
    const node = findNode(renderer!.root, "t1")!;
    expect(node).toBeTruthy();
    await act(async () => {
      (node.props.onClick as (event: unknown) => void)({ currentTarget: {} });
      await Promise.resolve();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({ id: "t1" });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onOpenTaskPage).not.toHaveBeenCalled();
    // 概览浮窗已打开（非模态，不导航）。
    const popover = renderer!.root
      .findAll((n) => n.props["aria-label"] === "任务概述：基础接口")
      .slice(0, 1);
    expect(popover.length).toBeGreaterThan(0);
    await act(async () => renderer!.unmount());
  });

  it("双击：关闭浮窗并调用 onOpenTaskPage（任务工作区），不进聊天", async () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const onOpenTaskPage = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TaskStarMap
          {...noopMap}
          tasks={[taskA, taskB]}
          agents={[owner]}
          onSelect={onSelect}
          onOpen={onOpen}
          onOpenTaskPage={onOpenTaskPage}
        />,
      );
      await Promise.resolve();
    });
    const node = findNode(renderer!.root, "t2")!;
    // 先单击打开浮窗，再双击——浮窗应关闭且进入任务页。
    await act(async () => {
      (node.props.onClick as (event: unknown) => void)({ currentTarget: {} });
      await Promise.resolve();
    });
    await act(async () => {
      (node.props.onDoubleClick as () => void)();
      await Promise.resolve();
    });
    expect(onOpenTaskPage).toHaveBeenCalledTimes(1);
    expect(onOpenTaskPage.mock.calls[0]![0]).toMatchObject({ id: "t2" });
    expect(onOpen).not.toHaveBeenCalled();
    const popover = renderer!.root.findAll((n) => n.props["aria-label"] === "任务概述：补充测试");
    expect(popover.length).toBe(0);
    await act(async () => renderer!.unmount());
  });

  it("键盘：节点 Ctrl/Cmd+Enter 与双击等价（onOpenTaskPage），普通 Enter 不触发", async () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const onOpenTaskPage = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TaskStarMap
          {...noopMap}
          tasks={[taskA, taskB]}
          agents={[owner]}
          onSelect={onSelect}
          onOpen={onOpen}
          onOpenTaskPage={onOpenTaskPage}
        />,
      );
      await Promise.resolve();
    });
    const node = findNode(renderer!.root, "t1")!;
    await act(async () => {
      (node.props.onKeyDown as (event: unknown) => void)({
        key: "Enter",
        ctrlKey: true,
        preventDefault: () => {},
      });
      await Promise.resolve();
    });
    expect(onOpenTaskPage).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    // 普通 Enter 不触发导航（保持原生按钮行为语义）。
    await act(async () => {
      (node.props.onKeyDown as (event: unknown) => void)({
        key: "Enter",
        preventDefault: () => {},
      });
      await Promise.resolve();
    });
    expect(onOpenTaskPage).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.unmount());
  });

  it("浮窗动作：打开会话 → onOpen；在任务页打开 → onOpenTaskPage", async () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const onOpenTaskPage = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TaskStarMap
          {...noopMap}
          tasks={[taskA, taskB]}
          agents={[owner]}
          onSelect={onSelect}
          onOpen={onOpen}
          onOpenTaskPage={onOpenTaskPage}
        />,
      );
      await Promise.resolve();
    });
    const node = findNode(renderer!.root, "t1")!;
    await act(async () => {
      (node.props.onClick as (event: unknown) => void)({ currentTarget: {} });
      await Promise.resolve();
    });
    const buttons = renderer!.root.findAllByType("button");
    const openChat = buttons.find((button) => button.props.children === "打开会话");
    const openPage = buttons.find((button) => button.props.children === "在任务页打开");
    expect(openChat).toBeTruthy();
    expect(openPage).toBeTruthy();
    await act(async () => {
      (openChat!.props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpenTaskPage).not.toHaveBeenCalled();
    // 重新打开浮窗再点「在任务页打开」。
    await act(async () => {
      (node.props.onClick as (event: unknown) => void)({ currentTarget: {} });
      await Promise.resolve();
    });
    const openPage2 = renderer!.root.findAllByType("button").find((button) => button.props.children === "在任务页打开");
    await act(async () => {
      (openPage2!.props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(onOpenTaskPage).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.unmount());
  });

  it("节点 aria-label / title 提示「单击查看概览，双击打开任务」", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TaskStarMap
          {...noopMap}
          tasks={[taskA, taskB]}
          agents={[owner]}
          onSelect={() => {}}
          onOpen={() => {}}
          onOpenTaskPage={() => {}}
        />,
      );
      await Promise.resolve();
    });
    const node = findNode(renderer!.root, "t1")!;
    expect(String(node.props["aria-label"])).toContain("单击查看概览，双击打开任务");
    expect(String(node.props.title)).toContain("单击查看概览，双击打开任务");
    await act(async () => renderer!.unmount());
  });

  it("已移除底部 star-hint，保留 ? 帮助与 sr-only 状态", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TaskStarMap
          {...noopMap}
          tasks={[taskA, taskB]}
          agents={[owner]}
          onSelect={() => {}}
          onOpen={() => {}}
          onOpenTaskPage={() => {}}
        />,
      );
      await Promise.resolve();
    });
    const hintNodes = renderer!.root.findAll((node) =>
      String(node.props.className ?? "").split(/\s+/).includes("star-hint"),
    );
    expect(hintNodes).toHaveLength(0);
    expect(String(renderer!.toJSON())).not.toContain("拖动空白平移");
    const help = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.title === "星图帮助");
    expect(help).toBeTruthy();
    const srOnly = renderer!.root.findAll((node) =>
      String(node.props.className ?? "").split(/\s+/).includes("sr-only"),
    );
    expect(srOnly.length).toBeGreaterThan(0);
    await act(async () => renderer!.unmount());
  });
});

describe("t419 G6 TeamDashboard 布线（单击不导航）", () => {
  it("星图节点单击只调用 onSelectTask，不触发 onOpenTaskPage / onOpenTask", async () => {
    const onSelectTask = vi.fn();
    const onOpenTask = vi.fn();
    const onOpenTaskPage = vi.fn();
    const snapshot = {
      workspace: { id: "ws", name: "Workspace", path: "S:/workspace" },
      agents: [owner],
      tasks: [taskA, taskB],
      boardEntries: [],
      messages: [],
      runs: [],
      settings: { models: [], providers: [], model: "", mock: true, layout: { maxDockGroups: 3 } },
    } as unknown as Snapshot;
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TeamDashboard
          snapshot={snapshot}
          busy={false}
          selectedTaskId={null}
          onSelectTask={onSelectTask}
          starmapFocus={null}
          autoOpenMemberDialog={false}
          onAutoOpenHandled={() => {}}
          onCreate={async () => false}
          onRecommend={async () => ({ ok: false, code: "RECOMMEND_EMPTY", message: "" })}
          onUpdate={() => {}}
          onOpenSettings={() => {}}
          onDelete={async () => false}
          onOpenTask={onOpenTask}
          onOpenTaskPage={onOpenTaskPage}
          onOpenMergeQueue={() => {}}
          onOpenMemory={() => {}}
          onOpenTaskGit={() => {}}
          scheduler={null}
          onOpenRuns={() => {}}
        />,
      );
      await Promise.resolve();
    });
    const node = renderer!.root
      .findAll((n) => Boolean(n.props["data-star-node"]))
      .find((n) => String(n.props["aria-label"] ?? "").startsWith("基础接口"))!;
    expect(node).toBeTruthy();
    await act(async () => {
      (node.props.onClick as (event: unknown) => void)({ currentTarget: {} });
      await Promise.resolve();
    });
    expect(onSelectTask).toHaveBeenCalledWith("t1");
    expect(onOpenTaskPage).not.toHaveBeenCalled();
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(String(renderer!.toJSON())).not.toContain("拖动空白平移 · 滚轮缩放");
    await act(async () => renderer!.unmount());
  });
});
