import { describe, expect, it } from "vitest";
import { defaultLayout, listGroups, listPanels } from "./layoutModel";
import { PANEL_DEFS, type DockVariant } from "./panelRegistry";

/**
 * t604：dockview legacy 的 buildDefaultLayout 行为（v1 fixture）：
 * - 主组 = MAIN_GROUP_ORDER 中非 defaultClosed（chat/tasks/mailbox/board），active=chat；
 * - wide/medium/narrow 额外 team 右组，active=team；
 * - single 不创建 team（team 不是默认 tab）；
 * - settings 不作为默认 tab（仍可通过启动器命令打开）。
 */
const DOCKVIEW_DEFAULT_FIXTURE: Record<
  DockVariant,
  { main: string[]; team: string[]; active: string }
> = {
  wide: { main: ["chat", "tasks", "mailbox", "board"], team: ["team"], active: "chat" },
  medium: { main: ["chat", "tasks", "mailbox", "board"], team: ["team"], active: "chat" },
  narrow: { main: ["chat", "tasks", "mailbox", "board"], team: ["team"], active: "chat" },
  single: { main: ["chat", "tasks", "mailbox", "board"], team: [], active: "chat" },
};

describe("t604 v2 default vs dockview fixture", () => {
  it("matches panel lists and active exactly for all breakpoints", () => {
    for (const variant of ["wide", "medium", "narrow", "single"] as const) {
      const fixture = DOCKVIEW_DEFAULT_FIXTURE[variant];
      const layout = defaultLayout(variant);
      const groups = listGroups(layout.root);
      expect(groups[0]?.panels, variant).toEqual(fixture.main);
      expect(groups[0]?.active, variant).toBe(fixture.active);
      if (fixture.team.length) {
        expect(groups[1]?.panels, variant).toEqual(fixture.team);
        expect(groups[1]?.active, variant).toBe("team");
        expect(groups).toHaveLength(2);
      } else {
        expect(groups).toHaveLength(1);
      }
      expect(listPanels(layout.root), variant).not.toContain("settings");
    }
  });

  it("keeps settings registered and openable without making it a default tab", () => {
    expect(PANEL_DEFS.settings.title).toBe("设置");
    for (const variant of ["wide", "medium", "narrow", "single"] as const) {
      expect(listPanels(defaultLayout(variant).root)).not.toContain("settings");
    }
  });
});
