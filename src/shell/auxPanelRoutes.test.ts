import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PANEL_LAUNCHER_GROUPS,
  PANEL_LAUNCHER_KEYS,
  filterPanelLauncherKeys,
} from "../App.js";
import { PANEL_DEFS, routeTabFromPanel } from "./dock/panelRegistry.js";

describe("t319 aux panel routes and launcher", () => {
  it("maps context/polls/watchdog to hash routes", () => {
    expect(routeTabFromPanel("context")).toBe("context");
    expect(routeTabFromPanel("polls")).toBe("polls");
    expect(routeTabFromPanel("watchdog")).toBe("watchdog");
    expect(routeTabFromPanel("runs")).toBe("tasks");
    expect(routeTabFromPanel("chat")).toBe("chat");
    expect(PANEL_DEFS.context.routeTab).toBe("context");
    expect(PANEL_DEFS.polls.routeTab).toBe("polls");
    expect(PANEL_DEFS.watchdog.routeTab).toBe("watchdog");
  });

  it("groups every launcher panel and lists auxiliary panels", () => {
    const grouped = PANEL_LAUNCHER_GROUPS.flatMap((group) => group.keys);
    expect(grouped.sort()).toEqual([...PANEL_LAUNCHER_KEYS].sort());
    const auxiliary = PANEL_LAUNCHER_GROUPS.find((group) => group.label === "辅助面板");
    expect(auxiliary?.keys).toEqual(
      expect.arrayContaining(["context", "polls", "watchdog", "runs"]),
    );
  });

  it("filters launcher by title or key", () => {
    expect(filterPanelLauncherKeys("上下文")).toEqual(["context"]);
    expect(filterPanelLauncherKeys("polls")).toEqual(["polls"]);
    expect(filterPanelLauncherKeys("看门狗")).toEqual(["watchdog"]);
    expect(filterPanelLauncherKeys("不存在")).toEqual([]);
    expect(filterPanelLauncherKeys("")).toEqual(PANEL_LAUNCHER_KEYS);
  });

  it("keeps aux panels scrollable at 960/480", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toContain('.dock-panel-body[data-panel="context"]');
    expect(css).toContain('.dock-panel-body[data-panel="polls"]');
    expect(css).toContain('.dock-panel-body[data-panel="watchdog"]');
    expect(css).toContain("overscroll-behavior: contain");
    expect(css).toContain("max-height: 100%");
    expect(css).toContain("@media (max-width: 960px)");
  });
});
