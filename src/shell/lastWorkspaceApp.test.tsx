// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { forwardRef } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (node: unknown) => node };
});

vi.mock("./dock/DockShell", () => ({
  default: forwardRef(function MockDock() {
    return <div data-testid="dock-shell" />;
  }),
}));

import App from "../App";
import { LAYOUT_KEYS } from "../shared/layoutPersistence";

const workspaces = [
  { id: "ws-a", name: "A", path: "S:/a" },
  { id: "ws-b", name: "B", path: "S:/b" },
];

function snapshotFor(workspace: (typeof workspaces)[number]) {
  return {
    workspace,
    agents: [],
    tasks: [],
    messages: [],
    boardEntries: [],
    runs: [],
    settings: { models: [], providers: [], model: "", mock: true, layout: { maxDockGroups: 3 } },
  };
}

function installWindow(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  const removed: string[] = [];
  const calls: string[] = [];
  const win: any = {
    deer: new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "listWorkspaces") return async () => workspaces;
          if (key === "getSnapshot") return async (id: string) => {
            calls.push(id);
            const workspace = workspaces.find((item) => item.id === id) ?? workspaces[0];
            return snapshotFor(workspace);
          };
          if (key === "onEvent" || key === "onRiskApproval") return () => () => {};
          if (key === "getTranslationSettings") return async () => ({ enabled: false });
          return async () => undefined;
        },
      },
    ),
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
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => {
        removed.push(key);
        values.delete(key);
      },
    },
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
  return { values, removed, calls };
}

async function mountApp() {
  const { act, create } = TestRenderer as any;
  await act(async () => {
    create(<App />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("last workspace boot persistence", () => {
  it("restores the saved workspace when it still exists", async () => {
    const { calls, values } = installWindow({ [LAYOUT_KEYS.lastWorkspaceId]: "ws-b" });
    await mountApp();
    expect(calls[0]).toBe("ws-b");
    expect(values.get(LAYOUT_KEYS.lastWorkspaceId)).toBe("ws-b");
  });

  it("falls back to the first workspace and clears a stale saved id", async () => {
    const { calls, values, removed } = installWindow({ [LAYOUT_KEYS.lastWorkspaceId]: "ws-gone" });
    await mountApp();
    expect(calls[0]).toBe("ws-a");
    expect(values.get(LAYOUT_KEYS.lastWorkspaceId)).toBe("ws-a");
    expect(removed).toContain(LAYOUT_KEYS.lastWorkspaceId);
  });
});
