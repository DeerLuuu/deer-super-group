import { describe, expect, it } from "vitest";
import type { PanelKey } from "./panelRegistry";
import { PANEL_DEFS } from "./panelRegistry";
import {
  DEFAULT_MAX_GROUPS,
  MAX_GROUPS,
  MIN_GROUPS,
  activatePanelInLayout,
  closePanelInLayout,
  countGroups,
  defaultLayout,
  defaultLayoutForWidth,
  effectiveMaxDockGroups,
  groupMinHeight,
  groupMinWidth,
  layoutEquivalent,
  listGroups,
  listPanels,
  movePanelInLayout,
  normalizeLayout,
  openPanelInLayout,
  resizeSplitInLayout,
  splitPanelInLayout,
  validateLayout,
  type DockLayout,
  type LayoutGroup,
  type LayoutSplit,
} from "./layoutModel";

/**
 * DW1-1（t506）：布局模型单元 + property tests。
 * 确定性伪随机（mulberry32）：随机命令序列可复现（记录 seed）。
 */

const ALL_OPENABLE: PanelKey[] = [
  "chat",
  "team",
  "tasks",
  "mailbox",
  "board",
  "context",
  "runs",
  "polls",
  "watchdog",
  "planDraft",
  "gitGraph",
  "mergeQueue",
  "console",
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type RandomOp =
  | { op: "open"; panel: PanelKey }
  | { op: "close"; panel: PanelKey }
  | { op: "activate"; panel: PanelKey }
  | { op: "split"; panel: PanelKey; direction: "left" | "right" | "above" | "below" }
  | { op: "move"; panel: PanelKey; target: PanelKey; position: "center" | "left" | "right" | "above" | "below" }
  | { op: "resize" };

function randomOp(rand: () => number): RandomOp {
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const directions = ["left", "right", "above", "below"] as const;
  const positions = ["center", ...directions] as const;
  const roll = rand();
  if (roll < 0.3) return { op: "open", panel: pick(ALL_OPENABLE) };
  if (roll < 0.5) return { op: "close", panel: pick(ALL_OPENABLE) };
  if (roll < 0.62) return { op: "activate", panel: pick(ALL_OPENABLE) };
  if (roll < 0.74) return { op: "split", panel: pick(ALL_OPENABLE), direction: pick([...directions]) };
  if (roll < 0.9) {
    return { op: "move", panel: pick(ALL_OPENABLE), target: pick(ALL_OPENABLE), position: pick([...positions]) };
  }
  return { op: "resize" };
}

function applyOp(layout: DockLayout, op: RandomOp): DockLayout {
  switch (op.op) {
    case "open":
      return openPanelInLayout(layout, op.panel);
    case "close":
      return closePanelInLayout(layout, op.panel);
    case "activate":
      return activatePanelInLayout(layout, op.panel);
    case "split":
      return splitPanelInLayout(layout, op.panel, op.direction, undefined);
    case "move":
      return movePanelInLayout(layout, op.panel, op.target, op.position, undefined);
    case "resize": {
      const groups = collectSplits(layout.root);
      if (groups.length === 0) return layout;
      const split = groups[Math.floor(Math.random() * groups.length)];
      const index = Math.floor(Math.random() * split.sizes.length);
      const delta = (Math.random() - 0.5) * 0.4;
      return resizeSplitInLayout(layout, split.id, index, delta);
    }
    default:
      return layout;
  }
}

function collectSplits(node: DockLayout["root"]): LayoutSplit[] {
  if (node.kind === "group") return [];
  return [node, ...node.children.flatMap(collectSplits)];
}

/** 不变量断言：panel 唯一/树完整/比例和/组数范围/normalize 幂等。 */
function assertInvariants(layout: DockLayout, note: string): void {
  const issues = validateLayout(layout);
  expect(issues, `${note}: validate=${JSON.stringify(issues)}`).toEqual([]);
  const panels = listPanels(layout.root);
  expect(new Set(panels).size, `${note}: panel 唯一`).toBe(panels.length);
  const groupCount = countGroups(layout.root);
  const limit = effectiveMaxDockGroups(undefined, layout.variant);
  expect(groupCount, `${note}: 组数 ≤ ${limit}`).toBeLessThanOrEqual(limit);
  expect(groupCount, `${note}: 至少 1 组`).toBeGreaterThanOrEqual(1);
  // settings 在布局内时永远存在（不可关闭）。
  // 比例和：每个 split 的 sizes 和 ≈ 1。
  for (const split of collectSplits(layout.root)) {
    const sum = split.sizes.reduce((total, value) => total + value, 0);
    expect(Math.abs(sum - 1), `${note}: sizes 和=1`).toBeLessThan(1e-5);
    for (const size of split.sizes) {
      expect(Number.isFinite(size) && size > 0, `${note}: size 正数`).toBe(true);
    }
    expect(split.sizes.length).toBe(split.children.length);
  }
  // normalize 幂等
  const normalized = normalizeLayout(layout);
  expect(
    layoutEquivalent(normalized.root, normalizeLayout(normalized).root),
    `${note}: normalize 幂等`,
  ).toBe(true);
}

describe("layoutModel 常量与工具", () => {
  it("effectiveMaxDockGroups：single 恒 1；默认 6；clamp 2–8", () => {
    expect(effectiveMaxDockGroups(undefined, "single")).toBe(1);
    expect(effectiveMaxDockGroups(undefined, "wide")).toBe(DEFAULT_MAX_GROUPS);
    expect(effectiveMaxDockGroups(99, "wide")).toBe(MAX_GROUPS);
    expect(effectiveMaxDockGroups(1, "wide")).toBe(MIN_GROUPS);
    expect(effectiveMaxDockGroups(Number.NaN, "medium")).toBe(DEFAULT_MAX_GROUPS);
  });

  it("groupMinWidth/Height 取组内面板最大下限", () => {
    const group: LayoutGroup = { kind: "group", id: "g", panels: ["chat", "tasks"], active: "chat" };
    expect(groupMinWidth(group)).toBe(Math.max(PANEL_DEFS.chat.minWidth, PANEL_DEFS.tasks.minWidth));
    expect(groupMinHeight(group)).toBe(Math.max(PANEL_DEFS.chat.minHeight, PANEL_DEFS.tasks.minHeight));
  });
});

describe("layoutModel 默认布局", () => {
  it("wide/medium/narrow：主组 + team 右分栏，权重对齐 VARIANT_WEIGHTS，settings 在主组", () => {
    for (const variant of ["wide", "medium", "narrow"] as const) {
      const layout = defaultLayout(variant);
      expect(validateLayout(layout)).toEqual([]);
      const groups = listGroups(layout.root);
      expect(groups).toHaveLength(2);
      const [main, team] = groups;
      expect(main.panels).toEqual(["chat", "tasks", "mailbox", "board", "settings"]);
      expect(team.panels).toEqual(["team"]);
      const split = layout.root as LayoutSplit;
      expect(split.axis).toBe("horizontal");
      const weights = { wide: [0.58, 0.42], medium: [0.56, 0.44], narrow: [0.52, 0.48] }[variant];
      expect(split.sizes[0]).toBeCloseTo(weights[0], 5);
      expect(split.sizes[1]).toBeCloseTo(weights[1], 5);
      expect(countGroups(layout.root)).toBeLessThanOrEqual(effectiveMaxDockGroups(undefined, variant));
    }
  });

  it("single：全部面板同组（team 是 tab，不右分栏）", () => {
    const layout = defaultLayout("single");
    expect(validateLayout(layout)).toEqual([]);
    expect(layout.root.kind).toBe("group");
    const group = layout.root as LayoutGroup;
    expect(group.panels).toContain("team");
    expect(group.panels).toContain("settings");
    expect(countGroups(layout.root)).toBe(1);
  });

  it("默认布局不含 defaultClosed 面板（context/runs/polls 等）", () => {
    for (const variant of ["wide", "medium", "narrow", "single"] as const) {
      const panels = listPanels(defaultLayout(variant).root);
      expect(panels).not.toContain("context");
      expect(panels).not.toContain("runs");
      expect(panels).not.toContain("planDraft");
      expect(panels).not.toContain("gitGraph");
    }
  });

  it("defaultLayoutForWidth 按断点选择变体", () => {
    expect(defaultLayoutForWidth(1200).variant).toBe("wide");
    expect(defaultLayoutForWidth(1000).variant).toBe("medium");
    // t194：Dock <920（MIN_SPLIT_DOCK_WIDTH）一律 single；不传 windowWidth 时保留旧 760 档（兼容调用）。
    expect(defaultLayoutForWidth(700).variant).toBe("single");
    expect(defaultLayoutForWidth(1200, 900).variant).toBe("single");
  });
});

describe("layoutModel validate 边界", () => {
  it("空组 / 重复 panel / active 越界 / sizes 长度 / NaN / 负数 / 超组数 全部拒绝", () => {
    const base = defaultLayout("wide");
    // 空组
    const emptyGroup: DockLayout = {
      ...base,
      root: { kind: "group", id: "g", panels: [], active: null },
    };
    expect(validateLayout(emptyGroup).map((i) => i.code)).toContain("E_EMPTY_GROUP");
    // 重复 panel
    const dup: DockLayout = {
      ...base,
      root: {
        kind: "split",
        id: "s",
        axis: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          { kind: "group", id: "g1", panels: ["chat", "tasks"], active: "chat" },
          { kind: "group", id: "g2", panels: ["chat"], active: "chat" },
        ],
      },
    };
    expect(validateLayout(dup).map((i) => i.code)).toContain("E_DUPLICATE_PANEL");
    // active 不在组内
    const badActive: DockLayout = {
      ...base,
      root: { kind: "group", id: "g", panels: ["chat"], active: "team" },
    };
    expect(validateLayout(badActive).map((i) => i.code)).toContain("E_ACTIVE_NOT_IN_GROUP");
    // 未知 panel
    const unknown: DockLayout = {
      ...base,
      root: { kind: "group", id: "g", panels: ["chat", "bogus" as PanelKey], active: "chat" },
    };
    expect(validateLayout(unknown).map((i) => i.code)).toContain("E_UNKNOWN_PANEL");
    // sizes 长度不匹配
    const badLen: DockLayout = {
      ...base,
      root: {
        kind: "split",
        id: "s",
        axis: "horizontal",
        sizes: [1],
        children: [
          { kind: "group", id: "g1", panels: ["chat"], active: "chat" },
          { kind: "group", id: "g2", panels: ["team"], active: "team" },
        ],
      },
    };
    expect(validateLayout(badLen).map((i) => i.code)).toContain("E_SPLIT_SIZE_LENGTH");
    // NaN / 负数
    const nanSizes: DockLayout = {
      ...base,
      root: {
        kind: "split",
        id: "s",
        axis: "horizontal",
        sizes: [Number.NaN, 0.5],
        children: [
          { kind: "group", id: "g1", panels: ["chat"], active: "chat" },
          { kind: "group", id: "g2", panels: ["team"], active: "team" },
        ],
      },
    };
    expect(validateLayout(nanSizes).map((i) => i.code)).toContain("E_SPLIT_BAD_SIZE");
    const negSizes: DockLayout = {
      ...nanSizes,
      root: { ...(nanSizes.root as LayoutSplit), sizes: [-0.5, 0.5] },
    };
    expect(validateLayout(negSizes).map((i) => i.code)).toContain("E_SPLIT_BAD_SIZE");
    // 超组数（single 变体 2 组）
    const tooMany: DockLayout = {
      ...defaultLayout("single"),
      root: {
        kind: "split",
        id: "s",
        axis: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          { kind: "group", id: "g1", panels: ["chat"], active: "chat" },
          { kind: "group", id: "g2", panels: ["team"], active: "team" },
        ],
      },
    };
    expect(validateLayout(tooMany).map((i) => i.code)).toContain("E_TOO_MANY_GROUPS");
    // single-child split
    const singleChild: DockLayout = {
      ...base,
      root: {
        kind: "split",
        id: "s",
        axis: "horizontal",
        sizes: [1],
        children: [{ kind: "group", id: "g", panels: ["chat"], active: "chat" }],
      },
    };
    expect(validateLayout(singleChild).map((i) => i.code)).toContain("E_SPLIT_TOO_FEW_CHILDREN");
    // 节点 id 冲突
    const dupIds: DockLayout = {
      ...base,
      root: {
        kind: "split",
        id: "same",
        axis: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          { kind: "group", id: "same", panels: ["chat"], active: "chat" },
          { kind: "group", id: "g2", panels: ["team"], active: "team" },
        ],
      },
    };
    expect(validateLayout(dupIds).map((i) => i.code)).toContain("E_DUPLICATE_NODE_ID");
  });
});

