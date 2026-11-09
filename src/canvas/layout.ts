import type {
  CanvasNodeKind,
  CanvasStatus,
  DeerCanvas,
  DeerCanvasEdge,
  DeerCanvasGroup,
  DeerCanvasNode,
  EdgeKind,
  InteractiveWarningCode,
} from "../shared/interactive.js";

/**
 * t64：交互画布确定性布局（纯函数；设计 §4.4）。
 *
 * 约束：
 * - 不使用 Math.random / Date.now / localeCompare 的非确定实现；
 * - 同输入两次调用逐坐标相等（AC-02）；
 * - 只读 artifact + 折叠状态，不访问 DOM / window / localStorage；
 * - 节点坐标由客户端计算，模型不能提供 x/y/宽高/颜色。
 */

export type Size = { w: number; h: number };

export const NODE_SIZE: Record<CanvasNodeKind, Size> = {
  root: { w: 200, h: 64 },
  topic: { w: 176, h: 52 },
  step: { w: 176, h: 52 },
  task: { w: 176, h: 52 },
  milestone: { w: 140, h: 72 },
  decision: { w: 176, h: 80 },
  note: { w: 176, h: 64 },
  risk: { w: 168, h: 64 },
};

export const LAYOUT_PADDING = 80;
export const LANE_HEIGHT = 140;
export const LANE_GAP = 160;
export const LANE_TITLE_WIDTH = 168;
export const LANE_NODE_START_X = 200;
export const MINDMAP_MAX_DEPTH = 4;

export interface LayoutOptions {
  /** 折叠的分组（路线图泳道 / 流程图分组）。 */
  collapsedGroups?: readonly string[];
  /** 折叠的思维导图分支节点 id（隐藏其全部后代）。 */
  collapsedBranches?: readonly string[];
}

export interface LayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface PositionedNode {
  node: DeerCanvasNode;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 思维导图深度；其他图为 0。 */
  depth: number;
  hidden: boolean;
  /** 1 跳聚焦时被 dim（不是隐藏）。 */
  dimmed: boolean;
  groupId: string | null;
  /** 思维导图子节点（布局稳定顺序）。 */
  children: string[];
  /** 被折叠/深度截断隐藏的直接/全部后代数。 */
  hiddenDescendants: number;
  branchCollapsed: boolean;
}

export interface PositionedEdge {
  edge: DeerCanvasEdge;
  fromId: string;
  toId: string;
  kind: EdgeKind;
  path: string;
  back: boolean;
  hidden: boolean;
}

export interface CanvasLane {
  id: string;
  label: string | null;
  group: DeerCanvasGroup | null;
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
  count: number;
}

export interface CanvasGroupBox {
  group: DeerCanvasGroup;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
  collapsed: boolean;
}

