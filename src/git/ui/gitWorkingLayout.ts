export const SECTION_RATIO_MIN = 20;
export const SECTION_RATIO_MAX = 80;
export const SECTION_RATIO_DEFAULT = 38;

export function clampSectionRatio(value: number): number {
  return Math.min(SECTION_RATIO_MAX, Math.max(SECTION_RATIO_MIN, value));
}

/** 拖拽时按容器高度换算；高度非法时保持原比例。 */
export function ratioAfterDrag(
  startRatio: number,
  deltaY: number,
  containerHeight: number,
): number {
  if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
    return clampSectionRatio(startRatio);
  }
  return clampSectionRatio(startRatio + (deltaY / containerHeight) * 100);
}

/** 键盘 ArrowUp/Down ±5，Home 恢复默认；其他键返回 null。 */
export function ratioAfterKey(current: number, key: string): number | null {
  if (key === "ArrowDown") return clampSectionRatio(current + 5);
  if (key === "ArrowUp") return clampSectionRatio(current - 5);
  if (key === "Home") return SECTION_RATIO_DEFAULT;
  return null;
}

type DragTarget = {
  addEventListener: (type: string, listener: (event: { clientY: number }) => void) => void;
  removeEventListener: (type: string, listener: (event: { clientY: number }) => void) => void;
};

/** pointerdown 后挂载 pointermove/pointerup；用于两段比例拖拽与单测。 */
export function attachSectionDrag(options: {
  startY: number;
  startRatio: number;
  height: number;
  onRatio: (ratio: number) => void;
  target: DragTarget;
}): () => void {
  const onMove = (event: { clientY: number }) => {
    options.onRatio(
      ratioAfterDrag(options.startRatio, event.clientY - options.startY, options.height),
    );
  };
  const onUp = () => {
    options.target.removeEventListener("pointermove", onMove);
    options.target.removeEventListener("pointerup", onUp);
  };
  options.target.addEventListener("pointermove", onMove);
  options.target.addEventListener("pointerup", onUp);
  return onUp;
}

