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
 * Create a v4 DB, then rewind it to the v2 shape: re-add the legacy mirror
 * columns, drop relation tables and set user_version=2. This exercises the
 * full v2 -> v3 -> v4 upgrade, including the contract column removal.
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
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-v4-fixture-"));
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
    raw.exec("ALTER TABLE tasks ADD COLUMN owner_id TEXT");
    raw.exec("ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'");
    raw.exec("DROP TABLE task_dependencies; DROP TABLE task_owners;");
    raw.exec("DELETE FROM schema_migrations WHERE version >= 3; PRAGMA user_version = 2");
    const ownerId = options.crossWorkspaceOwner
      ? agentB.id
      : options.missingOwner
        ? "missing-agent"
        : agentA.id;
    raw.prepare("UPDATE tasks SET owner_id = ?, depends_on = '[]' WHERE id = ?").run(ownerId, b.id);
    raw.prepare("UPDATE tasks SET owner_id = ?, depends_on = ? WHERE id = ?").run(
      agentA.id,
      JSON.stringify([a.id]),
      c.id,
    );
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

function columnNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name?: string }>).map((row) =>
      String(row.name),
    );
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

describe("O1-4 task graph contract schema", () => {
  it("migrates v2 through v3 to v4, backfills relations and removes legacy columns", () => {
    const fixture = makeV2Fixture();
    const store = new Store(fixture.dbPath);
    cleanup.push(() => store.close());

    expect(userVersionAt(fixture.dbPath)).toBe(4);
    expect(
      (store.db.prepare("SELECT version FROM schema_migrations WHERE version = 4").get() as
        | { version?: number }
        | undefined)?.version,
    ).toBe(4);
    expect(tableNames(fixture.dbPath)).toEqual(
      expect.arrayContaining(["task_owners", "task_dependencies", "schema_migrations"]),
    );
    expect(columnNames(fixture.dbPath)).not.toContain("owner_id");
    expect(columnNames(fixture.dbPath)).not.toContain("depends_on");
    const indexes = (store.db.prepare("PRAGMA index_list(task_dependencies)").all() as Array<{
      name?: string;
    }>).map((row) => String(row.name));
    expect(indexes).toContain("idx_task_dependencies_parent");
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.lastBackupPath).toBeTruthy();
    expect(existsSync(store.lastBackupPath!)).toBe(true);
    const backup = new DatabaseSync(store.lastBackupPath!);
    try {
      expect(Number((backup.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version)).toBe(3);
      const backupColumns = (backup.prepare("PRAGMA table_info(tasks)").all() as Array<{ name?: string }>).map(
        (row) => String(row.name),
      );
      expect(backupColumns).toEqual(expect.arrayContaining(["owner_id", "depends_on"]));
    } finally {
      backup.close();
    }

    expect(store.getTask(fixture.b.id)?.ownerId).toBe(fixture.agentA.id);
    expect(store.getTask(fixture.c.id)?.dependsOn).toEqual([fixture.a.id]);
    expect(store.listTasks(fixture.wsA.id).find((task) => task.id === fixture.c.id)?.dependsOn).toEqual([
      fixture.a.id,
    ]);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM task_owners").get()).toMatchObject({ n: 2 });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM task_dependencies").get()).toMatchObject({ n: 1 });
  });

  it("removes legacy columns from an existing v3 DB while preserving relations", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-v3-to-v4-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = path.join(root, "deer.db");
    const initial = new Store(dbPath);
    const ws = initial.createWorkspace("A", path.join(root, "a"));
    const agent = makeAgent(initial, ws.id, "Owner");
    const task = makeTask(initial, ws.id, "Task", agent.id);
    initial.close();

    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec("ALTER TABLE tasks ADD COLUMN owner_id TEXT; ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'");
      raw.prepare("UPDATE tasks SET owner_id = ?, depends_on = '[]' WHERE id = ?").run(agent.id, task.id);
      raw.exec("DELETE FROM schema_migrations WHERE version = 4; PRAGMA user_version = 3");
    } finally {
      raw.close();
    }

    const migrated = new Store(dbPath);
    cleanup.push(() => migrated.close());
    expect(userVersionAt(dbPath)).toBe(4);
    expect(columnNames(dbPath)).not.toContain("owner_id");
    expect(columnNames(dbPath)).not.toContain("depends_on");
    expect(migrated.getTask(task.id)?.ownerId).toBe(agent.id);
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const backup = new DatabaseSync(migrated.lastBackupPath!);
    try {
      expect(
        Number((backup.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version),
      ).toBe(3);
    } finally {
      backup.close();
    }
  });

  it("writes and reads owner/dependency facts only through relations", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-v4-write-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new Store(path.join(root, "deer.db"));
    cleanup.push(() => store.close());
    const ws = store.createWorkspace("A", path.join(root, "a"));
    const a = makeTask(store, ws.id, "A");
    const b = makeTask(store, ws.id, "B", undefined, [a.id]);
    const owner = makeAgent(store, ws.id, "Owner");

    expect(columnNames(path.join(root, "deer.db"))).not.toContain("owner_id");
    expect(columnNames(path.join(root, "deer.db"))).not.toContain("depends_on");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM task_owners").get()).toMatchObject({ n: 0 });
    store.setTaskOwner(b.id, owner.id);
    expect(store.getTask(b.id)?.ownerId).toBe(owner.id);
    expect(
      store.db.prepare("SELECT agent_id FROM task_owners WHERE task_id = ?").get(b.id),
    ).toMatchObject({ agent_id: owner.id });

    store.setTaskOwner(b.id, null);
    store.setTaskDependencies(b.id, []);
    expect(store.getTask(b.id)?.ownerId).toBeNull();
    expect(store.getTask(b.id)?.dependsOn).toEqual([]);
    expect(store.db.prepare("SELECT * FROM task_owners WHERE task_id = ?").all(b.id)).toEqual([]);
    expect(store.db.prepare("SELECT * FROM task_dependencies WHERE task_id = ?").all(b.id)).toEqual([]);
  });

  it("serves scheduler/UI reads from relations only", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-v4-read-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new Store(path.join(root, "deer.db"));
    cleanup.push(() => store.close());
    const ws = store.createWorkspace("A", path.join(root, "a"));
    const a = makeTask(store, ws.id, "A");
    const b = makeTask(store, ws.id, "B", undefined, [a.id]);
    const owner = makeAgent(store, ws.id, "Owner");
    store.setTaskOwner(b.id, owner.id);
    store.updateTask(b.id, { status: "queued" });
    expect(store.getTask(b.id)).toMatchObject({ ownerId: owner.id, dependsOn: [a.id] });
    expect(store.listTasks(ws.id).find((task) => task.id === b.id)).toMatchObject({
      ownerId: owner.id,
      dependsOn: [a.id],
    });
    expect(store.listQueuedTasks(ws.id).find((task) => task.id === b.id)?.ownerId).toBe(owner.id);
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
