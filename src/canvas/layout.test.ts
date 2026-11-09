import { describe, expect, it } from "vitest";
import type { DeerCanvas } from "../shared/interactive.js";
import {
  NODE_SIZE,
  computeCanvasLayout,
  fitView,
  nodeDegrees,
  nodeScreenAnchor,
  oneHopNeighbors,
  placeDetailPosition,
} from "./layout.js";

/**
 * t64：确定性布局单测（设计 §13.3 / AC-02/04/06）。
 */

function flowchart(direction: "TB" | "LR" = "TB"): DeerCanvas {
  return {
    protocol: "deer-canvas",
    version: 1,
    kind: "flowchart",
    title: "流程",
    direction,
    nodes: [
      { id: "a", label: "A", kind: "step", status: "done" },
      { id: "b", label: "B", kind: "step", status: "active" },
      { id: "c", label: "C", kind: "decision", status: "planned" },
      { id: "d", label: "D", kind: "step", status: "planned" },
    ],
    edges: [
      { id: "e1", from: "a", to: "b", kind: "flow" },
      { id: "e2", from: "b", to: "c", kind: "flow" },
      { id: "e3", from: "c", to: "d", kind: "flow" },
      { id: "e4", from: "a", to: "c", kind: "relates" },
    ],
    groups: [],
  };
}

function dependency(): DeerCanvas {
  return {
    protocol: "deer-canvas",
    version: 1,
    kind: "dependency",
    title: "依赖",
    direction: "LR",
    nodes: [
      { id: "t1", label: "设计", kind: "task", status: "done" },
      { id: "t2", label: "实现", kind: "task", status: "active" },
      { id: "t3", label: "评审", kind: "task", status: "planned" },
      { id: "ship", label: "交付", kind: "milestone", status: "planned" },
    ],
    edges: [
      { id: "e1", from: "t1", to: "t2", kind: "depends" },
      { id: "e2", from: "t2", to: "t3", kind: "depends" },
      { id: "e3", from: "t3", to: "ship", kind: "depends" },
    ],
    groups: [],
  };
}

function mindmap(): DeerCanvas {
  return {
    protocol: "deer-canvas",
    version: 1,
    kind: "mindmap",
    title: "导图",
    nodes: [
      { id: "root", label: "根", kind: "root", status: "active" },
      { id: "t1", label: "分支 1", kind: "topic", status: "planned" },
      { id: "t2", label: "分支 2", kind: "topic", status: "planned" },
      { id: "t3", label: "分支 3", kind: "topic", status: "planned" },
      { id: "t4", label: "分支 4", kind: "topic", status: "planned" },
      { id: "t5", label: "分支 5", kind: "topic", status: "planned" },
      { id: "t6", label: "分支 6", kind: "topic", status: "planned" },
      { id: "leaf1", label: "叶子 1", kind: "note", status: "planned" },
      { id: "leaf2", label: "叶子 2", kind: "note", status: "planned" },
    ],
    edges: [
      { id: "e1", from: "root", to: "t1", kind: "contains" },
      { id: "e2", from: "root", to: "t2", kind: "contains" },
      { id: "e3", from: "root", to: "t3", kind: "contains" },
      { id: "e4", from: "root", to: "t4", kind: "contains" },
      { id: "e5", from: "root", to: "t5", kind: "contains" },
      { id: "e6", from: "root", to: "t6", kind: "contains" },
      { id: "e7", from: "t1", to: "leaf1", kind: "contains" },
      { id: "e8", from: "t1", to: "leaf2", kind: "contains" },
    ],
    groups: [],
  };
}

