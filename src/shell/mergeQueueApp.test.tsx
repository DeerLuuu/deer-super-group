// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { forwardRef, useImperativeHandle } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (node: unknown) => node };
});

const opened: string[] = [];
const closed: string[] = [];

vi.mock("./dock/DockShell", () => ({
  default: forwardRef(function MockDock(props: any, ref: any) {
    useImperativeHandle(ref, () => ({
      openPanel: (key: string) => {
        opened.push(key);
        props.onActivePanelChange?.(key);
      },
      getOpenPanelKeys: () => opened,
      closePanel: (key: string) => {
        closed.push(key);
        props.onPanelClose?.(key);
      },
    }));
    return (
      <div data-testid="dock-shell">
        <button type="button" aria-label="dock-close-mergeQueue" onClick={() => props.onPanelClose?.("mergeQueue")}>
          close
        </button>
      </div>
    );
  }),
}));

import App from "../App";

const snapshot = {
  workspace: { id: "ws", name: "Workspace", path: "S:/workspace" },
  agents: [],
  tasks: [],
  messages: [],
  boardEntries: [],
  runs: [],
  settings: {
    models: [],
    providers: [],
    model: "",
    mock: true,
    layout: { maxDockGroups: 3 },
  },
};

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object" && "children" in value) {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

function fakeDeer() {  const base: Record<string, unknown> = {};
  return new Proxy(base, {
    get(_target, key) {
      if (key === "listWorkspaces") return async () => [snapshot.workspace];
      if (key === "getSnapshot") return async () => snapshot;
      if (key === "onEvent" || key === "onRiskApproval") return () => () => {};
      if (key === "getTranslationSettings") return async () => ({ enabled: false });
      if (key === "mergeQueue") return async () => ({ workspaceId: "ws", items: [], activeMerge: null, updatedAt: "" });
      return async () => undefined;
    },
  });
}

describe("t317 App/Dock MergeQueue entry recovery", () => {
  it("opens via sidebar, closes via Dock X, and reopens via sidebar/team/launcher handlers", async () => {
    const previous = (globalThis as { window?: unknown }).window;
    const win: any = {
      deer: fakeDeer(),
      location: { hash: "#/chat" },
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      confirm: () => true,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    (globalThis as { window?: unknown }).window = win;
    (globalThis as { localStorage?: unknown }).localStorage = win.localStorage;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = win.localStorage;
    (globalThis as { history?: unknown }).history = { replaceState: () => {}, pushState: () => {} };
    (globalThis as { document?: unknown }).document = {
      addEventListener: () => {},
      removeEventListener: () => {},
      body: { style: {} },
      documentElement: { style: {} },
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });
    // The sidebar entry is rendered by the real App shell.
    const sidebar = renderer.root.findAllByType("button").find((node: any) => node.props.title === "打开合并队列面板");
    expect(sidebar).toBeTruthy();
    await act(async () => {
      sidebar.props.onClick();
      await Promise.resolve();
    });
    expect(opened).toContain("mergeQueue");
    const close = renderer.root.findByProps({ "aria-label": "dock-close-mergeQueue" });
    await act(async () => {
      close.props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      sidebar.props.onClick();
      await Promise.resolve();
    });
    expect(opened.filter((key: string) => key === "mergeQueue").length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "dock-close-mergeQueue" }).props.onClick();
      await Promise.resolve();
    });
    const panelMenu = renderer.root.findAllByType("button").find((node: any) => node.props["aria-label"] === "面板");
    expect(panelMenu).toBeTruthy();
    await act(async () => {
      panelMenu.props.onClick();
      await Promise.resolve();
    });
    const launcher = renderer.root.findAllByProps({ role: "menuitem" }).find((node: any) =>
      textOf(node.children).includes("合并队列"),
    );
    expect(launcher).toBeTruthy();
    await act(async () => {
      launcher.props.onClick();
      await Promise.resolve();
    });
    expect(opened.filter((key: string) => key === "mergeQueue").length).toBeGreaterThanOrEqual(3);
    (globalThis as { window?: unknown }).window = previous;
  });
});
