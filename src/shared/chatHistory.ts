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

/** 首次显示的条数；0 表示全部，其余按 limit 截断。 */
export function initialVisibleMessageCount(total: number, limit: number): number {
  if (limit <= 0) return Math.max(0, total);
  return Math.min(Math.max(0, total), limit);
}

/** 每次加载更早的消息条数，至少保留现有条数。 */
export function nextVisibleMessageCount(
  current: number,
  total: number,
  pageSize: number,
): number {
  return Math.min(total, Math.max(current, current + Math.max(1, pageSize)));
}

/** server-only 页只允许按 server 返回条数增加可见数；客户端新发送不计入。 */
export function nextVisibleAfterServerLoad(
  current: number,
  previousLength: number,
  loadedCount: number,
): number {
  return Math.min(previousLength + loadedCount, current + loadedCount);
}

/** 点击刻度后的 scrollTop：首轮钳制到 0，避免负值。 */
export function scrollTopForTurn(
  anchorTop: number,
  nodeTop: number,
  scrollTop: number,
  padding = 12,
): number {
  return Math.max(0, anchorTop - nodeTop + scrollTop - padding);
}

/** turn 状态 → 中文描述，供刻度 title/aria 使用。 */
export function chatTurnStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "待处理";
    case "running":
    case "streaming":
      return "处理中";
    case "complete":
      return "已完成";
    case "error":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

/** 刻度条位置：优先使用 turn 顶部比例，否则按均分兜底。 */
export function normalizeTurnRailRatio(
  offset: number,
  firstOffset: number,
  lastOffset: number,
  index: number,
  count: number,
): number {
  if (count <= 1) return 0;
  if (lastOffset > firstOffset) {
    return Math.min(1, Math.max(0, (offset - firstOffset) / (lastOffset - firstOffset)));
  }
  return (index + 1) / (count + 1);
}

/** 刻度条位置：优先使用 turn 顶部比例，否则按均分兜底。 */
export function turnRailRatio(
  offsetTop: number | null,
  scrollHeight: number,
  index: number,
  count: number,
): number {
  if (offsetTop !== null && scrollHeight > 0) {
    return Math.min(1, Math.max(0, offsetTop / scrollHeight));
  }
  return (index + 1) / (count + 1);
}