function roadmap(): DeerCanvas {
  return {
    protocol: "deer-canvas",
    version: 1,
    kind: "roadmap",
    title: "路线图",
    direction: "LR",
    nodes: [
      { id: "p1-a", label: "A", kind: "step", status: "done", groupId: "p1", order: 0 },
      { id: "p1-b", label: "B", kind: "step", status: "active", groupId: "p1", order: 1 },
      { id: "p2-a", label: "C", kind: "step", status: "planned", groupId: "p2", order: 0 },
      { id: "p3-a", label: "D", kind: "milestone", status: "planned", groupId: "p3", order: 0 },
      { id: "loose", label: "未分组事项", kind: "step", status: "planned" },
    ],
    edges: [
      { id: "e1", from: "p1-a", to: "p1-b", kind: "flow" },
      { id: "e2", from: "p1-b", to: "p2-a", kind: "flow" },
      { id: "e3", from: "p2-a", to: "p3-a", kind: "flow" },
    ],
    groups: [
      { id: "p3", label: "P3", order: 2 },
      { id: "p1", label: "P1", order: 0 },
      { id: "p2", label: "P2", order: 1 },
      { id: "empty", label: "空分组", order: 9 },
    ],
  };
}

describe("布局确定性（AC-02）", () => {
  it("四类图同输入两次调用坐标/路径完全一致", () => {
    for (const artifact of [flowchart(), dependency(), mindmap(), roadmap()]) {
      const first = computeCanvasLayout(artifact);
      const second = computeCanvasLayout(artifact);
      expect(JSON.stringify(first.nodes.map((node) => [node.x, node.y]))).toBe(
        JSON.stringify(second.nodes.map((node) => [node.x, node.y])),
      );
      expect(JSON.stringify(first.edges.map((edge) => edge.path))).toBe(
        JSON.stringify(second.edges.map((edge) => edge.path)),
      );
    }
  });
});