export interface CanvasLayout {
  kind: DeerCanvas["kind"];
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  lanes: CanvasLane[];
  groupBoxes: CanvasGroupBox[];
  bounds: LayoutBounds;
  warnings: InteractiveWarningCode[];
  hiddenNodeCount: number;
  hiddenEdgeCount: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function emptyBounds(): LayoutBounds {
  return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function computeBounds(boxes: Box[], pad: number): LayoutBounds {
  if (boxes.length === 0) return emptyBounds();
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  const padded = {
    minX: round2(minX - pad),
    minY: round2(minY - pad),
    maxX: round2(maxX + pad),
    maxY: round2(maxY + pad),
  };
  return {
    ...padded,
    width: round2(padded.maxX - padded.minX),
    height: round2(padded.maxY - padded.minY),
  };
}

/** 无向邻接的边集合：布局只用 flow/depends/contains，忽略 relates。 */
function layoutEdges(artifact: DeerCanvas): DeerCanvasEdge[] {
  return artifact.edges.filter((edge) => edge.kind !== "relates");
}

function buildAdjacency(
  artifact: DeerCanvas,
  edges: DeerCanvasEdge[],
): { succ: Map<string, DeerCanvasEdge[]>; pred: Map<string, DeerCanvasEdge[]> } {
  const succ = new Map<string, DeerCanvasEdge[]>();
  const pred = new Map<string, DeerCanvasEdge[]>();
  for (const node of artifact.nodes) {
    succ.set(node.id, []);
    pred.set(node.id, []);
  }
  for (const edge of edges) {
    succ.get(edge.from)?.push(edge);
    pred.get(edge.to)?.push(edge);
  }
  return { succ, pred };
}

// ---------------------------------------------------------------------------
// 流程图 / 依赖图：分层（TB / LR）
// ---------------------------------------------------------------------------

interface LayeringResult {
  level: Map<string, number>;
  backEdges: Set<DeerCanvasEdge>;
  /** 拓扑顺序（稳定）。 */
  order: string[];
}

function computeLayering(artifact: DeerCanvas, edges: DeerCanvasEdge[]): LayeringResult {
  const { succ } = buildAdjacency(artifact, edges);
  const state = new Map<string, 0 | 1 | 2>();
  for (const node of artifact.nodes) state.set(node.id, 0);
  const backEdges = new Set<DeerCanvasEdge>();

  const visit = (id: string): void => {
    state.set(id, 1);
    for (const edge of succ.get(id) ?? []) {
      const target = edge.to;
      const targetState = state.get(target) ?? 0;
      if (targetState === 0) visit(target);
      else if (targetState === 1) backEdges.add(edge);
    }
    state.set(id, 2);
  };
  for (const node of artifact.nodes) {
    if ((state.get(node.id) ?? 0) === 0) visit(node.id);
  }

  // Kahn 拓扑（去掉回边后无环），level = 最长路径。
  const indegree = new Map<string, number>();
  for (const node of artifact.nodes) indegree.set(node.id, 0);
  for (const edge of edges) {
    if (backEdges.has(edge)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const level = new Map<string, number>();
  for (const node of artifact.nodes) level.set(node.id, 0);
  const queue: string[] = [];
  for (const node of artifact.nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) queue.push(node.id);
  }
  const order: string[] = [];
  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor];
    cursor += 1;
    order.push(id);
    for (const edge of succ.get(id) ?? []) {
      if (backEdges.has(edge)) continue;
      const nextLevel = Math.max(level.get(edge.to) ?? 0, (level.get(id) ?? 0) + 1);
      level.set(edge.to, nextLevel);
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }
  // 防御：若仍有节点未进入 order（不应发生，回边已移除），按数组顺序补入 level=0。
  for (const node of artifact.nodes) {
    if (!order.includes(node.id)) order.push(node.id);
  }
  return { level, backEdges, order };
}

function edgePath(
  from: Box,
  to: Box,
  direction: "TB" | "LR",
  back: boolean,
): string {
  if (direction === "TB") {
    const x1 = from.x + from.w / 2;
    const y1 = from.y + from.h;
    const x2 = to.x + to.w / 2;
    const y2 = to.y;
    if (back) {
      const offset = 70;
      return `M ${round2(x1)} ${round2(y1)} C ${round2(x1 - offset)} ${round2(y1 + 50)}, ${round2(x2 - offset)} ${round2(y2 - 50)}, ${round2(x2)} ${round2(y2)}`;
    }
    const bend = Math.max(36, Math.abs(y2 - y1) / 2.4);
    return `M ${round2(x1)} ${round2(y1)} C ${round2(x1)} ${round2(y1 + bend)}, ${round2(x2)} ${round2(y2 - bend)}, ${round2(x2)} ${round2(y2)}`;
  }
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  if (back) {
    const offset = 70;
    return `M ${round2(x1)} ${round2(y1)} C ${round2(x1 + 50)} ${round2(y1 - offset)}, ${round2(x2 - 50)} ${round2(y2 - offset)}, ${round2(x2)} ${round2(y2)}`;
  }
  const bend = Math.max(38, Math.abs(x2 - x1) / 2.4);
  return `M ${round2(x1)} ${round2(y1)} C ${round2(x1 + bend)} ${round2(y1)}, ${round2(x2 - bend)} ${round2(y2)}, ${round2(x2)} ${round2(y2)}`;
}

function layeredLayout(
  artifact: DeerCanvas,
  direction: "TB" | "LR",
  options: LayoutOptions,
): {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  groupBoxes: CanvasGroupBox[];
  warnings: InteractiveWarningCode[];
  bounds: LayoutBounds;
  hiddenNodeCount: number;
  hiddenEdgeCount: number;
} {
  const edgesForLayout = layoutEdges(artifact);
  const { level, backEdges } = computeLayering(artifact, edgesForLayout);
  const warnings: InteractiveWarningCode[] = [];
  if (backEdges.size > 0) warnings.push("W_CYCLE");

  const grouped = new Set(options.collapsedGroups ?? []);
  const groupIds = new Set(artifact.groups.map((group) => group.id));
  const levels = new Map<number, DeerCanvasNode[]>();
  for (const node of artifact.nodes) {
    const nodeLevel = level.get(node.id) ?? 0;
    const bucket = levels.get(nodeLevel) ?? [];
    bucket.push(node);
    levels.set(nodeLevel, bucket);
  }
  const levelKeys = Array.from(levels.keys()).sort((a, b) => a - b);

  const positions = new Map<string, PositionedNode>();
  for (const levelKey of levelKeys) {
    const bucket = levels.get(levelKey) ?? [];
    const sizes = bucket.map((node) => NODE_SIZE[node.kind]);
    const rowHeight = Math.max(...sizes.map((size) => size.h));
    const columnWidth = Math.max(...sizes.map((size) => size.w));
    bucket.forEach((node, index) => {
      const size = NODE_SIZE[node.kind];
      const x =
        direction === "TB"
          ? 60 + index * 220
          : 80 + levelKey * 230 + (columnWidth - size.w) / 2;
      const y =
        direction === "TB"
          ? 80 + levelKey * 150 + (rowHeight - size.h) / 2
          : 60 + index * 110;
      const hidden = Boolean(node.groupId && grouped.has(node.groupId));
      positions.set(node.id, {
        node,
        x: round2(x),
        y: round2(y),
        w: size.w,
        h: size.h,
        depth: 0,
        hidden,
        dimmed: false,
        groupId: node.groupId ?? null,
        children: [],
        hiddenDescendants: 0,
        branchCollapsed: false,
      });
    });
  }

  const nodes = artifact.nodes.map((node) => positions.get(node.id)!);
  const visible = nodes.filter((node) => !node.hidden);
  const edges: PositionedEdge[] = artifact.edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const hidden = !from || !to || from.hidden || to.hidden;
    const fromBox = from ?? { x: 0, y: 0, w: 0, h: 0 };
    const toBox = to ?? { x: 0, y: 0, w: 0, h: 0 };
    return {
      edge,
      fromId: edge.from,
      toId: edge.to,
      kind: edge.kind,
      back: backEdges.has(edge),
      hidden,
      path: hidden ? "" : edgePath(fromBox, toBox, direction, backEdges.has(edge)),
    };
  });

