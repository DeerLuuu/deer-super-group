// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (node: unknown) => node };
});

import type { Agent, Snapshot } from "../shared/types.js";
import TeamDashboard from "../TeamDashboard.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { HTMLElement?: unknown }).HTMLElement = class {};
(globalThis as { document?: unknown }).document = {
  activeElement: null,
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { style: {} },
  documentElement: { style: {} },
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }> };
    toJSON: () => unknown;
    unmount: () => void;
  };
};

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

const owner: Agent = {
  id: "a1",
  workspaceId: "ws",
  name: "Ren",
  role: "Engineer",
  systemPrompt: "",
  persona: "",
  agentsMd: "",
  model: "deepseek-flash",
  permission: "workspace_write",
  isRouter: false,
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const snapshot = {
  workspace: { id: "ws", name: "Workspace", path: "S:/workspace" },
  agents: [owner],
  tasks: [],
  boardEntries: [],
  messages: [],
  runs: [],
  settings: { models: [], providers: [], model: "", mock: true, layout: { maxDockGroups: 3 } },
} as unknown as Snapshot;

describe("t337 Team member edit target", () => {
  it("opens the Team member editor once when task permission chip targets an owner", async () => {
    const onAutoEditHandled = vi.fn();
    const onOpenAgentChat = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TeamDashboard
          snapshot={snapshot}
          busy={false}
          selectedTaskId={null}
          onSelectTask={() => {}}
          starmapFocus={null}
          autoOpenMemberDialog={false}
          onAutoOpenHandled={() => {}}
          autoEditMemberId="a1"
          onAutoEditHandled={onAutoEditHandled}
          onCreate={async () => false}
          onRecommend={async () => ({ ok: false, code: "RECOMMEND_EMPTY", message: "" })}
          onUpdate={() => {}}
          onOpenSettings={() => {}}
          onDelete={async () => false}
          onOpenTask={() => {}}
          onOpenTaskPage={() => {}}
          onOpenMergeQueue={() => {}}
          onOpenMemory={() => {}}
          onOpenTaskGit={() => {}}
          onOpenAgentChat={onOpenAgentChat}
          scheduler={null}
          onOpenRuns={() => {}}
        />,
      );
      await Promise.resolve();
    });
    expect(onAutoEditHandled).toHaveBeenCalledTimes(1);
    const text = textOf(renderer!.toJSON());
    expect(text).toContain("编辑成员");
    expect(text).toContain("Ren");
    const chatButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "打开 Ren 的对话");
    expect(chatButton).toBeTruthy();
    await act(async () => {
      (chatButton!.props.onClick as () => void)();
    });
    expect(onOpenAgentChat).toHaveBeenCalledWith("a1");
    await act(async () => renderer!.unmount());
  });
});