describe("流程图 / 依赖图分层", () => {
  it("TB 层级向下递增；LR 层级向右递增", () => {
    const tb = computeCanvasLayout(flowchart("TB"));
    const a = tb.nodes.find((node) => node.node.id === "a")!;
    const b = tb.nodes.find((node) => node.node.id === "b")!;
    const c = tb.nodes.find((node) => node.node.id === "c")!;
    expect(a.y).toBeLessThan(b.y);
    expect(b.y).toBeLessThan(c.y);
    expect(a.x).toBe(b.x);

    const lr = computeCanvasLayout(flowchart("LR"));
    const lrA = lr.nodes.find((node) => node.node.id === "a")!;
    const lrB = lr.nodes.find((node) => node.node.id === "b")!;
    expect(lrA.x).toBeLessThan(lrB.x);
    expect(lrA.y).toBe(lrB.y);
  });

  it("relates 边不参与分层，但正常渲染", () => {
    const layout = computeCanvasLayout(flowchart());
    const relates = layout.edges.find((edge) => edge.kind === "relates")!;
    expect(relates.hidden).toBe(false);
    expect(relates.path.length).toBeGreaterThan(0);
  });

  it("依赖图环：终止、标回边、给 W_CYCLE", () => {
    const cyclic: DeerCanvas = {
      ...dependency(),
      nodes: [
        { id: "x", label: "X", kind: "task", status: "active" },
        { id: "y", label: "Y", kind: "task", status: "active" },
      ],
      edges: [
        { id: "e1", from: "x", to: "y", kind: "depends" },
        { id: "e2", from: "y", to: "x", kind: "depends" },
      ],
    };
    const layout = computeCanvasLayout(cyclic);
    expect(layout.warnings).toContain("W_CYCLE");
    expect(layout.edges.some((edge) => edge.back)).toBe(true);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it("分组画成包围盒；折叠分组隐藏成员并保留计数", () => {
    const grouped: DeerCanvas = {
      ...flowchart(),
      groups: [{ id: "g1", label: "阶段一" }],
      nodes: flowchart().nodes.map((node, index) => (index < 2 ? { ...node, groupId: "g1" } : node)),
    };
    const open = computeCanvasLayout(grouped);
    expect(open.groupBoxes).toHaveLength(1);
    expect(open.groupBoxes[0].count).toBe(2);
    const collapsed = computeCanvasLayout(grouped, { collapsedGroups: ["g1"] });
    expect(collapsed.groupBoxes[0].collapsed).toBe(true);
    expect(collapsed.hiddenNodeCount).toBe(2);
    expect(collapsed.hiddenEdgeCount).toBeGreaterThan(0);
    // 折叠只隐藏，不重排其余节点。
    const nodeD = open.nodes.find((node) => node.node.id === "d")!;
    const collapsedD = collapsed.nodes.find((node) => node.node.id === "d")!;
    expect(collapsedD.x).toBe(nodeD.x);
    expect(collapsedD.y).toBe(nodeD.y);
  });
});

describe("思维导图径向布局", () => {
  it("根在中心，子节点分布在不同方向，深度正确", () => {
    const layout = computeCanvasLayout(mindmap());
    const root = layout.nodes.find((node) => node.node.id === "root")!;
    expect(root.x).toBe(-NODE_SIZE.root.w / 2);
    expect(root.y).toBe(-NODE_SIZE.root.h / 2);
    const topics = layout.nodes.filter((node) => node.node.kind === "topic");
    const angles = topics.map((node) => Math.atan2(node.y, node.x).toFixed(2));
    expect(new Set(angles).size).toBeGreaterThan(3);
    expect(topics.every((node) => node.depth === 1)).toBe(true);
    const leaf = layout.nodes.find((node) => node.node.id === "leaf1")!;
    expect(leaf.depth).toBe(2);
  });

  it("折叠分支隐藏后代并计数", () => {
    const layout = computeCanvasLayout(mindmap(), { collapsedBranches: ["t1"] });
    const t1 = layout.nodes.find((node) => node.node.id === "t1")!;
    const leaf = layout.nodes.find((node) => node.node.id === "leaf1")!;
    expect(t1.hidden).toBe(false);
    expect(t1.branchCollapsed).toBe(true);
    expect(t1.hiddenDescendants).toBe(2);
    expect(leaf.hidden).toBe(true);
    expect(layout.hiddenNodeCount).toBe(2);
  });

  it("无根节点给 W_ROOT；不可达节点给 W_UNREACHABLE 且仍可见", () => {
    const source = mindmap();
    const noRoot: DeerCanvas = {
      ...source,
      nodes: source.nodes
        .filter((node) => node.id !== "root")
        .map((node) => ({
          ...node,
          kind: node.id.startsWith("leaf") ? "note" : "topic",
          status: "planned",
        })) as DeerCanvas["nodes"],
      // 保留 t1→leaf 的边：t1 成为回退根，其余 topic 不可达。
      edges: source.edges.filter((edge) => edge.from !== "root" && edge.from !== "t2" && edge.from !== "t3" && edge.from !== "t4" && edge.from !== "t5" && edge.from !== "t6"),
    };
    const layout = computeCanvasLayout(noRoot);
    expect(layout.warnings).toContain("W_ROOT");
    expect(layout.warnings).toContain("W_UNREACHABLE");
    expect(layout.nodes.some((node) => !node.hidden)).toBe(true);
  });

  it("深度超过 4 的节点被截断（W_DENSITY）", () => {
    const nodes: DeerCanvas["nodes"] = [
      { id: "root", label: "根", kind: "root", status: "active" },
    ];
    const edges: DeerCanvas["edges"] = [];
    for (let depth = 1; depth <= 6; depth += 1) {
      nodes.push({
        id: `d${depth}`,
        label: `层 ${depth}`,
        kind: "topic",
        status: "planned",
      });
      edges.push({
        id: `e${depth}`,
        from: depth === 1 ? "root" : `d${depth - 1}`,
        to: `d${depth}`,
        kind: "contains",
      });
    }
    const deep: DeerCanvas = {
      protocol: "deer-canvas",
      version: 1,
      kind: "mindmap",
      title: "深树",
      nodes,
      edges,
      groups: [],
    };
    const layout = computeCanvasLayout(deep);
    const hidden = layout.nodes.filter((node) => node.hidden);
    expect(hidden.length).toBeGreaterThan(0);
    expect(layout.warnings).toContain("W_DENSITY");
  });
});

describe("路线图泳道", () => {
  it("泳道按 order 排序；未分组在末尾；同泳道 x 递增", () => {
    const layout = computeCanvasLayout(roadmap());
    expect(layout.lanes.map((lane) => lane.label)).toEqual(["P1", "P2", "P3", "空分组", "未分组"]);
    const a = layout.nodes.find((node) => node.node.id === "p1-a")!;
    const b = layout.nodes.find((node) => node.node.id === "p1-b")!;
    expect(a.x).toBeLessThan(b.x);
    expect(a.y).toBe(b.y);
    const loose = layout.nodes.find((node) => node.node.id === "loose")!;
    expect(loose.y).toBeGreaterThan(layout.nodes.find((node) => node.node.id === "p3-a")!.y);
  });

  it("空分组给 W_EMPTY_GROUP 并渲染空泳道", () => {
    const layout = computeCanvasLayout(roadmap());
    expect(layout.warnings).toContain("W_EMPTY_GROUP");
    const empty = layout.lanes.find((lane) => lane.label === "空分组")!;
    expect(empty.count).toBe(0);
  });

  it("折叠泳道隐藏其中节点，其他泳道坐标不变", () => {
    const open = computeCanvasLayout(roadmap());
    const collapsed = computeCanvasLayout(roadmap(), { collapsedGroups: ["p1"] });
    expect(collapsed.hiddenNodeCount).toBe(2);
    const cOpen = open.nodes.find((node) => node.node.id === "p2-a")!;
    const cCollapsed = collapsed.nodes.find((node) => node.node.id === "p2-a")!;
    expect(cCollapsed.x).toBe(cOpen.x);
    expect(cCollapsed.y).toBe(cOpen.y);
    const lane = collapsed.lanes.find((item) => item.id === "p1")!;
    expect(lane.collapsed).toBe(true);
  });
});

describe("bounds / fitView / 邻域", () => {
  it("bounds 包含全部可见节点并留出 padding", () => {
    for (const artifact of [flowchart(), dependency(), roadmap(), mindmap()]) {
      const layout = computeCanvasLayout(artifact);
      for (const node of layout.nodes.filter((item) => !item.hidden)) {
        expect(node.x).toBeGreaterThanOrEqual(layout.bounds.minX);
        expect(node.y).toBeGreaterThanOrEqual(layout.bounds.minY);
        expect(node.x + node.w).toBeLessThanOrEqual(layout.bounds.maxX);
        expect(node.y + node.h).toBeLessThanOrEqual(layout.bounds.maxY);
      }
    }
  });

  it("fitView 居中并按 maxScale 收敛", () => {
    const fit = fitView(
      { minX: -100, minY: -100, maxX: 300, maxY: 200, width: 400, height: 300 },
      { w: 800, h: 600 },
    );
    expect(fit.scale).toBe(1.4);
    expect(fit.x).toBe(260);
    expect(fit.y).toBe(230);
  });

  it("fitView 对超大图收敛到 minScale", () => {
    const fit = fitView(
      { minX: 0, minY: 0, maxX: 10000, maxY: 8000, width: 10000, height: 8000 },
      { w: 800, h: 600 },
    );
    expect(fit.scale).toBe(0.3);
  });

  it("1 跳邻域与出入度", () => {
    const artifact = flowchart();
    expect(Array.from(oneHopNeighbors(artifact, "b")).sort()).toEqual(["a", "b", "c"]);
    expect(nodeDegrees(artifact, "b")).toEqual({ incoming: 1, outgoing: 1 });
  });

  it("80 节点布局可完成且确定（性能 smoke）", () => {
    const nodes = Array.from({ length: 80 }, (_, index) => ({
      id: `n${index}`,
      label: `节点 ${index}`,
      kind: "step" as const,
      status: "planned" as const,
    }));
    const edges = Array.from({ length: 79 }, (_, index) => ({
      id: `e${index}`,
      from: `n${index}`,
      to: `n${index + 1}`,
      kind: "flow" as const,
    }));
    const big: DeerCanvas = {
      protocol: "deer-canvas",
      version: 1,
      kind: "flowchart",
      title: "大图",
      nodes,
      edges,
      groups: [],
    };
    const started = performance.now();
    const first = computeCanvasLayout(big);
    const elapsed = performance.now() - started;
    expect(first.nodes).toHaveLength(80);
    expect(elapsed).toBeLessThan(1000);
    const second = computeCanvasLayout(big);
    expect(first.nodes.map((node) => node.y)).toEqual(second.nodes.map((node) => node.y));
  });
});

describe("t80 F1：详情浮窗按实测尺寸 clamp/翻转", () => {
  const detail = { w: 280, h: 120 };

  it("节点位于顶部：浮窗在下方且不越界", () => {
    const placement = placeDetailPosition({
      node: { x: 40, y: 20, w: 176, h: 52 },
      view: { x: 0, y: 0, scale: 1 },
      container: { w: 400, h: 300 },
      detail,
    });
    expect(placement.placement).toBe("below");
    expect(placement.top).toBe(84); // 20 + 52 + 12
    expect(placement.left).toBe(40);
    expect(placement.top + detail.h).toBeLessThanOrEqual(300 - 8);
  });

  it("节点位于底部（t66 实测场景）：浮窗翻转到上方且底部动作不被裁剪", () => {
    const placement = placeDetailPosition({
      node: { x: 60, y: 240, w: 176, h: 52 },
      view: { x: 0, y: 0, scale: 1 },
      container: { w: 420, h: 300 },
      detail,
    });
    expect(placement.placement).toBe("above");
    expect(placement.top).toBe(240 - 12 - 120); // 108
    expect(placement.top).toBeGreaterThanOrEqual(8);
    expect(placement.top + detail.h).toBeLessThanOrEqual(300 - 8);
  });

  it("上下都放不下：夹取到可视区（CSS 内部滚动兜底）", () => {
    const placement = placeDetailPosition({
      // 节点本身很高（例如缩放后），上下都没有浮窗空间。
      node: { x: 10, y: 5, w: 176, h: 395 },
      view: { x: 0, y: 0, scale: 1 },
      container: { w: 420, h: 300 },
      detail: { w: 280, h: 200 },
    });
    expect(placement.placement).toBe("below");
    expect(placement.top).toBe(300 - 200 - 8); // 92
    expect(placement.top + 200).toBeLessThanOrEqual(292);
  });

  it("左侧越界被夹取；缩放后按屏幕坐标计算", () => {
    const placement = placeDetailPosition({
      node: { x: 900, y: 20, w: 176, h: 52 },
      view: { x: 0, y: 0, scale: 2 },
      container: { w: 400, h: 300 },
      detail,
    });
    expect(placement.left).toBe(400 - 280 - 8);
    const top = placeDetailPosition({
      node: { x: 90, y: 20, w: 20, h: 20 },
      view: { x: 0, y: 0, scale: 2 },
      container: { w: 400, h: 400 },
      detail,
    });
    // 屏幕底部 = 40*2 = 80；80 + 12 = 92
    expect(top.top).toBe(92);
  });
});

describe("t80 F8：缩放锚点使用选中节点屏幕坐标", () => {
  it("有节点时返回节点中心屏幕坐标；无节点返回 null", () => {
    const node = {
      node: { id: "a", label: "A", kind: "step" as const, status: "planned" as const },
      x: 100,
      y: 50,
      w: 100,
      h: 40,
      depth: 0,
      hidden: false,
      dimmed: false,
      groupId: null,
      children: [],
      hiddenDescendants: 0,
      branchCollapsed: false,
    };
    expect(nodeScreenAnchor(node, { x: 20, y: 10, scale: 2 })).toEqual({ x: 320, y: 150 });
    expect(nodeScreenAnchor(null, { x: 0, y: 0, scale: 1 })).toBeNull();
  });
});
