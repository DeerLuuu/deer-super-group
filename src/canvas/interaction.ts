/**
 * t64：画布节点单击/双击状态机（纯函数；设计 §4.5 / §7.8 / AC-05）。
 *
 * 目标：双击不能先闪出详情浮窗（吸收星图 S04 已知缺陷）。
 * - 第一次点击：立即选中，延时 250ms 后才打开详情；
 * - 第二次点击（detail === 2）：取消待打开详情，直接 1 跳聚焦；
 * - 拖拽位移 > 4px：忽略点击；
 * - Esc 逐级：详情 → 聚焦 → 清空选中。
 */

export const CLICK_DETAIL_DELAY_MS = 250;
export const DRAG_THRESHOLD_PX = 4;

export interface NodeClickState {
  pendingNodeId: string | null;
  pendingAt: number;
  selectedNodeId: string | null;
}

export type NodeClickEvent =
  | { type: "click"; nodeId: string; detail: number; now: number; moved?: boolean }
  | { type: "detail-timer"; nodeId: string; now: number }
  | { type: "cancel" }
  | { type: "select"; nodeId: string | null };

export interface NodeClickEffects {
  selectNodeId?: string | null;
  openDetailNodeId?: string;
  toggleFocusNodeId?: string;
}

export interface NodeClickResolution {
  state: NodeClickState;
  effects: NodeClickEffects;
}

export function createNodeClickState(): NodeClickState {
  return { pendingNodeId: null, pendingAt: 0, selectedNodeId: null };
}

export function resolveNodeClick(
  state: NodeClickState,
  event: NodeClickEvent,
): NodeClickResolution {
  if (event.type === "cancel") {
    return {
      state: { ...state, pendingNodeId: null, pendingAt: 0 },
      effects: {},
    };
  }
  if (event.type === "select") {
    return {
      state: { ...state, selectedNodeId: event.nodeId, pendingNodeId: null, pendingAt: 0 },
      effects: { selectNodeId: event.nodeId },
    };
  }
  if (event.type === "detail-timer") {
    if (state.pendingNodeId !== event.nodeId) {
      return { state, effects: {} };
    }
    return {
      state: { ...state, pendingNodeId: null, pendingAt: 0 },
      effects: { openDetailNodeId: event.nodeId },
    };
  }

  if (event.moved) {
    // 拖拽误触：不选中、不打开详情。
    return { state, effects: {} };
  }

  if (event.detail >= 2) {
    return {
      state: { ...state, selectedNodeId: event.nodeId, pendingNodeId: null, pendingAt: 0 },
      effects: { selectNodeId: event.nodeId, toggleFocusNodeId: event.nodeId },
    };
  }

  // detail === 1：如果存在同一节点的待打开详情且仍在窗口内，按第二次点击处理。
  if (state.pendingNodeId === event.nodeId && event.now <= state.pendingAt) {
    return {
      state: { ...state, selectedNodeId: event.nodeId, pendingNodeId: null, pendingAt: 0 },
      effects: { selectNodeId: event.nodeId, toggleFocusNodeId: event.nodeId },
    };
  }

  return {
    state: {
      ...state,
      selectedNodeId: event.nodeId,
      pendingNodeId: event.nodeId,
      pendingAt: event.now + CLICK_DETAIL_DELAY_MS,
    },
    effects: { selectNodeId: event.nodeId },
  };
}

/** 视口平移是否达到拖拽阈值（pointerdown → pointerup 的位移）。 */
export function isDragGesture(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
}

export type EscapeLayer = "detail" | "focus" | "selection" | "none";

/** Esc 逐级退出：详情 → 聚焦 → 选中。 */
export function nextEscapeLayer(state: {
  detailOpen: boolean;
  focused: boolean;
  selected: boolean;
}): EscapeLayer {
  if (state.detailOpen) return "detail";
  if (state.focused) return "focus";
  if (state.selected) return "selection";
  return "none";
}
