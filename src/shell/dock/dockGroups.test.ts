import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_DOCK_GROUPS, normalizeMaxDockGroups } from "../../shared/types";
import { canAddDockGroup, dockGroupLimitMessage, effectiveMaxDockGroups } from "./dockGroups";

describe("t208 Dock max groups", () => {
  it("defaults to 6 and clamps invalid values to 2–8", () => {
    expect(DEFAULT_MAX_DOCK_GROUPS).toBe(6);
    expect(effectiveMaxDockGroups(undefined)).toBe(6);
    expect(effectiveMaxDockGroups("8")).toBe(8);
    expect(effectiveMaxDockGroups(7.6)).toBe(8);
    expect(effectiveMaxDockGroups(99)).toBe(8);
    expect(effectiveMaxDockGroups(-3)).toBe(2);
    expect(effectiveMaxDockGroups("abc")).toBe(6);
    expect(normalizeMaxDockGroups(2)).toBe(2);
    expect(normalizeMaxDockGroups(8)).toBe(8);
  });

  it("allows the 6th group and rejects the 7th by default", () => {
    expect(canAddDockGroup(5, 6)).toBe(true);
    expect(canAddDockGroup(6, 6)).toBe(false); // 已有 6 组，第 7 组被拒
    expect(dockGroupLimitMessage(6)).toContain("最多 6 个分栏");
  });

  it("allows up to 8 when configured and rejects 9th", () => {
    expect(canAddDockGroup(7, 8)).toBe(true);
    expect(canAddDockGroup(8, 8)).toBe(false);
    expect(dockGroupLimitMessage(8)).toContain("最多 8 个分栏");
  });

  it("rejects the 3rd group when configured to 2", () => {
    expect(canAddDockGroup(1, 2)).toBe(true);
    expect(canAddDockGroup(2, 2)).toBe(false);
    expect(canAddDockGroup(3, 2)).toBe(false);
    expect(dockGroupLimitMessage(2)).toContain("最多 2 个分栏");
  });
});
