// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DockShell, { type DockHandle } from "./DockShell";
import DockShellV2 from "./DockShellV2";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { root: any; unmount: () => void };
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("t556 DockHandle seven-method contract", () => {
  it("keeps all seven methods callable on the v2-only DockShell", async () => {
    const store = new Map<string, string>();
    const localStorageMock = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    };
    (globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      localStorage: localStorageMock,
    };
    (globalThis as { localStorage?: unknown }).localStorage = localStorageMock;
    const ref = createRef<DockHandle>();
    expect(DockShell).toBe(DockShellV2);
    const methods: Array<keyof DockHandle> = [
      "openPanel",
      "getOpenPanelKeys",
      "closeActivePanel",
      "resetLayout",
      "resetAllLayouts",
      "moveActivePanel",
      "resizeActiveGroup",
    ];
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DockShell
          ref={ref}
          workspaceId="ws-contract"
          dockWidth={1200}
          windowWidth={1440}
          maxGroups={6}
          initialPanelKey="chat"
          onActivePanelChange={() => {}}
        />,
      );
      await Promise.resolve();
    });
    const handle = ref.current!;
    for (const method of methods) expect(typeof handle[method]).toBe("function");
    expect(handle.getOpenPanelKeys()).toContain("chat");
    await act(async () => {
      handle.openPanel("gitGraph");
      handle.moveActivePanel("left");
      handle.resizeActiveGroup(40);
      handle.resetLayout();
      handle.resetAllLayouts();
      handle.closeActivePanel();
      await Promise.resolve();
    });
    expect(handle.getOpenPanelKeys()).toBeTruthy();
    act(() => renderer!.unmount());
  });
});
