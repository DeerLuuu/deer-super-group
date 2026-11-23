import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/kernel/store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function makeDb(file: string, version: number, legacyColumns: boolean): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(
      `CREATE TABLE tasks (
         id TEXT PRIMARY KEY,
         workspace_id TEXT NOT NULL,
         title TEXT NOT NULL,
         ${legacyColumns ? "owner_id TEXT, depends_on TEXT NOT NULL DEFAULT '[]'," : ""}
         created_at TEXT NOT NULL
       )`,
    );
    db.prepare("INSERT INTO tasks (id, workspace_id, title, created_at) VALUES ('t1','ws','Task','2026-01-01T00:00:00.000Z')").run();
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

describe("restore-task-graph-backup script", () => {
  it("restores a pre-contract backup and saves the previous target", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-rollback-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const backup = path.join(root, "deer.db.v1-backup");
    const target = path.join(root, "deer.db");
    makeDb(backup, 3, true);
    makeDb(target, 4, false);
    const script = fileURLToPath(
      new URL("./restore-task-graph-backup.mjs", import.meta.url),
    );

    execFileSync(process.execPath, [script, backup, target], {
      encoding: "utf8",
      windowsHide: true,
    });

    const restored = new DatabaseSync(target);
    try {
      expect(Number((restored.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version)).toBe(3);
      expect(
        (restored.prepare("PRAGMA table_info(tasks)").all() as Array<{ name?: string }>).map(
          (row) => String(row.name),
        ),
      ).toContain("owner_id");
    } finally {
      restored.close();
    }
    expect(readdirSync(root).some((name) => name.startsWith("deer.db.before-restore-"))).toBe(true);
    expect(existsSync(backup)).toBe(true);
  });

  it("restores the automatic v3 backup produced by the real v4 migration", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-real-rollback-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, "deer.db");
    const initial = new Store(target);
    const ws = initial.createWorkspace("A", path.join(root, "a"));
    const agent = initial.createAgent({
      workspaceId: ws.id,
      name: "Owner",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    });
    initial.createTask({
      workspaceId: ws.id,
      title: "Owned",
      description: "",
      acceptance: [],
      ownerId: agent.id,
    });
    initial.close();

    const raw = new DatabaseSync(target);
    try {
      raw.exec("ALTER TABLE tasks ADD COLUMN owner_id TEXT; ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'");
      raw.exec("DELETE FROM schema_migrations WHERE version = 4; PRAGMA user_version = 3");
    } finally {
      raw.close();
    }
    const migrated = new Store(target);
    const backup = migrated.lastBackupPath;
    migrated.close();
    expect(backup).toBeTruthy();

    const script = fileURLToPath(new URL("./restore-task-graph-backup.mjs", import.meta.url));
    execFileSync(process.execPath, [script, backup!, target], {
      encoding: "utf8",
      windowsHide: true,
    });
    const restored = new DatabaseSync(target);
    try {
      expect(Number((restored.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version)).toBe(3);
      expect(
        (restored.prepare("PRAGMA table_info(tasks)").all() as Array<{ name?: string }>).map((row) =>
          String(row.name),
        ),
      ).toEqual(expect.arrayContaining(["owner_id", "depends_on"]));
    } finally {
      restored.close();
    }
  });

  it("rejects a non-v3 backup and a non-v4 target unless forced", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-rollback-guard-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const backup = path.join(root, "deer.db.v1-backup");
    const target = path.join(root, "deer.db");
    makeDb(backup, 2, true);
    makeDb(target, 3, true);
    const script = fileURLToPath(new URL("./restore-task-graph-backup.mjs", import.meta.url));
    expect(() =>
      execFileSync(process.execPath, [script, backup, target], {
        encoding: "utf8",
        windowsHide: true,
      }),
    ).toThrow();
    expect(() =>
      execFileSync(process.execPath, [script, "--force", backup, target], {
        encoding: "utf8",
        windowsHide: true,
      }),
    ).not.toThrow();
  });
});
