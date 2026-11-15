import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { ConsoleManager } from "./consoleManager.js";
import type { ConsoleEvent, ConsoleSession } from "../../src/shared/console.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

function workspace(): { root: string; manager: ConsoleManager; workspaceId: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-console-"));
  mkdirSync(path.join(root, "sub"), { recursive: true });
  writeFileSync(path.join(root, "out.js"), "process.stdout.write('hello world');");
  writeFileSync(path.join(root, "err.js"), "process.stderr.write('bad');");
  writeFileSync(path.join(root, "exit.js"), "process.exit(2);");
  writeFileSync(
    path.join(root, "stdin.js"),
    "process.stdin.once('data', (d) => { process.stdout.write('got:' + d.toString().trim()); process.exit(0); });",
  );
  writeFileSync(path.join(root, "long.js"), "setInterval(() => {}, 1000);");
  writeFileSync(path.join(root, "env.js"), "process.stdout.write(JSON.stringify(process.env));");
  writeFileSync(path.join(root, "cwd.js"), "process.stdout.write(process.cwd());");
  const manager = new ConsoleManager({
    workspaceRoot: (id) => (id === "ws-1" ? root : null),
    limits: { killGraceMs: 300, batchMs: 5 },
  });
  cleanups.push(async () => {
    await manager.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, manager, workspaceId: "ws-1" };
}

function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out waiting for console state"));
      }
    }, 20);
  });
}

function outputOf(events: ConsoleEvent[], sessionId: string): string {
  return events
    .filter((event) => event.type === "output" && event.sessionId === sessionId)
    .map((event) => (event as { data: string }).data)
    .join("");
}

