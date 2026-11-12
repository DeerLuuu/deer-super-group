// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { PanelKey } from "../dock/panelRegistry.js";
import { buildPanelDeps, type PanelDepsInput } from "./panelDeps.js";
import { PanelHost, PanelHostProvider, type PanelRender } from "./PanelHost.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { toJSON: () => unknown; update: (element: unknown) => void; unmount: () => void };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PanelKey[] = ["chat", "tasks", "team", "mailbox", "context", "watchdog"];

function fixture(overrides: Partial<PanelDepsInput> = {}): PanelDepsInput {
  return {
    agents: [{ id: "a1", name: "Alice" }],
    chatRouter: { id: "router", name: "Router", isRouter: true },
    tasks: [],
    workspace: { id: "w1", name: "Workspace" },
    workspaceId: "w1",
    runs: [],
    settings: { providers: [], models: [] },
    boardEntries: [],
    messages: [{ id: "m1", subject: "hello" }],
    selectedTask: null,
    selectedTaskId: null,
    trace: [],
    busy: false,
    taskStatusFilter: "all",
    createIntent: null,
    scheduler: null,
    schedulerLoading: false,
    schedulerError: null,
    taskRuns: [],
    runsLoading: false,
    runsError: null,
    selectedRunId: null,
    actionBusy: null,
    actionError: null,
    watchdogAlerts: [],
    watchdogHandoffs: [],
    taskWorkspaceSource: "tasks",
    starmapFocus: null,
    planDraft: null,
    planSource: null,
    planIssues: [],
    planBusy: false,
    planError: null,
    planConfirming: false,
    chatMessages: [],
    chatTurnsByAssistant: new Map(),
    chatTurnByUser: new Map(),
    questionsByKey: new Map(),
    questionsLoaded: true,
    pendingQuestions: [],
    chatBusy: false,
    chatInput: "",
    chatView: "chat",
    chatTrajectory: [],
    chatTrajectoryLoading: false,
    contextTaskId: null,
    contextSource: null,
    chatContextBusy: false,
    chatFullThrottle: false,
    workspaceOverview: null,
    context: null,
    selectedMessageId: null,
    selectedBoard: null,
    pollIntent: null,
    watchdogSnapshot: null,
    watchdogCosts: null,
    ...overrides,
  };
}

function mountedTree(renderRef: { current: PanelRender }, input: PanelDepsInput) {
  return (
    <PanelHostProvider renderRef={renderRef} depsByKey={buildPanelDeps(input)}>
      {mounted.map((key) => (
        <PanelHost key={key} panelKey={key} />
      ))}
    </PanelHostProvider>
  );
}

describe("t265 R2 PanelHost + t270 real panelDepsByKey", () => {
  it("uses production deps: unrelated state and messages/agents changes only bump correct panels", async () => {
    const counts: Record<string, number> = {};
    const renderRef: { current: PanelRender } = {
      current: (key) => {
        counts[key] = (counts[key] ?? 0) + 1;
        return <div data-panel={key}>{`${key}:${counts[key]}`}</div>;
      },
    };
    const base = fixture();
    const deps = buildPanelDeps(base);
    expect(deps.mailbox).toContain(base.agents);

    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(mountedTree(renderRef, base));
    });
    const renderer = treeRef.current;
    if (!renderer) throw new Error("renderer not created");
    expect(counts).toEqual({
      chat: 1,
      tasks: 1,
      team: 1,
      mailbox: 1,
      context: 1,
      watchdog: 1,
    });

    // App rerender with same slice references: no panel render.
    await act(async () => {
      renderer.update(mountedTree(renderRef, { ...base }));
    });
    expect(counts).toEqual({
      chat: 1,
      tasks: 1,
      team: 1,
      mailbox: 1,
      context: 1,
      watchdog: 1,
    });

    // Mailbox domain only.
    const messagesNext = [{ id: "m2", subject: "next" }];
    await act(async () => {
      renderer.update(mountedTree(renderRef, { ...base, messages: messagesNext }));
    });
    expect(counts).toEqual({
      chat: 1,
      tasks: 1,
      team: 1,
      mailbox: 2,
      context: 1,
      watchdog: 1,
    });

    // t270 F1：成员变化（agents 新引用）必须 bump mailbox。
    // tasks/team 消费 agents，属于合理更新；chat 只消费 router，context/watchdog 不得误触发。
    const agentsNext = [
      { id: "a1", name: "Alice" },
      { id: "a2", name: "Bob" },
    ];
    await act(async () => {
      renderer.update(mountedTree(renderRef, { ...base, agents: agentsNext }));
    });
    expect(counts).toEqual({
      chat: 1,
      tasks: 2,
      team: 2,
      mailbox: 3,
      context: 1,
      watchdog: 1,
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("renderRef is a facade to the latest renderer and late mounts read the latest version", async () => {
    let label = "old";
    const renderRef: { current: PanelRender } = {
      current: (key) => <div>{`${key}:${label}`}</div>,
    };
    const input = fixture();
    const tree = (isMounted: boolean) => (
      <PanelHostProvider renderRef={renderRef} depsByKey={buildPanelDeps(input)}>
        {isMounted ? <PanelHost panelKey="mailbox" /> : null}
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
