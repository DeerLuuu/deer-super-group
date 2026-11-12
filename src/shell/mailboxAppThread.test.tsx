// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { forwardRef, useImperativeHandle, type Ref } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (node: unknown) => node };
});

vi.mock("../CommandPalette", () => ({
  default: ({ onOpenMessage }: { onOpenMessage: (id: string) => void }) => (
    <button data-testid="palette-open-message" onClick={() => onOpenMessage("reply-1")}>
      打开测试邮件线程
    </button>
  ),
  CREATE_LABELS: {},
  CREATE_TARGET_TAB: {},
}));

vi.mock("./dock/DockShell", () => ({
  default: forwardRef(function MockDock(_props: unknown, ref: Ref<unknown>) {
    useImperativeHandle(ref, () => ({
      openPanel: () => {},
      getOpenPanelKeys: () => [],
      closePanel: () => {},
    }));
    return (
      <div data-testid="dock-shell">
        <PanelHost panelKey="mailbox" />
      </div>
    );
  }),
}));

import App from "../App";
import { PanelHost } from "./panel/PanelHost";

const workspace = { id: "ws", name: "Workspace", path: "S:/workspace" };
const messages = [
  {
    id: "root-1",
    workspaceId: "ws",
    threadId: "thread-1",
    from: "Router",
    to: ["Builder"],
    kind: "request",
    subject: "Root subject",
    body: "Root body",
    refs: [],
    createdAt: "2026-01-01T00:00:01Z",
  },
  {
    id: "reply-1",
    workspaceId: "ws",
    threadId: "thread-1",
    parentId: "root-1",
    from: "Builder",
    to: ["Router"],
    kind: "report",
    subject: "Re: Root subject",
    body: "Reply body",
    refs: [],
    createdAt: "2026-01-01T00:00:02Z",
  },
];
const snapshot = {
  workspace,
  agents: [],
  tasks: [],
  messages,
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
        if (key === "listWorkspaces") return async () => [workspace];
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

describe("t405 App-level mailbox thread navigation", () => {
  it("opens a reply from the Command Palette and locates its thread in MailboxView", async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const storage = new Map<string, string>();
    const webStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };
    const win = {
      deer: fakeDeer(),
      location: { hash: "#/tasks" },
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      confirm: () => true,
      localStorage: webStorage,
      sessionStorage: webStorage,
    };
    (globalThis as { window?: unknown }).window = win;
    (globalThis as { localStorage?: unknown }).localStorage = webStorage;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = webStorage;
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
    expect(renderer.root.findAllByProps({ "data-testid": "palette-open-message" })).toHaveLength(0);

    await act(async () => {
      listeners.get("keydown")?.({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        key: "k",
        preventDefault: () => {},
      });
      await Promise.resolve();
    });
    const paletteButton = renderer.root.findAllByProps({ "data-testid": "palette-open-message" })[0];
    expect(paletteButton).toBeTruthy();
    await act(async () => {
      (paletteButton.props.onClick as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });

    const output = textOf(renderer.toJSON());
    expect(output).toContain("Root subject");
    expect(output).toContain("Reply body");
    const options = renderer.root.findAllByProps({ role: "option" });
    expect(options.some((option: any) => option.props["aria-label"]?.includes("Root subject"))).toBe(true);
    expect(options.some((option: any) => option.props["aria-selected"] === true)).toBe(true);
  });
});
