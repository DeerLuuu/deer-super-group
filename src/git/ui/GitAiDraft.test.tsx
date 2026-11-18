// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitAiDraftPanel } from "./GitAiDraft.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { root: any; toJSON: () => unknown; unmount: () => void };
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const members = [
  { id: "a1", name: "Mika", role: "Designer" },
  { id: "a2", name: "Sol", role: "Engineer" },
];

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { window?: unknown }).window;
});

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object") return textOf((value as { children?: unknown }).children);
  return "";
}

describe("t368 GitAiDraftPanel", () => {
  it("generates, edits, fills and copies a PR draft", async () => {
    const draft = { title: "Generated title", body: "Generated body" };
    const generate = vi.fn(async () => ({
      ok: true,
      draft,
      agentName: "Mika",
      modelLabel: "model",
      generatedAt: "2026-01-01T00:00:00Z",
    }));
    const writeText = vi.fn(async () => undefined);
    (globalThis as { window?: unknown }).window = {
      deer: { gitGeneratePrDraft: generate, gitGenerateMergeDraft: vi.fn() },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText } },
    });
    const onUse = vi.fn();
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GitAiDraftPanel
          kind="pr"
          workspaceId="ws"
          taskId="t1"
          members={members}
          onUse={onUse}
        />,
      );
    });
    const generateButton = renderer!.root
      .findAllByType("button")
      .find((node: any) => textOf(node.children).includes("生成 PR 描述"))!;
    await act(async () => {
      generateButton.props.onClick();
      await Promise.resolve();
    });
    expect(generate).toHaveBeenCalledWith({ workspaceId: "ws", agentId: "a1", taskId: "t1", headSha: undefined });
    const titleInput = renderer!.root.findByProps({ "aria-label": "AI PR 描述标题" });
    expect(titleInput.props.value).toBe("Generated title");
    await act(async () => {
      titleInput.props.onChange({ target: { value: "Edited title" } });
      await Promise.resolve();
    });
    const use = renderer!.root
      .findAllByType("button")
      .find((node: any) => textOf(node.children).includes("填入 PR 表单"))!;
    await act(async () => use.props.onClick());
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ title: "Edited title" }));
    const copy = renderer!.root
      .findAllByType("button")
      .find((node: any) => textOf(node.children).includes("复制"))!;
    await act(async () => {
      copy.props.onClick();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Edited title"));
    await act(() => renderer!.unmount());
  });

  it("disables generation when Mock/no model reason is supplied", async () => {
    (globalThis as { window?: unknown }).window = {
      deer: { gitGeneratePrDraft: vi.fn() },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GitAiDraftPanel
          kind="merge"
          workspaceId="ws"
          taskId="t1"
          members={members}
          disabledReason="Mock 模式不调用真实模型，AI 草稿已禁用"
        />,
      );
    });
    const generate = renderer!.root
      .findAllByType("button")
      .find((node: any) => textOf(node.children).includes("生成合并说明"))!;
    expect(generate.props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Mock 模式");
    await act(() => renderer!.unmount());
  });
});
