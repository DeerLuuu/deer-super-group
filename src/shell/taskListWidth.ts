/** Tasks 列表在给定布局宽度下的真实可拖上限（CSS 52% / 280–520）。 */
export function taskListMaxWidth(layoutWidth: number): number {
  return Math.max(280, Math.min(520, Math.floor((layoutWidth || 960) * 0.52)));
}

/** 键盘/持久化宽度按实际布局 clamp，避免 aria 与视觉宽度不一致。 */
export function clampTaskListWidth(width: number, layoutWidth: number): number {
  return Math.min(taskListMaxWidth(layoutWidth), Math.max(280, Math.round(width)));
}
