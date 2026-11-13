/** Tasks 列表在给定布局宽度下的真实可拖上限（CSS 52% / 280–520）。 */
export const TASK_LIST_MIN_WIDTH = 280;
export const TASK_LIST_MAX_WIDTH = 520;
export const TASK_LIST_DEFAULT_WIDTH = 380;

export function taskListMaxWidth(layoutWidth: number): number {
  return Math.max(TASK_LIST_MIN_WIDTH, Math.min(TASK_LIST_MAX_WIDTH, Math.floor((layoutWidth || 960) * 0.52)));
}

/** 键盘/持久化宽度按实际布局 clamp，避免 aria 与视觉宽度不一致。 */
export function clampTaskListWidth(width: number, layoutWidth: number): number {
  const rounded = Number.isFinite(width) ? Math.round(width) : TASK_LIST_DEFAULT_WIDTH;
  return Math.min(taskListMaxWidth(layoutWidth), Math.max(TASK_LIST_MIN_WIDTH, rounded));
}

/**
 * 与 Sidebar 相同的 preferred/displayed 语义：
 * - preferred 是用户持久化宽度；
 * - displayed 只在当前布局无法容纳 preferred 时临时覆盖；
 * - 窄布局拖动/键盘只改 displayed，不写 localStorage；回到宽布局恢复 preferred。
 */
export type TaskListWidthState = {
  preferred: number;
  displayed: number | null;
};

export function isNarrowTaskListWidth(layoutWidth: number): boolean {
  return layoutWidth > 0 && taskListMaxWidth(layoutWidth) < TASK_LIST_MAX_WIDTH;
}

export function resizeTaskListWidth(
  state: TaskListWidthState,
  layoutWidth: number,
  requestedWidth: number,
): TaskListWidthState {
  const next = clampTaskListWidth(requestedWidth, layoutWidth);
  if (isNarrowTaskListWidth(layoutWidth)) {
    return { preferred: state.preferred, displayed: next };
  }
  return { preferred: next, displayed: null };
}

export function displayedTaskListWidth(
  state: TaskListWidthState,
  layoutWidth: number,
): number {
  const raw = isNarrowTaskListWidth(layoutWidth)
    ? (state.displayed ?? state.preferred)
    : state.preferred;
  return clampTaskListWidth(raw, layoutWidth);
}

/** 拖动结束：窄布局不持久化 preferred；宽布局清除 displayed 并允许写入。 */
export function commitTaskListWidth(
  state: TaskListWidthState,
  layoutWidth: number,
): TaskListWidthState & { persist: boolean } {
  if (isNarrowTaskListWidth(layoutWidth)) {
    return { ...state, persist: false };
  }
  return { preferred: state.preferred, displayed: null, persist: true };
}

/** 布局宽度切换时：宽布局清除 display override，窄布局重新 clamp displayed。 */
export function taskListWidthStateForLayout(
  state: TaskListWidthState,
  layoutWidth: number,
): TaskListWidthState {
  if (!isNarrowTaskListWidth(layoutWidth)) {
    return state.displayed === null ? state : { preferred: state.preferred, displayed: null };
  }
  if (state.displayed === null) return state;
  const clamped = clampTaskListWidth(state.displayed, layoutWidth);
  return clamped === state.displayed
    ? state
    : { preferred: state.preferred, displayed: clamped };
}
