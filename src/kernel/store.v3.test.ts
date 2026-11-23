import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./store.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function makeAgent(store: Store, workspaceId: string, name: string) {
  return store.createAgent({
    workspaceId,
    name,
    role: "engineer",
    systemPrompt: "",
    persona: "",
    agentsMd: "",
    model: null,
  });
}

function makeTask(store: Store, workspaceId: string, title: string, ownerId?: string, dependsOn?: string[]) {
  return store.createTask({
    workspaceId,
    title,
    description: "",
    acceptance: [],
    ownerId: ownerId ?? null,
    dependsOn: dependsOn ?? [],
  });
}

/**
 * Create a fully-migrated v3 DB, then rewind it to the v2 shape: drop the
 * relation tables and set user_version=2. The legacy owner_id/depends_on
 * columns remain, just like a pre-O1-1 database.
 */
function makeV2Fixture(
  options: {
    crossWorkspaceOwner?: boolean;
    badJson?: boolean;
    cycle?: boolean;
    missingOwner?: boolean;
    missingDependency?: boolean;
    crossWorkspaceDependency?: boolean;
    selfDependency?: boolean;
    duplicateDependency?: boolean;
    tooManyDependencies?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-v3-fixture-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "deer.db");
  const initial = new Store(dbPath);
  const wsA = initial.createWorkspace("A", path.join(root, "a"));
  const wsB = initial.createWorkspace("B", path.join(root, "b"));
  const agentA = makeAgent(initial, wsA.id, "Agent A");
  const agentB = makeAgent(initial, wsB.id, "Agent B");
  const a = makeTask(initial, wsA.id, "A");
  const b = makeTask(initial, wsA.id, "B");
  const c = makeTask(initial, wsA.id, "C", agentA.id, [a.id]);
  const d = makeTask(initial, wsB.id, "D");
  const many = options.tooManyDependencies
    ? Array.from({ length: 101 }, (_, index) => makeTask(initial, wsA.id, `many-${index}`))
    : [];
  initial.close();

  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec("DROP TABLE task_dependencies; DROP TABLE task_owners;");
    raw.exec("DELETE FROM schema_migrations WHERE version = 3; PRAGMA user_version = 2");
    const ownerId = options.crossWorkspaceOwner
      ? agentB.id
      : options.missingOwner
        ? "missing-agent"
        : agentA.id;
    raw.prepare("UPDATE tasks SET owner_id = ? WHERE id = ?").run(ownerId, b.id);
    if (options.badJson) {
      raw.prepare("UPDATE tasks SET depends_on = ? WHERE id = ?").run("{not-json", c.id);
    } else if (options.cycle) {
      raw.prepare("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([b.id]), a.id);
      raw.prepare("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([a.id]), b.id);
    } else if (options.missingDependency) {
      raw.prepare("UPDATE tasks SET depends_on = ? WHERE id = ?").run(
        JSON.stringify(["missing-task"]),
        c.id,
      );
    } else if (options.crossWorkspaceDependency) {
      raw.prepare("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([d.id]), c.id);
    } else if (options.selfDependency) {
      raw.prepare("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([c.id]), c.id);
    } else if (options.duplicateDependency) {
      raw.prepare("UPDATE tasks SET depends_on = ? WHERE id = ?").run(
        JSON.stringify([a.id, a.id]),
        c.id,
      );
    } else if (options.tooManyDependencies) {
      raw.prepare("UPDATE tasks SET depends_on = ? WHERE id = ?").run(
        JSON.stringify(many.map((task) => task.id)),
        c.id,
      );
    }
  } finally {
    raw.close();
  }
  return { root, dbPath, wsA, wsB, agentA, agentB, a, b, c, d };
}

function tableNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name?: string;
    }>).map((row) => String(row.name));
  } finally {
    db.close();
  }
}

function userVersionAt(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    return Number((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version);
  } finally {
    db.close();
  }
}

