import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendGuardLog,
  formatGuardError,
  installProcessGuards,
  isIgnorablePipeError,
} from "./processGuards.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function logPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), "deer-process-guard-"));
  roots.push(root);
  return path.join(root, "logs", "main.log");
}

function fakeProcess() {
  const events = new EventEmitter();
  return {
    events,
    on: events.on.bind(events),
    exit: vi.fn((code: number) => code),
  };
}

function fakeStream() {
  return new EventEmitter();
}

function pipeError(code = "EPIPE"): Error {
  return Object.assign(new Error(`${code}: broken pipe, write`), { code });
}

describe("isIgnorablePipeError", () => {
  it("recognizes EPIPE, EIO and ERR_STREAM_DESTROYED by code", () => {
    expect(isIgnorablePipeError(pipeError("EPIPE"))).toBe(true);
    expect(isIgnorablePipeError(pipeError("EIO"))).toBe(true);
    expect(isIgnorablePipeError(pipeError("ERR_STREAM_DESTROYED"))).toBe(true);
  });

  it("recognizes wrapped/cause pipe errors and common messages", () => {
    const wrapped = Object.assign(new Error("write failed"), { cause: pipeError("EPIPE") });
    expect(isIgnorablePipeError(wrapped)).toBe(true);
    expect(isIgnorablePipeError(new Error("EPIPE: broken pipe"))).toBe(true);
    expect(isIgnorablePipeError(new Error("broken pipe on stdout"))).toBe(true);
  });

  it("returns false for ordinary errors and non-objects", () => {
    expect(isIgnorablePipeError(new Error("boom"))).toBe(false);
    expect(isIgnorablePipeError({ code: "EACCES" })).toBe(false);
    expect(isIgnorablePipeError("EPIPE-ish text")).toBe(false);
    expect(isIgnorablePipeError(null)).toBe(false);
    expect(isIgnorablePipeError(undefined)).toBe(false);
  });
});

describe("process guards", () => {
  it("records stream EPIPE/EIO errors without crashing or writing to console", () => {
    const log = logPath();
    const proc = fakeProcess();
    const stdout = fakeStream();
    const stderr = fakeStream();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installProcessGuards({ logPath: log, process: proc, stdout: stdout as never, stderr: stderr as never });

    expect(() => stdout.emit("error", pipeError("EPIPE"))).not.toThrow();
    expect(() => stderr.emit("error", pipeError("EIO"))).not.toThrow();
    const text = readFileSync(log, "utf8");
    expect(text).toContain("stream:stdout:pipe");
    expect(text).toContain("stream:stderr:pipe");
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("ignores uncaught/rejected pipe errors and keeps running", () => {
    const log = logPath();
    const proc = fakeProcess();
    installProcessGuards({ logPath: log, process: proc, stdout: fakeStream() as never, stderr: fakeStream() as never });

    proc.events.emit("uncaughtException", pipeError("EPIPE"));
    proc.events.emit("uncaughtException", pipeError("ERR_STREAM_DESTROYED"));
    proc.events.emit("unhandledRejection", pipeError("EIO"));
    expect(proc.exit).not.toHaveBeenCalled();
    const text = readFileSync(log, "utf8");
    expect(text).toContain("uncaughtException:pipe");
    expect(text).toContain("unhandledRejection:pipe");
  });

  it("records ordinary uncaught exceptions and preserves fatal exit", () => {
    const log = logPath();
    const proc = fakeProcess();
    installProcessGuards({ logPath: log, process: proc, stdout: fakeStream() as never, stderr: fakeStream() as never });

    proc.events.emit("uncaughtException", new Error("real bug"));
    expect(proc.exit).toHaveBeenCalledWith(1);
    expect(readFileSync(log, "utf8")).toContain("real bug");
  });

  it("records ordinary rejections without swallowing them silently", () => {
    const log = logPath();
    const proc = fakeProcess();
    installProcessGuards({ logPath: log, process: proc, stdout: fakeStream() as never, stderr: fakeStream() as never });

    proc.events.emit("unhandledRejection", new Error("rejected work"));
    expect(proc.exit).not.toHaveBeenCalled();
    expect(readFileSync(log, "utf8")).toContain("rejected work");
  });

  it("log write failures are silent and appendGuardLog reports false", () => {
    const noWrite = vi.spyOn(console, "error").mockImplementation(() => {});
    const base = logPath();
    mkdirSync(path.dirname(base), { recursive: true });
    writeFileSync(base, "not a directory", "utf8");
    expect(appendGuardLog(path.join(base, "child.log"), "x", new Error("y"))).toBe(false);
    expect(noWrite).not.toHaveBeenCalled();
    noWrite.mockRestore();
  });

  it("formats non-Error values for the log", () => {
    expect(formatGuardError("plain")).toBe("plain");
    expect(formatGuardError({ code: "EPIPE" })).toContain("EPIPE");
  });
});
