/**
 * t360（D1）：任务 trace 客户端游标分页——纯函数（去重/过滤/分页/类型选项）。
 *
 * IPC 契约不变（getTaskTrace 仍一次返回 ≤2000 条），分页在渲染侧按 seq 游标推进：
 * 默认显示最新 100 条，「加载更早」每次向前扩 100 条。
 */

export type TraceEventLike = { seq: number; type: string };

/** 按 seq 去重（后出现的覆盖先出现的；输入为 seq 升序事件流）。 */
export function dedupeBySeq<E extends TraceEventLike>(events: E[]): E[] {
  const bySeq = new Map<number, E>();
  for (const event of events) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export type TraceFilter = string; // "all" 或事件类型（如 tool.call）

/** 按事件类型过滤；filter 为 "all"/空时原样返回。 */
export function filterTraceEvents<E extends TraceEventLike>(events: E[], filter: TraceFilter): E[] {
  if (!filter || filter === "all") return events;
  return events.filter((event) => event.type === filter);
}

/** 从事件流推导类型选项（去重 + 按出现频次降序，便于高频类型排前）。 */
export function traceTypeOptions<E extends TraceEventLike>(events: E[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** 取最新 limit 条（游标 = 展示窗口最旧一条的 seq）。 */
export function latestPage<E extends TraceEventLike>(events: E[], limit: number): E[] {
  if (events.length <= limit) return events;
  return events.slice(events.length - limit);
}

/** 「加载更早」后的新 limit（步长 100，封顶总量）。 */
export function growLimit(current: number, total: number, step = 100): number {
  return Math.min(current + step, Math.max(total, current));
}

/** 当前窗口信息（供 aria 与按钮文案）。 */
export function pageLabel(shown: number, total: number): string {
  return total > shown ? `最近 ${shown} / 共 ${total} 条` : `${total} 条事件`;
}