describe("t448 ConsoleManager real spawn", () => {
  it("runs a command, streams stdout and records exit code 0", async () => {
    const { manager, workspaceId } = workspace();
    const events: ConsoleEvent[] = [];
    manager.onEvent((event) => events.push(event));
    const started = manager.start(workspaceId, { command: "node out.js" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(
      () => manager.list(workspaceId).find((item) => item.id === started.value.id)?.status === "exited",
    );
    const session = manager.list(workspaceId)[0]!;
    expect(session.exitCode).toBe(0);
    expect(outputOf(events, session.id)).toContain("hello world");
    expect(session.pid).toBeGreaterThan(0);
  });

  it("reports a non-zero exit as failed", async () => {
    const { manager, workspaceId } = workspace();
    const started = manager.start(workspaceId, { command: "node exit.js" });
    if (!started.ok) throw new Error("start failed");
    await waitFor(() => manager.list(workspaceId)[0]?.status === "failed");
    expect(manager.snapshot(workspaceId, started.value.id)).toMatchObject({
      ok: true,
      value: { session: { exitCode: 2, status: "failed" } },
    });
  });

  it("writes stdin and rejects input to a finished session", async () => {
    const { manager, workspaceId } = workspace();
    const started = manager.start(workspaceId, { command: "node stdin.js" });
    if (!started.ok) throw new Error("start failed");
    expect(manager.input(workspaceId, started.value.id, "ping\n").ok).toBe(true);
    await waitFor(() => manager.list(workspaceId)[0]?.status === "exited");
    const snapshot = manager.snapshot(workspaceId, started.value.id);
    expect(snapshot.ok && snapshot.value.output).toContain("got:ping");
    const finished = manager.input(workspaceId, started.value.id, "more\n");
    expect(finished.ok).toBe(false);
    if (!finished.ok) expect(finished.error.code).toBe("CONSOLE_NOT_RUNNING");
  });

  it("stops a long-running command, is idempotent, and closeAll cleans up", async () => {
    const { manager, workspaceId } = workspace();
    const started = manager.start(workspaceId, { command: "node long.js" });
    if (!started.ok) throw new Error("start failed");
    const first = manager.stop(workspaceId, started.value.id);
    expect(first.ok).toBe(true);
    const second = manager.stop(workspaceId, started.value.id);
    expect(second.ok).toBe(true);
    await waitFor(() => manager.list(workspaceId)[0]?.status === "stopped");
    const other = manager.start(workspaceId, { command: "node long.js" });
    if (!other.ok) throw new Error("start failed");
    await manager.closeAll();
    expect(manager.list(workspaceId).every((session) => session.status === "stopped")).toBe(true);
  });

  it("limits cwd to the workspace and returns invalid cwd errors", async () => {
    const { manager, workspaceId } = workspace();
    const sub = manager.start(workspaceId, { command: "node ../cwd.js", cwd: "sub" });
    if (!sub.ok) throw new Error("start failed");
    await waitFor(() => manager.list(workspaceId)[0]?.status === "exited");
    const snapshot = manager.snapshot(workspaceId, sub.value.id);
    expect(snapshot.ok && snapshot.value.output).toContain("sub");
    for (const cwd of ["..", "../outside", ".", "missing", "C:\\"]) {
      if (cwd === ".") continue;
      const invalid = manager.start(workspaceId, { command: "node out.js", cwd });
      expect(invalid.ok, cwd).toBe(false);
      if (!invalid.ok) expect(invalid.error.code).toBe("CONSOLE_CWD_INVALID");
    }
    const absolute = manager.start(workspaceId, { command: "node out.js", cwd: path.resolve("/tmp") });
    expect(absolute.ok).toBe(false);
  });

  it("does not pass API tokens/SSH agent env to the child", async () => {
    const { manager, workspaceId } = workspace();
    const previous = process.env.TEST_TOKEN;
    const previousSsh = process.env.SSH_AUTH_SOCK;
    process.env.TEST_TOKEN = "secret-value";
    process.env.SSH_AUTH_SOCK = "ssh-secret";
    cleanups.push(() => {
      process.env.TEST_TOKEN = previous;
      process.env.SSH_AUTH_SOCK = previousSsh;
    });
    const started = manager.start(workspaceId, { command: "node env.js" });
    if (!started.ok) throw new Error("start failed");
    await waitFor(() => manager.list(workspaceId)[0]?.status === "exited");
    const snapshot = manager.snapshot(workspaceId, started.value.id);
    const env = snapshot.ok ? snapshot.value.output : "";
    expect(env).toContain("PATH");
    expect(env).not.toContain("TEST_TOKEN");
    expect(env).not.toContain("secret-value");
    expect(env).not.toContain("SSH_AUTH_SOCK");
    expect(env).not.toContain("ssh-secret");
  });
});

class FakeChild extends EventEmitter {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(): boolean {
    this.killed = true;
    setTimeout(() => this.emit("exit", 0, null), 1);
    return true;
  }
}

function fakeManager(
  limits: Partial<{ activePerWorkspace: number; historyPerWorkspace: number }> = {},
): {
  manager: ConsoleManager;
  spawned: FakeChild[];
  root: string;
  stop(): Promise<void>;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-console-fake-"));
  const spawned: FakeChild[] = [];
  let pid = 1000;
  const manager = new ConsoleManager({
    workspaceRoot: (id) => (id === "ws-1" ? root : null),
    limits: { killGraceMs: 50, batchMs: 2, ...limits },
    spawn: ((_file: string, _args: readonly string[]) => {
      const child = new FakeChild(pid++);
      spawned.push(child);
      return child as unknown as ChildProcess;
    }) as never,
  });
  cleanups.push(async () => {
    await manager.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    manager,
    spawned,
    root,
    stop: async () => {
      await manager.closeAll();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("t448 ConsoleManager limits/security/buffer", () => {
  it("rejects elevation and requires a one-time token for destructive commands", () => {
    const { manager, spawned } = fakeManager();
    const elevation = manager.start("ws-1", { command: "sudo apt install x" });
    expect(elevation.ok).toBe(false);
    if (!elevation.ok) expect(elevation.error.code).toBe("CONSOLE_ELEVATION_REJECTED");
    const runas = manager.start("ws-1", { command: "Start-Process cmd -Verb RunAs" });
    expect(runas.ok).toBe(false);
    const danger = manager.start("ws-1", { command: "rm -rf ." });
    expect(danger.ok).toBe(false);
    if (danger.ok) return;
    expect(danger.error.code).toBe("CONSOLE_CONFIRM_REQUIRED");
    const token = danger.error.details?.confirmToken;
    expect(typeof token).toBe("string");
    expect(spawned).toHaveLength(0);
    const confirmed = manager.start("ws-1", {
      command: "rm -rf .",
      confirmToken: token as string,
    });
    expect(confirmed.ok).toBe(true);
    expect(spawned).toHaveLength(1);
    const replay = manager.start("ws-1", {
      command: "rm -rf .",
      confirmToken: token as string,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("CONSOLE_CONFIRM_INVALID");
  });

  it("enforces active limits and keeps only the configured history", async () => {
    const { manager, spawned } = fakeManager({ activePerWorkspace: 2, historyPerWorkspace: 2 });
    const first = manager.start("ws-1", { command: "one" });
    const second = manager.start("ws-1", { command: "two" });
    const third = manager.start("ws-1", { command: "three" });
    expect(first.ok && second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.code).toBe("CONSOLE_LIMIT");
    spawned[0]!.emit("exit", 0, null);
    await waitFor(() => manager.list("ws-1").filter((s) => s.status === "exited").length === 1);
    const fourth = manager.start("ws-1", { command: "four" });
    expect(fourth.ok).toBe(true);
    spawned[0]!.emit("exit", 0, null);
    spawned[1]!.emit("exit", 0, null);
    spawned[2]!.emit("exit", 0, null);
    await waitFor(() => manager.list("ws-1").length <= 2);
    expect(manager.list("ws-1").length).toBeLessThanOrEqual(2);
  });

  it("truncates the 2MB ring buffer and reports dropped bytes", async () => {
    const { manager, spawned } = fakeManager();
    const started = manager.start("ws-1", { command: "big" });
    if (!started.ok) throw new Error("start failed");
    spawned[0]!.stdout.write("x".repeat(2 * 1024 * 1024 + 100));
    await waitFor(() => {
      const result = manager.snapshot("ws-1", started.value.id);
      return result.ok && result.value.truncated;
    });
    const snapshot = manager.snapshot("ws-1", started.value.id);
    expect(snapshot.ok && Buffer.byteLength(snapshot.value.output)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(snapshot.ok && snapshot.value.droppedBytes).toBeGreaterThan(0);
  });

  it("batches output events at the configured chunk size", async () => {
    const { manager, spawned } = fakeManager();
    const events: ConsoleEvent[] = [];
    manager.onEvent((event) => events.push(event));
    const started = manager.start("ws-1", { command: "batch" });
    if (!started.ok) throw new Error("start failed");
    spawned[0]!.stdout.write("a".repeat(40_000));
    await waitFor(() => outputOf(events, started.value.id).length >= 40_000);
    const chunks = events.filter(
      (event): event is Extract<ConsoleEvent, { type: "output" }> =>
        event.type === "output" && event.sessionId === started.value.id,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk.data)))).toBeLessThanOrEqual(16 * 1024);
  });

  it("closeAll force-terminates a hung child at the deadline", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-console-quit-"));
    const child = new FakeChild(5252);
    child.kill = () => true;
    const execFileCalls: string[][] = [];
    const manager = new ConsoleManager({
      workspaceRoot: () => root,
      platform: "win32",
      limits: { killGraceMs: 30, batchMs: 2 },
      spawn: (() => child as unknown as ChildProcess) as never,
      execFile: ((file: string, args: string[]) => {
        execFileCalls.push([file, ...args]);
        setTimeout(() => child.emit("exit", null, "SIGKILL"), 2);
      }) as never,
    });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const started = manager.start("ws-1", { command: "hung" });
    if (!started.ok) throw new Error("start failed");
    await manager.closeAll();
    expect(manager.list("ws-1")[0]?.status).toBe("stopped");
    expect(execFileCalls.some((args) => args[0] === "taskkill" && args.includes("/F"))).toBe(true);
  });

  it("force-kills a hung Windows child with taskkill after the grace period", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-console-hung-"));
    const child = new FakeChild(4242);
    child.kill = () => true;
    const execFileCalls: string[][] = [];
    const manager = new ConsoleManager({
      workspaceRoot: () => root,
      platform: "win32",
      limits: { killGraceMs: 30, batchMs: 2 },
      spawn: (() => child as unknown as ChildProcess) as never,
      execFile: ((file: string, args: string[]) => {
        execFileCalls.push([file, ...args]);
        setTimeout(() => child.emit("exit", null, "SIGKILL"), 1);
      }) as never,
    });
    cleanups.push(async () => {
      await manager.closeAll();
      rmSync(root, { recursive: true, force: true });
    });
    const started = manager.start("ws-1", { command: "hung" });
    if (!started.ok) throw new Error("start failed");
    const stopped = manager.stop("ws-1", started.value.id);
    expect(stopped.ok).toBe(true);
    await waitFor(() => manager.list("ws-1")[0]?.status === "stopped");
    expect(execFileCalls.some((args) => args[0] === "taskkill" && args.includes("/F"))).toBe(true);
    expect(execFileCalls.some((args) => args.includes("4242"))).toBe(true);
  });

  it("reports spawn errors as failed sessions", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-console-error-"));
    const manager = new ConsoleManager({
      workspaceRoot: () => root,
      spawn: (() => {
        throw new Error("spawn nope");
      }) as never,
    });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const started = manager.start("ws-1", { command: "anything" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => manager.list("ws-1")[0]?.status === "failed");
    expect(manager.list("ws-1")[0]?.error).toContain("spawn nope");
  });
});
