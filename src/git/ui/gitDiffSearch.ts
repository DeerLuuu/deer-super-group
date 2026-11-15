/**
 * t360（D1）：Git diff 搜索——纯函数（过滤/高亮/计数/跳转索引）。
 *
 * 约束：不引入虚拟列表库；20k 行 diff 过滤后仅渲染命中行，DOM 保持小；
 * 大小写不敏感子串匹配；查询为空时原样返回（由调用方短路）。
 */

export type UnifiedRow = { kind: "+" | "-" | " "; text: string };
export type SideRowLike = { oldText: string | null; newText: string | null };

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(value: string): string {
  return value.toLowerCase();
}

/** 行文本是否命中查询（大小写不敏感子串）。 */
export function lineMatches(text: string, query: string): boolean {
  if (!query) return true;
  return normalize(text).includes(normalize(query));
}

/** 统一行命中：add/del/context 行按 text 匹配。 */
export function unifiedRowMatches(row: UnifiedRow, query: string): boolean {
  return lineMatches(row.text, query);
}

/** 并排行命中：旧/新任一侧命中即保留。 */
export function sideRowMatches(row: SideRowLike, query: string): boolean {
  if (!query) return true;
  return (
    (row.oldText != null && lineMatches(row.oldText, query)) ||
    (row.newText != null && lineMatches(row.newText, query))
  );
}

export type HunkLike<R> = { header: string; rows: R[] };

/** 统一视图过滤：仅保留命中行；命中数为 0 的 hunk 整体隐藏。 */
export function filterUnifiedHunks<R extends UnifiedRow>(
  hunks: HunkLike<R>[],
  query: string,
): HunkLike<R>[] {
  if (!query) return hunks;
  const needle = normalize(query);
  return hunks
    .map((hunk) => ({
      header: hunk.header,
      rows: hunk.rows.filter((row) => normalize(row.text).includes(needle)),
    }))
    .filter((hunk) => hunk.rows.length > 0);
}

/** 并排视图过滤：仅保留命中行。 */
export function filterSideRows<R extends SideRowLike>(rows: R[], query: string): R[] {
  if (!query) return rows;
  return rows.filter((row) => sideRowMatches(row, query));
}

/** 单行命中次数（用于计数与逐段高亮）。 */
export function countLineMatches(text: string, query: string): number {
  if (!query) return 0;
  return splitHighlight(text, query).filter((segment) => segment.hit).length;
}

export type HighlightSegment = { text: string; hit: boolean };

/** 把行文本切成命中/未命中段，供 <mark> 渲染；大小写不敏感。 */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  if (!query) return [{ text, hit: false }];
  const needle = normalize(query);
  const segments: HighlightSegment[] = [];
  let index = 0;
  while (index <= text.length) {
    const from = normalize(text).indexOf(needle, index);
    if (from < 0) {
      if (index < text.length) segments.push({ text: text.slice(index), hit: false });
      break;
    }
    if (from > index) segments.push({ text: text.slice(index, from), hit: false });
    segments.push({ text: text.slice(from, from + query.length), hit: true });
    index = from + query.length;
  }
  return segments.length > 0 ? segments : [{ text: "", hit: false }];
}

/**
 * 生成命中索引表：对已渲染的行列表按出现顺序给出每条命中行的
 * `data-match-index`（一行可能多处命中，但跳转按行走）。
 * 返回总命中行数与总命中次数。
 */
export function matchStats(
  rows: Array<{ text: string }>,
  query: string,
): { hitRows: number; totalMatches: number } {
  if (!query) return { hitRows: 0, totalMatches: 0 };
  let hitRows = 0;
  let totalMatches = 0;
  for (const row of rows) {
    const count = countLineMatches(row.text, query);
    if (count > 0) {
      hitRows += 1;
      totalMatches += count;
    }
  }
  return { hitRows, totalMatches };
}

/** 跳转索引循环：Enter 向下、Shift+Enter 向上；越界回绕。 */
export function nextMatchIndex(current: number, total: number, backward: boolean): number {
  if (total <= 0) return 0;
  if (backward) return (current - 1 + total) % total;
  return (current + 1) % total;
}

/**
 * t489：并排视图命中统计——以过滤后的 SideRow 行数为准（一行可同时含旧/新命中）。
 * 与 unified 的 matchStats 分开定义：Enter 循环的 total 必须等于 DOM 中过滤行数。
 */
export function sideMatchStats<R extends SideRowLike>(
  rows: R[],
  query: string,
): { hitRows: number; totalMatches: number } {
  if (!query) return { hitRows: 0, totalMatches: 0 };
  let hitRows = 0;
  let totalMatches = 0;
  for (const row of rows) {
    if (!sideRowMatches(row, query)) continue;
    hitRows += 1;
    if (row.oldText != null) totalMatches += countLineMatches(row.oldText, query);
    if (row.newText != null) totalMatches += countLineMatches(row.newText, query);
  }
  return { hitRows, totalMatches };
}
