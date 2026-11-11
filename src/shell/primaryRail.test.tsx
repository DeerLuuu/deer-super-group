import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import PrimaryRail, { usePrimaryRailFocus } from "./PrimaryRail";
import {
  PRIMARY_RAIL_ENTRIES,
  railFocusIndex,
  railKeyForActive,
  type PrimaryRailKey,
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
    expect(railFocusIndex(0, "ArrowRight", 5)).toBe(1);
    expect(railFocusIndex(4, "ArrowDown", 5)).toBe(0);
    expect(railFocusIndex(0, "ArrowUp", 5)).toBe(4);
    expect(railFocusIndex(1, "ArrowLeft", 5)).toBe(0);
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

  it("collapsed rail keeps explicit aria-label names for screen readers", () => {
    const html = renderToStaticMarkup(
      <PrimaryRail activeKey="board" collapsed onOpen={() => {}} />,
    );
    expect(html).toContain("primary-rail is-collapsed");
    expect(html).not.toContain("工作台");
    for (const label of ["对话", "任务", "团队", "记忆", "邮箱"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    // label 文本仍在 DOM；折叠只由 CSS display:none 处理，显式 aria-label 提供名称。
    expect(html).toContain(">记忆</span>");
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
    expect(buttons[0].props["aria-label"]).toBe("对话");
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
    act(() => {
      (buttons[1].props.onKeyDown as (event: unknown) => void)({
        key: "ArrowLeft",
        preventDefault: () => {},
      });
    });
    act(() => {
      (buttons[0].props.onKeyDown as (event: unknown) => void)({
        key: " ",
        preventDefault: () => {},
      });
    });
    expect(opened).toHaveBeenLastCalledWith("chat");
  });
});

describe("t220 App rail focus cancellation", () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  let request: ((key: PrimaryRailKey) => void) | null = null;
  const act = (callback: () => void) => {
    (TestRenderer as unknown as { act: (cb: () => void) => void }).act(callback);
  };
  const create = (element: unknown) =>
    (TestRenderer as unknown as { create: (el: unknown) => { update: (el: unknown) => void; unmount: () => void } }).create(element);

  function renderHarness(element: unknown) {
    let renderer!: { update: (el: unknown) => void; unmount: () => void };
    act(() => {
      renderer = create(element);
    });
    return renderer;
  }

  function Harness({
    activeKey,
    focus,
  }: {
    activeKey: "chat" | "tasks";
    focus: (key: PrimaryRailKey) => boolean;
  }) {
    const { requestFocus } = usePrimaryRailFocus(activeKey as never, focus);
    request = requestFocus;
    return null;
  }

  function fakeWindow() {
    const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
    const fake = {
      setTimeout: (callback: () => void, delay: number) =>
        Number(globalThis.setTimeout(callback, delay)),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        listeners.get(type)?.delete(listener);
      },
      dispatch(type: string, event: Record<string, unknown> = {}) {
        for (const listener of listeners.get(type) ?? []) listener(event);
      },
    };
    (globalThis as { window?: unknown }).window = fake;
    return fake;
  }

  afterEach(() => {
    (globalThis as { window?: unknown }).window = previousWindow;
    vi.useRealTimers();
  });

  it("cancels old rail timers when the user immediately switches to Tasks", () => {
    vi.useFakeTimers();
    fakeWindow();
    const focus = vi.fn((key: PrimaryRailKey) => key === "tasks");
    let activeKey: "chat" | "tasks" = "chat";
    const renderer = renderHarness(<Harness activeKey={activeKey} focus={focus} />);
    act(() => request?.("chat"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    activeKey = "tasks";
    act(() => {
      renderer.update(<Harness activeKey={activeKey} focus={focus} />);
    });
    act(() => request?.("tasks"));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(focus).toHaveBeenLastCalledWith("tasks");
    expect(focus.mock.calls.some(([key]) => key === "chat")).toBe(true);
    expect(focus.mock.calls.filter(([key]) => key === "tasks").length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it("does not steal focus after Cmd/Ctrl+K or Alt while a rail focus retry is pending", () => {
    vi.useFakeTimers();
    const win = fakeWindow();
    const focus = vi.fn(() => false);
    const renderer = renderHarness(<Harness activeKey="tasks" focus={focus} />);
    act(() => request?.("tasks"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const before = focus.mock.calls.length;
    win.dispatch("keydown", { key: "k", ctrlKey: true });
    win.dispatch("keydown", { key: "1", altKey: true });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(focus.mock.calls.length).toBe(before);
    act(() => renderer.unmount());
  });

  it("invalidates pending focus on pointerdown and active-panel change", () => {
    vi.useFakeTimers();
    const win = fakeWindow();
    const focus = vi.fn(() => false);
    const renderer = renderHarness(<Harness activeKey="tasks" focus={focus} />);
    act(() => request?.("tasks"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const afterStart = focus.mock.calls.length;
    win.dispatch("pointerdown", {});
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(focus.mock.calls.length).toBe(afterStart);

    act(() => request?.("tasks"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const beforeSwitch = focus.mock.calls.length;
    act(() => {
      renderer.update(<Harness activeKey="chat" focus={focus} />);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(focus.mock.calls.length).toBe(beforeSwitch);
    act(() => renderer.unmount());
  });

  it("stops retrying once the requested panel accepts focus", () => {
    vi.useFakeTimers();
    fakeWindow();
    const focus = vi.fn(() => true);
    const renderer = renderHarness(<Harness activeKey="tasks" focus={focus} />);
    act(() => request?.("tasks"));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(focus).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
