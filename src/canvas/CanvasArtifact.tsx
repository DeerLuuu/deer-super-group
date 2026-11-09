import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  CANVAS_KIND_LABEL,
  CANVAS_STATUS_LABEL,
  CANVAS_STATUS_MARK,
  EDGE_KIND_LABEL,
  NODE_KIND_LABEL,
  type CanvasNodeKind,
  type DeerCanvas,
  type DeerCanvasNode,
} from "../shared/interactive";
import {
  MAX_SCALE,
  MIN_SCALE,
  clamp,
  computeCanvasLayout,
  fitView,
  nodeDegrees,
  nodeScreenAnchor,
  oneHopNeighbors,
  placeDetailPosition,
  type CanvasLayout,
  type DetailPlacement,
  type PositionedNode,
} from "./layout";
import {
  CLICK_DETAIL_DELAY_MS,
  createNodeClickState,
  isCanvasOverlayWheelTarget,
  nextEscapeLayer,
  resolveNodeClick,
  type NodeClickState,
} from "./interaction";

/**
 * t64：可缩放/平移/适应/聚焦的画布视口（设计 §4.5/§4.6/§7.8）。
 *
 * 安全：节点/边/文本全部由组件生成，模型只提供白名单语义字段；
 * 不执行 HTML/JS，不使用内联颜色（颜色只来自 status → token）。
 */

const LOD_TITLE = 0.55;
const LOD_FULL = 0.9;
const DETAIL_MAX_WIDTH = 300;

type View = { x: number; y: number; scale: number };

interface DragState {
  active: boolean;
  moved: boolean;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
}

function nodeShapeGeometry(node: DeerCanvasNode, w: number, h: number): ReactNode {
  const inset = Math.min(24, w * 0.14);
  switch (node.kind) {
    case "milestone":
      return (
        <polygon
          points={`${w / 2},1 ${w - 1},${h / 2} ${w / 2},${h - 1} 1,${h / 2}`}
          className="canvas-shape"
        />
      );
    case "decision":
      return (
        <polygon
          points={`${inset},1 ${w - inset},1 ${w - 1},${h / 2} ${w - inset},${h - 1} ${inset},${h - 1} 1,${h / 2}`}
          className="canvas-shape"
        />
      );
    case "risk":
      return (
        <polygon
          points={`14,1 ${w - 14},1 ${w - 1},14 ${w - 14},${h - 1} 14,${h - 1} 1,14`}
          className="canvas-shape"
        />
      );
    case "note":
      return (
        <rect
          x="1"
          y="1"
          width={w - 2}
          height={h - 2}
          rx="10"
          className="canvas-shape canvas-shape-dashed"
        />
      );
    case "root":
      return (
        <>
          <rect x="1" y="1" width={w - 2} height={h - 2} rx="24" className="canvas-shape" />
          <rect
            x="5"
            y="5"
            width={w - 10}
            height={h - 10}
            rx="20"
            className="canvas-shape canvas-shape-inner"
          />
        </>
      );
    default:
      return <rect x="1" y="1" width={w - 2} height={h - 2} rx="10" className="canvas-shape" />;
  }
}

function kindClass(kind: CanvasNodeKind): string {
  return `canvas-node kind-${kind}`;
}

