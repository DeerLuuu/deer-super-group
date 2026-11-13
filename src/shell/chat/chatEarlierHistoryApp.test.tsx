// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { forwardRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppService } from "../../kernel/service.js";

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (node: unknown) => node };
});

vi.mock("../dock/DockShell", async () => {
  const { PanelHost } = await import("../panel/PanelHost");
  return {
    default: forwardRef(function MockDock(_props: unknown, _ref: unknown) {
      return (
        <div data-testid="dock-shell">
          <PanelHost panelKey="chat" />
        </div>
      );
    }),
  };
});

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object") {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

import App from "../../App.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { HTMLElement?: unknown }).HTMLElement = class {};

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

describe("t477 real App server-only message append", () => {
  it("appends older SQLite messages and turns, grows rows/rail, and clears preserve", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-t477-app-"));
    const workspacePath = path.join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const service = new AppService(path.join(root, "data"));
    cleanup.push(() => {
      service.close();
      rmSync(root, { recursive: true, force: true });
    });
    const workspace = await service.openWorkspace(workspacePath);
    const router = service.getSnapshot(workspace.id).agents.find((agent) => agent.isRouter)!;
    for (let index = 0; index < 300; index += 1) {
      service.store.addChatMessage({
        workspaceId: workspace.id,
        agentId: router.id,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `history ${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }
    const baseSnapshot = service.getSnapshot(workspace.id);
    const snapshot = {
      ...baseSnapshot,
      settings: {
        ...baseSnapshot.settings,
        layout: { maxDockGroups: 3, chatHistoryLimit: 0 },
      },
    };
    const listChatCalls: Array<{ options?: { limit?: number; before?: { createdAt: string; id: string } } }> = [];
    const deer = new Proxy(
      {
        listWorkspaces: async () => [workspace],
        getSnapshot: async () => snapshot,
        listChat: async (
          workspaceId: string,
          agentId?: string,
          options?: { limit?: number; before?: { createdAt: string; id: string } },
        ) => {
          listChatCalls.push({ options });
          return service.listChat(workspaceId, agentId, options);
        },
        getChatTurns: async (
          workspaceId: string,
          agentId?: string,
          options?: { limit?: number; before?: string },
        ) => service.getChatTurns(workspaceId, agentId, options),
        getContext: async (workspaceId: string, agentId?: string, taskId?: string) =>
          service.getContext(workspaceId, agentId, taskId),
        listChatQuestions: async (workspaceId: string, agentId?: string) =>
          service.listChatQuestions(workspaceId, agentId),
        getChatTrajectory: async (workspaceId: string, agentId?: string) =>
          service.getChatTrajectory(workspaceId, agentId),
        getTranslationSettings: async () => service.getTranslationSettings(),
        listRuns: async () => [],
        getWatchdogSnapshot: async () => ({ ok: true, value: null }),
        getWatchdogCosts: async () => ({ ok: true, value: null }),
        onChatEvent: () => () => {},
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
      innerWidth: 1440,
      innerHeight: 1000,
    };
    (globalThis as { window?: unknown }).window = win;
    (globalThis as { localStorage?: unknown }).localStorage = win.localStorage;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = win.localStorage;
    (globalThis as { history?: unknown }).history = {
      replaceState: () => {},
      pushState: () => {},
    };
    (globalThis as { document?: unknown }).document = {
      addEventListener: () => {},
      removeEventListener: () => {},
      hasFocus: () => true,
      activeElement: null,
      body: { style: {} },
      documentElement: { style: {} },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const scrollNode = { scrollTop: 0, scrollHeight: 2400, clientHeight: 500 };
    try {
      const { act, create } = TestRenderer as any;
      let renderer: any;
      await act(async () => {
        renderer = create(<App />, {
          createNodeMock: (element: any) =>
            element.props.className === "chat-messages" ? scrollNode : null,
        });
        for (let index = 0; index < 12; index += 1) await Promise.resolve();
      });
      const rows = () => renderer.root.findAllByProps({ className: "chat-row user" }).length;
      const ticks = () => renderer.root.findAllByProps({ "data-rail-turn": undefined }).length;
      const initialRows = rows();
      const initialTicks = renderer.root
        .findAllByType("button")
        .filter((button: any) => Boolean(button.props["data-rail-turn"])).length;
      expect(initialRows).toBeGreaterThan(10);
      expect(listChatCalls[0]?.options).toBeUndefined();

      const chat = renderer.root.findAllByProps({ className: "chat-messages" })[0];
      await act(() => {
        (chat.props.onScroll as (event: unknown) => void)({
          currentTarget: { scrollTop: 0, scrollHeight: 2400, clientHeight: 500 },
        });
      });
      const more = renderer.root
        .findAllByType("button")
        .find((button: any) => textOf(button.children).includes("加载更早"));
      expect(more).toBeTruthy();
      await act(async () => {
        (more.props.onClick as () => void)();
        for (let index = 0; index < 12; index += 1) await Promise.resolve();
      });

      expect(listChatCalls.some((call) => call.options?.before)).toBe(true);
      expect(rows()).toBe(initialRows + 10);
      const nextTicks = renderer.root
        .findAllByType("button")
        .filter((button: any) => Boolean(button.props["data-rail-turn"])).length;
      expect(nextTicks).toBeGreaterThan(initialTicks);
      expect(renderer.root.findAllByProps({ className: "chat-messages" })[0]!.props["data-scroll-preserve"]).toBe("0");
      await act(async () => {
        renderer.unmount();
        await Promise.resolve();
      });
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  });
});