  const groupBoxes: CanvasGroupBox[] = [];
  for (const group of artifact.groups) {
    const allMembers = nodes.filter((node) => node.groupId === group.id);
    if (allMembers.length === 0) {
      warnings.push("W_EMPTY_GROUP");
      continue;
    }
    const collapsed = grouped.has(group.id);
    const members = collapsed ? allMembers : allMembers.filter((node) => !node.hidden);
    groupBoxes.push({ ...makeGroupBox(group, members), count: allMembers.length, collapsed });
  }
  // 无分组的节点不进入 groupBoxes（画布直接展示）。

  const boxes: Box[] = [
    ...visible.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h })),
    ...groupBoxes.map((box) => ({ x: box.x, y: box.y, w: box.w, h: box.h })),
  ];
  const hiddenNodeCount = nodes.filter((node) => node.hidden).length;
  const hiddenEdgeCount = edges.filter((edge) => edge.hidden).length;
  return {
    nodes,
    edges,
    groupBoxes,
    warnings: Array.from(new Set(warnings)),
    bounds: computeBounds(boxes, LAYOUT_PADDING),
    hiddenNodeCount,
    hiddenEdgeCount,
  };
}

function makeGroupBox(group: DeerCanvasGroup, members: PositionedNode[]): CanvasGroupBox {
  const padding = 22;
  const minX = Math.min(...members.map((node) => node.x));
  const minY = Math.min(...members.map((node) => node.y));
  const maxX = Math.max(...members.map((node) => node.x + node.w));
  const maxY = Math.max(...members.map((node) => node.y + node.h));
  return {
    group,
    x: round2(minX - padding),
    y: round2(minY - padding - 18),
    w: round2(Math.max(120, maxX - minX + padding * 2)),
    h: round2(maxY - minY + padding * 2 + 18),
    count: members.length,
    collapsed: false,
  };
}

