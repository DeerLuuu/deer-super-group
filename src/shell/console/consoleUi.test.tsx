// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ConsoleSession, ConsoleSnapshot } from "../../shared/console.js";
import { ConsoleStore } from "./consoleStore.js";
import { BackgroundTasksButton } from "./BackgroundTasksPopover.js";
import { ConsolePanel } from "./ConsolePanel.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
    };
    toJSON: () => unknown;
    update: (element: unknown) => void;
    unmount: () => void;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "ws-1";
const started = "2026-01-01T00:00:00.000Z";

function session(overrides: Partial<ConsoleSession> = {}): ConsoleSession {
  return {
    id: "con_1",
    workspaceId: WS,
    title: "dev server",
    command: "pnpm dev",
    cwd: "/workspace",
    cwdRelative: ".",
    source: "manual",
    status: "running",
    pid: 123,
    startedAt: started,
    endedAt: null,
    durationMs: 12_000,
    exitCode: null,
    signal: null,
    seq: 0,
    bytes: 7,
    truncated: false,
    droppedBytes: 0,
    error: null,
    ...overrides,
  };
}

function snapshot(value: ConsoleSession): ConsoleSnapshot {
  return { session: value, output: "initial output\n", truncated: false, droppedBytes: 0, seq: 0 };
}

function makeStore(values: ConsoleSession[], startResult?: ConsoleSession) {
  const api = {
    consoleList: vi.fn(async () => values),
    consoleSnapshot: vi.fn(async () => ({ ok: true as const, value: snapshot(values[0]!) })),
    consoleStart: vi.fn(async () =>
      startResult
        ? { ok: true as const, value: startResult }
        : { ok: false as const, error: { code: "CONSOLE_INTERNAL" as const, message: "nope", retryable: false } },
    ),
    consoleStop: vi.fn(async () => ({
      ok: true as const,
      value: { ...values[0]!, status: "stopped" as const },
    })),
    consoleInput: vi.fn(async () => ({ ok: true as const, value: { accepted: true } })),
    consoleClear: vi.fn(async () => ({ ok: true as const, value: values[0]! })),
    consoleCwds: vi.fn(async () => ({
      ok: true as const,
      value: [{ relative: ".", absolute: "/workspace" }],
    })),
  };
  return { store: new ConsoleStore(api), api };
}

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object") {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

