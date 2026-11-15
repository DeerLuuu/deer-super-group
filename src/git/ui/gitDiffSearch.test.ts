import { describe, expect, it } from "vitest";
import {
  countLineMatches,
  escapeRegExp,
  filterSideRows,
  filterUnifiedHunks,
  lineMatches,
  matchStats,
  nextMatchIndex,
  sideRowMatches,
  splitHighlight,
  unifiedRowMatches,
} from "./gitDiffSearch";

function row(kind: "+" | "-" | " ", text: string) {
  return { kind, text };
}

describe("t360 gitDiffSearch：匹配与高亮", () => {
  it("lineMatches 大小写不敏感；空查询全匹配", () => {
    expect(lineMatches("const TOKEN = 1", "token")).toBe(true);
    expect(lineMatches("const TOKEN = 1", "TOKEN")).toBe(true);
    expect(lineMatches("const TOKEN = 1", "nope")).toBe(false);
    expect(lineMatches("anything", "")).toBe(true);
  });

  it("unifiedRowMatches / sideRowMatches", () => {
    expect(unifiedRowMatches(row("+", "hello world"), "world")).toBe(true);
    expect(sideRowMatches({ oldText: "aaa", newText: "bbb" }, "aaa")).toBe(true);
    expect(sideRowMatches({ oldText: "aaa", newText: "bbb" }, "bbb")).toBe(true);
    expect(sideRowMatches({ oldText: "aaa", newText: "bbb" }, "ccc")).toBe(false);
    expect(sideRowMatches({ oldText: null, newText: "x" }, "")).toBe(true);
  });

  it("splitHighlight 切段并标记命中（多处命中）", () => {
    expect(splitHighlight("aXXbXXc", "xx")).toEqual([
      { text: "a", hit: false },
      { text: "XX", hit: true },
      { text: "b", hit: false },
      { text: "XX", hit: true },
      { text: "c", hit: false },
    ]);
    expect(splitHighlight("abc", "")).toEqual([{ text: "abc", hit: false }]);
    expect(splitHighlight("abc", "zzz")).toEqual([{ text: "abc", hit: false }]);
  });

  it("countLineMatches / matchStats 统计", () => {
    expect(countLineMatches("x hit y hit z", "hit")).toBe(2);
    const stats = matchStats([{ text: "alpha" }, { text: "beta alpha" }, { text: "gamma" }], "alpha");
    expect(stats).toEqual({ hitRows: 2, totalMatches: 2 });
    expect(matchStats([{ text: "a" }], "")).toEqual({ hitRows: 0, totalMatches: 0 });
  });

  it("nextMatchIndex 循环跳转（Enter 向下 / Shift+Enter 向上）", () => {
    expect(nextMatchIndex(0, 3, false)).toBe(1);
    expect(nextMatchIndex(2, 3, false)).toBe(0); // 回绕
    expect(nextMatchIndex(0, 3, true)).toBe(2); // 向上回绕
    expect(nextMatchIndex(0, 0, false)).toBe(0);
  });

  it("escapeRegExp 转义正则元字符", () => {
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
  });
});

describe("t360 gitDiffSearch：过滤", () => {
  it("filterUnifiedHunks 仅保留命中行，空 hunk 隐藏", () => {
    const hunks = [
      { header: "@@ -1 +1 @@", rows: [row("+", "keep me"), row("-", "drop"), row(" ", "keep too")] },
      { header: "@@ -9 +9 @@", rows: [row(" ", "nothing here")] },
    ];
    const filtered = filterUnifiedHunks(hunks, "keep");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.rows).toEqual([row("+", "keep me"), row(" ", "keep too")]);
    // 空查询原样返回
    expect(filterUnifiedHunks(hunks, "")).toBe(hunks);
  });

  it("filterSideRows 旧/新任一侧命中保留", () => {
    const rows = [
      { oldText: "aaa", newText: "bbb" },
      { oldText: "ccc", newText: "ddd" },
    ];
    expect(filterSideRows(rows, "bbb")).toEqual([{ oldText: "aaa", newText: "bbb" }]);
    expect(filterSideRows(rows, "")).toBe(rows);
  });

  it("20k 行量化：过滤后仅命中行，统计准确", () => {
    const rows = Array.from({ length: 20_000 }, (_, index) =>
      row(index % 400 === 0 ? "+" : " ", `line ${index} of the big diff`),
    );
    const needle = "199";
    const filtered = filterUnifiedHunks([{ header: "@@ -1 +1 @@", rows }], needle);
    const stats = matchStats(rows, needle);
    // 行号 199、1999、…1999x 命中；数量与统计一致
    expect(stats.hitRows).toBe(filtered[0]!.rows.length);
    expect(stats.hitRows).toBeGreaterThan(20);
    expect(stats.hitRows).toBeLessThan(200);
  });
});
