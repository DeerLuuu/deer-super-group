/** t329：加载更早后保持视口位置（以顶部相对内容增长量补偿）。 */
export function scrollTopAfterPrepend(
  previousTop: number,
  previousHeight: number,
  nextHeight: number,
): number {
  return Math.max(0, previousTop + Math.max(0, nextHeight - previousHeight));
}

/** 直接对滚动容器应用补偿，返回新的 scrollTop；供 DOM/组件回归测试使用。 */
export function applyHistoryScrollPreservation(
  node: { scrollTop: number; scrollHeight: number },
  previous: { top: number; height: number },
): number {
  node.scrollTop = scrollTopAfterPrepend(
    previous.top,
    previous.height,
    node.scrollHeight,
  );
  return node.scrollTop;
}

/** 每次加载更早的消息条数，至少保留现有条数。 */
export function nextVisibleMessageCount(
  current: number,
  total: number,
  pageSize: number,
): number {
  return Math.min(total, Math.max(current, current + Math.max(1, pageSize)));
}
