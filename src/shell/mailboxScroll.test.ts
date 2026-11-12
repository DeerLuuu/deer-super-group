import { describe, expect, it } from "vitest";
import {
  captureMailboxAnchor,
  captureMailboxScrollState,
  parseMailboxScrollState,
  restoreMailboxScrollTop,
  serializeMailboxScrollState,
} from "./mailboxScroll";

const items = [
  { id: "a", offsetTop: 0, offsetHeight: 80 },
  { id: "b", offsetTop: 100, offsetHeight: 80 },
  { id: "c", offsetTop: 200, offsetHeight: 80 },
];

describe("t405 mailbox scroll anchors", () => {
  it("restores the same thread after lastActivity reorder", () => {
    const anchor = captureMailboxAnchor(items, 120);
    expect(anchor).toEqual({ id: "b", offset: 20 });
    const reordered = [
      { id: "c", offsetTop: 0, offsetHeight: 80 },
      { id: "a", offsetTop: 100, offsetHeight: 80 },
      { id: "b", offsetTop: 200, offsetHeight: 80 },
    ];
    expect(restoreMailboxScrollTop(reordered, anchor)).toBe(220);
  });

  it("keeps a negative anchor offset so exact scrollTop is restored", () => {
    const anchor = captureMailboxAnchor([{ id: "b", offsetTop: 187, offsetHeight: 80 }], 180);
    expect(anchor).toEqual({ id: "b", offset: -7 });
    expect(restoreMailboxScrollTop([{ id: "b", offsetTop: 187, offsetHeight: 80 }], anchor)).toBe(180);
  });

  it("restores the same thread when a new active thread is inserted above", () => {
    const anchor = captureMailboxAnchor(items, 120);
    const withNewTop = [
      { id: "new", offsetTop: 0, offsetHeight: 90 },
      { id: "a", offsetTop: 90, offsetHeight: 80 },
      { id: "b", offsetTop: 190, offsetHeight: 80 },
      { id: "c", offsetTop: 290, offsetHeight: 80 },
    ];
    expect(restoreMailboxScrollTop(withNewTop, anchor)).toBe(210);
  });

  it("returns null when the anchored item disappears", () => {
    expect(restoreMailboxScrollTop([], { id: "b", offset: 20 })).toBeNull();
    expect(restoreMailboxScrollTop(items, { id: null, offset: 0 })).toBeNull();
  });

  it("captures/restores list and detail anchors together", () => {
    const state = captureMailboxScrollState(items, 120, items, 240);
    expect(state.thread).toEqual({ id: "b", offset: 20 });
    expect(state.message).toEqual({ id: "c", offset: 40 });
  });

  it("round-trips persisted anchors and tolerates malformed storage", () => {
    const state = captureMailboxScrollState(items, 120, items, 240);
    expect(parseMailboxScrollState(serializeMailboxScrollState(state))).toEqual(state);
    expect(parseMailboxScrollState(null)).toEqual({
      thread: { id: null, offset: 0 },
      message: { id: null, offset: 0 },
    });
    expect(parseMailboxScrollState("{bad")).toEqual({
      thread: { id: null, offset: 0 },
      message: { id: null, offset: 0 },
    });
  });
});
