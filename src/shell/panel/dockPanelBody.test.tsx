// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { memo } from "react";
import { describe, expect, it } from "vitest";
import type { PanelKey } from "../dock/panelRegistry.js";
import { buildPanelDeps, type PanelDepsInput } from "./panelDeps.js";
import { PanelHost, PanelHostProvider, type PanelRender } from "./PanelHost.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> }; toJSON: () => unknown; update: (element: unknown) => void; unmount: () => void };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function input(overrides: Partial<PanelDepsInput> = {}): PanelDepsInput {
  return {
    agents: [],
    tasks: [],
    workspace: { id: "w1" },
    workspaceId: "w1",
    runs: [],
    settings: { models: [] },
    boardEntries: [],
    messages: [],
    ...overrides,
  };
}

/** 与 DockShell 的 DockPanelBody 同结构的最小 fixture（真实 panel body DOM + PanelHost）。 */
function DockPanelBodyProbe({ panelKey }: { panelKey: PanelKey }) {
  return (
    <div className="dock-panel-body" data-panel={panelKey}>
      <PanelHost panelKey={panelKey} />
    </div>
  );
}

let railRenders = 0;
let railSnapshotRef: unknown = null;
const RailSnapshotProbe = memo(function RailSnapshotProbe({ snapshot }: { snapshot: { id: string } }) {
  railRenders += 1;
  railSnapshotRef = snapshot;
  return <span data-rail>{snapshot.id}</span>;
});

describe("t276 DockPanelBody / rail consistency", () => {
  it("bumps only the target DockPanelBody and leaves rail snapshot probe untouched", async () => {
    railRenders = 0;
    railSnapshotRef = null;
    const counts: Record<string, number> = {};
    const renderRef: { current: PanelRender } = {
      current: (key) => {
        counts[key] = (counts[key] ?? 0) + 1;
        return <div data-panel-content={key}>{`${key}:${counts[key]}`}</div>;
      },
    };
    const snapshot = { id: "snap-1" };
    const tree = (panelInput: PanelDepsInput) => (
      <div>
        <RailSnapshotProbe snapshot={snapshot} />
        <PanelHostProvider renderRef={renderRef} depsByKey={buildPanelDeps(panelInput)}>
          <DockPanelBodyProbe panelKey="board" />
          <DockPanelBodyProbe panelKey="context" />
        </PanelHostProvider>
      </div>
    );

    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(tree(input()));
    });
    const renderer = treeRef.current;
    if (!renderer) throw new Error("renderer not created");
    expect(counts).toEqual({ board: 1, context: 1 });
    expect(railRenders).toBe(1);
    expect(railSnapshotRef).toBe(snapshot);
    expect(renderer.root.findAllByType("div").filter((node) => node.props["data-panel"]).length).toBe(2);

    await act(async () => {
      renderer.update(
        tree(input({ boardEntries: [{ id: "b2", title: "next" }] })),
      );
    });
    expect(counts).toEqual({ board: 2, context: 1 });
    expect(railRenders).toBe(1);
    // panel 域 bump 不替换 rail/Workflow/NeedsMe 的 snapshot 引用。
    expect(railSnapshotRef).toBe(snapshot);

    await act(async () => {
      renderer.unmount();
    });
  });
});