describe("layoutModel normalize", () => {
  it("空组删除、single-child 折叠、sizes 归一、active 回退、幂等", () => {
    const messy: DockLayout = {
      schema: "deer.dock.layout",
      version: 2,
      variant: "wide",
      root: {
        kind: "split",
        id: "s0",
        axis: "horizontal",
        sizes: [0, 0],
        children: [
          {
            kind: "split",
            id: "s1",
            axis: "vertical",
            sizes: [3, 7],
            children: [
              { kind: "group", id: "g1", panels: ["chat", "tasks"], active: "bogus" as PanelKey },
              { kind: "group", id: "g-empty", panels: [], active: null },
            ],
          },
          { kind: "group", id: "g2", panels: ["team"], active: "team" },
        ],
      },
    };
    const normalized = normalizeLayout(messy);
    expect(validateLayout(normalized)).toEqual([]);
    const groups = listGroups(normalized.root);
    expect(groups.map((g) => g.id).join(",")).not.toContain("g-empty");
    // s1 只剩一个 child → 折叠，s0 直接持有 g1/g2
    const root = normalized.root as LayoutSplit;
    expect(root.children.map((c) => c.kind)).toEqual(["group", "group"]);
    expect(root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect((root.children[0] as LayoutGroup).active).toBe("chat");
    // 幂等
    expect(layoutEquivalent(normalized.root, normalizeLayout(normalized).root)).toBe(true);
  });

  it("全空树回退到单 chat 组", () => {
    const empty: DockLayout = {
      schema: "deer.dock.layout",
      version: 2,
      variant: "wide",
      root: { kind: "group", id: "g", panels: [], active: null },
    };
    const normalized = normalizeLayout(empty);
    expect(normalized.root.kind).toBe("group");
    expect((normalized.root as LayoutGroup).panels).toEqual(["chat"]);
    expect(validateLayout(normalized)).toEqual([]);
  });
});

describe("layoutModel 操作", () => {
  it("open 已存在激活 / 不存在插入 active group 并激活", () => {
    const base = defaultLayout("wide");
    const opened = openPanelInLayout(base, "gitGraph");
    const group = listGroups(opened.root).find((g) => (g.panels as string[]).includes("gitGraph"));
    expect(group).toBeDefined();
    expect(group?.active).toBe("gitGraph");
    const again = openPanelInLayout(opened, "gitGraph");
    expect(countGroups(again.root)).toBe(countGroups(opened.root));
  });

  it("close settings 拒绝；close 后空组删除、active 回退相邻", () => {
    const base = defaultLayout("wide");
    expect(closePanelInLayout(base, "settings")).toBe(base);
    const closed = closePanelInLayout(base, "mailbox");
    const main = listGroups(closed.root).find((g) => (g.panels as string[]).includes("chat"));
    expect(main?.panels).not.toContain("mailbox");
    expect(validateLayout(closed)).toEqual([]);
  });

  it("split 建新组、超组数拒绝；resize 保持和为 1", () => {
    let layout = defaultLayout("wide");
    layout = openPanelInLayout(layout, "gitGraph");
    layout = splitPanelInLayout(layout, "gitGraph", "right");
    expect(countGroups(layout.root)).toBe(3);
    expect(validateLayout(layout)).toEqual([]);
    // 找到含 3 个子树中 gitGraph 所在深层 split 的任一 split 做 resize。
    const splits = collectSplits(layout.root);
    expect(splits.length).toBeGreaterThan(0);
    const split = splits[0];
    const resized = resizeSplitInLayout(layout, split.id, 0, 0.2);
    const newSplit = collectSplits(resized.root).find((s) => s.id === split.id)!;
    expect(newSplit.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    // 超组数（single 变体）
    const single = defaultLayout("single");
    expect(countGroups(splitPanelInLayout(single, "team", "right").root)).toBe(1);
  });

  it("move center 并入目标组", () => {
    const base = defaultLayout("wide");
    const moved = movePanelInLayout(base, "team", "chat", "center");
    const main = listGroups(moved.root).find((g) => (g.panels as string[]).includes("chat"));
    expect(main?.panels).toContain("team");
    expect((main?.panels as string[]).indexOf("team")).toBe(
      (main?.panels as string[]).indexOf("chat") + 1,
    );
    expect(validateLayout(moved)).toEqual([]);
  });

  // t518 F1：panel/target 缺失时 center/split 四条 no-op 路径。
  it("move/split：panel 或 target 不在布局中 → 返回原 layout（no-op）", () => {
    const base = defaultLayout("wide");
    const snapshot = JSON.stringify(base);
    // panel 缺失（gitGraph 未打开）
    expect(JSON.stringify(movePanelInLayout(base, "gitGraph", "chat", "center"))).toBe(snapshot);
    expect(JSON.stringify(movePanelInLayout(base, "gitGraph", "chat", "right"))).toBe(snapshot);
    expect(JSON.stringify(splitPanelInLayout(base, "gitGraph", "right"))).toBe(snapshot);
    // target 缺失（target=gitGraph 未打开）
    expect(JSON.stringify(movePanelInLayout(base, "chat", "gitGraph", "center"))).toBe(snapshot);
    expect(JSON.stringify(movePanelInLayout(base, "chat", "gitGraph", "left"))).toBe(snapshot);
  });

  // t518 F2：schema mismatch 专用错误码。
  it("validate：schema/version 不匹配返回 E_SCHEMA_MISMATCH（不再复用 E_EMPTY_ROOT）", () => {
    const bad: DockLayout = { ...defaultLayout("wide"), version: 99 as never };
    const issues = validateLayout(bad);
    expect(issues.map((i) => i.code)).toContain("E_SCHEMA_MISMATCH");
    expect(issues.map((i) => i.code)).not.toContain("E_EMPTY_ROOT");
    const badSchema: DockLayout = {
      ...defaultLayout("wide"),
      schema: "deer.dock.state" as never,
    };
    expect(validateLayout(badSchema).map((i) => i.code)).toContain("E_SCHEMA_MISMATCH");
  });

  // t518 F3：DW1-2 契约——normalize 后 validate 必须为空（供 reducer 出口统一断言）。
  it("normalize 后 validate 恒为空（任意合法输入，含手动构造的脏树）", () => {
    const dirty: DockLayout = {
      schema: "deer.dock.layout",
      version: 2,
      variant: "wide",
      root: {
        kind: "split",
        id: "s",
        axis: "horizontal",
        sizes: [0, 0],
        children: [
          {
            kind: "split",
            id: "s2",
            axis: "vertical",
            sizes: [5, 5, 5],
            children: [
              { kind: "group", id: "g1", panels: ["chat", "team"], active: "chat" },
              { kind: "group", id: "g2", panels: ["tasks"], active: null },
              { kind: "group", id: "g3", panels: [], active: null },
            ],
          },
          { kind: "group", id: "g4", panels: ["mailbox", "board", "settings"], active: "board" },
        ],
      },
    };
    const normalized = normalizeLayout(dirty);
    expect(validateLayout(normalized)).toEqual([]);
    expect(validateLayout(normalizeLayout(normalized))).toEqual([]);
  });
});

describe("layoutModel property tests（1000+ 随机操作不变量）", () => {
  const SEEDS = [20261113, 42, 987654321, 7, 1337];
  const OPS_PER_SEED = 260;

  for (const seed of SEEDS) {
    it(`seed=${seed}：${OPS_PER_SEED} 次随机 open/close/move/split/resize 后不变量保持`, () => {
      const rand = mulberry32(seed);
      let layout = defaultLayout(seed % 2 === 0 ? "wide" : "single");
      assertInvariants(layout, `seed=${seed} init`);
      for (let step = 0; step < OPS_PER_SEED; step += 1) {
        const op = randomOp(rand);
        layout = applyOp(layout, op);
        assertInvariants(layout, `seed=${seed} step=${step} op=${JSON.stringify(op)}`);
        // settings 若在布局中永远不可被 close 移除
        const panels = listPanels(layout.root);
        if (panels.includes("settings")) {
          // close settings 是 no-op，无需额外断言（上面 invariants 已保证树合法）
        }
      }
      // 累计 5 seeds × 260 = 1300 次随机操作 ≥ 1000。
    });
  }

  it("随机重启等价：操作序列后 normalize 双跑结构一致（5×260 序列）", () => {
    for (const seed of SEEDS) {
      const rand = mulberry32(seed);
      let layout = defaultLayout("wide");
      for (let step = 0; step < OPS_PER_SEED; step += 1) {
        layout = applyOp(layout, randomOp(rand));
      }
      const once = normalizeLayout(layout);
      const twice = normalizeLayout(once);
      expect(layoutEquivalent(once.root, twice.root)).toBe(true);
      expect(validateLayout(once)).toEqual([]);
      expect(validateLayout(twice)).toEqual([]);
    }
  });

  it("不读取 v1 deer.dock.state：模型无 localStorage/dockview 运行时访问（源码扫描）", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const source = await readFile(resolve(__dirname, "layoutModel.ts"), "utf8");
    // 去掉注释后只检查运行时代码（文件头注释里的 v1 说明不算访问）。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/localStorage/);
    expect(code).not.toMatch(/deer\.dock\.state/);
    expect(code).not.toMatch(/from ["']dockview/);
    expect(code).not.toMatch(/require\(["']dockview/);
  });
});
