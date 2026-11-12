// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import TeamDashboard from "./TeamDashboard";
import type { MemberCandidate, Snapshot } from "./shared/types";

vi.mock("./TaskStarMap", () => ({ default: () => null }));
vi.mock("./Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{
        props: Record<string, unknown>;
        children: unknown[];
      }>;
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
    };
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") return textOf((value as { children?: unknown }).children);
  return "";
}

function candidate(overrides: Partial<MemberCandidate> = {}): MemberCandidate {
  return {
    candidateId: "c1",
    name: "Builder",
    role: "engineer",
    responsibilities: "实现前端",
    reason: "任务需要前端",
    suggestedModelProfileId: "p1:glm",
    suggestedModelLabel: "GLM 5.3",
    permission: "read_only",
    skills: ["React"],
    risks: [],
    ...overrides,
  };
}

function snapshot(mock = false): Snapshot {
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
      mock,
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

function dashboard(
  s: Snapshot,
  onCreate = vi.fn(async (_draft: unknown) => true),
  onRecommend = vi.fn(async () => ({
    ok: true as const,
    result: {
      candidates: [candidate()],
      generatedAt: "2026-11-12T00:00:00.000Z",
      modelLabel: "GLM 5.3",
      context: { memberCount: 0, taskCount: 0, hasDescription: false },
    },
  })),
) {
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
      onCreate={onCreate}
      onRecommend={onRecommend}
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

async function renderDashboard(
  s: Snapshot,
  onCreate = vi.fn(async (_draft: unknown) => true),
  onRecommend?: any,
) {
  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = create(dashboard(s, onCreate, onRecommend));
  });
  return { renderer: renderer!, onCreate, onRecommend };
}

function button(renderer: ReturnType<typeof create>, label: string) {
  return renderer.root
    .findAllByType("button")
    .find((item) => textOf(item.children).includes(label))!;
}

describe("t272 member recommendation dialog", () => {
  it("defaults to Router tab, renders candidates and explicit hire confirmation", async () => {
    const { renderer, onCreate } = await renderDashboard(snapshot());
    const tabs = renderer.root.findAllByProps({ role: "tab" });
    expect(tabs).toHaveLength(3);
    expect(tabs.some((tab) => textOf(tab.props.children).includes("Router 推荐"))).toBe(true);
    await act(async () => {
      (button(renderer, "让 Router 推荐").props.onClick as () => void)();
    });
    expect(renderer.root.findAllByProps({ className: "member-candidate" })).toHaveLength(1);
    expect(button(renderer, "聘用")).toBeTruthy();
    await act(() => {
      (button(renderer, "聘用").props.onClick as () => void)();
    });
    expect(button(renderer, "确认聘用")).toBeTruthy();
    await act(async () => {
      await (button(renderer, "确认聘用").props.onClick as () => Promise<void>)();
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      name: "Builder",
      model: "p1:glm",
      permission: "read_only",
    });
  });

  it("ignores a double confirm while the first hire is in flight", async () => {
    let resolveCreate: ((value: boolean) => void) | undefined;
    const onCreate = vi.fn(
      (_draft: unknown) =>
        new Promise<boolean>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { renderer } = await renderDashboard(snapshot(), onCreate);
    await act(async () => {
      (button(renderer, "让 Router 推荐").props.onClick as () => void)();
    });
    await act(() => {
      (button(renderer, "聘用").props.onClick as () => void)();
    });
    const confirm = button(renderer, "确认聘用");
    await act(() => {
      void (confirm.props.onClick as () => Promise<void>)();
      void (confirm.props.onClick as () => Promise<void>)();
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    await act(async () => resolveCreate?.(true));
  });

  it("disables A/C in mock mode and keeps manual tab", async () => {
    const { renderer } = await renderDashboard(snapshot(true));
    const tabs = renderer.root.findAllByProps({ role: "tab" });
    const router = tabs.find((item) => textOf(item.props.children).includes("Router 推荐"))!;
    const manual = tabs.find((item) => textOf(item.props.children).includes("自己设定"))!;
    expect(router.props["aria-disabled"]).toBe(true);
    expect(manual.props["aria-selected"]).toBe(true);
    expect(renderer.root.findAllByProps({ className: "member-candidate" })).toHaveLength(0);
  });

  it("description generation sends mode=description and edit pre-fills manual form", async () => {
    const onRecommend = vi.fn(async () => ({
      ok: true as const,
      result: {
        candidates: [candidate()],
        generatedAt: "2026-11-12T00:00:00.000Z",
        modelLabel: "GLM 5.3",
        context: { memberCount: 0, taskCount: 0, hasDescription: true },
      },
    }));
    const { renderer } = await renderDashboard(snapshot(), vi.fn(async () => true), onRecommend);
    await act(() => {
      (button(renderer, "描述生成").props.onClick as () => void)();
    });
    const textarea = renderer.root.findAllByType("textarea")[0]!;
    await act(() => {
      (textarea.props.onChange as (event: unknown) => void)({
        target: { value: "需要一个可访问性 QA" },
      });
    });
    await act(async () => {
      (button(renderer, "生成候选").props.onClick as () => void)();
    });
    expect(onRecommend).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "description", description: "需要一个可访问性 QA" }),
    );
    await act(() => {
      (button(renderer, "编辑后聘用").props.onClick as () => void)();
    });
    const nameInput = renderer.root
      .findAllByType("input")
      .find((item) => item.props.placeholder === "Builder");
    expect(nameInput!.props.value).toBe("Builder");
  });

  it("does not switch to disabled Router tab with no model", async () => {
    const s = snapshot();
    s.settings.models = [];
    const { renderer } = await renderDashboard(s);
    const tabs = renderer.root.findAllByProps({ role: "tab" });
    const router = tabs.find((item) => textOf(item.props.children).includes("Router 推荐"))!;
    expect(router.props["aria-disabled"]).toBe(true);
    await act(() => {
      (router.props.onClick as () => void)();
    });
    expect(renderer.root.findAllByType("textarea").length).toBeGreaterThan(0);
    expect(button(renderer, "创建成员").props.disabled).toBe(true);
  });
});
