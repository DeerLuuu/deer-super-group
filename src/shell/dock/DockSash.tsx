/**
 * DW1-3（t548）：DockSash——分栏分隔条。
 * role=separator、可聚焦、方向键微调、Home/End 归零/拉满、指针拖动（pointer capture）。
 * onDelta 语义：dragAmount（像素）→ 调用方换算为权重 delta。
 */
import { useCallback, useRef } from "react";

export interface DockSashProps {
  axis: "horizontal" | "vertical";
  /** 无障碍标签（「调整分栏 i/n」）。 */
  "aria-label": string;
  /** 拖动/键盘增量回调（delta>0 = 增大前方 pane 权重）。 */
  onResize: (delta: number) => void;
  /** 双击恢复当前布局（t576：sash 交互复位）。 */
  onReset?: () => void;
}

const KEY_STEP = 0.02;

export default function DockSash({ axis, onResize, onReset, ...rest }: DockSashProps) {
  "use no memo";
  const dragOriginRef = useRef<{ pos: number; fired: boolean } | null>(null);
  const sashRef = useRef<HTMLDivElement | null>(null);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const horizontal = axis === "horizontal";
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault();
          onResize(-KEY_STEP);
          break;
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault();
          onResize(KEY_STEP);
          break;
        case "Home":
          event.preventDefault();
          onResize(-0.5);
          break;
        case "End":
          event.preventDefault();
          onResize(0.5);
          break;
        default:
          break;
      }
      void horizontal;
    },
    [axis, onResize],
  );

  function onPointerDown(event: React.PointerEvent) {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragOriginRef.current = {
      pos: axis === "horizontal" ? event.clientX : event.clientY,
      fired: false,
    };
  }

  function onPointerMove(event: React.PointerEvent) {
    const origin = dragOriginRef.current;
    if (!origin) return;
    const current = axis === "horizontal" ? event.clientX : event.clientY;
    const distance = current - origin.pos;
    if (!origin.fired && Math.abs(distance) < 4) return; // 4px 阈值
    origin.fired = true;
    const container = sashRef.current?.parentElement;
    const span = container
      ? axis === "horizontal"
        ? container.clientWidth
        : container.clientHeight
      : 1000;
    onResize(distance / Math.max(1, span));
    origin.pos = current;
  }

  function onPointerUp(event: React.PointerEvent) {
    dragOriginRef.current = null;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      ref={sashRef}
      className="docktree-sash"
      role="separator"
      tabIndex={0}
      aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"}
      aria-label={rest["aria-label"]}
      data-axis={axis}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      title="拖动调整分栏；双击恢复默认布局"
    />
  );
}
