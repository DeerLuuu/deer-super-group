import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { Agent, Task, TaskStatus } from "./shared/types";
import { TASK_STATUS_LABEL } from "./shared/copy";
import EmptyState from "./EmptyState";
import Modal from "./Modal";

/**
 * 星图第二轮重设计（t46，采纳 S01–S08/S10–S12，依据 docs/team/starmap-decisions.md）：
 * - S01 默认视觉基线：小圆点/圆环节点 + 细线 + 深色底 + 状态颜色×形状双编码；
 * - S02 确定性自然聚类布局：分层 DAG 坐标为种子 + 确定性力模拟（无随机源，纯函数可复现）；
 * - S03 缩放渐进标签 LOD（<0.55 仅点 / 0.55–0.9 标题 / ≥0.9 完整标签，同屏 ≤24）；
 * - S04 单击浮窗 + 双击会话（非模态 popover，Esc 关闭保留选中）；
 * - S05 hover/键盘焦点 1 跳邻居高亮（dim 不 hide）；
 * - S06 Local Focus 1–3 跳（范围外 dim、面包屑退出、还原进入前视口）；
 * - S07 过滤/搜索 + 视图状态条（dim 默认，「只看」hide 并报隐藏任务/依赖边/跨边界数）；
 * - S08 图模型单一事实源（buildGraph 纯函数，dependsOn 唯一依赖边，owner 归属二级虚线、默认关）；
 * - S10 首访引导 + 稀疏/空图双态 + 「?」帮助面板（复用 Modal）；
 * - S11 键盘可达性基线（节点 button、Enter/Ctrl+Enter、方向键平移、+/−/0、aria-live、focus-visible）；
 * - S12 镜头模型（任务更新不 auto-fit、视口+过滤按工作区持久化、只读读数）。
 * 未采纳项（S09 分组切换/S13 拖拽/S14 性能分级/S15 关联区/S16 图层注册表）未实现。
 */

// ---------- 可调常量（S03/S12：标签阈值与布局参数集中一处） ----------
const LOD_TITLE = 0.55;
const LOD_FULL = 0.9;
const MAX_LABELS = 24;
const DOT_MIN = 6;
const DOT_MAX = 14;
const LINK_DISTANCE = 170;
const LEVEL_X = 200;
const REPULSION = 26000;
const FORCE_ITERATIONS = 240;
const SEED_X_GAP = 320;
const SEED_Y_GAP = 150;
const SEED_PAD = 170;
const OWNER_BAND_GAP = 240;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.4;
const HOVER_DELAY_MS = 150;
const MAX_FOCUS_DEPTH = 3;

const STATUS_FILTERS: Array<"all" | TaskStatus> = [
  "all",
  "queued",
  "running",
  "review",
  "blocked",
  "ready",
  "done",
  "failed",
  "cancelled",
];

type View = { x: number; y: number; scale: number };

type LayoutNode = {
  task: Task;
  x: number;
  y: number;
  level: number;
};

type OwnerNode = { agent: Agent; x: number; y: number };

type FocusMode = {
  taskId: string;
  depth: number;
  direction: "up" | "down" | "both";
};

type StarFilter = {
  keyword: string;
  status: "all" | TaskStatus;
  hide: boolean;
};

const DEFAULT_FILTER: StarFilter = { keyword: "", status: "all", hide: false };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function taskLevelMap(tasks: Task[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  function levelOf(task: Task): number {
    const cached = levels.get(task.id);
    if (cached !== undefined) return cached;
    if (visiting.has(task.id)) return 0;
    visiting.add(task.id);
    let level = 0;
    for (const dependencyId of task.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency) level = Math.max(level, levelOf(dependency) + 1);
    }
    visiting.delete(task.id);
    levels.set(task.id, level);
    return level;
  }
  for (const task of tasks) levelOf(task);
  return levels;
}

/**
 * S02 确定性力导向布局：以分层 DAG 坐标为种子，叠加成对斥力 + 依赖连线弹簧 +
 * 依赖深度 x 软约束 + 质心回收。全流程无随机源，是任务集合的纯函数：
 * 同一输入永远得到同一坐标（刷新/事件刷新不跳变），依赖方向仍大致沿 x 正向可读。
 */
