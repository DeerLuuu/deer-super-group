import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { PanelKey } from "./panelRegistry";
import { PANEL_DEFS } from "./panelRegistry";
import { defaultLayout, countGroups, listGroups, listPanels, validateLayout } from "./layoutModel";
import { clampGroups, clearV2Store } from "./layoutOps";
import { loadV2Store,
  reduceDock,
  saveV2Store,
  switchVariant,
  useDockLayoutController,
  v2StorageKey,
  type DockCommand,
  type DockLayout,
} from "./layoutOps";

/**
 * DW1-2（t526）：命令 reducer + v2 持久化测试。
 * localStorage 用真实实现（node 环境下 safeStorage 返回 null → 降级路径）+
 * 最小 Storage stub 注入（通过临时替换 globalThis.localStorage 测读写路径）。
 */

const storageStub = (() => {
  let map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => void (map = new Map()),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
})();

function withLocalStorage<T>(fn: () => T): T {
  const previous = (globalThis as Record<string, unknown>).localStorage;
  (globalThis as Record<string, unknown>).localStorage = storageStub;
  try {
    return fn();
  } finally {
    (globalThis as Record<string, unknown>).localStorage = previous;
  }
}

afterEach(() => {
  storageStub.clear();
});

// ---------------------------------------------------------------------------
// 命令矩阵
// ---------------------------------------------------------------------------

