import { describe, expect, it } from "vitest";
import {
  applyHistoryScrollPreservation,
  nextVisibleMessageCount,
  scrollTopAfterPrepend,
} from "./chatHistory.js";

describe("t329 history scroll preservation", () => {
  it("compensates scrollTop by prepended content height", () => {
    expect(scrollTopAfterPrepend(120, 400, 700)).toBe(420);
    expect(scrollTopAfterPrepend(0, 400, 700)).toBe(300);
    expect(scrollTopAfterPrepend(120, 700, 400)).toBe(120);
  });

  it("pages without losing already visible messages", () => {
    expect(nextVisibleMessageCount(40, 150, 40)).toBe(80);
    expect(nextVisibleMessageCount(140, 150, 40)).toBe(150);
    expect(nextVisibleMessageCount(150, 150, 40)).toBe(150);
  });

  it("applies scrollTop compensation to an actual scroll container shape", () => {
    const node = { scrollTop: 120, scrollHeight: 700, clientHeight: 300 };
    const next = applyHistoryScrollPreservation(node, { top: 120, height: 400 });
    expect(next).toBe(420);
    expect(node.scrollTop).toBe(420);
  });
});