describe("t448 console UI", () => {
  it("shows the Chat background badge, popover list, empty state, and opens a session", async () => {
    const running = session();
    const exited = session({ id: "con_2", title: "tests", command: "pnpm test", status: "exited", exitCode: 0 });
    const { store } = makeStore([running, exited]);
    const open = vi.fn();
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<BackgroundTasksButton store={store} onOpenConsole={open} />);
      await store.setWorkspace(WS);
    });
    const trigger = renderer!.root
      .findAllByProps({ className: "ghost tiny background-tasks-trigger" })[0]!;
    expect(trigger.props["aria-label"]).toBe("后台任务，1 个运行中");
    await act(async () => {
      (trigger.props.onClick as () => void)();
    });
    expect(textOf(renderer!.toJSON())).toContain("dev server");
    expect(textOf(renderer!.toJSON())).toContain("tests");
    const item = renderer!.root
      .findAllByProps({ role: "option" })
      .find((node) => textOf(node.children ?? node.props.children).includes("dev server"))!;
    await act(async () => {
      (item.props.onClick as () => void)();
    });
    expect(open).toHaveBeenCalledWith("con_1");
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  it("renders tabs/log/composer, sends stdin, stops, and confirms closing a running tab", async () => {
    const running = session();
    const second = session({ id: "con_2", title: "worker", command: "pnpm work" });
    const { store, api } = makeStore([running, second], running);
    const confirm = vi.fn(() => true);
    const previousConfirm = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { confirm } as never;
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<ConsolePanel store={store} workspaceId={WS} />);
      await store.setWorkspace(WS);
    });
    expect(renderer!.root.findAllByProps({ role: "tablist" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ role: "log" })[0]!.props["aria-live"]).toBe("polite");
    expect(renderer!.root.findAllByProps({ role: "tab" })[0]!.props["aria-selected"]).toBe(true);
    const input = renderer!.root.findAllByProps({ "aria-label": "控制台输入" })[0]!;
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { value: "hello" } });
      await Promise.resolve();
    });
    await act(async () => {
      (renderer!.root.findAllByProps({ "aria-label": "控制台输入" })[0]!.props.onKeyDown as (event: unknown) => void)({
        key: "Enter",
        shiftKey: false,
        preventDefault() {},
      });
      await Promise.resolve();
    });
    expect(api.consoleInput).toHaveBeenCalledWith(WS, "con_1", "hello\n");
    const stop = renderer!.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("停止"))!;
    await act(async () => {
      (stop.props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(api.consoleStop).toHaveBeenCalled();
    const restart = renderer!.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("重启"))!;
    await act(async () => {
      (restart.props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(api.consoleStart).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ command: "pnpm dev", cwd: ".", title: "dev server" }),
    );
    const clear = renderer!.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("清屏"))!;
    await act(async () => {
      (clear.props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(api.consoleClear).toHaveBeenCalled();
    const close = renderer!.root.findAllByProps({ "aria-label": "关闭 worker" })[0]!;
    await act(async () => {
      (close.props.onClick as (event: unknown) => void)({ stopPropagation() {} });
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalled();
    expect(store.visibleSessions().map((item) => item.id)).not.toContain("con_2");
    (globalThis as { window?: unknown }).window = previousConfirm;
    await act(() => renderer!.unmount());
  });

  it("opens a new command form from + while another tab is running", async () => {
    const running = session();
    const { store, api } = makeStore([running], session({ id: "con_new" }));
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<ConsolePanel store={store} workspaceId={WS} />);
      await store.setWorkspace(WS);
    });
    expect(renderer!.root.findAllByProps({ "aria-label": "控制台输入" })).toHaveLength(1);
    await act(async () => {
      (renderer!.root.findAllByProps({ "aria-label": "新建控制台" })[0]!.props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(renderer!.root.findAllByProps({ "aria-label": "运行命令" })).toHaveLength(1);
    const input = renderer!.root.findAllByProps({ "aria-label": "运行命令" })[0]!;
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { value: "npm run lint" } });
      await Promise.resolve();
    });
    await act(async () => {
      (renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.children).includes("启动"))!
        .props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(api.consoleStart).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ command: "npm run lint" }),
    );
    await act(() => renderer!.unmount());
  });

  it("shows a danger confirmation and retries start with the one-time token", async () => {
    const created = session({ id: "con_danger", status: "starting" });
    const api = {
      consoleList: vi.fn(async () => []),
      consoleSnapshot: vi.fn(),
      consoleStart: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false as const,
          error: {
            code: "CONSOLE_CONFIRM_REQUIRED" as const,
            message: "需要确认",
            retryable: false,
            details: { confirmToken: "tok-1", reasons: ["递归删除"] },
          },
        })
        .mockResolvedValueOnce({ ok: true as const, value: created }),
      consoleStop: vi.fn(),
      consoleInput: vi.fn(),
      consoleClear: vi.fn(),
      consoleCwds: vi.fn(async () => ({ ok: true as const, value: [] })),
    };
    const store = new ConsoleStore(api);
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<ConsolePanel store={store} workspaceId={WS} />);
      await store.setWorkspace(WS);
    });
    const input = renderer!.root.findAllByProps({ "aria-label": "运行命令" })[0]!;
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { value: "rm -rf ." } });
      await Promise.resolve();
    });
    await act(async () => {
      (renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.children).includes("启动"))!
        .props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(renderer!.root.findAllByProps({ role: "alertdialog" })).toHaveLength(1);
    expect(textOf(renderer!.toJSON())).toContain("递归删除");
    await act(async () => {
      (renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.children).includes("确认并启动"))!
        .props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(api.consoleStart).toHaveBeenCalledTimes(2);
    expect((api.consoleStart.mock.calls[1] as unknown[])[1]).toMatchObject({
      command: "rm -rf .",
      confirmToken: "tok-1",
    });
    await act(() => renderer!.unmount());
  });

  it("shows an empty state and starts a command with cwd", async () => {
    const created = session({ id: "con_new", status: "starting" });
    const { store, api } = makeStore([], created);
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<ConsolePanel store={store} workspaceId={WS} />);
      await store.setWorkspace(WS);
    });
    expect(textOf(renderer!.toJSON())).toContain("还没有控制台任务");
    const input = renderer!.root.findAllByProps({ "aria-label": "运行命令" })[0]!;
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { value: "pnpm test" } });
      await Promise.resolve();
    });
    const start = renderer!.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("启动"))!;
    await act(async () => {
      (start.props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(api.consoleStart).toHaveBeenCalledWith(WS, {
      command: "pnpm test",
      cwd: ".",
      title: undefined,
      confirmToken: undefined,
    });
    expect(store.selected()?.id).toBe("con_new");
    await act(() => renderer!.unmount());
  });
});
