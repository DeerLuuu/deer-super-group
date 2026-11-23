/**
 * DW1-1（t506）：自研 Dock 布局树模型（纯数据层，不接 UI）。
 *
 * 依据 docs/team/architecture-batch-v2.md §3.3：
 * - LayoutNode = LayoutSplit | LayoutGroup，panel 全局唯一；
 * - normalize：空组删除、single-child split 折叠、sizes 归一（正数、和为 1、与 children 等长）；
 * - validate：非法树/重复 panel/超组数/active 越界/未知 PanelKey 全部拒绝；
 * - 默认布局：wide/medium/narrow 主组+team 右分栏（VARIANT_WEIGHTS），single 全部同组；
 * - 本模块不 import DockShell/旧渲染器，不读 v1 `deer.dock.state`（v2 key 归 DW1-2）。
 */

import {
  MAIN_GROUP_ORDER,
  PANEL_DEFS,
  VARIANT_WEIGHTS,
  selectVariant,
  type DockVariant,
  type PanelKey,
} from "./panelRegistry";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type { DockVariant, PanelKey };

export interface LayoutSplit {
  kind: "split";
  /** 稳定 id：持久化/测试定位用（同一棵树内唯一）。 */
  id: string;
  axis: "horizontal" | "vertical";
  /** flex 权重（normalize 后为正数且和为 1）；length === children.length。 */
  sizes: number[];
  children: LayoutNode[];
}

export interface LayoutGroup {
  kind: "group";
  id: string;
  /** 顺序 = tab 顺序；panel 全局唯一。 */
  panels: PanelKey[];
  active: PanelKey | null;
}

export type LayoutNode = LayoutSplit | LayoutGroup;

export interface DockLayout {
  schema: "deer.dock.layout";
  version: 2;
  variant: DockVariant;
  root: LayoutNode;
}