export default function CanvasArtifact({
  artifact,
  height = "clamp(240px, 34vh, 420px)",
  compact = false,
  onVisibleLayoutChange,
}: {
  artifact: DeerCanvas;
  /** 视口高度（CSS 值；放大时由 CanvasCard 传入更大值）。 */
  height?: number | string;
  compact?: boolean;
  /** t80 F7：回传折叠后的可见布局，供 CanvasCard 按可见集导出 Mermaid/SVG。 */
  onVisibleLayoutChange?: (layout: CanvasLayout) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const detailFirstActionRef = useRef<HTMLButtonElement | null>(null);
  const markerId = `arrow-${useId().replace(/[:]/g, "")}`;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [detailSize, setDetailSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [collapsedBranches, setCollapsedBranches] = useState<string[]>([]);
  const [legendOpen, setLegendOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const clickStateRef = useRef<NodeClickState>(createNodeClickState());
  const detailTimerRef = useRef<number | null>(null);
  const dragRef = useRef<DragState>({
    active: false,
    moved: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
  });
  const fittedRef = useRef(false);
  const userInteractedRef = useRef(false);
  const lastBackgroundClickRef = useRef(0);

  const layout = useMemo<CanvasLayout>(
    () => computeCanvasLayout(artifact, { collapsedGroups, collapsedBranches }),
    [artifact, collapsedGroups, collapsedBranches],
  );
  const offsetX = layout.bounds.minX;
  const offsetY = layout.bounds.minY;
  const neighbours = useMemo(
    () => (focusedId ? oneHopNeighbors(artifact, focusedId) : null),
    [artifact, focusedId],
  );

  // t80 F7：折叠状态变化后把可见布局回传给 CanvasCard（导出与所见一致）。
  useEffect(() => {
    onVisibleLayoutChange?.(layout);
  }, [layout, onVisibleLayoutChange]);

  const applyView = useCallback((next: View) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const zoomAt = useCallback(
    (factor: number, anchorX?: number, anchorY?: number) => {
      const current = viewRef.current;
      const px = anchorX ?? size.w / 2;
      const py = anchorY ?? size.h / 2;
      const worldX = (px - current.x) / current.scale;
      const worldY = (py - current.y) / current.scale;
      const nextScale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
      userInteractedRef.current = true;
      applyView({
        scale: nextScale,
        x: px - worldX * nextScale,
        y: py - worldY * nextScale,
      });
    },
    [applyView, size.h, size.w],
  );

  const doFit = useCallback(
    (announce = true) => {
      const next = fitView(layout.bounds, size);
      applyView(next);
      if (announce) setAnnouncement("已适应画布");
    },
    [applyView, layout.bounds, size],
  );

  // 容器尺寸（ResizeObserver 只在浏览器运行；SSR 渲染不触发）。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 首次挂载或容器首次可用时自动 fit；用户交互后不再自动 fit。
  useEffect(() => {
    if (fittedRef.current) return;
    if (size.w === 0 || size.h === 0) return;
    fittedRef.current = true;
    applyView(fitView(layout.bounds, size));
  }, [applyView, layout.bounds, size]);

  // 滚轮缩放（以指针为锚点；非 passive，避免页面滚动）。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      // t80 F10：详情/图例/工具栏内的滚轮不缩放画布，也不阻止其自身滚动。
      if (isCanvasOverlayWheelTarget(event.target as Element | null)) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0015);
      zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // t80 F1：用 ref 测量详情浮窗实际高度（CSS 另有 max-height + 内部滚动兜底）。
  useEffect(() => {
    if (!detailId) return;
    const element = detailRef.current;
    if (!element) return;
    const update = () => {
      setDetailSize({ w: element.offsetWidth, h: element.offsetHeight });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [detailId]);

  // t80 F2：打开详情后把焦点移到首个动作；Tab 可离开（非模态，不圈禁）。
  useEffect(() => {
    if (!detailId) return;
    detailFirstActionRef.current?.focus();
  }, [detailId]);

  useEffect(() => {
    return () => {
      if (detailTimerRef.current !== null) window.clearTimeout(detailTimerRef.current);
    };
  }, []);

  function scheduleDetail(nodeId: string) {
    if (detailTimerRef.current !== null) window.clearTimeout(detailTimerRef.current);
    detailTimerRef.current = window.setTimeout(() => {
      detailTimerRef.current = null;
      const resolution = resolveNodeClick(clickStateRef.current, {
        type: "detail-timer",
        nodeId,
        now: Date.now(),
      });
      clickStateRef.current = resolution.state;
      if (resolution.effects.openDetailNodeId) {
        setDetailId(resolution.effects.openDetailNodeId);
      }
    }, CLICK_DETAIL_DELAY_MS);
  }

  function handleNodeClick(nodeId: string, event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    // 再次单击同一节点：关闭详情并回焦（设计 §4.5 / t80 F2）。
    if (detailId === nodeId) {
      closeDetail();
      setSelectedId(nodeId);
      return;
    }
    const now = Date.now();
    const resolution = resolveNodeClick(clickStateRef.current, {
      type: "click",
      nodeId,
      detail: event.detail,
      now,
    });
    clickStateRef.current = resolution.state;
    const effects = resolution.effects;
    if (effects.selectNodeId !== undefined) setSelectedId(effects.selectNodeId);
    if (effects.toggleFocusNodeId) {
      toggleFocus(effects.toggleFocusNodeId);
      return;
    }
    if (resolution.state.pendingNodeId === nodeId) {
      scheduleDetail(nodeId);
    }
  }

  function toggleFocus(nodeId: string) {
    if (detailTimerRef.current !== null) {
      window.clearTimeout(detailTimerRef.current);
      detailTimerRef.current = null;
    }
    clickStateRef.current = { ...clickStateRef.current, pendingNodeId: null, pendingAt: 0 };
    if (detailId) closeDetail();
    setFocusedId((current) => {
      const next = current === nodeId ? null : nodeId;
      if (next) {
        const count = oneHopNeighbors(artifact, nodeId).size - 1;
        setAnnouncement(`已聚焦：${nodeTitle(nodeId)}，${count} 个邻居`);
      } else {
        setAnnouncement("已退出聚焦");
      }
      return next;
    });
  }

  function nodeTitle(nodeId: string): string {
    return artifact.nodes.find((node) => node.id === nodeId)?.label ?? "节点";
  }

  function openDetail(nodeId: string) {
    if (detailTimerRef.current !== null) {
      window.clearTimeout(detailTimerRef.current);
      detailTimerRef.current = null;
    }
    setSelectedId(nodeId);
    setDetailId(nodeId);
  }

  function closeDetail(restoreFocus = true) {
    const node = detailId;
    setDetailId(null);
    if (restoreFocus && node) {
      const element = containerRef.current?.querySelector<HTMLElement>(
        `[data-node-id="${cssSafe(node)}"]`,
      );
      element?.focus();
    }
  }

  /** t80 F8：+/- 缩放锚点——优先详情节点，其次选中/聚焦节点，最后回退容器中心。 */
  function selectedZoomAnchor(): { x: number; y: number } | null {
    const anchorId = detailId ?? selectedId ?? focusedId;
    if (!anchorId) return null;
    const node = layout.nodes.find((item) => item.node.id === anchorId) ?? null;
    return nodeScreenAnchor(node, viewRef.current);
  }

  function zoomBy(factor: number) {
    const anchor = selectedZoomAnchor();
    zoomAt(factor, anchor?.x, anchor?.y);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const inNode = Boolean(target.closest("[data-node-id]"));
    if (event.key === "Escape") {
      const layer = nextEscapeLayer({
        detailOpen: Boolean(detailId),
        focused: Boolean(focusedId),
        selected: Boolean(selectedId),
      });
      if (layer === "detail") {
        event.preventDefault();
        closeDetail(true);
        return;
      }
      if (layer === "focus") {
        event.preventDefault();
        setFocusedId(null);
        setAnnouncement("已退出聚焦");
        return;
      }
      if (layer === "selection") {
        event.preventDefault();
        setSelectedId(null);
        return;
      }
      return;
    }
    if (inNode) return;
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
        zoomBy(1.2);
        break;
      case "-":
      case "_":
        event.preventDefault();
        zoomBy(1 / 1.2);
        break;
      case "0":
        event.preventDefault();
        userInteractedRef.current = true;
        doFit();
        break;
      default:
        break;
    }
  }

  function panBy(dx: number, dy: number) {
    userInteractedRef.current = true;
    applyView({ ...viewRef.current, x: viewRef.current.x + dx, y: viewRef.current.y + dy });
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, .canvas-detail, .canvas-toolbar, .canvas-legend, .canvas-focusbar")) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      active: true,
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX - rect.left,
      startY: event.clientY - rect.top,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag.active) return;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    const totalX = event.clientX - drag.startX;
    const totalY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(totalX, totalY) > 4) drag.moved = true;
    if (!drag.moved) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    userInteractedRef.current = true;
    applyView({
      ...viewRef.current,
      x: viewRef.current.x + dx,
      y: viewRef.current.y + dy,
    });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const wasActive = drag.active;
    const moved = drag.moved;
    drag.active = false;
    if (!wasActive || moved) return;
    // 空白点击：第一次关闭详情并清除选中；第二次清除聚焦（设计 §4.5）。
    const now = Date.now();
    const second = now - lastBackgroundClickRef.current <= 400;
    lastBackgroundClickRef.current = now;
    if (detailId) {
      closeDetail();
      setSelectedId(null);
      return;
    }
    if (second && focusedId) {
      setFocusedId(null);
      setAnnouncement("已退出聚焦");
      return;
    }
    setSelectedId(null);
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) =>
      current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId],
    );
    const group = artifact.groups.find((item) => item.id === groupId);
    setAnnouncement(
      collapsedGroups.includes(groupId)
        ? `已展开分组：${group?.label ?? groupId}`
        : `已折叠分组：${group?.label ?? groupId}`,
    );
  }

  function toggleBranch(nodeId: string) {
    setCollapsedBranches((current) =>
      current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId],
    );
    setAnnouncement(
      collapsedBranches.includes(nodeId)
        ? `已展开分支：${nodeTitle(nodeId)}`
        : `已折叠分支：${nodeTitle(nodeId)}`,
    );
  }

  const lodTier = view.scale < LOD_TITLE ? 1 : view.scale < LOD_FULL ? 2 : 3;
  const detailNode =
    detailId !== null ? layout.nodes.find((node) => node.node.id === detailId) ?? null : null;
  const detailPos = detailNode ? computeDetailPosition(detailNode) : null;

  /**
   * t80 F1：按浮窗**实测尺寸**定位；未测量前用 280×180 估算，测量后自动纠正。
   * 底部空间不足时翻转到节点上方，并夹取在容器内。
   */
  function computeDetailPosition(node: PositionedNode): DetailPlacement {
    const measured = detailSize.h > 0 ? detailSize : { w: DETAIL_MAX_WIDTH, h: 180 };
    return placeDetailPosition({
      node,
      view,
      container: size,
      detail: measured,
    });
  }

  const focusTitle = focusedId ? nodeTitle(focusedId) : null;
  const visibleCount = layout.nodes.filter((node) => !node.hidden).length;

  return (
    <div className="canvas-artifact">
      <div
        ref={containerRef}
        className={`canvas-viewport ${compact ? "compact" : ""}`}
        style={{ height }}
        tabIndex={0}
        role="application"
        aria-label={`交互画布：${artifact.title}，${CANVAS_KIND_LABEL[artifact.kind]}，${visibleCount} 个节点，${layout.edges.filter((edge) => !edge.hidden).length} 条边`}
        aria-describedby={`canvas-hint-${markerId}`}
        onKeyDown={handleKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="canvas-grid" aria-hidden="true" />
        <div
          className="canvas-world"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          <svg
            className="canvas-edges"
            style={{
              position: "absolute",
              left: offsetX,
              top: offsetY,
              width: layout.bounds.width,
              height: layout.bounds.height,
            }}
            viewBox={`${offsetX} ${offsetY} ${layout.bounds.width} ${layout.bounds.height}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="canvas-arrow" />
              </marker>
            </defs>
            {layout.edges.map((edge) => {
              if (edge.hidden || !edge.path) return null;
              const dimmed = neighbours
                ? !(neighbours.has(edge.fromId) && neighbours.has(edge.toId))
                : false;
              return (
                <path
                  key={`${edge.fromId}->${edge.toId}:${edge.kind}`}
                  d={edge.path}
                  className={`canvas-edge edge-${edge.kind}${edge.back ? " back" : ""}${dimmed ? " dimmed" : ""}`}
                  markerEnd={
                    edge.kind === "flow" || edge.kind === "depends"
                      ? `url(#${markerId})`
                      : undefined
                  }
                />
              );
            })}
          </svg>

          {layout.kind === "roadmap" &&
            layout.lanes.map((lane) => (
              <div
                key={`lane-${lane.id}`}
                className={`canvas-lane${lane.collapsed ? " collapsed" : ""}`}
                style={{ left: lane.x, top: lane.y, width: lane.w, height: lane.h }}
              >
                <button
                  type="button"
                  className="canvas-lane-head"
                  aria-expanded={!lane.collapsed}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (lane.group) toggleGroup(lane.group.id);
                  }}
                  disabled={!lane.group}
                >
                  <span className="canvas-lane-title">{lane.label ?? "未分组"}</span>
                  <span className="canvas-lane-count">
                    {lane.count} 项{lane.collapsed ? " · 已折叠" : ""}
                  </span>
                  {lane.group?.status && (
                    <span
                      className="canvas-lane-status"
                      data-status={lane.group.status}
                      title={CANVAS_STATUS_LABEL[lane.group.status]}
                    >
                      {CANVAS_STATUS_MARK[lane.group.status]}
                    </span>
                  )}
                </button>
              </div>
            ))}

          {layout.groupBoxes.map((box) => (
            <div
              key={`group-${box.group.id}`}
              className={`canvas-group-box${box.collapsed ? " collapsed" : ""}`}
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            >
              <button
                type="button"
                className="canvas-group-head"
                aria-expanded={!box.collapsed}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleGroup(box.group.id);
                }}
                title={box.group.label}
              >
                {box.group.label} · {box.count} 项{box.collapsed ? "（已折叠）" : ""}
              </button>
            </div>
          ))}

          {layout.nodes.map((node) => {
            if (node.hidden) return null;
            const data = node.node;
            const dimmed = neighbours ? !neighbours.has(data.id) : false;
            const selected = selectedId === data.id;
            const degrees = nodeDegrees(artifact, data.id);
            const group = data.groupId
              ? artifact.groups.find((item) => item.id === data.groupId)
              : undefined;
            const label = data.label;
            return (
              <button
                key={data.id}
                type="button"
                className={`${kindClass(data.kind)} lod-${lodTier}${selected ? " selected" : ""}${dimmed ? " dimmed" : ""}${focusedId === data.id ? " focused" : ""}`}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.w,
                  height: node.h,
                }}
                data-node-id={data.id}
                data-status={data.status}
                aria-label={`${label}，${NODE_KIND_LABEL[data.kind]}，${CANVAS_STATUS_LABEL[data.status]}${group ? `，分组 ${group.label}` : ""}，${degrees.incoming} 上游，${degrees.outgoing} 下游`}
                aria-pressed={selected}
                title={`${label}（${NODE_KIND_LABEL[data.kind]}）`}
                onClick={(event) => handleNodeClick(data.id, event)}
                onDoubleClick={(event) => event.preventDefault()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.ctrlKey || event.metaKey) toggleFocus(data.id);
                    else openDetail(data.id);
                  }
                }}
              >
                <svg
                  className="canvas-node-shape"
                  width={node.w}
                  height={node.h}
                  viewBox={`0 0 ${node.w} ${node.h}`}
                  aria-hidden="true"
                  focusable="false"
                >
                  {nodeShapeGeometry(data, node.w, node.h)}
                </svg>
                <span className="canvas-node-label">{label}</span>
                {data.meta && lodTier === 3 && <span className="canvas-node-meta">{data.meta}</span>}
                <span
                  className="canvas-status-mark"
                  aria-hidden="true"
                  title={CANVAS_STATUS_LABEL[data.status]}
                >
                  {CANVAS_STATUS_MARK[data.status]}
                </span>
                {node.hiddenDescendants > 0 && (
                  <span className="canvas-node-badge" aria-hidden="true">
                    +{node.hiddenDescendants}
                  </span>
                )}
              </button>
            );
          })}

          {layout.kind === "mindmap" &&
            layout.nodes.map((node) => {
              if (node.hidden || node.children.length === 0) return null;
              return (
                <button
                  key={`branch-${node.node.id}`}
                  type="button"
                  className="canvas-branch-toggle"
                  style={{ left: node.x + node.w - 12, top: node.y - 8 }}
                  aria-label={
                    node.branchCollapsed
                      ? `展开分支 ${node.node.label}`
                      : `折叠分支 ${node.node.label}`
                  }
                  aria-expanded={!node.branchCollapsed}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleBranch(node.node.id);
                  }}
                >
                  {node.branchCollapsed ? "+" : "−"}
                </button>
              );
            })}
        </div>

        {focusedId && (
          <div className="canvas-focusbar" role="status">
            <span className="muted">全部 › 聚焦：{focusTitle}</span>
            <button
              type="button"
              className="ghost tiny"
              onClick={() => {
                setFocusedId(null);
                setAnnouncement("已退出聚焦");
              }}
            >
              退出聚焦 (Esc)
            </button>
          </div>
        )}

        <div className="canvas-toolbar" role="group" aria-label="画布缩放">
          <button
            type="button"
            className="ghost tiny"
            aria-label="缩小画布"
            onClick={() => zoomBy(1 / 1.2)}
          >
            −
          </button>
          <span className="canvas-readout" aria-live="off">
            {Math.round(view.scale * 100)}%
          </span>
          <button
            type="button"
            className="ghost tiny"
            aria-label="放大画布"
            onClick={() => zoomBy(1.2)}
          >
            ＋
          </button>
          <button
            type="button"
            className="ghost tiny"
            onClick={() => {
              userInteractedRef.current = true;
              doFit();
            }}
            title="适应画布（0）"
          >
            适应
          </button>
          <button
            type="button"
            className="ghost tiny"
            aria-expanded={legendOpen}
            aria-controls={`canvas-legend-${markerId}`}
            onClick={() => setLegendOpen((open) => !open)}
          >
            图例
          </button>
        </div>

        {legendOpen && (
          <div
            className="canvas-legend"
            id={`canvas-legend-${markerId}`}
            role="dialog"
            aria-label="画布图例"
          >
            <div className="canvas-legend-head">
              状态
              <button type="button" className="ghost tiny" onClick={() => setLegendOpen(false)}>
                关闭
              </button>
            </div>
            <div className="canvas-legend-body">
              <div className="canvas-legend-section">
                {Object.entries(CANVAS_STATUS_LABEL).map(([status, label]) => (
                  <span key={status} className="canvas-legend-item">
                    <span className="canvas-legend-dot" data-status={status} aria-hidden="true">
                      {CANVAS_STATUS_MARK[status as keyof typeof CANVAS_STATUS_MARK]}
                    </span>
                    {label}
                  </span>
                ))}
              </div>
              <div className="canvas-legend-section">
                {Object.entries(EDGE_KIND_LABEL).map(([kind, label]) => (
                  <span key={kind} className="canvas-legend-item">
                    <span className={`canvas-legend-line edge-${kind}`} aria-hidden="true" />
                    {label}
                  </span>
                ))}
              </div>
              <div className="canvas-legend-section muted tiny">
                颜色不是唯一通道：每个节点带状态标记；分组标题可折叠泳道/分区。
              </div>
            </div>
          </div>
        )}

        <div className="sr-only" id={`canvas-hint-${markerId}`}>
          拖动空白平移，滚轮缩放，方向键平移，加减号缩放，0 适应画布；Tab
          到节点后回车查看详情，Ctrl 加回车聚焦一跳邻居，Esc 逐级退出。
        </div>
        <div className="sr-only" role="status" aria-live="polite">
          {announcement}
        </div>
        <div className="canvas-hint" aria-hidden="true">
          {compact ? "拖动平移 · 滚轮缩放 · 单击详情" : "拖动平移 · 滚轮缩放 · 单击详情 · 双击聚焦"}
        </div>

        {detailNode && detailPos && (
          <CanvasNodeDetail
            detailRef={detailRef}
            firstActionRef={detailFirstActionRef}
            node={detailNode}
            artifact={artifact}
            placement={detailPos}
            focused={Boolean(focusedId)}
            onClose={() => closeDetail()}
            onToggleFocus={() => toggleFocus(detailNode.node.id)}
            onClearFocus={() => {
              setFocusedId(null);
              closeDetail();
            }}
            onCopy={(value) => {
              void copyWithFallback(value, setAnnouncement);
            }}
          />
        )}
      </div>
      {layout.hiddenNodeCount > 0 && (
        <div className="canvas-collapsed-note muted tiny">
          已折叠 {layout.hiddenNodeCount} 节点 / {layout.hiddenEdgeCount} 边
          <button
            type="button"
            className="ghost tiny"
            onClick={() => {
              setCollapsedGroups([]);
              setCollapsedBranches([]);
            }}
          >
            展开全部
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * t80 F1/F2：节点详情浮窗（非模态 popover）。
 * - 按实测尺寸由 `placeDetailPosition` 决定位置（底部节点翻转/夹取）；
 * - 打开后由父组件把焦点移到首个动作；Tab 可离开，不圈禁。
 * 导出为独立组件便于 SSR 断言（role/aria/first action/placement）。
 */
export function CanvasNodeDetail({
  node,
  artifact,
  placement,
  focused,
  detailRef,
  firstActionRef,
  onClose,
  onToggleFocus,
  onClearFocus,
  onCopy,
}: {
  node: PositionedNode;
  artifact: DeerCanvas;
  placement: DetailPlacement;
  focused: boolean;
  detailRef?: RefObject<HTMLDivElement | null>;
  firstActionRef?: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onToggleFocus: () => void;
  onClearFocus: () => void;
  onCopy: (value: string) => void;
}) {
  const degrees = nodeDegrees(artifact, node.node.id);
  const groupLabel = node.groupId
    ? artifact.groups.find((group) => group.id === node.groupId)?.label ?? node.groupId
    : null;
  return (
    <div
      ref={detailRef}
      className="canvas-detail"
      data-placement={placement.placement}
      role="dialog"
      aria-modal="false"
      aria-label={`节点详情：${node.node.label}`}
      style={{ left: placement.left, top: placement.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="canvas-detail-head">
        <strong>{node.node.label}</strong>
        <button type="button" className="ghost tiny" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="canvas-detail-meta muted tiny">
        {NODE_KIND_LABEL[node.node.kind]} · {CANVAS_STATUS_LABEL[node.node.status]}
        {node.node.meta ? ` · ${node.node.meta}` : ""}
      </div>
      {node.node.note && <p className="canvas-detail-note">{node.node.note}</p>}
      <div className="canvas-detail-meta muted tiny">
        {groupLabel ? `分组：${groupLabel}` : "未分组"} · 上游 {degrees.incoming} / 下游{" "}
        {degrees.outgoing}
      </div>
      {node.node.refs && (
        <div className="canvas-detail-meta muted tiny">
          引用：
          {[
            node.node.refs.taskId ? `任务 ${node.node.refs.taskId}` : "",
            node.node.refs.messageId ? `消息 ${node.node.refs.messageId}` : "",
            node.node.refs.board ? `黑板 ${node.node.refs.board}` : "",
          ]
            .filter(Boolean)
            .join(" · ") || "—"}
        </div>
      )}
      <div className="canvas-detail-actions">
        <button
          ref={firstActionRef}
          type="button"
          className="ghost tiny"
          onClick={onToggleFocus}
        >
          {focused ? "退出 1 跳聚焦" : "聚焦 1 跳"}
        </button>
        {focused && (
          <button type="button" className="ghost tiny" onClick={onClearFocus}>
            清除聚焦
          </button>
        )}
        <button type="button" className="ghost tiny" onClick={() => onCopy(node.node.id)}>
          复制节点 ID
        </button>
        <button type="button" className="ghost tiny" onClick={() => onCopy(node.node.label)}>
          复制标题
        </button>
      </div>
    </div>
  );
}

async function copyWithFallback(value: string, announce: (message: string) => void): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      announce(`已复制：${value.slice(0, 40)}`);
      return;
    }
  } catch {
    // ignore
  }
  announce("复制失败：当前环境不支持剪贴板");
}

/** CSS 属性选择器里的节点 id 只含白名单字符（schema 已保证），这里再做一次防御。 */
function cssSafe(value: string): string {
  return value.replace(/["\\\]]/g, "");
}
