// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { forwardRef } from "react";
import { describe, expect, it, vi } from "vitest";

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

import App from "../../App.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { HTMLElement?: unknown }).HTMLElement = class {};

const router = {
  id: "router",
  workspaceId: "ws",
  name: "Router",
  role: "Coordinator",
  systemPrompt: "",
  persona: "",
  agentsMd: "",
  model: null,
  permission: "full_access",
  isRouter: true,
  status: "idle",
  createdAt: "",
};
const mika = {
  ...router,
  id: "a1",
  name: "Mika",
  role: "Designer",
  permission: "workspace_write",
  isRouter: false,
  model: "deepseek-flash",
};

const snapshot = {
  workspace: { id: "ws", name: "Workspace", path: "S:/workspace" },
  agents: [router, mika],
  tasks: [],
  messages: [],
  boardEntries: [],
  runs: [],
  settings: {
    models: [{ id: "deepseek-flash", label: "DeepSeek", providerId: "p", modelId: "deepseek-flash" }],
    providers: [{ id: "p", name: "Provider" }],
    model: "deepseek-flash",
    mock: true,
    layout: { maxDockGroups: 3 },
  },
};

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object") {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

describe("t424 App chat agent switch", () => {
  it("loads the deep-linked member, sends to it, and keeps per-agent drafts", async () => {
    const listChat = vi.fn(async (_ws: string, agentId?: string) => [
      {
        id: `${agentId}-msg`,
        workspaceId: "ws",
        agentId,
        role: "assistant",
        content: `history for ${agentId}`,
        reasoning: "",
        createdAt: new Date().toISOString(),
      },
    ]);
    const sendChat = vi.fn(async () => null);
    const getContext = vi.fn(async () => ({
      workspaceId: "ws",
      generatedAt: "",
      sections: [],
      totalChars: 0,
      truncated: false,
    }));
    const getChatTurns = vi.fn(async () => ({
      turns: [],
      hasMore: false,
      nextBefore: null,
      truncated: false,
      generatedAt: "",
    }));
    const deer = new Proxy(
      {
        listWorkspaces: async () => [snapshot.workspace],
        getSnapshot: async () => snapshot,
        listChat,
        sendChat,
        getContext,
        getChatTurns,
        listChatQuestions: async () => [],
        getChatTrajectory: async () => [],
        getTranslationSettings: async () => ({ enabled: false }),
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
      location: { hash: "#/chat?agent=a1" },
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
    };
    (globalThis as { window?: unknown }).window = win;
    (globalThis as { localStorage?: unknown }).localStorage = win.localStorage;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = win.localStorage;
    (globalThis as { history?: unknown }).history = { replaceState: () => {}, pushState: () => {} };
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
    try {
      const { act, create } = TestRenderer as any;
      let renderer: any;
      await act(async () => {
        renderer = create(<App />);
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      const textarea = () =>
        renderer.root.findByType("textarea") as any;
      expect(textarea().props["aria-label"]).toBe("给 Mika 发消息");
      expect(listChat).toHaveBeenCalledWith("ws", "a1");
      expect(textOf(renderer.toJSON())).toContain("history for a1");

      await act(async () => {
        textarea().props.onChange({ target: { value: "mika draft" } });
        await Promise.resolve();
      });
      const trigger = renderer.root
        .findAllByProps({ role: "combobox" })
        .find((node: any) => node.props["aria-label"] === "切换对话成员");
      await act(async () => {
        trigger.props.onClick();
        await Promise.resolve();
      });
      const routerOption = renderer.root
        .findAllByProps({ role: "option" })
        .find((option: any) =>
          textOf(option.children ?? option.props.children).includes("Router"),
        );
      await act(async () => {
        routerOption.props.onClick();
        for (let index = 0; index < 6; index += 1) await Promise.resolve();
      });
      expect(textarea().props["aria-label"]).toBe("给 Router 发消息");
      expect(textarea().props.value).toBe("");
      expect(listChat).toHaveBeenCalledWith("ws", "router");
      await act(async () => {
        textarea().props.onChange({ target: { value: "router draft" } });
        await Promise.resolve();
      });

      const trigger2 = renderer.root
        .findAllByProps({ role: "combobox" })
        .find((node: any) => node.props["aria-label"] === "切换对话成员");
      await act(async () => {
        trigger2.props.onClick();
        await Promise.resolve();
      });
      const mikaOption = renderer.root
        .findAllByProps({ role: "option" })
        .find((option: any) => textOf(option.children ?? option.props.children).includes("Mika"));
      await act(async () => {
        mikaOption.props.onClick();
        for (let index = 0; index < 6; index += 1) await Promise.resolve();
      });
      expect(textarea().props.value).toBe("mika draft");
      await act(async () => {
        textarea().props.onKeyDown({ key: "Enter", ctrlKey: true, preventDefault() {} });
        for (let index = 0; index < 6; index += 1) await Promise.resolve();
      });
      expect(sendChat).toHaveBeenCalledWith("ws", "a1", "mika draft");
      await act(async () => {
        renderer.unmount();
        await Promise.resolve();
      });
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  });
});
