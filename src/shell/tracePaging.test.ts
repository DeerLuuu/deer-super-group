import { describe, expect, it } from "vitest";
import {
  dedupeBySeq,
  filterTraceEvents,
  growLimit,
  latestPage,
  pageLabel,
  traceTypeOptions,
} from "./tracePaging";

function event(seq: number, type = "tool.call") {
  return { seq, type };
}

describe("t360 tracePaging：去重与过滤", () => {
  it("dedupeBySeq 按 seq 去重并升序", () => {
    const events = [event(1), event(2), event(2), event(3), event(1)];
    expect(dedupeBySeq(events).map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("filterTraceEvents 按类型；all/空原样返回", () => {
    const events = [event(1, "tool.call"), event(2, "run.completed"), event(3, "tool.call")];
    expect(filterTraceEvents(events, "tool.call")).toHaveLength(2);
    expect(filterTraceEvents(events, "all")).toBe(events);
    expect(filterTraceEvents(events, "")).toBe(events);
  });

  it("traceTypeOptions 去重并按频次降序", () => {
    const options = traceTypeOptions([
      event(1, "a"),
      event(2, "b"),
      event(3, "a"),
      event(4, "a"),
      event(5, "b"),
    ]);
    expect(options).toEqual([
      { type: "a", count: 3 },
      { type: "b", count: 2 },
    ]);
  });
});

describe("t360 tracePaging：分页", () => {
  it("latestPage 默认取最新 limit 条", () => {
    const events = Array.from({ length: 250 }, (_, index) => event(index + 1));
    const page = latestPage(events, 100);
    expect(page).toHaveLength(100);
    expect(page[0]!.seq).toBe(151);
    expect(page[99]!.seq).toBe(250);
    expect(latestPage(events, 300)).toHaveLength(250);
  });

  it("growLimit 步长 100，封顶总量", () => {
    expect(growLimit(100, 250)).toBe(200);
    expect(growLimit(200, 250)).toBe(250);
    expect(growLimit(250, 250)).toBe(250);
  });

  it("pageLabel 与旧口径一致", () => {
    expect(pageLabel(100, 250)).toBe("最近 100 / 共 250 条");
    expect(pageLabel(250, 250)).toBe("250 条事件");
  });
});