// ---------------------------------------------------------------------------
// 思维导图：径向树
// ---------------------------------------------------------------------------

const MINDMAP_RADIUS = (depth: number): number =>
  depth === 0 ? 0 : 170 + (depth - 1) * 150;

interface MindmapTree {
  rootId: string;
  children: Map<string, string[]>;
  depth: Map<string, number>;
  order: string[];
  warnings: InteractiveWarningCode[];
}

function buildMindmapTree(artifact: DeerCanvas, edges: DeerCanvasEdge[]): MindmapTree {
  const warnings: InteractiveWarningCode[] = [];
  const { succ } = buildAdjacency(artifact, edges);
  const roots = artifact.nodes.filter((node) => node.kind === "root");
  let rootId = roots[0]?.id ?? artifact.nodes[0]?.id ?? "";
  if (roots.length === 0) warnings.push("W_ROOT");
  if (roots.length > 1) warnings.push("W_ROOT");

  const children = new Map<string, string[]>();
  const depth = new Map<string, number>();
  const order: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = rootId ? [rootId] : [];
  depth.set(rootId, 0);
  visited.add(rootId);
  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor];
    cursor += 1;
    order.push(id);
    const next: string[] = [];
    for (const edge of succ.get(id) ?? []) {
      if (edge.kind === "relates") continue;
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      depth.set(edge.to, (depth.get(id) ?? 0) + 1);
      next.push(edge.to);
      queue.push(edge.to);
    }
    children.set(id, next);
  }
  for (const node of artifact.nodes) {
    if (!visited.has(node.id)) {
      warnings.push("W_UNREACHABLE");
      break;
    }
  }
  for (const [, kids] of children) {
    if (kids.length > 8) {
      warnings.push("W_DENSITY");
      break;
    }
  }
  if (!rootId) warnings.push("W_ROOT");
  return {
    rootId,
    children,
    depth,
    order,
    warnings: Array.from(new Set(warnings)),
  };
}

