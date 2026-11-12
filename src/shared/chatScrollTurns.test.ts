import { describe, expect, it } from "vitest";
import {
  initialVisibleMessageCount,
  nextVisibleMessageCount,
  turnRailRatio,
} from "./chatHistory.js";
import { DEFAULT_CHAT_HISTORY_LIMIT, normalizeChatHistoryLimit, normalizeLayoutSettings } from "./types.js";

describe("t443 chat scroll / history limit", () => {
  it("defaults recent N to 40 and clamps invalid values", () => {
    expect(DEFAULT_CHAT_HISTORY_LIMIT).toBe(40);
    expect(normalizeChatHistoryLimit(undefined)).toBe(40);
    expect(normalizeChatHistoryLimit("40")).toBe(40);
    expect(normalizeChatHistoryLimit(0)).toBe(0);
    expect(normalizeChatHistoryLimit(1)).toBe(20);
    expect(normalizeChatHistoryLimit(999)).toBe(80);
    expect(normalizeLayoutSettings({ maxDockGroups: 6 }).chatHistoryLimit).toBe(40);
    expect(normalizeLayoutSettings({ maxDockGroups: 6, chatHistoryLimit: 0 }).chatHistoryLimit).toBe(0);
  });

  it("keeps initial/all and paging counts consistent", () => {
    expect(initialVisibleMessageCount(150, 40)).toBe(40);
    expect(initialVisibleMessageCount(150, 0)).toBe(150);
    expect(initialVisibleMessageCount(12, 40)).toBe(12);
    expect(nextVisibleMessageCount(40, 150, 40)).toBe(80);
    expect(nextVisibleMessageCount(140, 150, 40)).toBe(150);
  });

  it("positions ticks by turn top and falls back to even spacing", () => {
    expect(turnRailRatio(200, 800, 0, 3)).toBe(0.25);
    expect(turnRailRatio(null, 800, 0, 3)).toBe(0.25);
    expect(turnRailRatio(null, 800, 2, 3)).toBe(0.75);
    expect(turnRailRatio(1200, 800, 0, 3)).toBe(1);
    expect(turnRailRatio(-20, 800, 0, 3)).toBe(0);
  });
});