/** 模型校验结果（validate 从不抛错，错误以列表返回）。 */
export interface ValidationIssue {
  code:
    | "E_EMPTY_ROOT"
    | "E_EMPTY_GROUP"
    | "E_UNKNOWN_PANEL"
    | "E_DUPLICATE_PANEL"
    | "E_ACTIVE_NOT_IN_GROUP"
    | "E_SPLIT_TOO_FEW_CHILDREN"
    | "E_SPLIT_SIZE_LENGTH"
    | "E_SPLIT_BAD_SIZE"
    | "E_TOO_MANY_GROUPS"
    | "E_NON_POSITIVE_SIZE_SUM"
    | "E_DUPLICATE_NODE_ID"
    /** t518：schema/version 不匹配专用码（原先复用 E_EMPTY_ROOT）。 */
    | "E_SCHEMA_MISMATCH";
  path: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// 常量（与 §3.3 对齐；沿用现有 onWillDrop/组上限语义）
// ---------------------------------------------------------------------------

export const MIN_GROUPS = 2;
export const MAX_GROUPS = 8;
export const DEFAULT_MAX_GROUPS = 6;

/**
 * effectiveMaxDockGroups：窄窗（single 变体）保持 1 组上限之外，
 * 其余变体沿用「默认 6、用户可设 2–8」的语义。
 */
export function effectiveMaxDockGroups(
  maxGroups: number | undefined,
  variant: DockVariant,
): number {
  if (variant === "single") return 1;
  const requested = maxGroups ?? DEFAULT_MAX_GROUPS;
  if (!Number.isFinite(requested)) return DEFAULT_MAX_GROUPS;
  return Math.min(MAX_GROUPS, Math.max(MIN_GROUPS, Math.round(requested)));
}

/** 组内最小尺寸来自 PANEL_DEFS（取组内面板最大 minWidth/minHeight）。 */
export function groupMinWidth(group: LayoutGroup): number {
  return group.panels.reduce((max, key) => Math.max(max, PANEL_DEFS[key].minWidth), 0);
}

export function groupMinHeight(group: LayoutGroup): number {
  return group.panels.reduce((max, key) => Math.max(max, PANEL_DEFS[key].minHeight), 0);
}

// ---------------------------------------------------------------------------
// 遍历工具
// ---------------------------------------------------------------------------

export function listGroups(node: LayoutNode): LayoutGroup[] {
  if (node.kind === "group") return [node];
  return node.children.flatMap(listGroups);
}

export function listPanels(node: LayoutNode): PanelKey[] {
  return listGroups(node).flatMap((group) => group.panels);
}

export function countGroups(node: LayoutNode): number {
  return listGroups(node).length;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/** 校验布局树；返回问题列表（空数组 = 合法）。从不抛错。 */
export function validateLayout(
  layout: DockLayout,
  context: { maxGroups?: number; variant?: DockVariant } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxGroups = effectiveMaxDockGroups(
    context.maxGroups,
    context.variant ?? layout.variant,
  );
  const seenPanels = new Set<PanelKey>();
  const seenNodeIds = new Set<string>();

  if (layout.schema !== "deer.dock.layout" || layout.version !== 2) {
    // t518：schema/version 不匹配用专用码（DW1-2 persistence 据此决定删除回默认）。
    issues.push({ code: "E_SCHEMA_MISMATCH", path: "$", detail: "schema/version mismatch" });
    return issues;
  }

  function visit(node: LayoutNode, path: string): void {
    if (!node || typeof node !== "object" || !("kind" in node)) {
      issues.push({ code: "E_EMPTY_ROOT", path, detail: "not a LayoutNode" });
      return;
    }
    if (seenNodeIds.has(node.id)) {
      issues.push({ code: "E_DUPLICATE_NODE_ID", path, detail: node.id });
    }
    seenNodeIds.add(node.id);

    if (node.kind === "group") {
      if (node.panels.length === 0) {
        issues.push({ code: "E_EMPTY_GROUP", path });
      }
      for (const key of node.panels) {
        if (!(key in PANEL_DEFS)) {
          issues.push({ code: "E_UNKNOWN_PANEL", path, detail: key });
          continue;
        }
        if (seenPanels.has(key)) {
          issues.push({ code: "E_DUPLICATE_PANEL", path, detail: key });
        }
        seenPanels.add(key);
      }
      if (node.active !== null) {
        if (!(node.panels as string[]).includes(node.active)) {
          issues.push({ code: "E_ACTIVE_NOT_IN_GROUP", path, detail: node.active });
        }
        // active 指向不可关闭面板没问题；这里只校验归属。
      }
      return;
    }

    // split
    if (node.children.length < 2) {
      issues.push({ code: "E_SPLIT_TOO_FEW_CHILDREN", path });
    }
    if (node.sizes.length !== node.children.length) {
      issues.push({ code: "E_SPLIT_SIZE_LENGTH", path });
    }
    let sum = 0;
    for (const size of node.sizes) {
      if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
        issues.push({ code: "E_SPLIT_BAD_SIZE", path, detail: String(size) });
      } else {
        sum += size;
      }
    }
    if (node.sizes.length === node.children.length && sum <= 0) {
      issues.push({ code: "E_NON_POSITIVE_SIZE_SUM", path });
    }
    node.children.forEach((child, index) => visit(child, `${path}.children[${index}]`));
  }

  visit(layout.root, "$.root");

  const groupCount = (() => {
    try {
      return countGroups(layout.root);
    } catch {
      return 0;
    }
  })();
  if (groupCount > maxGroups) {
    issues.push({
      code: "E_TOO_MANY_GROUPS",
      path: "$.root",
      detail: `${groupCount} > ${maxGroups}`,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

let normalizerCounter = 0;
function nextNodeId(prefix: string): string {
  normalizerCounter += 1;
  return `${prefix}-${normalizerCounter.toString(36)}`;
}

/**
 * 规范化布局树（幂等）：
 * - 空组删除；single-child split 折叠为其唯一 child；
 * - sizes 修复为正数、四舍五入到 6 位小数、和归一为 1；
 * - group.active 不在 panels 内时回退到首个 panel（组非空）；
 * - 未知 PanelKey 从 panels 中剔除（保守修复；若因此组空则删除）；
 * - split/group 缺 id 时补稳定 id；节点 id 冲突时重编 split id；
 * - 折叠/删除后若 root 为空 group → 单 chat 组（最低可用布局）。
 */
export function normalizeLayout(layout: DockLayout): DockLayout {
  normalizerCounter = 0;
  // 只在遍历中记录「本次已分配」的 id：保留原 id（幂等/调用方可依赖），
  // 仅当同一次遍历内出现重复时才重新生成。
  const assignedIds = new Set<string>();

  function uniqueId(prefix: string, fallback?: string): string {
    if (fallback && !assignedIds.has(fallback)) {
      assignedIds.add(fallback);
      return fallback;
    }
    let id = nextNodeId(prefix);
    while (assignedIds.has(id)) id = nextNodeId(prefix);
    assignedIds.add(id);
    return id;
  }

  function fixSizes(sizes: number[], count: number): number[] {
    const safe = sizes.slice(0, count).map((value) =>
      Number.isFinite(value) && value > 0 ? value : 0,
    );
    while (safe.length < count) safe.push(0);
    const sum = safe.reduce((total, value) => total + value, 0);
    if (sum <= 0) return new Array(count).fill(1 / count).map(round6);
    return safe.map((value) => round6(value / sum));
  }

  function round6(value: number): number {
    return Math.round(value * 1e6) / 1e6;
  }

  function renormalizeSum(values: number[]): number[] {
    const sum = values.reduce((total, value) => total + value, 0);
    if (sum <= 0) return values;
    const scaled = values.map((value) => round6(value / sum));
    // 消除舍入残差：把差值加到最大权重上，保证 sum === 1（6 位精度）。
    const residual = round6(1 - scaled.reduce((total, value) => total + value, 0));
    if (residual !== 0) {
      let maxIndex = 0;
      for (let index = 1; index < scaled.length; index += 1) {
        if (scaled[index] > scaled[maxIndex]) maxIndex = index;
      }
      scaled[maxIndex] = round6(scaled[maxIndex] + residual);
    }
    return scaled;
  }

  function visit(node: LayoutNode): LayoutNode | null {
    if (node.kind === "group") {
      const panels = node.panels.filter((key) => key in PANEL_DEFS);
      if (panels.length === 0) return null;
      const active = node.active !== null && (panels as string[]).includes(node.active)
        ? node.active
        : panels[0];
      return {
        kind: "group",
        id: uniqueId("group", node.id),
        panels: dedupe(panels),
        active,
      };
    }
    const children = node.children
      .map((child) => visit(child))
      .filter((child): child is LayoutNode => child !== null);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return {
      kind: "split",
      id: uniqueId("split", node.id),
      axis: node.axis === "vertical" ? "vertical" : "horizontal",
      sizes: renormalizeSum(fixSizes(node.sizes, children.length)),
      children,
    };
  }

  function dedupe(panels: PanelKey[]): PanelKey[] {
    return [...new Set(panels)];
  }

  const normalizedRoot = visit(layout.root);
  const root: LayoutNode =
    normalizedRoot !== null
      ? normalizedRoot
      : { kind: "group", id: "group-main", panels: ["chat"], active: "chat" };

  return { schema: "deer.dock.layout", version: 2, variant: layout.variant, root };
}

// ---------------------------------------------------------------------------
// 默认布局
// ---------------------------------------------------------------------------

/**
 * 初始默认布局（§3.3 保持现有 UX）：
 * - wide/medium/narrow：主组 chat + MAIN_GROUP_ORDER tabs（含 settings，未 defaultClosed 的主组面板）；
 *   team 右分栏，权重 VARIANT_WEIGHTS；context 等默认关闭面板不进入布局；
 * - single：全部未关闭面板（含 team）在同一 group。
 */
export function defaultLayout(variant: DockVariant): DockLayout {
  if (variant === "single") {
    const panels: PanelKey[] = [...MAIN_GROUP_ORDER, "team", "settings"];
    const unique = [...new Set(panels.filter((key) => !PANEL_DEFS[key].defaultClosed))];
    return {
      schema: "deer.dock.layout",
      version: 2,
      variant,
      root: { kind: "group", id: "group-main", panels: unique, active: "chat" },
    };
  }

  const mainWithSettings: PanelKey[] = [...MAIN_GROUP_ORDER, "settings"];
  const mainPanels: PanelKey[] = mainWithSettings.filter(
    (key) => !PANEL_DEFS[key].defaultClosed,
  );
  const weights = VARIANT_WEIGHTS[variant];
  const mainSize = weights.main / (weights.main + weights.team);
  const teamSize = weights.team / (weights.main + weights.team);

  const root: LayoutSplit = {
    kind: "split",
    id: "split-root",
    axis: "horizontal",
    sizes: [
      Math.round(mainSize * 1e6) / 1e6,
      Math.round(teamSize * 1e6) / 1e6,
    ],
    children: [
      { kind: "group", id: "group-main", panels: mainPanels, active: "chat" },
      { kind: "group", id: "group-team", panels: ["team"], active: "team" },
    ],
  };
  return normalizeLayout({ schema: "deer.dock.layout", version: 2, variant, root });
}

/**
 * 按断点/组数生成默认布局（selectVariant 判档；maxGroups 只用于校验上下文，
 * 默认布局本身组数恒 ≤2，天然满足）。
 */
export function defaultLayoutForWidth(
  dockWidth: number,
  windowWidth: number = Number.POSITIVE_INFINITY,
): DockLayout {
  return defaultLayout(selectVariant(dockWidth, windowWidth));
}

// ---------------------------------------------------------------------------
// 布局操作（供 property tests 驱动；DW1-2 的 reducer 将以同语义复用）
// ---------------------------------------------------------------------------

export type SplitDirection = "left" | "right" | "above" | "below";

/** 打开面板：已存在则激活；不存在则插入 anchor 所在组（缺省 active group，尾插），返回新布局。 */
export function openPanelInLayout(
  layout: DockLayout,
  panel: PanelKey,
  anchor?: PanelKey,
): DockLayout {
  const groups = listGroups(layout.root);
  if (groups.some((group) => (group.panels as string[]).includes(panel))) {
    return activatePanelInLayout(layout, panel);
  }
  const next = structuredCloneCompat(layout);
  // t542：anchor 优先（对齐 legacy ensurePanel referencePanel:"chat"）；无 anchor 回 active group。
  const anchorGroup = anchor
    ? groups.find((group) => (group.panels as string[]).includes(anchor))
    : undefined;
  const target =
    (anchorGroup && findGroupOf(next.root, anchorGroup.panels[0])) ||
    findActiveGroup(next.root) ||
    listGroups(next.root)[0];
  target.panels.push(panel);
  target.active = panel;
  return normalizeLayout(next);
}

/** 激活面板（panel 不存在时原样返回）。 */
export function activatePanelInLayout(layout: DockLayout, panel: PanelKey): DockLayout {
  const groups = listGroups(layout.root);
  if (!groups.some((group) => (group.panels as string[]).includes(panel))) return layout;
  const next = structuredCloneCompat(layout);
  const target = findGroupOf(next.root, panel);
  if (target) target.active = panel;
  return next;
}

/**
 * 关闭面板：settings 不可关闭（原样返回）；组空由 normalize 删除；
 * active 关闭后回退到相邻 tab（前一个，否则后一个）。
 */
export function closePanelInLayout(layout: DockLayout, panel: PanelKey): DockLayout {
  if (!PANEL_DEFS[panel].closable) return layout;
  const groups = listGroups(layout.root);
  if (!groups.some((group) => (group.panels as string[]).includes(panel))) return layout;
  const next = structuredCloneCompat(layout);
  const group = findGroupOf(next.root, panel);
  if (!group) return layout;
  const index = group.panels.indexOf(panel);
  group.panels.splice(index, 1);
  if (group.active === panel) {
    group.active = group.panels[Math.max(0, index - 1)] ?? null;
  }
  return normalizeLayout(next);
}

/** 拆分：把 panel 移出到新 group（direction 相对原位置）；超组数时原样返回。 */
export function splitPanelInLayout(
  layout: DockLayout,
  panel: PanelKey,
  direction: SplitDirection,
  maxGroups?: number,
): DockLayout {
  const groups = listGroups(layout.root);
  if (!groups.some((group) => (group.panels as string[]).includes(panel))) return layout;
  if (PANEL_DEFS[panel].closable === false) {
    // settings 允许 split（不可关闭≠不可移动）；照常处理。
  }
  const limit = effectiveMaxDockGroups(maxGroups, layout.variant);
  if (countGroups(layout.root) >= limit) return layout;

  const next = structuredCloneCompat(layout);
  const group = findGroupOf(next.root, panel);
  if (!group || group.panels.length === 0) return layout;
  // 单面板组拆分 = 改造原父 split；为保持简单，这里把 panel 从原组移除并新建兄弟组。
  const index = group.panels.indexOf(panel);
  group.panels.splice(index, 1);
  if (group.active === panel) {
    group.active = group.panels[Math.max(0, index - 1)] ?? null;
  }
  const newGroup: LayoutGroup = {
    kind: "group",
    id: `group-${panel}`,
    panels: [panel],
    active: panel,
  };
  const replaced = replaceGroupWithSplit(next.root, group.id, newGroup, direction);
  if (!replaced) return layout;
  return normalizeLayout(next);
}

function replaceGroupWithSplit(
  node: LayoutNode,
  groupId: string,
  newGroup: LayoutGroup,
  direction: SplitDirection,
): boolean {
  if (node.kind === "group") return false;
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child.kind === "group" && child.id === groupId) {
      const axis: LayoutSplit["axis"] =
        direction === "left" || direction === "right" ? "horizontal" : "vertical";
      const before = direction === "left" || direction === "above";
      const pair: LayoutSplit = {
        kind: "split",
        id: `split-${groupId}-${direction}`,
        axis,
        sizes: [0.5, 0.5],
        children: before ? [newGroup, child] : [child, newGroup],
      };
      node.children[index] = pair;
      return true;
    }
    if (replaceGroupWithSplit(child, groupId, newGroup, direction)) return true;
  }
  return false;
}

/** resize：调整 split 下第 index 个权重 ±delta（0–1 语义），再归一。 */
export function resizeSplitInLayout(
  layout: DockLayout,
  splitId: string,
  index: number,
  delta: number,
): DockLayout {
  const next = structuredCloneCompat(layout);
  const split = findSplit(next.root, splitId);
  if (!split) return layout;
  if (index < 0 || index >= split.sizes.length) return layout;
  const clamped = Number.isFinite(delta) ? Math.min(0.95, Math.max(-0.95, delta)) : 0;
  const before = split.sizes[index];
  const target = Math.min(0.98, Math.max(0.01, before + clamped));
  const residual = target - before;
  // 从其余权重按比例扣除/补回，保持和为 1。
  const others = split.sizes.reduce((total, value, i) => (i === index ? total : total + value), 0);
  if (others <= 0) {
    split.sizes = split.sizes.map((_, i) => (i === index ? target : (1 - target) / (split.sizes.length - 1)));
  } else {
    split.sizes = split.sizes.map((value, i) => {
      if (i === index) return target;
      return Math.max(0.001, value - (residual * value) / others);
    });
  }
  return normalizeLayout(next);
}

/** move：panel 并入 target 所在组（center）；其他 position 由 split 语义处理。 */
export function movePanelInLayout(
  layout: DockLayout,
  panel: PanelKey,
  target: PanelKey,
  position: "center" | SplitDirection,
  maxGroups?: number,
): DockLayout {
  if (panel === target) return layout;
  // t518：开头统一守卫——panel/target 任一不在布局中即返回原 layout（no-op）。
  if (!findGroupOf(layout.root, panel) || !findGroupOf(layout.root, target)) return layout;
  if (position === "center") {
    const next = closePanelFromGroupOnly(structuredCloneCompat(layout), panel);
    const group = findGroupOf(next.root, target) ?? findActiveGroup(next.root);
    if (!group) return layout;
    const index = group.panels.indexOf(target);
    group.panels.splice(index + 1, 0, panel);
    group.active = panel;
    return normalizeLayout(next);
  }
  return splitPanelTargetInLayout(layout, panel, target, position, maxGroups);
}

function splitPanelTargetInLayout(
  layout: DockLayout,
  panel: PanelKey,
  target: PanelKey,
  direction: SplitDirection,
  maxGroups: number | undefined,
): DockLayout {
  const limit = effectiveMaxDockGroups(maxGroups, layout.variant);
  if (countGroups(layout.root) >= limit) return layout;
  const next = closePanelFromGroupOnly(structuredCloneCompat(layout), panel);
  const group = findGroupOf(next.root, target);
  if (!group) return layout;
  const newGroup: LayoutGroup = {
    kind: "group",
    id: `group-${panel}`,
    panels: [panel],
    active: panel,
  };
  const replaced = replaceGroupWithSplit(next.root, group.id, newGroup, direction);
  if (!replaced) {
    // target 组是 root：包一层 split。
    if (next.root.kind === "group" && next.root.id === group.id) {
      const axis: LayoutSplit["axis"] =
        direction === "left" || direction === "right" ? "horizontal" : "vertical";
      const before = direction === "left" || direction === "above";
      next.root = {
        kind: "split",
        id: "split-root",
        axis,
        sizes: [0.5, 0.5],
        children: before ? [newGroup, next.root] : [next.root, newGroup],
      };
      return normalizeLayout(next);
    }
    return layout;
  }
  return normalizeLayout(next);
}

/** 只从原组移除（不触发空组清理——normalize 稍后统一处理）。 */
function closePanelFromGroupOnly(layout: DockLayout, panel: PanelKey): DockLayout {
  // settings「不可关闭」指用户关闭操作；move/split 属重排，允许（t518 注释明确）。
  const group = findGroupOf(layout.root, panel);
  if (!group) return layout;
  const index = group.panels.indexOf(panel);
  group.panels.splice(index, 1);
  if (group.active === panel) {
    group.active = group.panels[Math.max(0, index - 1)] ?? null;
  }
  return layout;
}

// ---------------------------------------------------------------------------
// 内部查找
// ---------------------------------------------------------------------------

function findActiveGroup(node: LayoutNode): LayoutGroup | null {
  if (node.kind === "group") return node;
  for (const child of node.children) {
    const found = findActiveGroup(child);
    if (found) return found;
  }
  return null;
}

function findGroupOf(node: LayoutNode, panel: PanelKey): LayoutGroup | null {
  if (node.kind === "group") {
    return (node.panels as string[]).includes(panel) ? node : null;
  }
  for (const child of node.children) {
    const found = findGroupOf(child, panel);
    if (found) return found;
  }
  return null;
}

function findSplit(node: LayoutNode, splitId: string): LayoutSplit | null {
  if (node.kind === "group") return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplit(child, splitId);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function structuredCloneCompat<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 结构等价（忽略 id 的持久化差异时的比较；比较 kind/panels/active/axis/sizes）。 */
export function layoutEquivalent(a: LayoutNode, b: LayoutNode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "group" && b.kind === "group") {
    return (
      a.panels.join("|") === b.panels.join("|") &&
      (a.active ?? "") === (b.active ?? "")
    );
  }
  if (a.kind === "split" && b.kind === "split") {
    return (
      a.axis === b.axis &&
      a.sizes.length === b.sizes.length &&
      a.sizes.every((size, index) => Math.abs(size - b.sizes[index]) < 1e-6) &&
      a.children.length === b.children.length &&
      a.children.every((child, index) => layoutEquivalent(child, b.children[index]))
    );
  }
  return false;
}