function mindmapLayout(
  artifact: DeerCanvas,
  options: LayoutOptions,
): {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  warnings: InteractiveWarningCode[];
  bounds: LayoutBounds;
  hiddenNodeCount: number;
  hiddenEdgeCount: number;
} {
  const edgesForTree = layoutEdges(artifact);
  const tree = buildMindmapTree(artifact, edgesForTree);
  const warnings = [...tree.warnings];
  for (const [, depth] of tree.depth) {
    if (depth > MINDMAP_MAX_DEPTH) {
      warnings.push("W_DENSITY");
      break;
    }
  }
  const collapsed = new Set(options.collapsedBranches ?? []);
  const { succ } = buildAdjacency(artifact, edgesForTree);

  const leafCount = new Map<string, number>();
  const computeLeaves = (id: string): number => {
    const cached = leafCount.get(id);
    if (cached !== undefined) return cached;
    const kids = tree.children.get(id) ?? [];
    const count = kids.length === 0 ? 1 : kids.reduce((sum, kid) => sum + computeLeaves(kid), 0);
    leafCount.set(id, count);
    return count;
  };

  // 坐标：按父节点扇区递归分配角度。
  const cx = new Map<string, { x: number; y: number; angle: number }>();
  if (tree.rootId) {
    cx.set(tree.rootId, { x: 0, y: 0, angle: -Math.PI / 2 });
    const place = (parentId: string, sectorStart: number, sectorEnd: number): void => {
      const parent = cx.get(parentId);
      if (!parent) return;
      const kids = tree.children.get(parentId) ?? [];
      if (kids.length === 0) return;
      const total = kids.reduce((sum, kid) => sum + computeLeaves(kid), 0) || 1;
      let start = sectorStart;
      const parentDepth = tree.depth.get(parentId) ?? 0;
      const nextDepth = parentDepth + 1;
      const radius = MINDMAP_RADIUS(nextDepth);
      for (const kid of kids) {
        const span = ((sectorEnd - sectorStart) * computeLeaves(kid)) / total;
        const childStart = start;
        const childEnd = start + span;
        const angle = (childStart + childEnd) / 2;
        const x = radius ? Math.cos(angle) * radius : 0;
        const y = radius ? Math.sin(angle) * radius : 0;
        cx.set(kid, { x: round2(x), y: round2(y), angle });
        place(kid, childStart, childEnd);
        start = childEnd;
      }
    };
    place(tree.rootId, -Math.PI / 2, (3 * Math.PI) / 2);
    // 叶子过少时整圈扩展（避免子节点挤在一侧）。
    const rootKids = tree.children.get(tree.rootId) ?? [];
    if (rootKids.length > 0 && rootKids.length < 6) {
      const radius = MINDMAP_RADIUS(1);
      rootKids.forEach((kid, index) => {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / rootKids.length;
        cx.set(kid, {
          x: round2(Math.cos(angle) * radius),
          y: round2(Math.sin(angle) * radius),
          angle,
        });
        place(kid, angle - Math.PI / rootKids.length, angle + Math.PI / rootKids.length);
      });
    }
  }

  const countHiddenDescendants = (id: string): number => {
    const kids = tree.children.get(id) ?? [];
    let hidden = 0;
    for (const kid of kids) {
      const kidDepth = tree.depth.get(kid) ?? 0;
      if (kidDepth > MINDMAP_MAX_DEPTH || collapsed.has(id)) hidden += 1;
      hidden += countHiddenDescendants(kid);
    }
    return hidden;
  };

  const positions = new Map<string, PositionedNode>();
  for (const node of artifact.nodes) {
    const size = NODE_SIZE[node.kind];
    const center = cx.get(node.id);
    const depth = tree.depth.get(node.id) ?? 0;
    const hidden =
      depth > MINDMAP_MAX_DEPTH || isDescendantOfCollapsed(node.id, tree, collapsed);
    const x = (center?.x ?? 0) - size.w / 2;
    const y = (center?.y ?? 0) - size.h / 2;
    positions.set(node.id, {
      node,
      x: round2(x),
      y: round2(y),
      w: size.w,
      h: size.h,
      depth,
      hidden,
      dimmed: false,
      groupId: node.groupId ?? null,
      children: tree.children.get(node.id) ?? [],
      hiddenDescendants: countHiddenDescendants(node.id),
      branchCollapsed: collapsed.has(node.id),
    });
  }

  // 不可达节点（孤立）单独排在下方的隔离区，仍可见（W_UNREACHABLE）。
  const isolated = artifact.nodes.filter((node) => !tree.depth.has(node.id));
  isolated.forEach((node, index) => {
    const placed = positions.get(node.id);
    if (!placed) return;
    placed.x = round2(-320 + index * 220);
    placed.y = round2(MINDMAP_RADIUS(MINDMAP_MAX_DEPTH) + 260);
    placed.hidden = false;
  });
  if (isolated.length > 0 && !warnings.includes("W_UNREACHABLE")) warnings.push("W_UNREACHABLE");

  const nodes = artifact.nodes.map((node) => positions.get(node.id)!);
  const edges: PositionedEdge[] = artifact.edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const hidden = !from || !to || from.hidden || to.hidden;
    const path =
      hidden || !from || !to
        ? ""
        : `M ${round2(from.x + from.w / 2)} ${round2(from.y + from.h / 2)} L ${round2(to.x + to.w / 2)} ${round2(to.y + to.h / 2)}`;
    return {
      edge,
      fromId: edge.from,
      toId: edge.to,
      kind: edge.kind,
      back: false,
      hidden,
      path,
    };
  });

  const visible = nodes.filter((node) => !node.hidden);
  const bounds = computeBounds(
    visible.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h })),
    LAYOUT_PADDING,
  );
  return {
    nodes,
    edges,
    warnings: Array.from(new Set(warnings)),
    bounds,
    hiddenNodeCount: nodes.filter((node) => node.hidden).length,
    hiddenEdgeCount: edges.filter((edge) => edge.hidden).length,
  };
}

