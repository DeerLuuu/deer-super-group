// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { LazyPanel } from "./LazyPanel.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }> };
    toJSON: () => unknown;
    update: (element: unknown) => void;
    unmount: () => void;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") return textOf((value as { children?: unknown }).children);
  return "";
}

function Panel({ label }: { label: string }) {
  return <div className="lazy-panel-content">loaded {label}</div>;
}

describe("t323 LazyPanel", () => {
  it("shows a role=status skeleton then swaps in the lazy panel without remounting the shell", async () => {
    let resolve!: (value: { default: typeof Panel }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ default: typeof Panel }>((done) => {
          resolve = done;
        }),
    );
    const tree = (
      <LazyPanel load={load} label="团队">
        {(Component) => <Component label="团队" />}
      </LazyPanel>
    );
    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(tree);
    });
    expect(textOf(treeRef.current?.toJSON())).toContain("正在加载面板");
    expect(textOf(treeRef.current?.toJSON())).toContain("团队");

    await act(async () => {
      resolve({ default: Panel });
      await Promise.resolve();
    });
    expect(textOf(treeRef.current?.toJSON())).toContain("loaded");
    expect(textOf(treeRef.current?.toJSON())).toContain("团队");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shows an error state and retries with a fresh loader after a failed chunk", async () => {
    let attempts = 0;
    const load = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("chunk failed"));
      return Promise.resolve({ default: Panel });
    });
    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(
        <LazyPanel load={load} label="设置">
          {(Component) => <Component label="设置" />}
        </LazyPanel>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const errorState = textOf(treeRef.current?.toJSON());
    expect(errorState).toContain("加载失败");
    expect(errorState).toContain("重试");

    const retry = treeRef.current?.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("重试"));
    expect(retry).toBeTruthy();
    await act(async () => {
      (retry!.props.onClick as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textOf(treeRef.current?.toJSON())).toContain("loaded");
    expect(textOf(treeRef.current?.toJSON())).toContain("设置");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
