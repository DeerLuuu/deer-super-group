import { describe, expect, it } from "vitest";
import { PANEL_DEFS, panelInsertDirection, selectVariant } from "./panelRegistry";
import {
  DOCK_SASH_WIDTH,
  MIN_SPLIT_DOCK_WIDTH,
  NARROW_WINDOW_MAX,
  SIDEBAR_AUTO_COLLAPSE_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_RESIZER_WIDTH,
  TASKS_MIN_WIDTH,
  TEAM_MIN_WIDTH,
  clampSidebarWidth,
  commitSidebarWidth,
  displayedSidebarWidth,
  effectivePanelMinWidth,
  isNarrowWindow,
  resizeSidebarWidth,
  shouldAutoCollapseSidebar,
  sidebarMaxWidth,
  sidebarWidthStateForWindow,
  singleDockWidth,
} from "./narrowWindow";

describe("t194/t212 narrow-window dock layout", () => {
  describe("selectVariant", () => {
    it.each([
      // window width, actual dock width, expected（≤960 即使侧栏折叠、Dock 变宽也强制单栏）
      [960, 898, "single"],
      [900, 838, "single"],
      [760, 698, "single"],
      [960, 1200, "single"],
      // 非 single 需要 Tasks 560 + sash 4 + Team 360 = 924
      [1200, 923, "single"],
      [1200, 924, "medium"],
      [1000, 924, "medium"],
      [1100, 1038, "medium"],
      [1440, 1184, "wide"],
    ] as const)("window=%i dock=%i → %s", (windowWidth, dockWidth, expected) => {
      expect(selectVariant(dockWidth, windowWidth)).toBe(expected);
    });

    it("keeps legacy dock-only behavior for existing callers/tests", () => {
      expect(selectVariant(1190)).toBe("wide");
      expect(selectVariant(1036)).toBe("medium");
      expect(selectVariant(900)).toBe("medium");
      expect(selectVariant(760)).toBe("narrow");
    });

    it("accounts for the dock sash in the split minimum", () => {
      expect(DOCK_SASH_WIDTH).toBe(4);
      expect(MIN_SPLIT_DOCK_WIDTH).toBe(TASKS_MIN_WIDTH + DOCK_SASH_WIDTH + TEAM_MIN_WIDTH);
      expect(MIN_SPLIT_DOCK_WIDTH).toBe(924);
      expect(PANEL_DEFS.tasks.minWidth).toBe(TASKS_MIN_WIDTH);
    });

    it("covers 1440 → 1100 → 960 → 900 → 760 transitions", () => {
      const sequence = [
        [1440, 1440 - 250 - SIDEBAR_RESIZER_WIDTH],
        [1100, 1100 - 56 - SIDEBAR_RESIZER_WIDTH],
        [960, 960 - 56 - SIDEBAR_RESIZER_WIDTH],
        [900, 900 - 56 - SIDEBAR_RESIZER_WIDTH],
        [760, 760 - 56 - SIDEBAR_RESIZER_WIDTH],
      ] as const;
      expect(sequence.map(([windowWidth, dock]) => selectVariant(dock, windowWidth))).toEqual([
        "wide",
        "medium",
        "single",
        "single",
        "single",
      ]);
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

  describe("sidebar width budget", () => {
    it("subtracts the 6px sidebar resizer from the narrow max width", () => {
      expect(SIDEBAR_RESIZER_WIDTH).toBe(6);
      expect(sidebarMaxWidth(760)).toBe(760 - TASKS_MIN_WIDTH - 6);
      expect(sidebarMaxWidth(900)).toBe(900 - TASKS_MIN_WIDTH - 6);
      expect(sidebarMaxWidth(960)).toBe(960 - TASKS_MIN_WIDTH - 6);
      expect(sidebarMaxWidth(1440)).toBe(SIDEBAR_MAX_WIDTH);
    });

    it("keeps the actual single dock >= 560 at 760/900/960 expanded", () => {
      for (const windowWidth of [760, 900, 960]) {
        const displayed = clampSidebarWidth(SIDEBAR_MAX_WIDTH, windowWidth);
        expect(singleDockWidth(windowWidth, displayed)).toBeGreaterThanOrEqual(TASKS_MIN_WIDTH);
        expect(displayed).toBeLessThanOrEqual(sidebarMaxWidth(windowWidth));
      }
    });

    it("clamps manual drag values", () => {
      expect(clampSidebarWidth(250, 760)).toBe(194);
      expect(clampSidebarWidth(250, 900)).toBe(250);
      expect(clampSidebarWidth(250, 960)).toBe(250);
      expect(clampSidebarWidth(480, 760)).toBe(194);
      expect(clampSidebarWidth(480, 1440)).toBe(480);
      expect(clampSidebarWidth(100, 760)).toBe(180);
      expect(clampSidebarWidth(250, 700)).toBe(180);
    });

    it("keeps wide windows at the normal 480 max", () => {
      expect(sidebarMaxWidth(1440)).toBe(SIDEBAR_MAX_WIDTH);
      expect(isNarrowWindow(960)).toBe(true);
      expect(isNarrowWindow(961)).toBe(false);
    });

    it("falls back to actual dock width for single <560 (960@200% zoom)", () => {
      // 960 Electron window @200% => 480 CSS viewport, 56 collapsed sidebar, 6 resizer
      const dock = singleDockWidth(480, 56);
      expect(dock).toBe(418);
      expect(effectivePanelMinWidth(560, true, dock)).toBe(418);
      // 正常 560/≥560 dock 仍保持 560
      expect(effectivePanelMinWidth(560, true, 560)).toBe(560);
      expect(effectivePanelMinWidth(560, true, 904)).toBe(560);
      expect(effectivePanelMinWidth(560, false, 904)).toBe(560);
    });
  });

  describe("preferredWidth vs displayedWidth", () => {
    it("760 narrow drag only changes display and 1440 restores the preferred value", () => {
      const initial = { preferred: 250, displayed: null };
      // 宽窗拖拽：改 preferred
      const wideDrag = resizeSidebarWidth(initial, 1440, 400);
      expect(wideDrag).toEqual({ preferred: 400, displayed: null });
      // 窄窗拖拽：只改 display，preferred 保持 400
      const narrowDrag = resizeSidebarWidth(wideDrag, 760, 480);
      expect(narrowDrag).toEqual({ preferred: 400, displayed: 194 });
      expect(displayedSidebarWidth(narrowDrag, 760)).toBe(194);
      // 窄窗 mouseup 不持久化
      expect(commitSidebarWidth(narrowDrag, 760)).toEqual({
        preferred: 400,
        displayed: 194,
        persist: false,
      });
      // 回到宽窗：display override 清掉，恢复 preferred
      const restored = sidebarWidthStateForWindow(narrowDrag, 1440);
      expect(restored).toEqual({ preferred: 400, displayed: null });
      expect(displayedSidebarWidth(restored, 1440)).toBe(400);
    });

    it("never lets a narrow display override leak into wide rendering", () => {
      const narrow = resizeSidebarWidth({ preferred: 250, displayed: null }, 760, 480);
      expect(displayedSidebarWidth(narrow, 760)).toBe(194);
      // 同一 narrow 档内 display override 保留，但跨到 wide 必须回 preferred。
      expect(displayedSidebarWidth(narrow, 900)).toBe(194);
      expect(displayedSidebarWidth(narrow, 1440)).toBe(250);
      expect(displayedSidebarWidth({ preferred: 250, displayed: 194 }, 1440)).toBe(250);
    });

    it("wide mouseup persists preferred; narrow mouseup does not", () => {
      const wide = resizeSidebarWidth({ preferred: 250, displayed: null }, 1440, 400);
      expect(commitSidebarWidth(wide, 1440)).toEqual({
        preferred: 400,
        displayed: null,
        persist: true,
      });
      const narrow = resizeSidebarWidth({ preferred: 400, displayed: null }, 760, 480);
      expect(commitSidebarWidth(narrow, 760).persist).toBe(false);
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