function computeLayout(tasks: Task[], levels: Map<string, number>): LayoutNode[] {
  const groups = new Map<number, Task[]>();
  for (const task of tasks) {
    const level = levels.get(task.id) ?? 0;
    const group = groups.get(level) ?? [];
    group.push(task);
    groups.set(level, group);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [level, group] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    group.forEach((task, index) => {
      pos.set(task.id, {
        x: SEED_PAD + level * SEED_X_GAP,
        y: SEED_PAD + (index - (group.length - 1) / 2) * SEED_Y_GAP,
      });
    });
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const links: Array<[string, string]> = [];
  const missingDependencyIds = new Set<string>();
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      if (byId.has(dependencyId)) links.push([dependencyId, task.id]);
      else missingDependencyIds.add(dependencyId);
    }
  }

  const ids = tasks.map((task) => task.id);
  const levelTarget = (id: string) => SEED_PAD + (levels.get(id) ?? 0) * LEVEL_X;
  const force = new Map<string, { fx: number; fy: number }>();

  for (let iter = 0; iter < FORCE_ITERATIONS; iter++) {
    const alpha = 1 - iter / FORCE_ITERATIONS;
    for (const id of ids) force.set(id, { fx: 0, fy: 0 });

    // 成对斥力（确定性：重叠时按索引方向分离）
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i])!;
        const b = pos.get(ids[j])!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 36) {
          dx = 6;
          dy = ((i * 7 + j * 13) % 11) - 5;
          d2 = 36;
        }
        const d = Math.sqrt(d2) || 1;
        const f = REPULSION / d2;
        const ux = dx / d;
        const uy = dy / d;
        force.get(ids[i])!.fx -= f * ux;
        force.get(ids[i])!.fy -= f * uy;
        force.get(ids[j])!.fx += f * ux;
        force.get(ids[j])!.fy += f * uy;
      }
    }

    // 依赖连线弹簧：拉向 LINK_DISTANCE
    for (const [fromId, toId] of links) {
      const a = pos.get(fromId)!;
      const b = pos.get(toId)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const delta = (d - LINK_DISTANCE) * 0.08;
      const ux = dx / d;
      const uy = dy / d;
      force.get(fromId)!.fx += delta * ux;
      force.get(fromId)!.fy += delta * uy;
      force.get(toId)!.fx -= delta * ux;
      force.get(toId)!.fy -= delta * uy;
    }

    // 质心回收 + 依赖深度 x 软约束（保留 DAG 左→右语义）
    for (const id of ids) {
      const p = pos.get(id)!;
      const f = force.get(id)!;
      const gx = (levelTarget(id) - p.x) * 0.05 - p.x * 0.002;
      const gy = -p.y * 0.006;
      p.x += clamp((f.fx + gx) * alpha, -16, 16);
      p.y += clamp((f.fy + gy) * alpha, -16, 16);
    }
  }

  return tasks
    .map((task) => ({
      task,
      x: pos.get(task.id)!.x,
      y: pos.get(task.id)!.y,
      level: levels.get(task.id) ?? 0,
    }))
    .sort(
      (a, b) =>
        a.level - b.level ||
        a.task.createdAt.localeCompare(b.task.createdAt) ||
        a.task.id.localeCompare(b.task.id),
    );
}

/** S08 图模型单一事实源：nodes/edges 唯一来自 tasks 的 dependsOn。（导出供单测校验） */
export type GraphModel = {
  layout: LayoutNode[];
  nodeById: Map<string, LayoutNode>;
  levels: Map<string, number>;
  upstream: Map<string, string[]>;
  downstream: Map<string, string[]>;
  degree: Map<string, number>;
  /** 指向不存在任务的依赖 id（只计数，不补假节点）。 */
  issues: { missingDependencyIds: number };
};

export function buildGraph(tasks: Task[]): GraphModel {
  const levels = taskLevelMap(tasks);
  const layout = computeLayout(tasks, levels);
  const nodeById = new Map(layout.map((node) => [node.task.id, node]));
  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  const degree = new Map<string, number>();
  const missing = new Set<string>();
  for (const task of tasks) {
    upstream.set(task.id, []);
    downstream.set(task.id, []);
    degree.set(task.id, 0);
  }
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      if (!nodeById.has(dependencyId)) {
        missing.add(dependencyId);
        continue;
      }
      upstream.get(task.id)!.push(dependencyId);
      downstream.get(dependencyId)!.push(task.id);
      degree.set(dependencyId, (degree.get(dependencyId) ?? 0) + 1);
      degree.set(task.id, (degree.get(task.id) ?? 0) + 1);
    }
  }
  return {
    layout,
    nodeById,
    levels,
    upstream,
    downstream,
    degree,
    issues: { missingDependencyIds: missing.size },
  };
}

