// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { forwardRef, useImperativeHandle, type Ref } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (node: unknown) => node };
});

// The App-level test forces one lazy panel to fail on its first render, then
// succeeds after the user presses retry. This exercises App route -> PanelHost
// -> LazyPanel boundary -> retry, not just the isolated LazyPanel unit.
const panelState: {
  shouldThrow: boolean;
  renders: number;
  pending: boolean;
  gate: Promise<void> | null;
  resolveGate: (() => void) | null;
} = { shouldThrow: false, renders: 0, pending: false, gate: null, resolveGate: null };

vi.mock("../git/ui/GitGraphPanel", () => ({
  default: function MockGitGraphPanel() {
    panelState.renders += 1;
    if (panelState.pending && panelState.gate) throw panelState.gate;
    if (panelState.shouldThrow) throw new Error("chunk/render failed");
    return <div data-testid="git-graph-loaded">git-graph-loaded</div>;
  },
}));

vi.mock("./dock/DockShell", () => ({
  default: forwardRef(function MockDock(_props: unknown, ref: Ref<unknown>) {
    useImperativeHandle(ref, () => ({
      openPanel: () => {},
      getOpenPanelKeys: () => [],
      closePanel: () => {},
    }));
    // App has already installed PanelHostProvider around DockShell; rendering a
    // real PanelHost goes through App's renderPanelContent and its LazyPanel.
    return (
      <div data-testid="dock-shell">
        <PanelHost panelKey="gitGraph" />
      </div>
    );
  }),
}));

import App from "../App";
import { PanelHost } from "./panel/PanelHost";

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

function fakeDeer() {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "listWorkspaces") return async () => [snapshot.workspace];
        if (key === "getSnapshot") return async () => snapshot;
        if (key === "onEvent" || key === "onRiskApproval") return () => () => {};
        if (key === "getTranslationSettings") return async () => ({ enabled: false });
        return async () => undefined;
      },
    },
  );
}

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object" && "children" in value) {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

function installWindow(hash: string) {
  const win: Record<string, unknown> = {
    deer: fakeDeer(),
    location: { hash },
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
}

async function mountApp(hash: string) {
  installWindow(hash);
  const { act, create } = TestRenderer as any;
  let renderer: any;
  await act(async () => {
    renderer = create(<App />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe("t323/t327 App-level lazy panel deep link and recovery", () => {
  it("opens #/git through App + PanelHost and shows the lazy panel after the fallback", async () => {
    panelState.shouldThrow = false;
    panelState.renders = 0;
    panelState.pending = true;
    panelState.gate = new Promise<void>((resolve) => {
      panelState.resolveGate = resolve;
    });
    const renderer = await mountApp("#/git");
    // The route selects gitGraph during App boot; the lazy panel's Suspense
    // fallback is visible while the component gate is pending.
    expect(textOf(renderer.toJSON())).toContain("正在加载面板");
    expect(textOf(renderer.toJSON())).toContain("版本图");
    const { act } = TestRenderer as any;
    await act(async () => {
      panelState.pending = false;
      panelState.resolveGate?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textOf(renderer.toJSON())).toContain("git-graph-loaded");
  });

  it("shows the lazy error state at App level and retries successfully", async () => {
    panelState.pending = false;
    panelState.shouldThrow = true;
    panelState.renders = 0;
    const renderer = await mountApp("#/git");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(textOf(renderer.toJSON())).toContain("加载失败");
    const retry = renderer.root
      .findAllByType("button")
      .find((node: any) => textOf(node.children).includes("重试"));
    expect(retry).toBeTruthy();
    panelState.shouldThrow = false;
    const { act } = TestRenderer as any;
    await act(async () => {
      retry.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textOf(renderer.toJSON())).toContain("git-graph-loaded");
    expect(panelState.renders).toBeGreaterThanOrEqual(2);
  });
});
