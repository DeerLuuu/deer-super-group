import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitSettingsPanel, TaskVcsPanel } from "./GitPanels.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
    };
    toJSON: () => unknown;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") return textOf((value as { children?: unknown }).children);
  return "";
}

const originalWindow = (globalThis as { window?: unknown }).window;
afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

/**
 * F7：Git 面板的初始 loading/aria 状态可用 SSR 自动回归；
 * Esc/Tab/焦点环/窄屏交互无 DOM 测试环境（仓库未装 jsdom/RTL），
 * 按 t111 实现文档 §8 的 manual-only 例外，用 t103 mock fixture Electron 冒烟复现。
 */
describe("GitPanels initial loading states", () => {
  it("TaskVcsPanel shows a busy loading status instead of an empty VCS", () => {
    const html = renderToStaticMarkup(<TaskVcsPanel taskId="t1" />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("加载 Git 状态");
    expect(html).not.toContain("尚未产生 Git 提交");
  });

  it("GitSettingsPanel shows loading before settings arrive", () => {
    const html = renderToStaticMarkup(<GitSettingsPanel workspaceId="w1" />);
    expect(html).toContain('aria-label="Git 设置"');
    expect(html).toContain("加载中");
  });
});

describe("t198 GitSettingsPanel dirty guard", () => {
  it("marks Git edits dirty and clears them after save", async () => {
    const settings = {
      workspaceId: "w1",
      mode: "auto",
      provider: "auto",
      baseBranch: "main",
      maxWorktrees: 1,
      checksCommand: null,
      checksTimeoutMs: 600_000,
      requireApproval: true,
      autoMerge: false,
      autoCreatePr: false,
      pushOnCancel: false,
      preserveWorktreeOnCancel: false,
      mergeMethod: "squash",
    };
    let savedSettings = settings;
    (globalThis as { window?: unknown }).window = {
      setTimeout,
      clearTimeout,
      deer: {
        getGitSettings: async () => settings,
        saveGitSettings: async (_workspaceId: string, next: typeof settings) => {
          savedSettings = { ...next, baseBranch: next.baseBranch };
          return savedSettings;
        },
      },
    };
    const onDirtyChange = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <GitSettingsPanel workspaceId="w1" onDirtyChange={onDirtyChange} />,
      );
    });
    const input = renderer!.root
      .findAllByType("input")
      .find((item) => item.props.value === "main");
    expect(input).toBeTruthy();
    await act(() => {
      (input!.props.onChange as (event: unknown) => void)({
        target: { value: "develop" },
      });
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    const saveButton = renderer!.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("保存 Git 设置"));
    expect(saveButton).toBeTruthy();
    await act(async () => {
      await (saveButton!.props.onClick as () => Promise<void>)();
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(textOf(renderer!.toJSON())).toContain("已保存");
    expect(savedSettings.baseBranch).toBe("develop");
  });
});
