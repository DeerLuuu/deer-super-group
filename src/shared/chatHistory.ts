/** t329：加载更早后保持视口位置（以顶部相对内容增长量补偿）。 */
export function scrollTopAfterPrepend(
  previousTop: number,
  previousHeight: number,
  nextHeight: number,
): number {
  return Math.max(0, previousTop + Math.max(0, nextHeight - previousHeight));
}

/** 每次加载更早的消息条数，至少保留现有条数。 */
export function nextVisibleMessageCount(
  current: number,
  total: number,
  pageSize: number,
): number {
  return Math.min(total, Math.max(current, current + Math.max(1, pageSize)));
}
