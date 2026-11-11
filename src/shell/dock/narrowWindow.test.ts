import { describe, expect, it } from "vitest";
import { PANEL_DEFS, panelInsertDirection, selectVariant } from "./panelRegistry";
import {
  MIN_SPLIT_DOCK_WIDTH,
  NARROW_WINDOW_MAX,
  SIDEBAR_AUTO_COLLAPSE_WIDTH,
  SIDEBAR_MAX_WIDTH,
  TASKS_MIN_WIDTH,
  clampSidebarWidth,
  isNarrowWindow,
  shouldAutoCollapseSidebar,
  sidebarMaxWidth,
} from "./narrowWindow";

describe("t194 narrow-window dock layout", () => {
  describe("selectVariant", () => {
    it.each([
      // window width, dock width, expected（≤960 即使侧栏折叠、Dock 变宽也强制单栏）
      [960, 896, "single"],
      [900, 836, "single"],
      [760, 696, "single"],
      [960, 1200, "single"],
      // 非 single 需要同时容纳 Tasks 560 + Team 360
      [1200, 900, "single"],
      [1000, 900, "single"],
      [1200, 950, "medium"],
      [1100, 1036, "medium"],
      [1440, 1190, "wide"],
    ] as const)("window=%i dock=%i → %s", (windowWidth, dockWidth, expected) => {
      expect(selectVariant(dockWidth, windowWidth)).toBe(expected);
    });

    it("defaults to existing dock-only behavior without window width", () => {
      expect(selectVariant(1190)).toBe("wide");
      expect(selectVariant(1036)).toBe("medium");
      expect(selectVariant(1036, Number.POSITIVE_INFINITY)).toBe("medium");
    });

    it("keeps the split minimum above the task min width", () => {
      expect(MIN_SPLIT_DOCK_WIDTH).toBe(TASKS_MIN_WIDTH + PANEL_DEFS.team.minWidth);
      expect(PANEL_DEFS.tasks.minWidth).toBe(TASKS_MIN_WIDTH);
    });
  });

  describe("panelInsertDirection", () => {
    it("puts Team within the main group in single variant", () => {
      expect(panelInsertDirection("single", "team")).toBe("within");
    });

    it("keeps Team as a right split on wider variants", () => {
      expect(panelInsertDirection("wide", "team")).toBe("right");
      expect(panelInsertDirection("medium", "team")).toBe("right");
      expect(panelInsertDirection("narrow", "team")).toBe("right");
    });

    it("never splits non-team panels", () => {
      for (const variant of ["single", "wide", "medium", "narrow"] as const) {
        expect(panelInsertDirection(variant, "chat")).toBe("within");
        expect(panelInsertDirection(variant, "tasks")).toBe("within");
      }
    });
  });

  describe("sidebar width guard", () => {
    it("clamps sidebar so single dock keeps tasks readable width at narrow windows", () => {
      for (const windowWidth of [760, 900, 960]) {
        const max = sidebarMaxWidth(windowWidth);
        expect(max).toBeLessThanOrEqual(SIDEBAR_MAX_WIDTH);
        expect(windowWidth - clampSidebarWidth(SIDEBAR_MAX_WIDTH, windowWidth)).toBeGreaterThanOrEqual(
          TASKS_MIN_WIDTH,
        );
        expect(windowWidth - max).toBeGreaterThanOrEqual(TASKS_MIN_WIDTH);
      }
    });

    it("clamps manual drag values", () => {
      expect(clampSidebarWidth(250, 760)).toBe(200);
      expect(clampSidebarWidth(250, 900)).toBe(250);
      expect(clampSidebarWidth(250, 960)).toBe(250);
      expect(clampSidebarWidth(480, 760)).toBe(200);
      expect(clampSidebarWidth(480, 1440)).toBe(480);
      expect(clampSidebarWidth(100, 760)).toBe(180);
      expect(clampSidebarWidth(250, 700)).toBe(180);
    });

    it("keeps wide windows at the normal 480 max", () => {
      expect(sidebarMaxWidth(1440)).toBe(SIDEBAR_MAX_WIDTH);
      expect(isNarrowWindow(960)).toBe(true);
      expect(isNarrowWindow(961)).toBe(false);
    });
  });

  describe("auto collapse edge", () => {
    it("collapses on initial narrow and on wide→narrow edge only", () => {
      expect(shouldAutoCollapseSidebar(null, 960)).toBe(true);
      expect(shouldAutoCollapseSidebar(null, 1440)).toBe(false);
      expect(shouldAutoCollapseSidebar(1200, 960)).toBe(true);
      expect(shouldAutoCollapseSidebar(SIDEBAR_AUTO_COLLAPSE_WIDTH + 1, 900)).toBe(true);
    });

    it("does not override a manual expansion inside the narrow range", () => {
      expect(shouldAutoCollapseSidebar(960, 900)).toBe(false);
      expect(shouldAutoCollapseSidebar(900, 760)).toBe(false);
      expect(shouldAutoCollapseSidebar(NARROW_WINDOW_MAX, 760)).toBe(false);
    });
  });
});
