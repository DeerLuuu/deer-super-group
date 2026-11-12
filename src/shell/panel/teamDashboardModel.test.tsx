// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import TeamDashboard from "../../TeamDashboard";
import type { Snapshot } from "../../shared/types";

vi.mock("../../TaskStarMap", () => ({
  default: () => null,
}));
vi.mock("../../Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { root: { findAllByType: (type: string) => Array<{ children: unknown[] }> }; toJSON: () => unknown; unmount: () => void };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") return textOf((value as { children?: unknown }).children);
  return "";
}

function snapshot(): Snapshot {
  return {
    workspace: {
      id: "w1",
      name: "Workspace",
      path: "C:\\workspace",
      overview: null,
      overviewEnabled: false,
      createdAt: "2026-11-12T00:00:00.000Z",
    },
    agents: [],
    tasks: [],
    messages: [],
    boardEntries: [],
    settings: {
      providers: [{ id: "p1", name: "Provider" }],
      models: [
        {
          id: "p1:glm",
          providerId: "p1",
          modelId: "glm-5.3",
          label: "GLM 5.3",
          supportsImages: false,
          contextWindow: 128000,
          maxOutputTokens: 8192,
          thinkingEnabled: true,
          thinkingEffort: "medium",
        },
      ],
    },
  } as unknown as Snapshot;
}

function dashboard(s: Snapshot) {
  const noop = () => {};
  return (
    <TeamDashboard
      snapshot={s}
      busy={false}
      selectedTaskId={null}
      onSelectTask={noop}
      starmapFocus={null}
      autoOpenMemberDialog
      onAutoOpenHandled={noop}
      onCreate={noop}
      onUpdate={noop}
      onDelete={async () => false}
      onOpenTask={noop}
      onOpenTaskPage={noop}
      onOpenMergeQueue={noop}
      onOpenMemory={noop}
      onOpenTaskGit={noop}
      scheduler={null}
      onOpenRuns={noop}
    />
  );
}

describe("t276 TeamDashboard model dropdown", () => {
  it("keeps model options from snapshot.settings.models when the member dialog opens", async () => {
    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(dashboard(snapshot()));
    });
    const renderer = treeRef.current;
    if (!renderer) throw new Error("renderer not created");
    const options = renderer.root.findAllByType("option");
    expect(options.some((option) => textOf(option.children).includes("GLM 5.3"))).toBe(true);
    await act(async () => {
      renderer.unmount();
    });
  });
});
