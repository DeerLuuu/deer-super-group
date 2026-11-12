// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import type { PanelKey } from "../dock/panelRegistry.js";
import { PanelHost, PanelHostProvider, type PanelDeps, type PanelRender } from "./PanelHost.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { toJSON: () => unknown; update: (element: unknown) => void; unmount: () => void };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const six: PanelKey[] = ["chat", "tasks", "team", "mailbox", "board", "runs"];

describe("t265 R2 PanelHost", () => {
  it("6 mounted panels: unrelated provider render does not render any panel; one domain bump renders only that panel", async () => {
    const counts: Record<string, number> = {};
    const renderRef: { current: PanelRender } = {
      current: (key) => {
        counts[key] = (counts[key] ?? 0) + 1;
        return <div data-panel={key}>{`${key}:${counts[key]}`}</div> as ReactNode;
      },
    };
    const baseDeps: PanelDeps = {
      chat: [1],
      tasks: [1],
      team: [1],
      mailbox: [1],
      board: [1],
      runs: [1],
    };
    const tree = (
      <PanelHostProvider renderRef={renderRef} depsByKey={baseDeps}>
        {six.map((key) => (
          <PanelHost key={key} panelKey={key} />
        ))}
      </PanelHostProvider>
    );

    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(tree);
    });
    const renderer = treeRef.current;
    if (!renderer) throw new Error("renderer not created");
    expect(counts).toEqual({ chat: 1, tasks: 1, team: 1, mailbox: 1, board: 1, runs: 1 });

    // App rerender with a new deps object, but identical array references: no panel render.
    await act(async () => {
      renderer.update(
        <PanelHostProvider renderRef={renderRef} depsByKey={{ ...baseDeps }}>
          {six.map((key) => (
            <PanelHost key={key} panelKey={key} />
          ))}
        </PanelHostProvider>,
      );
    });
    expect(counts).toEqual({ chat: 1, tasks: 1, team: 1, mailbox: 1, board: 1, runs: 1 });

    // Only mailbox's domain changes.
    await act(async () => {
      renderer.update(
        <PanelHostProvider
          renderRef={renderRef}
          depsByKey={{ ...baseDeps, mailbox: [2] }}
        >
          {six.map((key) => (
            <PanelHost key={key} panelKey={key} />
          ))}
        </PanelHostProvider>,
      );
    });
    expect(counts).toEqual({ chat: 1, tasks: 1, team: 1, mailbox: 2, board: 1, runs: 1 });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("renderRef is a facade to the latest renderer and late mounts read the latest version", async () => {
    let label = "old";
    const renderRef: { current: PanelRender } = {
      current: (key) => <div>{`${key}:${label}`}</div>,
    };
    const deps: PanelDeps = { mailbox: [1] };
    const tree = (mounted: boolean) => (
      <PanelHostProvider renderRef={renderRef} depsByKey={deps}>
        {mounted ? <PanelHost panelKey="mailbox" /> : null}
      </PanelHostProvider>
    );
    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(tree(false));
    });
    label = "latest";
    await act(async () => {
      treeRef.current?.update(tree(true));
    });
    expect(JSON.stringify(treeRef.current?.toJSON())).toContain("mailbox:latest");
  });
});