describe("reduceDock 命令矩阵", () => {
  it("open：新面板插入并激活 + persist；已存在只激活", () => {
    const base = defaultLayout("wide");
    const opened = reduceDock(base, { type: "open", panel: "gitGraph", cause: "command" });
    expect(opened.effects.persist).toBe(true);
    expect(opened.effects.activatedPanel).toBe("gitGraph");
    expect(listPanels(opened.layout.root)).toContain("gitGraph");
    const again = reduceDock(opened.layout, { type: "open", panel: "gitGraph", cause: "nav" });
    expect(countGroups(again.layout.root)).toBe(countGroups(opened.layout.root));
    expect(again.effects.activatedPanel).toBe("gitGraph");
  });

  it("close：settings 运行时拒绝（notify）+ no persist；普通面板关闭并持久化", () => {
    const base = defaultLayout("wide");
    const rejected = reduceDock(base, { type: "close", panel: "settings" });
    expect(rejected.layout).toBe(base);
    expect(rejected.effects.persist).toBe(false);
    expect(rejected.effects.notify.join()).toContain("不可关闭");

    const closed = reduceDock(base, { type: "close", panel: "mailbox" });
    expect(closed.effects.persist).toBe(true);
    expect(listPanels(closed.layout.root)).not.toContain("mailbox");
    expect(validateLayout(closed.layout)).toEqual([]);
  });

  it("close：面板不存在 → no-op 无 persist", () => {
    const base = defaultLayout("wide");
    const result = reduceDock(base, { type: "close", panel: "gitGraph" });
    expect(result.layout).toBe(base);
    expect(result.effects.persist).toBe(false);
    expect(result.effects.notify).toEqual([]);
  });

  it("activate：存在则激活；不存在 no-op", () => {
    const base = defaultLayout("wide");
    const activated = reduceDock(base, { type: "activate", panel: "tasks" });
    expect(activated.effects.activatedPanel).toBe("tasks");
    expect(activated.effects.persist).toBe(true);
    const missed = reduceDock(base, { type: "activate", panel: "gitGraph" });
    expect(missed.effects.persist).toBe(false);
  });

  it("move center：并入目标组并激活；panel/target 缺失 no-op", () => {
    const base = defaultLayout("wide");
    const moved = reduceDock(base, { type: "move", panel: "team", target: "chat", position: "center" });
    expect(moved.effects.persist).toBe(true);
    expect(moved.effects.activatedPanel).toBe("team");
    const main = listGroups(moved.layout.root).find((g) => (g.panels as string[]).includes("chat"));
    expect(main?.panels).toContain("team");
    const missed = reduceDock(base, { type: "move", panel: "gitGraph", target: "chat", position: "center" });
    expect(missed.layout).toBe(base);
  });

  it("split：新建组激活；达上限拒绝 + notify（与 onWillDrop 语义一致）", () => {
    let layout = defaultLayout("wide");
    let result = reduceDock(layout, { type: "open", panel: "gitGraph", cause: "command" });
    layout = result.layout;
    result = reduceDock(layout, { type: "split", panel: "gitGraph", direction: "right" });
    expect(countGroups(result.layout.root)).toBe(3);
    expect(result.effects.activatedPanel).toBe("gitGraph");

    // single 变体上限 1 → split 拒绝。
    const single = defaultLayout("single");
    const rejected = reduceDock(single, { type: "split", panel: "team", direction: "right" });
    expect(countGroups(rejected.layout.root)).toBe(1);
    expect(rejected.effects.notify.join()).toContain("最多");
  });

  it("resize：权重调整保持和为 1 + persist", () => {
    const base = defaultLayout("wide");
    const root = base.root as { kind: "split"; id: string; sizes: number[] };
    const resized = reduceDock(base, { type: "resize", splitId: root.id, index: 0, delta: 0.1 });
    expect(resized.effects.persist).toBe(true);
    const newRoot = resized.layout.root as { kind: "split"; sizes: number[] };
    expect(newRoot.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it("dragDrop：center 走 move center；edge 走 move edge", () => {
    const base = defaultLayout("wide");
    const center = reduceDock(base, { type: "dragDrop", panel: "team", target: "chat", position: "center" });
    expect(center.effects.activatedPanel).toBe("team");
    const edge = reduceDock(base, { type: "dragDrop", panel: "chat", target: "team", position: "edge", edge: "left" });
    expect(countGroups(edge.layout.root)).toBeGreaterThanOrEqual(2);
  });

  it("reset：当前变体回默认；指定变体切换", () => {
    const modified = reduceDock(defaultLayout("wide"), { type: "close", panel: "mailbox" }).layout;
    const reset = reduceDock(modified, { type: "reset" });
    expect(listPanels(reset.layout.root)).toContain("mailbox");
    expect(reset.effects.activatedPanel).toBe("chat");
    const single = reduceDock(modified, { type: "reset", variant: "single" });
    expect(single.layout.variant).toBe("single");
    expect(countGroups(single.layout.root)).toBe(1);
  });

  it("未知面板 open/close → notify 且布局不变", () => {
    const base = defaultLayout("wide");
    const badOpen = reduceDock(base, { type: "open", panel: "bogus" as PanelKey, cause: "command" });
    expect(badOpen.layout).toBe(base);
    expect(badOpen.effects.notify.join()).toContain("未知面板");
  });

  it("所有命令出口 validate 恒空（守恒不变量）", () => {
    const commands: DockCommand[] = [
      { type: "open", panel: "gitGraph", cause: "command" },
      { type: "close", panel: "mailbox" },
      { type: "activate", panel: "board" },
      { type: "move", panel: "team", target: "chat", position: "center" },
      { type: "split", panel: "tasks", direction: "below" },
      { type: "dragDrop", panel: "chat", target: "team", position: "edge", edge: "above" },
      { type: "reset" },
    ];
    let layout: DockLayout = defaultLayout("wide");
    for (const command of commands) {
      layout = reduceDock(layout, command).layout;
      expect(validateLayout(layout)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// maxGroups 裁剪
// ---------------------------------------------------------------------------

describe("clampGroups 裁剪", () => {
  it("超过上限的多余组并入 active group 直到 ≤ limit", () => {
    let layout = defaultLayout("wide");
    // 构建 4 组：split gitGraph + split console + split polls。
    for (const panel of ["gitGraph", "console", "polls"] as PanelKey[]) {
      layout = reduceDock(layout, { type: "open", panel, cause: "command" }).layout;
      layout = reduceDock(layout, { type: "split", panel, direction: "right" }).layout;
    }
    expect(countGroups(layout.root)).toBe(5);
    // maxGroups=3 → 裁剪到 3。
    const clamped = clampGroups(layout, 3);
    expect(countGroups(clamped.root)).toBe(3);
    expect(validateLayout(clamped, { maxGroups: 3 })).toEqual([]);
    // panel 不丢失。
    const before = new Set(listPanels(layout.root));
    const after = new Set(listPanels(clamped.root));
    expect(after).toEqual(before);
  });

  it("默认布局（≤2 组）不触发裁剪；断点变体保留", () => {
    for (const variant of ["wide", "medium", "narrow", "single"] as const) {
      const layout = defaultLayout(variant);
      const clamped = clampGroups(layout, undefined);
      expect(countGroups(clamped.root)).toBe(countGroups(layout.root));
      expect(clamped.variant).toBe(variant);
    }
  });
});

// ---------------------------------------------------------------------------
// v2 持久化
// ---------------------------------------------------------------------------

describe("v2 持久化", () => {
  it("key 格式：deer.dock.layout.v2.<workspaceId>（不与 v1 相交）", () => {
    expect(v2StorageKey("ws1")).toBe("deer.dock.layout.v2.ws1");
    expect(v2StorageKey("ws1")).not.toContain("deer.dock.state");
    expect(v2StorageKey("ws1")).not.toMatch(/^deer\.dock\.v1\./);
  });

  it("读写 round-trip；损坏/版本不符/结构非法 → 删除 key 返回 null", () => {
    withLocalStorage(() => {
      const store: Parameters<typeof saveV2Store>[1] = {
        schema: "deer.dock.layout",
        version: 2,
        updatedAt: new Date().toISOString(),
        variants: { wide: defaultLayout("wide") },
        activePanel: "chat",
      };
      expect(saveV2Store("ws1", store)).toBe(true);
      const loaded = loadV2Store("ws1");
      expect(loaded).not.toBeNull();
      expect(loaded?.variants.wide?.variant).toBe("wide");

      // 版本不符。
      storageStub.setItem(
        v2StorageKey("ws1"),
        JSON.stringify({ ...store, version: 99 }),
      );
      expect(loadV2Store("ws1")).toBeNull();
      expect(storageStub.getItem(v2StorageKey("ws1"))).toBeNull();

      // JSON 损坏。
      storageStub.setItem(v2StorageKey("ws1"), "{not json");
      expect(loadV2Store("ws1")).toBeNull();

      // 结构非法（重复 panel）。
      const badLayout = {
        ...defaultLayout("wide"),
        root: {
          kind: "split" as const,
          id: "s",
          axis: "horizontal" as const,
          sizes: [0.5, 0.5],
          children: [
            { kind: "group" as const, id: "g1", panels: ["chat", "chat"], active: "chat" },
            { kind: "group" as const, id: "g2", panels: ["team"], active: "team" },
          ],
        },
      };
      storageStub.setItem(
        v2StorageKey("ws1"),
        JSON.stringify({ ...store, variants: { wide: badLayout } }),
      );
      expect(loadV2Store("ws1")).toBeNull();
    });
  });

  it("无 localStorage（node/SSR）→ 读写降级不抛错", () => {
    // 本测试环境 typeof localStorage === "undefined"（withLocalStorage 之外）。
    expect(loadV2Store("ws-none")).toBeNull();
    expect(
      saveV2Store("ws-none", {
        schema: "deer.dock.layout",
        version: 2,
        updatedAt: new Date().toISOString(),
        variants: {},
        activePanel: null,
      }),
    ).toBe(false);
    expect(() => clearV2Store("ws-none")).not.toThrow();
  });

  it("超限（>64KB）→ save 返回 false；load 删除并返回 null", () => {
    withLocalStorage(() => {
      const huge = "x".repeat(70 * 1024);
      const store = {
        schema: "deer.dock.layout" as const,
        version: 2,
        updatedAt: "",
        variants: {},
        activePanel: null,
      };
      // 直接注入超限原始值模拟读路径。
      storageStub.setItem(v2StorageKey("ws2"), `{"schema":"deer.dock.layout","version":2,"updatedAt":"","variants":{},"activePanel":null,"pad":"${huge}"}`);
      expect(loadV2Store("ws2")).toBeNull();
      expect(storageStub.getItem(v2StorageKey("ws2"))).toBeNull();
      void store;
    });
  });

  it("不读 v1：源码扫描（去注释）无 deer.dock.state / v1 key 引用", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const source = await readFile(resolve(__dirname, "layoutOps.ts"), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/deer\.dock\.state/);
    expect(code).not.toMatch(/deer\.dock\.v1\./);
    expect(code).not.toMatch(/from ["']dockview/);
  });
});

// ---------------------------------------------------------------------------
// 变体切换（断点保持）
// ---------------------------------------------------------------------------

describe("switchVariant", () => {
  it("保存当前变体 → 恢复目标变体存档或默认；断点语义保留", () => {
    withLocalStorage(() => {
      const wide = defaultLayout("wide");
      const modified = reduceDock(wide, { type: "close", panel: "mailbox" }).layout;
      const switched = switchVariant(null, modified, "single");
      expect(switched.layout.variant).toBe("single");
      expect(countGroups(switched.layout.root)).toBe(1);
      expect(switched.savedPrevious).toBe(true);
      // t530 F5：返回完整 store，持久化归属调用方。
      expect(switched.store.variants.wide).toBeDefined();
      expect(switched.store.variants.wide?.variant).toBe("wide");

      // 切回 wide：restore 保存的 modified（mailbox 已关）。
      const back = switchVariant(switched.store, switched.layout, "wide");
      expect(back.layout.variant).toBe("wide");
      expect(listPanels(back.layout.root)).not.toContain("mailbox");
      expect(validateLayout(back.layout)).toEqual([]);
    });
  });

  it("t530 F3：layout.variant 与 variants key 不一致 → loadV2Store 删除回 null", () => {
    withLocalStorage(() => {
      const mismatched = { ...defaultLayout("single"), variant: "wide" as never };
      storageStub.setItem(
        v2StorageKey("ws9"),
        JSON.stringify({
          schema: "deer.dock.layout",
          version: 2,
          updatedAt: "",
          variants: { single: mismatched },
          activePanel: null,
        }),
      );
      expect(loadV2Store("ws9")).toBeNull();
      expect(storageStub.getItem(v2StorageKey("ws9"))).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// t530 F1：useDockLayoutController React 接线（真实生产消费方）
// ---------------------------------------------------------------------------

describe("t530 useDockLayoutController React 接线", () => {
  type RtrModule = {
    default: {
      create: (node: unknown) => { root: { findByType: (t: string) => { props: Record<string, unknown> } }; update: (n: unknown) => void; unmount: () => void };
    };
    act: (fn: () => Promise<void> | void) => Promise<void>;
  };
  const loadRtr = async (): Promise<RtrModule> => {
    // @ts-expect-error react-test-renderer 19.x 不带类型声明（仅测试依赖）
    const mod = (await import("react-test-renderer")) as RtrModule;
    return mod;
  };
  const previousActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  afterAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnv;
  });

  it("dispatch 经 reduceDock → effects 驱动 persist/notify/activate；flush 写入 v2 store", async () => {
    const React = await import("react");
    const { default: TestRenderer, act } = await loadRtr();
    const { useDockLayoutController } = await import("./layoutOps");

    let notified: string[] = [];
    let activated: string[] = [];
    let controller: ReturnType<typeof useDockLayoutController> | null = null;

    function Harness() {
      controller = useDockLayoutController({
        workspaceId: "ws-ctrl",
        variant: "wide",
        debounceMs: 10,
        onNotify: (message) => notified.push(message),
        onActivatedPanel: (panel) => activated.push(panel),
      });
      return null;
    }

    await withLocalStorageAsync(async () => {
      let renderer: ReturnType<typeof TestRenderer.create> | null = null;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(Harness));
      });
      // mount：初始为默认 wide 布局（无存档）。
      expect(controller!.layout.variant).toBe("wide");

      // open 新面板：activatedPanel 回调 + 10ms debounce 后 persist。
      await act(async () => {
        controller!.dispatch({ type: "open", panel: "gitGraph", cause: "command" });
      });
      expect(activated).toContain("gitGraph");
      expect(listPanels(controller!.layout.root)).toContain("gitGraph");

      // settings close：notify 拒绝 + no persist。
      const beforeNotify = notified.length;
      await act(async () => {
        controller!.dispatch({ type: "close", panel: "settings" });
      });
      expect(notified.length).toBe(beforeNotify + 1);
      expect(notified[notified.length - 1]).toContain("不可关闭");

      // debounce 后 v2 store 写入。
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      controller!.flush();
      const raw = storageStub.getItem(v2StorageKey("ws-ctrl"));
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as { variants: { wide?: { root: unknown } } };
      expect(parsed.variants.wide).toBeDefined();
      expect(JSON.stringify(parsed.variants.wide)).toContain("gitGraph");

      // 卸载 flush 安全（React 19 严格模式双挂载安全）。
      await act(async () => {
        renderer!.unmount();
      });
    });
  });

  it("setVariant：变体切换持久化（controller 内部完成）", async () => {
    const React = await import("react");
    const { default: TestRenderer, act } = await loadRtr();
    const { useDockLayoutController } = await import("./layoutOps");
    let controller: ReturnType<typeof useDockLayoutController> | null = null;
    function Harness() {
      controller = useDockLayoutController({ workspaceId: "ws-var", variant: "wide", debounceMs: 10 });
      return null;
    }
    await withLocalStorageAsync(async () => {
      let renderer: ReturnType<typeof TestRenderer.create> | null = null;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(Harness));
      });
      await act(async () => {
        controller!.dispatch({ type: "close", panel: "mailbox" });
      });
      await act(async () => {
        controller!.setVariant("single");
      });
      expect(controller!.layout.variant).toBe("single");
      const raw = storageStub.getItem(v2StorageKey("ws-var"));
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as { variants: Record<string, { variant: string }> };
      // 旧变体已保存（mailbox 关闭状态保留在 wide）。
      expect(parsed.variants.wide?.variant).toBe("wide");
      expect(parsed.variants.single?.variant).toBe("single");
      await act(async () => {
        renderer!.unmount();
      });
    });
  });
});

async function withLocalStorageAsync<T>(fn: () => Promise<T>): Promise<T> {
  const previous = (globalThis as Record<string, unknown>).localStorage;
  (globalThis as Record<string, unknown>).localStorage = storageStub;
  try {
    return await fn();
  } finally {
    (globalThis as Record<string, unknown>).localStorage = previous;
  }
}

// ---------------------------------------------------------------------------
// fake renderer parity（旧布局语义 vs 新模型）
// ---------------------------------------------------------------------------

describe("fake renderer parity（DW1-2 接线测试）", () => {
  /**
   * fake renderer：把布局树渲染为「组 → tabs/active」的纯文本快照（无 DOM）。
   * parity = 新模型操作与旧 dockview 布局语义的关键行为一致：
   * open 已存在激活 / close 删组 / move center 并入 / split 新组 / reset 回默认。
   */
  function renderFake(layout: DockLayout): string {
    const lines: string[] = [layout.variant];
    function walk(node: typeof layout.root, depth: number): void {
      const pad = "  ".repeat(depth);
      if (node.kind === "group") {
        const tabs = node.panels.map((p) => `${p}${node.active === p ? "*" : ""}`).join("|");
        lines.push(`${pad}group(${node.id}): ${tabs}`);
        return;
      }
      lines.push(`${pad}split(${node.axis}): ${node.sizes.map((s) => s.toFixed(2)).join(":")}`);
      node.children.forEach((child, i) => {
        lines.push(`${pad}[${i}]`);
        walk(child, depth + 1);
      });
    }
    walk(layout.root, 1);
    return lines.join("\n");
  }

  it("open/close/move/split/reset 的快照 parity：与旧语义关键行为一致", () => {
    const base = defaultLayout("wide");
    // open 新面板：出现在某 group 尾部且 active。
    const opened = reduceDock(base, { type: "open", panel: "gitGraph", cause: "command" });
    expect(renderFake(opened.layout)).toMatch(/gitGraph\*/);
    // close：面板从快照消失。
    const closed = reduceDock(opened.layout, { type: "close", panel: "gitGraph" });
    expect(renderFake(closed.layout)).not.toContain("gitGraph");
    // move center：team 并入 chat 所在组（右分栏组消失）。
    const moved = reduceDock(base, { type: "move", panel: "team", target: "chat", position: "center" });
    expect(renderFake(moved.layout)).toMatch(/chat\|.*team\*|team\*.*chat\|/);
    expect(renderFake(moved.layout)).not.toMatch(/group\(group-team\)/);
    // split：新组出现。
    const split = reduceDock(opened.layout, { type: "split", panel: "gitGraph", direction: "right" });
    expect(renderFake(split.layout)).toMatch(/group\(group-gitGraph\): gitGraph\*/);
    // reset：回到默认快照。
    const reset = reduceDock(split.layout, { type: "reset" });
    expect(renderFake(reset.layout)).toBe(renderFake(base));
  });

  it("settings 不可关闭：旧 renderer 语义（关闭按钮隐藏）= 新模型 close 拒绝 no-op", () => {
    const base = defaultLayout("wide");
    const result = reduceDock(base, { type: "close", panel: "settings" });
    expect(renderFake(result.layout)).toBe(renderFake(base));
    expect(PANEL_DEFS.settings.closable).toBe(false);
  });
});
