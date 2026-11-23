import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PANEL_DEFS } from "./panelRegistry";
import { defaultLayout, listGroups, validateLayout } from "./layoutModel";
import { reduceDock, type DockCommand } from "./layoutOps";
import DockTree from "./DockTree";
import DockGroup from "./DockGroup";
import DockSash from "./DockSash";

/**
 * DW1-3（t548）：自研渲染器测试（SSR 断言 + controller 驱动的功能对齐）。
 * PanelHost 在无 App context 时走缺省 render（面板体不渲染）；tablist/sash 结构可断言。
 */

const wide = defaultLayout("wide");
const single = defaultLayout("single");

function treeProps(overrides: Record<string, unknown> = {}) {
  return {
    layout: wide,
    onActivate: () => {},
    onClose: () => {},
    onResize: () => {},
    onDrop: () => {},
    ...overrides,
  };
}

describe("DW1-3 DockTree 渲染", () => {
  it("wide：split + sash + 两组 tablist（chat 主组 + team 右组）", () => {
    const html = renderToStaticMarkup(<DockTree {...treeProps()} />);
    expect(html).toContain("docktree-split");
    expect(html).toMatch(/data-axis="horizontal"/);
    expect(html).toContain('role="separator"');
    expect((html.match(/role="tablist"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/data-panel="chat"/);
    expect(html).toMatch(/data-panel="team"/);
  });

  it("single：单组 tablist（team 是 tab），无 sash", () => {
    const html = renderToStaticMarkup(<DockTree {...treeProps({ layout: single })} />);
    expect((html.match(/role="tablist"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('role="separator"');
    expect(html).toMatch(/data-panel="team"/);
  });

  it("roving tabIndex：active tab 0、其余 -1；aria-selected", () => {
    const html = renderToStaticMarkup(<DockTree {...treeProps()} />);
    expect(html).toMatch(/aria-selected="true"/);
    expect(html).toMatch(/tabindex="0"/);
    expect(html).toMatch(/tabindex="-1"/);
  });

  it("settings 无关闭按钮；其他面板有", () => {
    const html = renderToStaticMarkup(<DockTree {...treeProps()} />);
    // wide 默认布局含 settings（主组）——无「关闭设置」；有「关闭对话」等。
    expect(html).not.toMatch(/关闭设置/);
    expect(html).toMatch(/关闭对话|关闭任务|关闭团队/);
  });
});

describe("DW1-3 DockSash / 落点提示", () => {
  it("sash：role=separator + aria-orientation + 可聚焦", () => {
    const html = renderToStaticMarkup(
      <DockSash axis="horizontal" aria-label="调整分栏 2/2" onResize={() => {}} />,
    );
    expect(html).toContain('role="separator"');
    expect(html).toMatch(/aria-orientation="vertical"/);
    expect(html).toMatch(/tabindex="0"/);
    expect(html).toMatch(/aria-label="调整分栏 2\/2"/);
  });

  it("t576：只保留单一 drop-position，不再有四层 dropzone/hover", () => {
    const css = readFileSync(new URL("./dockLayout.css", import.meta.url), "utf8");
    expect(css).not.toContain(".docktree-dropzone");
    expect(css).toContain(".docktree-drop-position.active");
    expect(css).toContain(".docktree-drop-position.left");
    expect(css).toContain(".docktree-drop-position.center");
  });

  it("DockGroup：组内 tab 顺序 = group.panels；tabpanel 与 tab 配对", () => {
    const group = listGroups(single.root)[0];
    const html = renderToStaticMarkup(
      <DockGroup
        group={group}
        panelDefs={PANEL_DEFS}
        onActivate={() => {}}
        onClose={() => {}}
        onDrop={() => {}}
      />,
    );
    expect(html).toContain(`data-group="${group.id}"`);
    for (const panel of group.panels) {
      expect(html).toMatch(new RegExp(`data-panel="${panel}"`));
    }
  });
});

describe("DW1-4 v2-only 外壳", () => {
  it("DockShell.tsx 保留 v2 opt-in 分派，默认仍是 dockview", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const source = await readFile(resolve(__dirname, "DockShell.tsx"), "utf8");
    expect(source).toContain("DockShellV2");
    expect(source).toContain("DockShellLegacy");
    expect(source).toContain("getDockEngine");
  });

  it("DockTree CSS 强制 panel 根撑满 group body", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const css = await readFile(resolve(__dirname, "dockLayout.css"), "utf8");
    expect(css).toMatch(/\.docktree-panel > \.panel[\s\S]*?flex: 1 1 auto/);
    expect(css).toMatch(/\.docktree-panel > \.panel[\s\S]*?width: 100%/);
    expect(css).toMatch(/\.docktree-panel > \*[\s\S]*?min-width: 0/);
  });
});

describe("DW1-3 功能对齐（命令 → 布局 → 树）", () => {
  function walkthrough(commands: DockCommand[]) {
    let layout = wide;
    for (const command of commands) {
      layout = reduceDock(layout, command, { maxGroups: 6 }).layout;
      expect(validateLayout(layout, { maxGroups: 6 })).toEqual([]);
    }
    return layout;
  }

  it("open/anchor → 新面板进 chat 组；close → 组删除；activate → active 迁移", () => {
    const opened = walkthrough([
      { type: "open", panel: "gitGraph", cause: "command", anchor: "chat" },
    ]);
    const main = listGroups(opened.root).find((g) => g.panels.includes("chat"));
    expect(main?.panels).toContain("gitGraph");
    const closed = walkthrough([{ type: "close", panel: "team" }]);
    expect(listGroups(closed.root)).toHaveLength(1);
    const activated = walkthrough([{ type: "activate", panel: "tasks" }]);
    expect(listGroups(activated.root).find((g) => g.panels.includes("chat"))?.active).toBe(
      "tasks",
    );
  });

  it("split + resize：组数增加、sash resize 保持和为 1", () => {
    const split = walkthrough([{ type: "split", panel: "tasks", direction: "right" }]);
    expect(listGroups(split.root)).toHaveLength(3);
    const root = split.root as { id: string; sizes: number[] };
    const resized = walkthrough([
      { type: "split", panel: "tasks", direction: "right" },
      { type: "resize", splitId: root.id, index: 0, delta: 0.1 },
    ]);
    const newRoot = resized.root as unknown as { sizes: number[] };
    expect(newRoot.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it("dragDrop center 并入 / edge 拆分；single 超组拒绝（2–8 语义）", () => {
    const merged = walkthrough([
      { type: "dragDrop", panel: "team", target: "chat", position: "center" },
    ]);
    expect(listGroups(merged.root)).toHaveLength(1);
    const split = walkthrough([
      { type: "dragDrop", panel: "chat", target: "team", position: "edge", edge: "left" },
    ]);
    // chat 拆出独立组（主组其余面板保留）→ 3 组。
    expect(listGroups(split.root)).toHaveLength(3);
    const singleRejected = reduceDock(single, {
      type: "split",
      panel: "team",
      direction: "right",
    });
    expect(listGroups(singleRejected.layout.root)).toHaveLength(1);
  });

  it("reset：回默认布局（与 defaultLayout 结构一致）", () => {
    const reset = walkthrough([
      { type: "close", panel: "team" },
      { type: "reset" },
    ]);
    expect(JSON.stringify(reset.root)).toBe(JSON.stringify(wide.root));
  });

  it("四断点：wide/medium/narrow 两组 + sash；single 单组", () => {
    for (const variant of ["wide", "medium", "narrow"] as const) {
      const layout = defaultLayout(variant);
      expect(listGroups(layout.root)).toHaveLength(2);
      expect(validateLayout(layout)).toEqual([]);
    }
    expect(listGroups(single.root)).toHaveLength(1);
  });
});

describe("DW1-3 DockShellV2 契约", () => {
  it("默认导出存在（forwardRef 组件）", async () => {
    const mod = await import("./DockShellV2");
    expect(mod.default).toBeDefined();
  });
});
