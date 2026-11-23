// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import DockShellV2 from "./DockShellV2";
import DockGroup from "./DockGroup";
import { PANEL_DEFS } from "./panelRegistry";
import { defaultLayout, listGroups } from "./layoutModel";
import type { DockHandle } from "./DockShell";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { root: any; toJSON: () => unknown; unmount: () => void };
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

function installWindow() {
  const store = new Map<string, string>();
  const windowMock = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  };
  (globalThis as { window?: unknown }).window = windowMock;
  (globalThis as { localStorage?: unknown }).localStorage = windowMock.localStorage;
  return windowMock;
}

async function renderShell() {
  const windowMock = installWindow();
  const ref = createRef<DockHandle>();
  const onPanelClose = vi.fn();
  const onActive = vi.fn();
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <DockShellV2
        ref={ref}
        workspaceId="ws-1"
        dockWidth={1200}
        windowWidth={1440}
        maxGroups={6}
        initialPanelKey="chat"
        onActivePanelChange={onActive}
        onPanelClose={onPanelClose}
      />,
    );
    await Promise.resolve();
  });
  return { renderer: renderer!, ref, onPanelClose, onActive, windowMock };
}

function focusTarget(groupId: string): EventTarget {
  const group = { getAttribute: (name: string) => (name === "data-group" ? groupId : null) };
  return { closest: (selector: string) => (selector === "[data-group]" ? group : null) } as unknown as EventTarget;
}

describe("t550 DockShellV2 active group / close", () => {
  it("records the focused team group and uses it for Ctrl+Alt+W close", async () => {
    const { renderer, onPanelClose, windowMock } = await renderShell();
    const team = listGroups(defaultLayout("wide").root).find((group) => group.panels.includes("team"))!;
    const shell = renderer.root.findByProps({ className: "docktree-shell" });
    await act(async () => {
      shell.props.onFocusCapture({ target: focusTarget(team.id) });
      await Promise.resolve();
    });
    const keydown = windowMock.addEventListener.mock.calls.find(([type]) => type === "keydown")?.[1];
    expect(keydown).toBeTypeOf("function");
    const preventDefault = vi.fn();
    await act(async () => {
      keydown({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, key: "w", preventDefault });
      await Promise.resolve();
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(onPanelClose).toHaveBeenCalledTimes(1);
    expect(onPanelClose).toHaveBeenCalledWith("team");
    act(() => renderer.unmount());
  });

  it("uses the focused team group for Ctrl+Alt+Shift+ArrowLeft direction", async () => {
    const { renderer, windowMock } = await renderShell();
    const team = listGroups(defaultLayout("wide").root).find((group) => group.panels.includes("team"))!;
    const shell = renderer.root.findByProps({ className: "docktree-shell" });
    await act(async () => {
      shell.props.onFocusCapture({ target: focusTarget(team.id) });
      await Promise.resolve();
    });
    const keydown = windowMock.addEventListener.mock.calls.find(([type]) => type === "keydown")?.[1];
    const preventDefault = vi.fn();
    await act(async () => {
      keydown({
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
        metaKey: false,
        key: "ArrowLeft",
        preventDefault,
      });
      await Promise.resolve();
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ className: "docktree-group" })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ "data-panel": "team" }).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });
});

describe("t550 DockGroup a11y/state", () => {
  it("keeps all tabpanels mounted (hidden), close is decorative, aria-controls targets exist", () => {
    const group = listGroups(defaultLayout("wide").root).find((item) => item.id)!;
    // use a group with multiple panels for hidden state
    const target = listGroups(defaultLayout("wide").root).find((item) => item.panels.length > 1) ?? group;
    const htmlMarkup = renderToStaticMarkup(
      <DockGroup
        group={target}
        panelDefs={PANEL_DEFS}
        onActivate={() => {}}
        onClose={() => {}}
        onDrop={() => {}}
      />,
    );
    const html = String(htmlMarkup);
    for (const panel of target.panels) {
      expect(html).toMatch(new RegExp(`id="docktree-panel-${target.id}-${panel}"`));
      expect(html).toMatch(new RegExp(`aria-controls="docktree-panel-${target.id}-${panel}"`));
    }
    expect(html).toMatch(/docktree-panel[^"]*"[^>]*hidden/);
    expect(html).not.toMatch(/docktree-tab-close[^>]*role="button"/);
    expect(html).not.toMatch(/docktree-tab-close[^>]*tabindex/);
  });

  it("keeps every PanelHost wrapper mounted when active tab changes", () => {
    const target = listGroups(defaultLayout("wide").root).find((item) => item.panels.length > 1)!;
    const other = target.panels.find((panel) => panel !== target.active)!;
    const render = (active: string) =>
      renderToStaticMarkup(
        <DockGroup
          group={{ ...target, active: active as typeof target.active }}
          panelDefs={PANEL_DEFS}
          onActivate={() => {}}
          onClose={() => {}}
          onDrop={() => {}}
        />,
      );
    const first = String(render(target.active ?? target.panels[0]));
    const switched = String(render(other));
    for (const panel of target.panels) {
      expect(first).toMatch(new RegExp(`id="docktree-panel-${target.id}-${panel}"`));
      expect(switched).toMatch(new RegExp(`id="docktree-panel-${target.id}-${panel}"`));
    }
    expect(switched).toMatch(new RegExp(`aria-controls="docktree-panel-${target.id}-${other}"`));
  });

  it("closes the focused tab exactly once via Delete key", () => {
    const target = listGroups(defaultLayout("wide").root).find((item) => item.panels.length > 1)!;
    const onClose = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <DockGroup
          group={target}
          panelDefs={PANEL_DEFS}
          onActivate={() => {}}
          onClose={onClose}
          onDrop={() => {}}
        />,
      );
    });
    const closable = target.panels.find((panel) => PANEL_DEFS[panel].closable)!;
    const tab = renderer!.root
      .findAllByType("button")
      .find((node: any) => node.props.id === `docktree-tab-${target.id}-${closable}`)!;
    const preventDefault = vi.fn();
    act(() => tab.props.onKeyDown({ key: "Delete", preventDefault }));
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(closable);
    act(() => renderer!.unmount());
  });
});
