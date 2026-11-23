/** t576：根据指针在 group body 内的位置计算唯一落点。 */
export type DropPosition = "center" | "left" | "right" | "above" | "below";

export interface DropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 四边 25% 内取最近的一侧；对角线时比较归一化距离，距离更近的轴优先；
 * 四边都不近则 center。纯函数，便于单测。
 */
export function computeDropPosition(
  clientX: number,
  clientY: number,
  rect: DropRect,
): DropPosition {
  if (rect.width <= 0 || rect.height <= 0) return "center";
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  const candidates: Array<{ position: DropPosition; distance: number }> = [
    { position: "left", distance: x },
    { position: "right", distance: 1 - x },
    { position: "above", distance: y },
    { position: "below", distance: 1 - y },
  ];
  let nearest = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.distance < nearest.distance) nearest = candidate;
  }
  return nearest.distance <= 0.25 ? nearest.position : "center";
}