/** S06：从 taskId 出发按方向收集 ≤depth 跳的可达集合。 */
function reachable(
  taskId: string,
  depth: number,
  direction: "up" | "down" | "both",
  upstream: Map<string, string[]>,
  downstream: Map<string, string[]>,
): Set<string> {
  const result = new Set<string>([taskId]);
  let frontier = [taskId];
  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      const neighbors =
        direction === "up"
          ? upstream.get(id) ?? []
          : direction === "down"
            ? downstream.get(id) ?? []
            : [...(upstream.get(id) ?? []), ...(downstream.get(id) ?? [])];
      for (const neighbor of neighbors) {
        if (!result.has(neighbor)) {
          result.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return result;
}

const STATUS_LEGEND: Array<TaskStatus> = [
  "running",
  "queued",
  "review",
  "blocked",
  "ready",
  "done",
  "failed",
  "cancelled",
];

export default function TaskStarMap({
  tasks,
  agents,
  selectedTaskId,
  focus,
  workspaceId,
  memberFilterId,
  onSelect,
  onOpen,
  onOpenTaskPage,
  onFilterMember,
}: {
  tasks: Task[];
  agents: Agent[];
  selectedTaskId: string | null;
  /** C14：外部「在星图中定位」请求；nonce 变化即重新居中同一节点。 */
  focus: { taskId: string; nonce: number } | null;
  /** S12：视口/过滤按工作区持久化。 */
  workspaceId: string;
  /** TeamDashboard 成员过滤（S07 视图状态条展示）。 */
  memberFilterId: string | null;
  onSelect: (task: Task) => void;
  onOpen: (task: Task) => void;
  onOpenTaskPage: (task: Task) => void;
  onFilterMember: (memberId: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 });
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // S05：hover / 键盘焦点邻域高亮（防抖）。
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  // S04：单击浮窗。
  const [popoverTaskId, setPopoverTaskId] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const popoverTriggerRef = useRef<HTMLElement | null>(null);

  // S06：局部聚焦。
  const [focusMode, setFocusMode] = useState<FocusMode | null>(null);
  const preFocusViewRef = useRef<View | null>(null);

  // S07：过滤/搜索。
  const [filter, setFilter] = useState<StarFilter>(DEFAULT_FILTER);

  // S08：归属图层（默认关）。
  const [ownership, setOwnership] = useState(false);

  // S10：图例 / 帮助。

  const [legendOpen, setLegendOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // S11：aria-live 播报。
  const [announcement, setAnnouncement] = useState("");

  // S12：初始化与「布局已更新」提示。
  // 集成修复 IF-02（t48）：初始化按工作区记录（原为一次性 didInitRef），
  // 否则切换工作区时仍沿用旧视口/过滤，并把旧视口写进新工作区的存档。
  const initializedWorkspaceRef = useRef<string | null>(null);
  const fittedIdsRef = useRef<string | null>(null);
  const [layoutStale, setLayoutStale] = useState(false);

  // S08：图模型单一事实源（内容键驱动 memo：同内容刷新零重算）。
  const modelKey = useMemo(
    () =>
      tasks
        .map((task) => `${task.id}:${task.dependsOn.join(",")}:${task.createdAt}`)
        .join("|"),
    [tasks],
  );
  const model = useMemo(
    () => buildGraph(tasks),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelKey],
  );
  const nodeById = model.nodeById;
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  // S08：归属视图的 owner 节点（下缘成员带，不移动任务坐标）。
  const ownerNodes = useMemo<OwnerNode[]>(() => {
    if (!ownership) return [];
    const ownersWithTasks = agents.filter((agent) =>
      tasks.some((task) => task.ownerId === agent.id),
    );
    if (ownersWithTasks.length === 0) return [];
    const xs = model.layout.map((node) => node.x);
    const maxY = Math.max(...model.layout.map((node) => node.y));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const spread = Math.max(maxX - minX, 320);
    return ownersWithTasks.map((agent, index) => ({
      agent,
      x: minX + (spread * (index + 0.5)) / ownersWithTasks.length,
      y: maxY + OWNER_BAND_GAP,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownership, agents, modelKey]);

  const worldBounds = useMemo(() => {
    const xs = model.layout.map((node) => node.x);
    const ys = model.layout.map((node) => node.y);
    for (const owner of ownerNodes) {
      xs.push(owner.x);
      ys.push(owner.y + 40);
    }
    const minX = xs.length ? Math.min(...xs) - SEED_PAD : 0;
    const minY = ys.length ? Math.min(...ys) - SEED_PAD : 0;
    const maxX = xs.length ? Math.max(...xs) + SEED_PAD : 640;
    const maxY = ys.length ? Math.max(...ys) + SEED_PAD : 420;
    return {
      x: minX,
      y: minY,
      width: Math.max(640, maxX - minX),
      height: Math.max(420, maxY - minY),
    };
  }, [model.layout, ownerNodes]);

  const worldWidth = worldBounds.width;
  const worldHeight = worldBounds.height;

  // ---------- S07：过滤匹配 ----------
  const keyword = filter.keyword.trim().toLowerCase();
  const matchFilter = useCallback(
    (task: Task) => {
      const statusOk = filter.status === "all" || task.status === filter.status;
      if (!statusOk) return false;
      if (!keyword) return true;
      const ownerName = task.ownerId
        ? (agentById.get(task.ownerId)?.name ?? "").toLowerCase()
        : "";
      return (
        task.title.toLowerCase().includes(keyword) ||
        task.id.toLowerCase().includes(keyword) ||
        ownerName.includes(keyword)
      );
    },
    [filter.status, keyword, agentById],
  );

  const filteredOut = useMemo(
    () => tasks.filter((task) => !matchFilter(task)),
    [tasks, matchFilter],
  );
  const hiddenTasks = filter.hide ? filteredOut.length : 0;
  const hiddenStats = useMemo(() => {
    if (!filter.hide) return { edges: 0, cross: 0 };
    const hiddenSet = new Set(filteredOut.map((task) => task.id));
    let edges = 0;
    let cross = 0;
    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        const a = hiddenSet.has(task.id);
        const b = hiddenSet.has(dep);
        if (a && b) edges += 1;
        else if (a !== b) cross += 1;
      }
    }
    return { edges, cross };
  }, [filter.hide, filteredOut, tasks]);

  // ---------- S06：聚焦范围 ----------
  const focusSet = useMemo(() => {
    if (!focusMode) return null;
    return reachable(
      focusMode.taskId,
      focusMode.depth,
      focusMode.direction,
      model.upstream,
      model.downstream,
    );
  }, [focusMode, model]);

  // ---------- S05：邻域高亮集合 ----------
  const neighborSet = useMemo(() => {
    if (!highlightId) return null;
    const set = new Set<string>([highlightId]);
    for (const id of model.upstream.get(highlightId) ?? []) set.add(id);
    for (const id of model.downstream.get(highlightId) ?? []) set.add(id);
    return set;
  }, [highlightId, model]);

  // ---------- 视口 ----------
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const fitView = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const scale = clamp(
      Math.min((rect.width - 72) / worldWidth, (rect.height - 72) / worldHeight),
      MIN_SCALE,
      1.05,
    );
    const next = {
      x: (rect.width - worldWidth * scale) / 2 - worldBounds.x * scale,
      y: (rect.height - worldHeight * scale) / 2 - worldBounds.y * scale,
      scale,
    };
    viewRef.current = next;
    setView(next);
    fittedIdsRef.current = modelKey;
    setLayoutStale(false);
  }, [worldWidth, worldHeight, worldBounds.x, worldBounds.y, modelKey]);

  // S12：挂载/切换工作区初始化——恢复该工作区持久化的视口/过滤，或首次适应；任务更新不 auto-fit。
  useEffect(() => {
    if (initializedWorkspaceRef.current === workspaceId) return;
    initializedWorkspaceRef.current = workspaceId;
    try {
      const savedRaw = localStorage.getItem(`deer.starmap.view.${workspaceId}`);
      if (savedRaw) {
        const saved = JSON.parse(savedRaw) as {
          view?: Partial<View>;
          filter?: Partial<StarFilter>;
          ownership?: boolean;
        };
        if (saved.view && Number.isFinite(saved.view.x) && Number.isFinite(saved.view.y)) {
          const restored: View = {
            x: Number(saved.view.x),
            y: Number(saved.view.y),
            scale: clamp(Number(saved.view.scale ?? 1), MIN_SCALE, MAX_SCALE),
          };
          viewRef.current = restored;
          setView(restored);
        } else {
          fitView();
        }
        if (saved.filter) {
          setFilter({
            keyword: typeof saved.filter.keyword === "string" ? saved.filter.keyword : "",
            status:
              saved.filter.status && STATUS_FILTERS.includes(saved.filter.status)
                ? saved.filter.status
                : "all",
            hide: Boolean(saved.filter.hide),
          });
        } else {
          setFilter(DEFAULT_FILTER);
        }
        if (typeof saved.ownership === "boolean") setOwnership(saved.ownership);
        else setOwnership(false);
        fittedIdsRef.current = modelKey;
        setLayoutStale(false);
      } else {
        setFilter(DEFAULT_FILTER);
        setOwnership(false);
        fitView();
      }
    } catch {
      fitView();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // S12：任务集合变化 → 不自动 fit，提示「布局已更新」。
  useEffect(() => {
    if (initializedWorkspaceRef.current !== workspaceId) return;
    if (fittedIdsRef.current !== null && fittedIdsRef.current !== modelKey) {
      setLayoutStale(true);
    }
  }, [modelKey, workspaceId]);

  // S12：视口/过滤/图层持久化（按工作区，不保存节点坐标）。
  useEffect(() => {
    if (initializedWorkspaceRef.current !== workspaceId) return;
    try {
      localStorage.setItem(
        `deer.starmap.view.${workspaceId}`,
        JSON.stringify({ view, filter, ownership }),
      );
    } catch {
      /* 忽略配额错误 */
    }
  }, [view, filter, ownership, workspaceId]);

  // S11：aria-live 播报聚焦/过滤状态。
  useEffect(() => {
    if (focusMode) {
      const title = nodeById.get(focusMode.taskId)?.task.title ?? focusMode.taskId;
      setAnnouncement(
        `已聚焦 ${title} 的 ${focusMode.depth} 跳邻域，共 ${focusSet?.size ?? 1} 个任务`,
      );
    } else if (keyword || filter.status !== "all") {
      setAnnouncement(
        `过滤后显示 ${tasks.length - filteredOut.length} / ${tasks.length} 个任务`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMode?.taskId, focusMode?.depth, filter.status, keyword]);

  // 容器尺寸（浮窗钳制用；S12：容器 resize 不再自动 fit）。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // C14 修复：focus 优先于挂载期 fitView。
  const appliedFocusNonceRef = useRef<number>(-1);

  // C14：外部定位请求 → 双 rAF 后居中该节点。
  useEffect(() => {
    if (!focus) return;
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      appliedFocusNonceRef.current = focus.nonce;
      const node = nodeById.get(focus.taskId);
      const element = containerRef.current;
      if (!node || !element) return;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const scale = clamp(viewRef.current.scale, 0.9, 1.4);
      const next = {
        x: rect.width / 2 - node.x * scale,
        y: rect.height / 2 - node.y * scale,
        scale,
      };
      viewRef.current = next;
      setView(next);
    };
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(apply);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, focus?.taskId]);

  // 滚轮缩放（绕指针）。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const rect = element!.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const current = viewRef.current;
      const nextScale = clamp(
        current.scale * (event.deltaY < 0 ? 1.12 : 0.89),
        MIN_SCALE,
        MAX_SCALE,
      );
      const worldX = (px - current.x) / current.scale;
      const worldY = (py - current.y) / current.scale;
      const next = {
        x: px - worldX * nextScale,
        y: py - worldY * nextScale,
        scale: nextScale,
      };
      viewRef.current = next;
      setView(next);
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  function zoomBy(factor: number) {
    const element = containerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const px = rect.width / 2;
    const py = rect.height / 2;
    const current = viewRef.current;
    const nextScale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
    const worldX = (px - current.x) / current.scale;
    const worldY = (py - current.y) / current.scale;
    const next = {
      x: px - worldX * nextScale,
      y: py - worldY * nextScale,
      scale: nextScale,
    };
    viewRef.current = next;
    setView(next);
  }

  function panBy(dx: number, dy: number) {
    const next = { ...viewRef.current, x: viewRef.current.x + dx, y: viewRef.current.y + dy };
    viewRef.current = next;
    setView(next);
  }

  function centerOn(taskId: string) {
    const node = nodeById.get(taskId);
    const element = containerRef.current;
    if (!node || !element) return;
    const rect = element.getBoundingClientRect();
    const scale = clamp(viewRef.current.scale, 0.9, 1.4);
    const next = {
      x: rect.width / 2 - node.x * scale,
      y: rect.height / 2 - node.y * scale,
      scale,
    };
    viewRef.current = next;
    setView(next);
  }

  // ---------- 交互 ----------
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if (
      (event.target as HTMLElement).closest(
        "[data-star-node], .star-popover, .star-guide, .star-controls, .star-legend, .modal, .modal-backdrop, button, input, select, textarea, a, [role='dialog']",
      )
    ) {
      return;
    }
    // 集成修复 IF-01（t48）：S04 与 bb-47 要求「点击空白关闭浮窗」，原实现只有 Esc/动作会关闭。
    // 空白按下（即将开始平移）时关闭浮窗，不抢焦点；选中态保留。
    if (legendOpen) setLegendOpen(false);
    if (popoverTaskId) closePopover(false);
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: viewRef.current.x,
      originY: viewRef.current.y,
    };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const next = {
      ...viewRef.current,
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    };
    viewRef.current = next;
    setView(next);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  // S05：hover 邻域高亮（防抖 150ms）。
  function scheduleHighlight(taskId: string | null) {
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    if (taskId === null) {
      setHighlightId(null);
      return;
    }
    hoverTimerRef.current = window.setTimeout(
      () => setHighlightId(taskId),
      HOVER_DELAY_MS,
    );
  }

  // S04：单击选中 + 打开浮窗。
  function openPopover(task: Task, trigger: HTMLElement) {
    popoverTriggerRef.current = trigger;
    setPopoverTaskId(task.id);
  }

  function closePopover(restoreFocus = true) {
    setPopoverTaskId(null);
    if (restoreFocus) popoverTriggerRef.current?.focus?.();
  }

  // S04：浮窗打开后聚焦首个动作。
  useEffect(() => {
    if (!popoverTaskId) return;
    const node = popoverRef.current?.querySelector<HTMLElement>("button");
    node?.focus();
  }, [popoverTaskId]);

  // S06：进入/退出局部聚焦。
  function enterFocusMode(taskId: string) {
    preFocusViewRef.current = viewRef.current;
    setFocusMode({ taskId, depth: 1, direction: "both" });
    closePopover(false);
  }

  function exitFocusMode() {
    setFocusMode(null);
    const restore = preFocusViewRef.current;
    if (restore) {
      viewRef.current = restore;
      setView(restore);
      preFocusViewRef.current = null;
    }
  }

  // S11：画布键盘——方向键平移（Shift 加速）、+/−/0 缩放、Esc 逐级退出。
  function onCanvasKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 120 : 40;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        panBy(step, 0);
        break;
      case "ArrowRight":
        event.preventDefault();
        panBy(-step, 0);
        break;
      case "ArrowUp":
        event.preventDefault();
        panBy(0, step);
        break;
      case "ArrowDown":
        event.preventDefault();
        panBy(0, -step);
        break;
      case "+":
      case "=":
        event.preventDefault();
        zoomBy(1.18);
        break;
      case "-":
        event.preventDefault();
        zoomBy(0.85);
        break;
      case "0":
        event.preventDefault();
        fitView();
        break;
      case "Escape":
        if (legendOpen) {
          event.preventDefault();
          setLegendOpen(false);
        } else if (popoverTaskId) {
          event.preventDefault();
          closePopover();
        } else if (focusMode) {
          event.preventDefault();
          exitFocusMode();
        } else if (highlightId) {
          setHighlightId(null);
        }
        break;
      default:
        break;
    }
  }

  // ---------- 渲染推导 ----------
  // S03：LOD 档位与标签集合（≤24，优先级 selected > hover/focus > failed/blocked > 度数）。
  const lod = view.scale < LOD_TITLE ? 1 : view.scale < LOD_FULL ? 2 : 3;
  const labelIds = useMemo(() => {
    const forced = new Set<string>();
    if (selectedTaskId) forced.add(selectedTaskId);
    if (highlightId) forced.add(highlightId);
    if (focusMode) forced.add(focusMode.taskId);
    const cap = Math.max(MAX_LABELS, forced.size);
    const sorted = [...model.layout].sort((a, b) => {
      const rank = (node: LayoutNode) => {
        const status = node.task.status;
        const priority =
          status === "failed" || status === "blocked"
            ? 2
            : status === "running" || status === "review"
              ? 1
              : 0;
        return priority * 100 + (model.degree.get(node.task.id) ?? 0);
      };
      return rank(b) - rank(a);
    });
    const set = new Set(forced);
    for (const node of sorted) {
      if (set.size >= cap) break;
      set.add(node.task.id);
    }
    return set;
  }, [selectedTaskId, highlightId, focusMode, model]);

  const popoverNode = popoverTaskId ? nodeById.get(popoverTaskId) : null;
  const popoverPos = popoverNode
    ? (() => {
        const sx = view.x + popoverNode.x * view.scale;
        const sy = view.y + popoverNode.y * view.scale;
        const width = 264;
        const left = clamp(sx + 14, 8, Math.max(8, size.w - width - 8));
        const top = clamp(sy - 20, 8, Math.max(8, size.h - 260));
        return { left, top, width };
      })()
    : null;

  const memberFilterName = memberFilterId
    ? (agentById.get(memberFilterId)?.name ?? null)
    : null;
  const filterActive = Boolean(keyword) || filter.status !== "all";
  const visibleCount = tasks.length - filteredOut.length;
  const showArrows = view.scale >= 1;
  const sparse = tasks.length > 0 && tasks.length <= 3;

  function nodeClassName(task: Task): string {
    const classes = ["star-dot", `status-${task.status}`];
    if (task.id === selectedTaskId) classes.push("selected");
    if (highlightId && neighborSet && !neighborSet.has(task.id)) classes.push("dim");
    if (!matchFilter(task)) classes.push(filter.hide ? "hidden" : "dim");
    if (focusMode && focusSet && !focusSet.has(task.id)) classes.push("dim");
    if (focusMode && focusMode.taskId === task.id) classes.push("focus-origin");
    if (highlightId === task.id) classes.push("hl-center");
    return classes.join(" ");
  }

  function edgeClassName(fromTask: Task, toTask: Task): string {
    const classes = ["star-edge"];
    if (fromTask.status === "done") classes.push("done");
    const fromHighlighted = !highlightId || neighborSet?.has(fromTask.id);
    const toHighlighted = !highlightId || neighborSet?.has(toTask.id);
    if (highlightId && !(fromHighlighted && toHighlighted)) classes.push("dim");
    const fromMatch = matchFilter(fromTask);
    const toMatch = matchFilter(toTask);
    if (filter.hide && !(fromMatch && toMatch)) classes.push("hidden");
    else if (!fromMatch || !toMatch) classes.push("dim");
    if (focusMode && focusSet) {
      if (!(focusSet.has(fromTask.id) && focusSet.has(toTask.id))) classes.push("dim");
    }
    return classes.join(" ");
  }

  function radiusOf(taskId: string): number {
    return DOT_MIN + Math.min(DOT_MAX - DOT_MIN, model.degree.get(taskId) ?? 0);
  }

  function labelTier(taskId: string): 1 | 2 | 3 {
    if (
      taskId === selectedTaskId ||
      taskId === highlightId ||
      taskId === focusMode?.taskId
    ) {
      return 3;
    }
    return lod as 1 | 2 | 3;
  }

  return (
    <div
      ref={containerRef}
      className={`star-map ${panning ? "panning" : ""}`}
      tabIndex={0}
      role="application"
      aria-label={`任务星图，${visibleCount} 个任务${filterActive ? `（已过滤，共 ${tasks.length} 个）` : ""}`}
      style={{
        backgroundPosition: `${view.x}px ${view.y}px`,
        backgroundSize: `${28 * view.scale}px ${28 * view.scale}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onCanvasKeyDown}
    >
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
      >
        {announcement}
      </div>

      {/* S07：视图状态条 */}
      <div className="star-toolbar" onPointerDown={(event) => event.stopPropagation()}>
        {focusMode ? (
          <div className="star-focusbar">
            <span className="ellipsis">
              全部任务 › 聚焦：{nodeById.get(focusMode.taskId)?.task.title ?? focusMode.taskId}
              {" · "}
              {focusMode.direction === "up"
                ? "上游"
                : focusMode.direction === "down"
                  ? "下游"
                  : "双向"}{" "}
              {focusMode.depth} 跳 · {focusSet?.size ?? 1}/{tasks.length}
            </span>
            <button
              type="button"
              className="ghost tiny"
              onClick={() =>
                setFocusMode((mode) =>
                  mode ? { ...mode, depth: Math.max(1, mode.depth - 1) } : mode,
                )
              }
              disabled={focusMode.depth <= 1}
              title="减少跳数"
            >
              −跳
            </button>
            <button
              type="button"
              className="ghost tiny"
              onClick={() =>
                setFocusMode((mode) =>
                  mode
                    ? { ...mode, depth: Math.min(MAX_FOCUS_DEPTH, mode.depth + 1) }
                    : mode,
                )
              }
              disabled={focusMode.depth >= MAX_FOCUS_DEPTH}
              title="增加跳数"
            >
              +跳
            </button>
            <button
              type="button"
              className="ghost tiny"
              onClick={() =>
                setFocusMode((mode) =>
                  mode
                    ? {
                        ...mode,
                        direction:
                          mode.direction === "both"
                            ? "up"
                            : mode.direction === "up"
                              ? "down"
                              : "both",
                      }
                    : mode,
                )
              }
              title="切换 上游/下游/双向"
            >
              {focusMode.direction === "both"
                ? "双向"
                : focusMode.direction === "up"
                  ? "上游"
                  : "下游"}
            </button>
            <button type="button" className="ghost tiny" onClick={exitFocusMode}>
              退出(Esc)
            </button>
          </div>
        ) : (
          <div className="star-filterbar">
            <input
              className="star-filter-input"
              value={filter.keyword}
              onChange={(event) => setFilter((f) => ({ ...f, keyword: event.target.value }))}
              placeholder="搜索标题 / ID / 负责人"
              aria-label="搜索星图任务"
            />
            <select
              className="star-filter-select"
              value={filter.status}
              onChange={(event) =>
                setFilter((f) => ({
                  ...f,
                  status: event.target.value as "all" | TaskStatus,
                }))
              }
              aria-label="按状态过滤"
            >
              {STATUS_FILTERS.map((status) => (
                <option key={status} value={status}>
                  {status === "all" ? "全部状态" : TASK_STATUS_LABEL[status]}
                </option>
              ))}
            </select>
            <label className="check star-filter-hide">
              <input
                type="checkbox"
                checked={filter.hide}
                onChange={(event) => setFilter((f) => ({ ...f, hide: event.target.checked }))}
              />
              只看
            </label>
            {memberFilterName && (
              <button
                type="button"
                className="chip active"
                onClick={() => onFilterMember(null)}
                title="清除成员过滤"
              >
                成员：{memberFilterName} ×
              </button>
            )}
            {filterActive && (
              <button
                type="button"
                className="chip"
                onClick={() => setFilter(DEFAULT_FILTER)}
              >
                清除全部
              </button>
            )}
            {hiddenTasks > 0 && (
              <span className="muted tiny star-hidden-note">
                已隐藏 {hiddenTasks} 个任务 / {hiddenStats.edges} 条依赖边
                {hiddenStats.cross > 0 ? ` / ${hiddenStats.cross} 条跨边界` : ""}
              </span>
            )}
            {model.issues.missingDependencyIds > 0 && (
              <span
                className="muted tiny star-hidden-note"
                title="依赖指向不存在的任务，仅计数、不补假节点"
              >
                {model.issues.missingDependencyIds} 条依赖缺失端点
              </span>
            )}
          </div>
        )}
      </div>

      <div
        className="star-world"
        style={{
          width: worldWidth,
          height: worldHeight,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        <svg
          className={`star-edges ${showArrows ? "show-arrows" : ""}`}
          width={worldWidth}
          height={worldHeight}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="star-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {model.layout.map((toNode) =>
            (model.upstream.get(toNode.task.id) ?? []).map((fromId) => {
              const fromNode = nodeById.get(fromId);
              if (!fromNode) return null;
              return (
                <line
                  key={`${fromId}->${toNode.task.id}`}
                  className={edgeClassName(fromNode.task, toNode.task)}
                  x1={fromNode.x}
                  y1={fromNode.y}
                  x2={toNode.x}
                  y2={toNode.y}
                  markerEnd={showArrows ? "url(#star-arrow)" : undefined}
                />
              );
            }),
          )}
          {/* S08：归属边（虚线无箭头，二级关系，不参与依赖语义） */}
          {ownership &&
            ownerNodes.map((owner) =>
              model.layout
                .filter((node) => node.task.ownerId === owner.agent.id)
                .map((node) => (
                  <line
                    key={`owns:${owner.agent.id}:${node.task.id}`}
                    className="star-edge owns"
                    x1={owner.x}
                    y1={owner.y}
                    x2={node.x}
                    y2={node.y}
                  />
                )),
            )}
        </svg>

        {/* S01/S03/S11：小圆点节点（button，键盘可达）+ LOD 标签 */}
        {model.layout.map((node) => {
          const task = node.task;
          if (filter.hide && !matchFilter(task)) return null;
          const owner = task.ownerId ? agentById.get(task.ownerId) : null;
          const r = radiusOf(task.id);
          const tier = labelTier(task.id);
          const showLabel = tier >= 2 && labelIds.has(task.id);
          return (
            <button
              key={task.id}
              type="button"
              data-star-node
              className={nodeClassName(task)}
              style={{ left: node.x - r, top: node.y - r, width: r * 2, height: r * 2 }}
              onClick={(event) => {
                onSelect(task);
                openPopover(task, event.currentTarget);
              }}
              onDoubleClick={() => {
                closePopover(false);
                onOpen(task);
              }}
              onMouseEnter={() => scheduleHighlight(task.id)}
              onMouseLeave={() => scheduleHighlight(null)}
              onFocus={() => scheduleHighlight(task.id)}
              onBlur={() => scheduleHighlight(null)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  closePopover(false);
                  onOpen(task);
                }
              }}
              aria-label={`${task.title}，${TASK_STATUS_LABEL[task.status]}，${
                owner ? owner.name : "未分配"
              }，${(model.upstream.get(task.id) ?? []).length} 个上游、${
                (model.downstream.get(task.id) ?? []).length
              } 个下游`}
            >
              {showLabel && (
                <span className={`star-label tier-${tier}`} aria-hidden="true">
                  <span className="star-label-title ellipsis">
                    {task.title.length > 12 && tier === 2
                      ? `${task.title.slice(0, 12)}…`
                      : task.title}
                  </span>
                  {tier === 3 && (
                    <span className="star-label-meta">
                      {TASK_STATUS_LABEL[task.status]} · {owner ? owner.name : "未分配"}
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}

        {/* S08：归属视图 owner 节点（下缘成员带；点击 = 成员过滤） */}
        {ownership &&
          ownerNodes.map((owner) => (
            <button
              key={owner.agent.id}
              type="button"
              data-star-node
              className={`star-owner-hub ${
                memberFilterId === owner.agent.id ? "selected" : ""
              }`}
              style={{ left: owner.x - 16, top: owner.y - 16 }}
              onClick={() => onFilterMember(owner.agent.id)}
              title={`${owner.agent.name} 的任务（点击过滤）`}
            >
              {owner.agent.name.slice(0, 1).toUpperCase()}
            </button>
          ))}
      </div>

      {/* S04：单击浮窗（非模态，Esc 关闭保留选中） */}
      {popoverNode && popoverPos && (
        <div
          ref={popoverRef}
          className="star-popover"
          role="dialog"
          aria-modal={false}
          aria-label={`任务概述：${popoverNode.task.title}`}
          style={{ left: popoverPos.left, top: popoverPos.top, width: popoverPos.width }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closePopover();
            }
          }}
        >
          <div className="star-popover-head">
            <span className={`status status-${popoverNode.task.status}`}>
              {TASK_STATUS_LABEL[popoverNode.task.status]}
            </span>
            <strong className="ellipsis">{popoverNode.task.title}</strong>
          </div>
          <div className="star-popover-meta muted tiny">
            {popoverNode.task.ownerId
              ? (agentById.get(popoverNode.task.ownerId)?.name ?? "未分配")
              : "未分配"}
            {" · 上游 "}
            {(model.upstream.get(popoverNode.task.id) ?? []).length}
            {" / 下游 "}
            {(model.downstream.get(popoverNode.task.id) ?? []).length}
            {" · "}
            <span className="mono">{popoverNode.task.id}</span>
          </div>
          {popoverNode.task.description && (
            <p className="star-popover-desc muted">
              {popoverNode.task.description.slice(0, 96)}
              {popoverNode.task.description.length > 96 ? "…" : ""}
            </p>
          )}
          <div className="star-popover-actions">
            <button
              type="button"
              className="primary tiny"
              onClick={() => {
                closePopover(false);
                onOpen(popoverNode.task);
              }}
            >
              打开会话
            </button>
            <button
              type="button"
              className="ghost tiny"
              onClick={() => {
                closePopover(false);
                onOpenTaskPage(popoverNode.task);
              }}
            >
              在任务页打开
            </button>
            <button
              type="button"
              className="ghost tiny"
              onClick={() => centerOn(popoverNode.task.id)}
            >
              居中
            </button>
            <button
              type="button"
              className="ghost tiny"
              onClick={() => enterFocusMode(popoverNode.task.id)}
            >
              聚焦
            </button>
            <button
              type="button"
              className="ghost tiny"
              onClick={() => {
                void navigator.clipboard?.writeText(popoverNode.task.id).catch(() => {});
              }}
              title="复制任务 ID"
            >
              复制 ID
            </button>
          </div>
        </div>
      )}

      {/* S10：空图 / 稀疏图 / 过滤为空 */}
      {tasks.length === 0 ? (
        <div className="star-empty">
          <EmptyState
            compact
            icon="✦"
            title="还没有任务"
            description="到「任务」页用「规划任务」或「+ 新建」创建后，这里会出现任务星图。"
          />
        </div>
      ) : visibleCount === 0 ? (
        <div className="star-empty">
          <EmptyState
            compact
            icon="◎"
            title="当前过滤下没有任务"
            description="换个关键词或状态，或清除全部过滤条件。"
            actions={[
              {
                label: "清除过滤",
                onClick: () => setFilter(DEFAULT_FILTER),
                primary: true,
              },
            ]}
          />
        </div>
      ) : (
        sparse &&
        !ownership && (
          <div className="star-sparse">
            <span className="muted tiny">任务较少——开启「归属」可查看成员聚类（虚线为归属，不是依赖）</span>
            <button
              type="button"
              className="ghost tiny"
              onClick={() => setOwnership(true)}
            >
              开启归属视图
            </button>
          </div>
        )
      )}

      {/* S10/S08：常驻图例（可折叠） */}
      <div
        className="star-legend"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="ghost tiny star-legend-toggle"
          onClick={() => setLegendOpen((open) => !open)}
          aria-expanded={legendOpen}
          aria-controls="star-legend-panel"
          aria-haspopup="dialog"
        >
          图例
        </button>
        {legendOpen && (
          <div
            id="star-legend-panel"
            className="star-legend-body"
            role="dialog"
            aria-label="星图图例"
          >
            <div className="muted tiny">
              <span className="legend-line legend-dep">——</span> 依赖（箭头=方向） ·{" "}
              <span className="legend-line legend-own">- - -</span> 归属（二级）
            </div>
            <div className="muted tiny">节点大小 = 连接数 · 颜色/形状 = 状态</div>
            <div className="star-legend-status">
              {STATUS_LEGEND.map((status) => (
                <span key={status} className="muted tiny">
                  <i className={`legend-dot status-${status}`} /> {TASK_STATUS_LABEL[status]}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 控制条（S12：只读读数） */}
      <div className="star-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" className="ghost tiny" onClick={() => zoomBy(1.18)} title="放大（+）">
          +
        </button>
        <span className="star-zoom" title="缩放 / 可见节点 / 依赖边">
          {Math.round(view.scale * 100)}% · {visibleCount} 点 ·{" "}
          {tasks.reduce((sum, task) => sum + (model.upstream.get(task.id)?.length ?? 0), 0)} 边
        </span>
        <button type="button" className="ghost tiny" onClick={() => zoomBy(0.85)} title="缩小（−）">
          −
        </button>
        <button type="button" className="ghost tiny" onClick={fitView} title="适应画布（0）">
          适应
        </button>
        <button
          type="button"
          className={`ghost tiny ${ownership ? "primary" : ""}`}
          onClick={() => setOwnership((open) => !open)}
          title="归属视图：成员 hub + 虚线归属边（不参与依赖语义）"
          aria-pressed={ownership}
        >
          归属
        </button>
        <button
          type="button"
          className="ghost tiny"
          onClick={() => setHelpOpen(true)}
          title="星图帮助"
        >
          ?
        </button>
      </div>

      {layoutStale && (
        <button
          type="button"
          className="ghost tiny star-stale-fit"
          onClick={fitView}
          onPointerDown={(event) => event.stopPropagation()}
        >
          布局已更新 · 适应
        </button>
      )}

      <div className="star-hint">
        拖动空白平移 · 滚轮缩放 · 单击浮窗 · 双击会话 · Tab 键盘浏览 · Esc 退出聚焦
      </div>

      {/* S10：帮助面板（复用 C25 Modal） */}
      {helpOpen && (
        <Modal
          title="星图帮助"
          description="手势、快捷键与图例速查"
          onClose={() => setHelpOpen(false)}
        >
          <div className="star-help">
            <div className="section-label">手势与快捷键</div>
            <table className="model-table">
              <tbody>
                <tr>
                  <td>单击节点</td>
                  <td>打开任务概述浮窗</td>
                </tr>
                <tr>
                  <td>双击 / Ctrl+Enter</td>
                  <td>打开任务会话（对话页，可返回团队）</td>
                </tr>
                <tr>
                  <td>悬停 / Tab 聚焦</td>
                  <td>高亮 1 跳上下游邻居</td>
                </tr>
                <tr>
                  <td>滚轮 · 拖空白</td>
                  <td>缩放 · 平移</td>
                </tr>
                <tr>
                  <td>+ / − / 0</td>
                  <td>放大 / 缩小 / 适应</td>
                </tr>
                <tr>
                  <td>方向键（Shift 加速）</td>
                  <td>平移画布</td>
                </tr>
                <tr>
                  <td>Esc</td>
                  <td>关浮窗 → 退出聚焦（逐级）</td>
                </tr>
              </tbody>
            </table>
            <div className="section-label">图例</div>
            <ul className="muted tiny">
              <li>
                <span className="legend-line legend-dep">——</span> 实线 = 依赖（dependsOn，唯一依赖边来源；箭头=方向）
              </li>
              <li>
                <span className="legend-line legend-own">- - -</span> 虚线 = 归属（owner 二级关系，默认关，不参与依赖语义）
              </li>
              <li>节点大小 = 连接数（上下游总数）</li>
              <li>颜色/形状 = 任务状态（同任务页/进度条语义 token）</li>
            </ul>
            <div className="modal-foot">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setFilter(DEFAULT_FILTER);
                  setFocusMode(null);
                  setOwnership(false);
                  fitView();
                }}
              >
                恢复默认视图
              </button>
              <button type="button" className="primary" onClick={() => setHelpOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
