import { describe, expect, it, vi } from "vitest";
import type { ConsoleSession, ConsoleSnapshot } from "../../shared/console.js";
import { ConsoleStore } from "./consoleStore.js";

const WS = "ws-1";
const started = "2026-01-01T00:00:00.000Z";

function session(overrides: Partial<ConsoleSession> = {}): ConsoleSession {
  return {
    id: "con_1",
    workspaceId: WS,
    title: "dev",
    command: "pnpm dev",
    cwd: "/workspace",
    cwdRelative: ".",
    source: "manual",
    status: "running",
    pid: 123,
    startedAt: started,
    endedAt: null,
    durationMs: 0,
    exitCode: null,
    signal: null,
    seq: 0,
    bytes: 0,
    truncated: false,
    droppedBytes: 0,
    error: null,
    ...overrides,
  };
}

function snapshot(value: ConsoleSession): ConsoleSnapshot {
  return {
    session: value,
    output: "initial",
    truncated: false,
    droppedBytes: 0,
    seq: value.seq,
  };
}

describe("t448 ConsoleStore", () => {
  it("loads list/snapshot, appends output without notifying Chat meta, and updates status", async () => {
    const first = session();
    const api = {
      consoleList: vi.fn(async () => [first]),
      consoleSnapshot: vi.fn(async () => ({ ok: true as const, value: snapshot(first) })),
      consoleStart: vi.fn(),
      consoleStop: vi.fn(),
      consoleInput: vi.fn(),
      consoleClear: vi.fn(),
      consoleCwds: vi.fn(async () => ({ ok: true as const, value: [{ relative: ".", absolute: "/workspace" }] })),
    };
    const store = new ConsoleStore(api);
    const metaListener = vi.fn();
    const outputListener = vi.fn();
    store.subscribe(metaListener);
    await store.setWorkspace(WS);
    expect(store.runningCount()).toBe(1);
    expect(store.getOutput("con_1").output).toBe("initial");
    store.subscribeOutput("con_1", outputListener);
    const metaCalls = metaListener.mock.calls.length;
    store.handleEvent({
      type: "output",
      sessionId: "con_1",
      seq: 1,
      stream: "stdout",
      data: " more",
      truncated: false,
    });
    expect(store.getOutput("con_1").output).toContain("initial more");
    expect(outputListener).toHaveBeenCalled();
    expect(metaListener.mock.calls.length).toBe(metaCalls);
    store.handleEvent({
      type: "status",
      sessionId: "con_1",
      seq: 2,
      session: session({ status: "exited", seq: 2, exitCode: 0 }),
    });
    expect(store.selected()?.status).toBe("exited");
    expect(metaListener.mock.calls.length).toBeGreaterThan(metaCalls);
    store.handleEvent({
      type: "cleared",
      sessionId: "con_1",
      seq: 3,
      session: session({ status: "exited", seq: 3 }),
    });
    expect(store.getOutput("con_1").output).toBe("");
  });

  it("selects a newly started tab, supports hidden close, and caps the local output tail", async () => {
    const first = session();
    const created = session({ id: "con_2", title: "test", command: "pnpm test" });
    const api = {
      consoleList: vi.fn(async () => [first]),
      consoleSnapshot: vi.fn(async () => ({ ok: true as const, value: snapshot(first) })),
      consoleStart: vi.fn(async () => ({ ok: true as const, value: created })),
      consoleStop: vi.fn(async () => ({ ok: true as const, value: { ...created, status: "stopped" as const } })),
      consoleInput: vi.fn(),
      consoleClear: vi.fn(),
      consoleCwds: vi.fn(async () => ({ ok: true as const, value: [] })),
    };
    const store = new ConsoleStore(api);
    await store.setWorkspace(WS);
    await store.start({ command: "pnpm test" });
    expect(store.selected()?.id).toBe("con_2");
    expect(store.visibleSessions().map((item) => item.id)).toContain("con_2");
    await store.close("con_2");
    expect(store.visibleSessions().map((item) => item.id)).not.toContain("con_2");
    store.handleEvent({
      type: "output",
      sessionId: "con_1",
      seq: 1,
      stream: "stdout",
      data: "x".repeat(300 * 1024),
      truncated: false,
    });
    expect(new TextEncoder().encode(store.getOutput("con_1").output).length).toBeLessThanOrEqual(256 * 1024);
    expect(store.getOutput("con_1").truncated).toBe(true);
  });
});
