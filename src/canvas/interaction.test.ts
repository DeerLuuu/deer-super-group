import { describe, expect, it } from "vitest";
import {
  CANVAS_OVERLAY_SELECTOR,
  CLICK_DETAIL_DELAY_MS,
  createNodeClickState,
  isCanvasOverlayWheelTarget,
  isDragGesture,
  nextEscapeLayer,
  resolveNodeClick,
} from "./interaction.js";

/**
 * t64：单击不误触双击状态机（设计 §7.8 / AC-05）。
 */

describe("节点点击状态机", () => {
  it("第一次点击：立即选中，250ms 后才打开详情", () => {
    const first = resolveNodeClick(createNodeClickState(), {
      type: "click",
      nodeId: "a",
      detail: 1,
      now: 1000,
    });
    expect(first.effects.selectNodeId).toBe("a");
    expect(first.effects.openDetailNodeId).toBeUndefined();
    expect(first.state.pendingNodeId).toBe("a");
    expect(first.state.pendingAt).toBe(1000 + CLICK_DETAIL_DELAY_MS);

    const timer = resolveNodeClick(first.state, { type: "detail-timer", nodeId: "a", now: 1250 });
    expect(timer.effects.openDetailNodeId).toBe("a");
    expect(timer.state.pendingNodeId).toBeNull();
  });

  it("双击（detail=2）：取消待打开详情，直接 1 跳聚焦（不闪出详情）", () => {
    const first = resolveNodeClick(createNodeClickState(), {
      type: "click",
      nodeId: "a",
      detail: 1,
      now: 1000,
    });
    const second = resolveNodeClick(first.state, {
      type: "click",
      nodeId: "a",
      detail: 2,
      now: 1100,
    });
    expect(second.effects.openDetailNodeId).toBeUndefined();
    expect(second.effects.toggleFocusNodeId).toBe("a");
    expect(second.state.pendingNodeId).toBeNull();
    // 计时器即使之后触发也不能再打开详情。
    const late = resolveNodeClick(second.state, { type: "detail-timer", nodeId: "a", now: 1300 });
    expect(late.effects.openDetailNodeId).toBeUndefined();
  });

  it("两次 detail=1 且在 250ms 窗口内：按双击处理", () => {
    const first = resolveNodeClick(createNodeClickState(), {
      type: "click",
      nodeId: "a",
      detail: 1,
      now: 1000,
    });
    const second = resolveNodeClick(first.state, {
      type: "click",
      nodeId: "a",
      detail: 1,
      now: 1200,
    });
    expect(second.effects.toggleFocusNodeId).toBe("a");
  });

  it("拖拽位移 > 4px 的点击被忽略", () => {
    const moved = resolveNodeClick(createNodeClickState(), {
      type: "click",
      nodeId: "a",
      detail: 1,
      now: 1000,
      moved: true,
    });
    expect(moved.effects).toEqual({});
    expect(moved.state.pendingNodeId).toBeNull();
    expect(isDragGesture(5, 0)).toBe(true);
    expect(isDragGesture(3, 0)).toBe(false);
  });

  it("不同节点的计时器不互相打开", () => {
    const first = resolveNodeClick(createNodeClickState(), {
      type: "click",
      nodeId: "a",
      detail: 1,
      now: 1000,
    });
    const other = resolveNodeClick(first.state, { type: "detail-timer", nodeId: "b", now: 1200 });
    expect(other.effects.openDetailNodeId).toBeUndefined();
  });

  it("cancel 清理待打开详情", () => {
    const first = resolveNodeClick(createNodeClickState(), {
      type: "click",
      nodeId: "a",
      detail: 1,
      now: 1000,
    });
    const cancelled = resolveNodeClick(first.state, { type: "cancel" });
    expect(cancelled.state.pendingNodeId).toBeNull();
  });

  it("Esc 逐级：详情 → 聚焦 → 选中 → none", () => {
    expect(nextEscapeLayer({ detailOpen: true, focused: true, selected: true })).toBe("detail");
    expect(nextEscapeLayer({ detailOpen: false, focused: true, selected: true })).toBe("focus");
    expect(nextEscapeLayer({ detailOpen: false, focused: false, selected: true })).toBe(
      "selection",
    );
    expect(nextEscapeLayer({ detailOpen: false, focused: false, selected: false })).toBe("none");
  });
});

describe("t80 F10：浮层内滚轮不缩放画布", () => {
  it("selector 覆盖详情/图例/工具栏", () => {
    for (const part of ["canvas-detail", "canvas-legend", "canvas-toolbar"]) {
      expect(CANVAS_OVERLAY_SELECTOR).toContain(part);
    }
  });

  it("命中浮层的 target 返回 true；画布空白/节点返回 false", () => {
    const target = (matched: string | null) => ({
      closest: (selector: string) => (matched && selector.includes(matched) ? {} : null),
    });
    expect(isCanvasOverlayWheelTarget(target("canvas-detail"))).toBe(true);
    expect(isCanvasOverlayWheelTarget(target("canvas-legend"))).toBe(true);
    expect(isCanvasOverlayWheelTarget(target("canvas-toolbar"))).toBe(true);
    expect(isCanvasOverlayWheelTarget(target(null))).toBe(false);
    expect(isCanvasOverlayWheelTarget(null)).toBe(false);
    expect(isCanvasOverlayWheelTarget(undefined)).toBe(false);
  });
});
