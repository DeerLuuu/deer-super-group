import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import PrimaryRail from "./PrimaryRail";
import {
  PRIMARY_RAIL_ENTRIES,
  railFocusIndex,
  railKeyForActive,
} from "./primaryRailData";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("t216 primary rail", () => {
  it("has exactly the five primary entries in order with icons and short labels", () => {
    expect(PRIMARY_RAIL_ENTRIES.map((entry) => entry.key)).toEqual([
      "chat",
      "tasks",
      "team",
      "board",
      "mailbox",
    ]);
    expect(PRIMARY_RAIL_ENTRIES.map((entry) => entry.label)).toEqual([
      "对话",
      "任务",
      "团队",
      "记忆",
      "邮箱",
    ]);
    for (const entry of PRIMARY_RAIL_ENTRIES) {
      expect(entry.icon.length).toBeGreaterThan(0);
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  it("derives active entry from the existing panel/tab state without a second state", () => {
    expect(railKeyForActive("chat", "chat")).toBe("chat");
    expect(railKeyForActive("board", "chat")).toBe("board");
    expect(railKeyForActive("runs", "tasks")).toBe("tasks");
    expect(railKeyForActive("context", "chat")).toBe("chat");
    expect(railKeyForActive("settings", "settings")).toBeNull();
    expect(railKeyForActive(null, "mailbox")).toBe("mailbox");
    expect(railKeyForActive(null, "settings")).toBeNull();
  });

  it("moves focus with Arrow/Home/End and wraps", () => {
    expect(railFocusIndex(0, "ArrowDown", 5)).toBe(1);
    expect(railFocusIndex(4, "ArrowDown", 5)).toBe(0);
    expect(railFocusIndex(0, "ArrowUp", 5)).toBe(4);
    expect(railFocusIndex(2, "Home", 5)).toBe(0);
    expect(railFocusIndex(2, "End", 5)).toBe(4);
    expect(railFocusIndex(2, "Enter", 5)).toBeNull();
  });

  it("renders all five entries with aria-current on the active item", () => {
    const html = renderToStaticMarkup(
      <PrimaryRail activeKey="team" collapsed={false} onOpen={() => {}} />,
    );
    expect(html).toContain('aria-label="一级入口"');
    for (const label of ["对话", "任务", "团队", "记忆", "邮箱"]) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/aria-current="page"[^>]*>.*?团队/);
    expect(html).toContain("primary-rail-item is-active");
  });

  it("keeps labels in DOM (CSS hides them when collapsed) and supports click/keyboard", () => {
    const { create, act } = TestRenderer as unknown as {
      create: (element: unknown, options?: unknown) => {
        root: {
          findAllByType: (type: string) => Array<{ props: Record<string, unknown> }>;
        };
      };
      act: (callback: () => void) => void;
    };
    const focused: string[] = [];
    const opened = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    act(() => {
      renderer = create(
        <PrimaryRail activeKey={null} collapsed onOpen={opened} />,
        {
          createNodeMock: (element: { type?: string }) =>
            element.type === "button" ? { focus: () => focused.push("button") } : {},
        },
      );
    });
    const buttons = renderer!.root.findAllByType("button");
    expect(buttons).toHaveLength(5);
    expect(buttons[0].props.title).toBe("对话");
    act(() => {
      (buttons[0].props.onClick as () => void)();
    });
    expect(opened).toHaveBeenCalledWith("chat");
    act(() => {
      (buttons[0].props.onKeyDown as (event: unknown) => void)({
        key: "ArrowDown",
        preventDefault: () => {},
      });
    });
    expect(focused.length).toBeGreaterThan(0);
    act(() => {
      (buttons[1].props.onKeyDown as (event: unknown) => void)({
        key: "Enter",
        preventDefault: () => {},
      });
    });
    expect(opened).toHaveBeenCalledWith("tasks");
  });
});
