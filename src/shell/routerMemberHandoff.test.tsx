// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import TeamDashboard from "../TeamDashboard";
import type { MemberCandidate, Snapshot } from "../shared/types";

vi.mock("../TaskStarMap", () => ({ default: () => null }));
vi.mock("../Modal", () => ({
  default: ({ children, onClose }: { children: ReactNode; onClose?: () => void }) => (
    <div role="dialog">
      {children}
      <button type="button" aria-label="modal-close" onClick={onClose}>close</button>
    </div>
  ),
}));

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { root: any; toJSON: () => unknown; unmount: () => void };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") return textOf((value as { children?: unknown }).children);
  return "";
}

function snapshot(overrides: Partial<Snapshot["settings"]> = {}): Snapshot {
  return {
    workspace: { id: "w1", name: "Workspace", path: "C:\\workspace", overview: null, overviewEnabled: false, createdAt: "2026-11-12T00:00:00.000Z" },
    agents: [],
    tasks: [],
    messages: [],
    boardEntries: [],
    settings: {
      providers: [{ id: "p1", name: "Provider" }],
      models: [{ id: "p1:glm", providerId: "p1", modelId: "glm-5.3", label: "GLM 5.3", supportsImages: false, contextWindow: 128000, maxOutputTokens: 8192, thinkingEnabled: true, thinkingEffort: "medium" }],
      ...overrides,
    },
  } as unknown as Snapshot;
}

function candidate(overrides: Partial<MemberCandidate> = {}): MemberCandidate {
  return {
    candidateId: "c1",
    name: "A11y Reviewer",
    role: "reviewer",
    responsibilities: "Accessibility review",
    reason: "No accessibility specialist",
    suggestedModelProfileId: null,
    suggestedModelLabel: null,
    permission: "read_only",
    skills: ["a11y"],
    risks: [],
    ...overrides,
  };
}

function dashboard(options: {
  members?: MemberCandidate[];
  snapshot?: Snapshot;
  onCreate?: ReturnType<typeof vi.fn>;
  onHandled?: () => void;
}) {
  const noop = () => {};
  return (
    <TeamDashboard
      snapshot={options.snapshot ?? snapshot()}
      busy={false}
      selectedTaskId={null}
      onSelectTask={noop}
      starmapFocus={null}
      autoOpenMemberDialog={false}
      onAutoOpenHandled={noop}
      recommendedMembers={options.members}
      onRecommendedMembersHandled={options.onHandled}
      onCreate={(options.onCreate ?? vi.fn(async () => true)) as never}
      onRecommend={async () => ({ ok: false as const, code: "RECOMMEND_FAILED" as const, message: "test" })}
      onOpenSettings={noop}
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

function buttonByText(renderer: any, text: string) {
  return renderer.root.findAllByType("button").find((node: any) => textOf(node.children).includes(text));
}

describe("t415 Router recommendation handoff", () => {
  it("auto-opens the existing create modal with candidates prefilled", async () => {
    const onHandled = vi.fn();
    let renderer: any;
    await act(async () => {
      renderer = create(dashboard({ members: [candidate()], onHandled }));
      await Promise.resolve();
    });
    const output = textOf(renderer.toJSON());
    expect(output).toContain("新建成员");
    expect(output).toContain("A11y Reviewer");
    expect(output).toContain("reviewer");
    expect(output).toContain("Accessibility review");
    expect(output).toContain("No accessibility specialist");
    expect(output).toContain("read_only");
    const close = renderer.root.findByProps({ "aria-label": "modal-close" });
    await act(() => close.props.onClick());
    expect(onHandled).toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("does not create until the user confirms, then creates read_only", async () => {
    const onCreate = vi.fn(async () => true);
    let renderer: any;
    await act(async () => {
      renderer = create(dashboard({ members: [candidate()], onCreate }));
      await Promise.resolve();
    });
    const hire = buttonByText(renderer, "聘用");
    await act(() => hire!.props.onClick());
    expect(onCreate).not.toHaveBeenCalled();
    const confirm = buttonByText(renderer, "确认聘用");
    await act(async () => {
      confirm!.props.onClick();
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: "A11y Reviewer",
      role: "reviewer",
      permission: "read_only",
    }));
    act(() => renderer.unmount());
  });

  it("cancel and close do not create; edit keeps fields editable", async () => {
    const onCreate = vi.fn(async () => true);
    let renderer: any;
    await act(async () => {
      renderer = create(dashboard({ members: [candidate()], onCreate }));
      await Promise.resolve();
    });
    const edit = buttonByText(renderer, "编辑后聘用");
    await act(() => edit!.props.onClick());
    const inputs = renderer.root.findAllByType("input");
    expect(inputs.some((input: any) => input.props.value === "A11y Reviewer")).toBe(true);
    expect(inputs.some((input: any) => input.props.value === "reviewer")).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
    act(() => renderer.unmount());

    await act(async () => {
      renderer = create(dashboard({ members: [candidate()], onCreate }));
      await Promise.resolve();
    });
    const cancel = buttonByText(renderer, "聘用");
    await act(() => cancel!.props.onClick());
    const cancelConfirm = buttonByText(renderer, "取消");
    await act(() => cancelConfirm!.props.onClick());
    expect(onCreate).not.toHaveBeenCalled();
    const close = renderer.root.findByProps({ "aria-label": "modal-close" });
    await act(() => close.props.onClick());
    expect(onCreate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("shows name conflict and blocks hire", async () => {
    const onCreate = vi.fn(async () => true);
    let renderer: any;
    await act(async () => {
      renderer = create(dashboard({ members: [candidate({ nameConflict: true })], onCreate }));
      await Promise.resolve();
    });
    expect(textOf(renderer.toJSON())).toContain("名称与现有成员重复");
    const hire = buttonByText(renderer, "聘用");
    expect(hire.props.disabled).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("does not auto-open for empty candidates or mock mode", async () => {
    let empty: any;
    await act(async () => {
      empty = create(dashboard({ members: [] }));
      await Promise.resolve();
    });
    expect(empty.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => empty.unmount());

    const mockSnapshot = snapshot({ mock: true } as never);
    let mock: any;
    await act(async () => {
      mock = create(dashboard({ members: [candidate()], snapshot: mockSnapshot }));
      await Promise.resolve();
    });
    expect(textOf(mock.toJSON())).toContain("Mock");
    expect(buttonByText(mock, "聘用").props.disabled).toBe(true);
    act(() => mock.unmount());
  });
});