function isDescendantOfCollapsed(
  nodeId: string,
  tree: MindmapTree,
  collapsed: Set<string>,
): boolean {
  if (collapsed.size === 0) return false;
  // 反向查找祖先链。
  const parentOf = new Map<string, string>();
  for (const [parent, kids] of tree.children) {
    for (const kid of kids) parentOf.set(kid, parent);
  }
  let current = parentOf.get(nodeId);
  let guard = 0;
  while (current && guard < 64) {
    if (collapsed.has(current)) return true;
    current = parentOf.get(current);
    guard += 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 路线图：泳道
// ---------------------------------------------------------------------------

function roadmapLayout(
  artifact: DeerCanvas,
  options: LayoutOptions,
): {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  lanes: CanvasLane[];
  warnings: InteractiveWarningCode[];
  bounds: LayoutBounds;
  hiddenNodeCount: number;
  hiddenEdgeCount: number;
} {
  const warnings: InteractiveWarningCode[] = [];
  const grouped = new Set(options.collapsedGroups ?? []);
  const sortedGroups = artifact.groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => {
      const orderA = a.group.order ?? a.index;
      const orderB = b.group.order ?? b.index;
      if (orderA !== orderB) return orderA - orderB;
      return compareIds(a.group.id, b.group.id);
    });
  const groupIds = new Set(sortedGroups.map((item) => item.group.id));
  const ungrouped = artifact.nodes.filter((node) => !node.groupId || !groupIds.has(node.groupId));

  const laneOf = new Map<string, number>();
  const nodesByLane = new Map<number, DeerCanvasNode[]>();
  sortedGroups.forEach((item, laneIndex) => {
    nodesByLane.set(laneIndex, []);
  });
  for (const node of artifact.nodes) {
    if (!node.groupId || !groupIds.has(node.groupId)) continue;
    const laneIndex = sortedGroups.findIndex((item) => item.group.id === node.groupId);
    if (laneIndex < 0) continue;
    laneOf.set(node.id, laneIndex);
  }
  const ungroupedLaneIndex = ungrouped.length > 0 ? sortedGroups.length : -1;
  const positions = new Map<string, PositionedNode>();
  const lanes: CanvasLane[] = [];

  const placeLane = (
    laneIndex: number,
    group: DeerCanvasGroup | null,
    label: string | null,
    laneNodes: DeerCanvasNode[],
  ): void => {
    const collapsed = group ? grouped.has(group.id) : false;
    const laneY = 60 + laneIndex * LANE_GAP;
    const ordered = [...laneNodes].sort((a, b) => {
      const orderA = a.order ?? artifact.nodes.indexOf(a);
      const orderB = b.order ?? artifact.nodes.indexOf(b);
      if (orderA !== orderB) return orderA - orderB;
      return compareIds(a.id, b.id);
    });
    ordered.forEach((node, index) => {
      const size = NODE_SIZE[node.kind];
      positions.set(node.id, {
        node,
        x: round2(LANE_NODE_START_X + index * 220),
        y: round2(laneY + 44),
        w: size.w,
        h: size.h,
        depth: 0,
        hidden: collapsed,
        dimmed: false,
        groupId: group?.id ?? null,
        children: [],
        hiddenDescendants: 0,
        branchCollapsed: false,
      });
    });
    const laneW = Math.max(360, LANE_NODE_START_X + Math.max(1, ordered.length) * 220 + 40);
    lanes.push({
      id: group?.id ?? "__ungrouped",
      label: group?.label ?? label,
      group,
      x: 8,
      y: round2(laneY),
      w: round2(laneW - 8),
      h: LANE_HEIGHT,
      collapsed,
      count: ordered.length,
    });
    if (group && ordered.length === 0 && !collapsed) warnings.push("W_EMPTY_GROUP");
  };

  sortedGroups.forEach((item, laneIndex) => {
    const laneNodes = artifact.nodes.filter((node) => laneOf.get(node.id) === laneIndex);
    placeLane(laneIndex, item.group, item.group.label, laneNodes);
  });
  if (ungroupedLaneIndex >= 0) {
    placeLane(ungroupedLaneIndex, null, "未分组", ungrouped);
  }

  const nodes = artifact.nodes.map((node) => {
    const position = positions.get(node.id);
    if (position) return position;
    const size = NODE_SIZE[node.kind];
    return {
      node,
      x: 200,
      y: 60 + 44,
      w: size.w,
      h: size.h,
      depth: 0,
      hidden: true,
      dimmed: false,
      groupId: node.groupId ?? null,
      children: [],
      hiddenDescendants: 0,
      branchCollapsed: false,
    } satisfies PositionedNode;
  });

  const edges: PositionedEdge[] = artifact.edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const hidden = !from || !to || from.hidden || to.hidden;
    let path = "";
    if (!hidden && from && to) {
      const fromLane = from.groupId ?? "__ungrouped";
      const toLane = to.groupId ?? "__ungrouped";
      const sameLane = fromLane === toLane;
      const x1 = from.x + from.w;
      const y1 = from.y + from.h / 2;
      const x2 = to.x;
      const y2 = to.y + to.h / 2;
      if (sameLane) {
        path = `M ${round2(x1)} ${round2(y1)} C ${round2(x1 + 40)} ${round2(y1 - 34)}, ${round2(x2 - 40)} ${round2(y2 - 34)}, ${round2(x2)} ${round2(y2)}`;
      } else {
        const midY = round2((y1 + y2) / 2);
        path = `M ${round2(x1)} ${round2(y1)} C ${round2(x1 + 60)} ${midY}, ${round2(x2 - 60)} ${midY}, ${round2(x2)} ${round2(y2)}`;
      }
    }
    return {
      edge,
      fromId: edge.from,
      toId: edge.to,
      kind: edge.kind,
      back: false,
      hidden,
      path,
    };
  });

  const boxes: Box[] = [];
  for (const node of nodes) {
    if (!node.hidden) boxes.push({ x: node.x, y: node.y, w: node.w, h: node.h });
  }
  for (const lane of lanes) {
    boxes.push({ x: lane.x, y: lane.y, w: lane.w, h: Math.max(lane.h, 96) });
  }
  return {
    nodes,
    edges,
    lanes,
    warnings: Array.from(new Set(warnings)),
    bounds: computeBounds(boxes, LAYOUT_PADDING),
    hiddenNodeCount: nodes.filter((node) => node.hidden).length,
    hiddenEdgeCount: edges.filter((edge) => edge.hidden).length,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function computeCanvasLayout(
  artifact: DeerCanvas,
  options: LayoutOptions = {},
): CanvasLayout {
  if (artifact.kind === "roadmap") {
    const result = roadmapLayout(artifact, options);
    return {
      kind: artifact.kind,
      nodes: result.nodes,
      edges: result.edges,
      lanes: result.lanes,
      groupBoxes: [],
      bounds: result.bounds,
      warnings: result.warnings,
      hiddenNodeCount: result.hiddenNodeCount,
      hiddenEdgeCount: result.hiddenEdgeCount,
    };
  }
  if (artifact.kind === "mindmap") {
    const result = mindmapLayout(artifact, options);
    return {
      kind: artifact.kind,
      nodes: result.nodes,
      edges: result.edges,
      lanes: [],
      groupBoxes: [],
      bounds: result.bounds,
      warnings: result.warnings,
      hiddenNodeCount: result.hiddenNodeCount,
      hiddenEdgeCount: result.hiddenEdgeCount,
    };
  }
  const direction = artifact.direction ?? "TB";
  const result = layeredLayout(artifact, direction, options);
  return {
    kind: artifact.kind,
    nodes: result.nodes,
    edges: result.edges,
    lanes: [],
    groupBoxes: result.groupBoxes,
    bounds: result.bounds,
    warnings: result.warnings,
    hiddenNodeCount: result.hiddenNodeCount,
    hiddenEdgeCount: result.hiddenEdgeCount,
  };
}

// ---------------------------------------------------------------------------
// 视口
// ---------------------------------------------------------------------------

export interface FitViewport {
  x: number;
  y: number;
  scale: number;
}

export interface FitViewOptions {
  padding?: number;
  minScale?: number;
  maxScale?: number;
}

export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2.2;

export function fitView(
  bounds: LayoutBounds,
  container: { w: number; h: number },
  options: FitViewOptions = {},
): FitViewport {
  const padding = options.padding ?? 48;
  const minScale = options.minScale ?? MIN_SCALE;
  const maxScale = options.maxScale ?? 1.4;
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const availableW = Math.max(32, container.w - padding * 2);
  const availableH = Math.max(32, container.h - padding * 2);
  const raw = Math.min(availableW / width, availableH / height);
  const scale = clamp(Number.isFinite(raw) ? raw : 1, minScale, maxScale);
  return {
    x: round2((container.w - width * scale) / 2 - bounds.minX * scale),
    y: round2((container.h - height * scale) / 2 - bounds.minY * scale),
    scale: round2(scale),
  };
}

/** 1 跳聚焦：返回节点及其直接邻居（所有边类型）。 */
export function oneHopNeighbors(artifact: DeerCanvas, nodeId: string): Set<string> {
  const ids = new Set<string>([nodeId]);
  for (const edge of artifact.edges) {
    if (edge.from === nodeId) ids.add(edge.to);
    if (edge.to === nodeId) ids.add(edge.from);
  }
  return ids;
}

/** 节点入/出度（详情浮窗展示；relates 也计入）。 */
export function nodeDegrees(
  artifact: DeerCanvas,
  nodeId: string,
): { incoming: number; outgoing: number } {
  let incoming = 0;
  let outgoing = 0;
  for (const edge of artifact.edges) {
    if (edge.to === nodeId) incoming += 1;
    if (edge.from === nodeId) outgoing += 1;
  }
  return { incoming, outgoing };
}

// ---------------------------------------------------------------------------
// t80 F1/F8：详情浮窗定位与缩放锚点（纯函数，便于单测）
// ---------------------------------------------------------------------------

export interface ScreenViewport {
  x: number;
  y: number;
  scale: number;
}

/** 节点的屏幕坐标锚点（节点中心）；用于 +/- 缩放以选中节点为锚点（F8）。 */
export function nodeScreenAnchor(
  node: PositionedNode | null | undefined,
  view: ScreenViewport,
): { x: number; y: number } | null {
  if (!node) return null;
  return {
    x: round2(view.x + (node.x + node.w / 2) * view.scale),
    y: round2(view.y + (node.y + node.h / 2) * view.scale),
  };
}

export interface DetailPlacementInput {
  node: Pick<PositionedNode, "x" | "y" | "w" | "h">;
  view: ScreenViewport;
  container: { w: number; h: number };
  detail: { w: number; h: number };
  offset?: number;
  margin?: number;
}

export interface DetailPlacement {
  left: number;
  top: number;
  /** 浮窗位于节点的下方还是上方（F1：底部节点自动翻转）。 */
  placement: "below" | "above";
}

/**
 * 节点详情浮窗定位（F1）：按浮窗**实际尺寸**计算。
 * - 优先在节点下方；下方放不下且上方放得下 → 翻转到上方；
 * - 上下都放不下 → 夹取到可视区（配合 CSS max-height + 内部滚动）；
 * - 左侧夹取，不超出容器。
 */
export function placeDetailPosition(input: DetailPlacementInput): DetailPlacement {
  const offset = input.offset ?? 12;
  const margin = input.margin ?? 8;
  const { node, view, container, detail } = input;
  const nodeLeft = view.x + node.x * view.scale;
  const nodeTop = view.y + node.y * view.scale;
  const nodeBottom = view.y + (node.y + node.h) * view.scale;
  const maxLeft = Math.max(margin, container.w - detail.w - margin);
  const maxTop = Math.max(margin, container.h - detail.h - margin);
  const belowTop = nodeBottom + offset;
  const aboveTop = nodeTop - offset - detail.h;

  let placement: "below" | "above" = "below";
  let top = belowTop;
  if (belowTop > maxTop) {
    if (aboveTop >= margin) {
      placement = "above";
      top = aboveTop;
    } else {
      top = clamp(belowTop, margin, maxTop);
    }
  }
  return {
    left: round2(clamp(nodeLeft, margin, maxLeft)),
    top: round2(clamp(top, margin, maxTop)),
    placement,
  };
}

/** 状态 → CSS 变量名（颜色来自主题 token，不接受模型色值）。 */
export function statusVariable(status: CanvasStatus): string {
  const token =
    status === "planned" ? "ready" : status === "active" ? "running" : status;
  return `--status-${token}`;
}