describe("O1-1 v3 task graph schema", () => {
  it("migrates a v2 DB, backfills owner/dependencies, and keeps old columns mirrored", () => {
    const fixture = makeV2Fixture();
    const store = new Store(fixture.dbPath);
    cleanup.push(() => store.close());

    expect(
      Number((store.db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version),
    ).toBe(3);
    expect(
      (store.db.prepare("SELECT version FROM schema_migrations WHERE version = 3").get() as
        | { version?: number }
        | undefined)?.version,
    ).toBe(3);
    expect(tableNames(fixture.dbPath)).toEqual(
      expect.arrayContaining(["task_owners", "task_dependencies", "schema_migrations"]),
    );
    const indexes = (store.db.prepare("PRAGMA index_list(task_dependencies)").all() as Array<{
      name?: string;
    }>).map((row) => String(row.name));
    expect(indexes).toContain("idx_task_dependencies_parent");
    expect(store.db.prepare("PRAGMA foreign_key_list(task_owners)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "tasks", from: "task_id", to: "id", on_delete: "CASCADE" }),
        expect.objectContaining({ table: "agents", from: "agent_id", to: "id", on_delete: "CASCADE" }),
      ]),
    );
    expect(store.db.prepare("PRAGMA foreign_key_list(task_dependencies)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "tasks", from: "task_id", to: "id", on_delete: "CASCADE" }),
        expect.objectContaining({
          table: "tasks",
          from: "depends_on_task_id",
          to: "id",
          on_delete: "RESTRICT",
        }),
      ]),
    );
    expect(store.lastBackupPath).toBeTruthy();
    expect(existsSync(store.lastBackupPath!)).toBe(true);

    expect(store.getTask(fixture.b.id)?.ownerId).toBe(fixture.agentA.id);
    expect(store.getTask(fixture.c.id)?.dependsOn).toEqual([fixture.a.id]);
    expect(store.listTasks(fixture.wsA.id).find((task) => task.id === fixture.c.id)?.dependsOn).toEqual([
      fixture.a.id,
    ]);
    expect(
      store.db.prepare("SELECT owner_id, depends_on FROM tasks WHERE id = ?").get(fixture.c.id),
    ).toMatchObject({ owner_id: fixture.agentA.id, depends_on: JSON.stringify([fixture.a.id]) });
    expect(store.db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM task_owners").get()).toMatchObject({ n: 2 });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM task_dependencies").get()).toMatchObject({ n: 1 });
  });

  it("keeps owner/dependency mirrors in sync for O1-1 writes and reads relation first", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-v3-write-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new Store(path.join(root, "deer.db"));
    cleanup.push(() => store.close());
    const ws = store.createWorkspace("A", path.join(root, "a"));
    const a = makeTask(store, ws.id, "A");
    const b = makeTask(store, ws.id, "B", undefined, [a.id]);

    expect(store.db.prepare("SELECT COUNT(*) AS n FROM task_owners").get()).toMatchObject({ n: 0 });
    const owner = makeAgent(store, ws.id, "Owner");
    store.updateTask(b.id, { ownerId: owner.id });
    expect(store.getTask(b.id)?.ownerId).toBe(owner.id);
    expect(
      store.db.prepare("SELECT agent_id FROM task_owners WHERE task_id = ?").get(b.id),
    ).toMatchObject({ agent_id: owner.id });

    store.updateTask(b.id, { ownerId: null, dependsOn: [] });
    expect(store.getTask(b.id)?.ownerId).toBeNull();
    expect(store.getTask(b.id)?.dependsOn).toEqual([]);
    expect(store.db.prepare("SELECT * FROM task_owners WHERE task_id = ?").all(b.id)).toEqual([]);
    expect(store.db.prepare("SELECT * FROM task_dependencies WHERE task_id = ?").all(b.id)).toEqual([]);
    expect(
      store.db.prepare("SELECT owner_id, depends_on FROM tasks WHERE id = ?").get(b.id),
    ).toMatchObject({ owner_id: null, depends_on: "[]" });
  });

  it("serves relation-first reads to scheduler/UI when legacy columns diverge", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-v3-read-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new Store(path.join(root, "deer.db"));
    cleanup.push(() => store.close());
    const ws = store.createWorkspace("A", path.join(root, "a"));
    const a = makeTask(store, ws.id, "A");
    const b = makeTask(store, ws.id, "B", undefined, [a.id]);
    const owner = makeAgent(store, ws.id, "Owner");
    store.updateTask(b.id, { ownerId: owner.id, status: "queued" });

    // Simulate a stale legacy mirror; relation remains authoritative.
    store.db
      .prepare("UPDATE tasks SET owner_id = 'legacy-owner', depends_on = ? WHERE id = ?")
      .run(JSON.stringify(["legacy-dep"]), b.id);
    expect(store.getTask(b.id)).toMatchObject({ ownerId: owner.id, dependsOn: [a.id] });
    expect(store.listTasks(ws.id).find((task) => task.id === b.id)).toMatchObject({
      ownerId: owner.id,
      dependsOn: [a.id],
    });
    expect(store.listQueuedTasks(ws.id).find((task) => task.id === b.id)?.ownerId).toBe(owner.id);
  });

  it("falls back to legacy columns when relation tables are unavailable", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-v3-fallback-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new Store(path.join(root, "deer.db"));
    cleanup.push(() => store.close());
    const ws = store.createWorkspace("A", path.join(root, "a"));
    const a = makeTask(store, ws.id, "A");
    const b = makeTask(store, ws.id, "B", undefined, [a.id]);
    const owner = makeAgent(store, ws.id, "Owner");
    store.updateTask(b.id, { ownerId: owner.id });
    // Simulate a non-v3/legacy reader path where relation tables are absent.
    store.db.exec("DROP TABLE task_dependencies; DROP TABLE task_owners;");
    expect(store.getTask(b.id)?.ownerId).toBe(owner.id);
    expect(store.getTask(b.id)?.dependsOn).toEqual([a.id]);
  });

  it("rejects malformed dependency JSON and leaves v2 untouched", () => {
    const fixture = makeV2Fixture({ badJson: true });
    expect(() => new Store(fixture.dbPath)).toThrow(/task graph migration failed/);
    expect(userVersionAt(fixture.dbPath)).toBe(2);
    expect(tableNames(fixture.dbPath)).not.toContain("task_owners");
  });

  it("rejects a cross-workspace owner and leaves v2 untouched", () => {
    const fixture = makeV2Fixture({ crossWorkspaceOwner: true });
    expect(() => new Store(fixture.dbPath)).toThrow(/another workspace/);
    expect(userVersionAt(fixture.dbPath)).toBe(2);
    expect(tableNames(fixture.dbPath)).not.toContain("task_dependencies");
  });

  it("rejects a dependency cycle and leaves v2 untouched", () => {
    const fixture = makeV2Fixture({ cycle: true });
    expect(() => new Store(fixture.dbPath)).toThrow(/dependency cycle/);
    expect(userVersionAt(fixture.dbPath)).toBe(2);
    expect(tableNames(fixture.dbPath)).not.toContain("task_owners");
  });

  it("rejects a missing owner and leaves v2 untouched", () => {
    const fixture = makeV2Fixture({ missingOwner: true });
    expect(() => new Store(fixture.dbPath)).toThrow(/owner agent .* not found/);
    expect(userVersionAt(fixture.dbPath)).toBe(2);
    expect(tableNames(fixture.dbPath)).not.toContain("task_owners");
  });

  it("rejects a missing dependency and leaves v2 untouched", () => {
    const fixture = makeV2Fixture({ missingDependency: true });
    expect(() => new Store(fixture.dbPath)).toThrow(/dependency .* not found/);
    expect(userVersionAt(fixture.dbPath)).toBe(2);
    expect(tableNames(fixture.dbPath)).not.toContain("task_dependencies");
  });

  it("rejects a cross-workspace dependency and leaves v2 untouched", () => {
    const fixture = makeV2Fixture({ crossWorkspaceDependency: true });
    expect(() => new Store(fixture.dbPath)).toThrow(/another workspace/);
    expect(userVersionAt(fixture.dbPath)).toBe(2);
    expect(tableNames(fixture.dbPath)).not.toContain("task_owners");
  });

  it("rejects self/duplicate/over-limit dependencies and leaves v2 untouched", () => {
    for (const [options, pattern] of [
      [{ selfDependency: true }, /self dependency/],
      [{ duplicateDependency: true }, /duplicate dependency/],
      [{ tooManyDependencies: true }, /too many dependencies/],
    ] as const) {
      const fixture = makeV2Fixture(options);
      expect(() => new Store(fixture.dbPath)).toThrow(pattern);
      expect(userVersionAt(fixture.dbPath)).toBe(2);
      expect(tableNames(fixture.dbPath)).not.toContain("task_owners");
    }
  });

  it("fails closed when the v3 backup cannot be written", () => {
    const fixture = makeV2Fixture();
    const notADirectory = path.join(fixture.root, "backup-is-a-file");
    writeFileSync(notADirectory, "not a directory", "utf8");
    expect(() => new Store(fixture.dbPath, { backupDirectory: notADirectory })).toThrow(
      /task graph migration failed/,
    );
    expect(userVersionAt(fixture.dbPath)).toBe(2);
    expect(tableNames(fixture.dbPath)).not.toContain("task_owners");
  });
});
