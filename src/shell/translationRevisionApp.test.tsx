// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { forwardRef } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (node: unknown) => node };
});

vi.mock("./dock/DockShell", () => ({
  default: forwardRef(function MockDock(_props: unknown, _ref: unknown) {
    return <div data-testid="dock-shell" />;
  }),
}));

vi.mock("../SettingsView", () => ({
  default: (props: { onSave: (settings: unknown) => Promise<unknown> }) => (
    <button
      type="button"
      data-testid="settings-save"
      onClick={() => void props.onSave({ models: [] })}
    >
      save
    </button>
  ),
}));

import App from "../App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { HTMLElement?: unknown }).HTMLElement = class {};

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

describe("t335 App translation settings revision", () => {
  it("bumps revision on successful save and keeps it on failed save", async () => {
    const saveSettings = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("save failed"));
    const deer = new Proxy(
      {
        listWorkspaces: async () => [snapshot.workspace],
        getSnapshot: async () => snapshot,
        getTranslationSettings: async () => ({ enabled: false }),
        saveSettings,
        onEvent: () => () => {},
        onRiskApproval: () => () => {},
      },
      {
        get(target, key) {
          if (key in target) return target[key as keyof typeof target];
          return async () => undefined;
        },
      },
    );
    const previousWindow = (globalThis as { window?: unknown }).window;
    const win: any = {
      deer,
      location: { hash: "#/settings" },
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
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const revision = () =>
      renderer.root.findByProps({ className: "app" }).props["data-translation-revision"];
    expect(revision()).toBe(0);
    const save = renderer.root.findByProps({ "data-testid": "settings-save" });
    await act(async () => {
      save.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(revision()).toBe(1);
    await act(async () => {
      save.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(revision()).toBe(1);
    (globalThis as { window?: unknown }).window = previousWindow;
  });
});
