import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_GIT_SETTINGS,
  type CheckRun,
  type GitSettings,
  type MergeQueueItem,
  type PrInfo,
  type TaskVcs,
  type WorktreeRecord,
} from "./types.js";

type Row = Record<string, unknown>;

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS git_schema (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS git_repo_config (
  workspace_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'auto',
  base_branch TEXT NOT NULL DEFAULT 'main',
  remote TEXT,
  provider TEXT NOT NULL DEFAULT 'auto',
  api_host TEXT NOT NULL DEFAULT 'github.com',
  auto_create_pr INTEGER NOT NULL DEFAULT 1,
  auto_push_wip INTEGER NOT NULL DEFAULT 1,
  push_on_cancel INTEGER NOT NULL DEFAULT 0,
  preserve_worktree_on_cancel INTEGER NOT NULL DEFAULT 0,
  export_cancel_patch INTEGER NOT NULL DEFAULT 0,
  require_approval INTEGER NOT NULL DEFAULT 1,
  checks_mode TEXT NOT NULL DEFAULT 'shell',
  checks_command TEXT,
  checks_timeout_ms INTEGER NOT NULL DEFAULT 1800000,
  required_checks TEXT NOT NULL DEFAULT '[]',
  merge_method TEXT NOT NULL DEFAULT 'squash',
  auto_merge INTEGER NOT NULL DEFAULT 1,
  allow_skip_blocked INTEGER NOT NULL DEFAULT 0,
  max_worktrees INTEGER NOT NULL DEFAULT 3,
  merge_captain TEXT NOT NULL DEFAULT 'human',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS git_worktrees (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  branch_task_id TEXT,
  run_id TEXT,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_git_wt_active ON git_worktrees(task_id)
  WHERE state IN ('reserving','creating','ready','active','finalizing');
CREATE UNIQUE INDEX IF NOT EXISTS ux_git_wt_branch_active ON git_worktrees(workspace_id, branch)
  WHERE state IN ('reserving','creating','ready','active','finalizing');

CREATE TABLE IF NOT EXISTS task_vcs (
  task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  branch TEXT,
  base_branch TEXT,
  head_sha TEXT,
  pr_provider TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_state TEXT,
  checks_state TEXT,
  review_state TEXT,
  merge_state TEXT,
  merge_commit_sha TEXT,
  conflict_task_id TEXT,
  target_task_id TEXT,
  target_branch TEXT,
  scope_paths TEXT NOT NULL DEFAULT '[]',
  degraded_reason TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_vcs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  worktree_path TEXT,
  branch TEXT,
  base_sha TEXT,
  commit_sha TEXT,
  pr_number INTEGER,
  mode TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pr_records (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  number INTEGER,
  branch TEXT,
  url TEXT,
  task_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  state TEXT NOT NULL,
  checks_json TEXT NOT NULL DEFAULT '[]',
  review_state TEXT,
  mergeable TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pr_task ON pr_records(workspace_id, provider, task_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pr_branch ON pr_records(workspace_id, provider, branch)
  WHERE branch IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pr_number ON pr_records(workspace_id, provider, number)
  WHERE number IS NOT NULL;

CREATE TABLE IF NOT EXISTS merge_queue (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pr_provider TEXT NOT NULL DEFAULT 'local',
  pr_number INTEGER,
  branch TEXT,
  task_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  state TEXT NOT NULL,
  position INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  approval_actor TEXT,
  approved_at TEXT,
  approved_head_sha TEXT,
  checks_waived INTEGER NOT NULL DEFAULT 0,
  checks_waived_by TEXT,
  checks_waived_reason TEXT,
  checks_waived_at TEXT,
  merge_commit_sha TEXT,
  conflict_task_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_merge_active ON merge_queue(workspace_id, pr_provider, pr_number)
  WHERE state IN ('queued','waiting_checks','waiting_review','ready','updating','merging');
CREATE UNIQUE INDEX IF NOT EXISTS ux_merge_active_branch ON merge_queue(workspace_id, pr_provider, branch)
  WHERE branch IS NOT NULL AND state IN ('queued','waiting_checks','waiting_review','ready','updating','merging');
CREATE UNIQUE INDEX IF NOT EXISTS ux_merge_active_task ON merge_queue(workspace_id, task_id)
  WHERE state IN ('queued','waiting_checks','waiting_review','ready','updating','merging');

CREATE TABLE IF NOT EXISTS merge_attempts (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL,
  pr_provider TEXT NOT NULL,
  pr_number INTEGER,
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  state TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  source TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS git_jobs (
  id TEXT PRIMARY KEY,
  command_id TEXT,
  kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_git_jobs_pending ON git_jobs(state, next_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_git_jobs_kind_run ON git_jobs(kind, run_id)
  WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_git_jobs_command ON git_jobs(command_id)
  WHERE command_id IS NOT NULL;
`;

function now(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

export class GitStore {
  readonly db: DatabaseSync;
  private readonly databasePath: string;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private tableInfo(table: string): Array<{ name?: string }> {
    return this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  }

  private migrate(): void {
    const versionRow = this.db
      .prepare("SELECT version FROM git_schema ORDER BY version DESC LIMIT 1")
      .get() as { version?: number } | undefined;
    const current = Number(versionRow?.version ?? 0);
    if (current >= 2) return;

    // Old v1 databases may already have git_repo_config without the t92 columns.
    const columns = new Set(this.tableInfo("git_repo_config").map((item) => item.name));
    const additions: Array<[string, string]> = [
      ["remote", "TEXT"],
      ["provider", "TEXT NOT NULL DEFAULT 'auto'"],
      ["api_host", "TEXT NOT NULL DEFAULT 'github.com'"],
      ["auto_create_pr", "INTEGER NOT NULL DEFAULT 1"],
      ["auto_push_wip", "INTEGER NOT NULL DEFAULT 1"],
      ["push_on_cancel", "INTEGER NOT NULL DEFAULT 0"],
      ["preserve_worktree_on_cancel", "INTEGER NOT NULL DEFAULT 0"],
      ["export_cancel_patch", "INTEGER NOT NULL DEFAULT 0"],
      ["require_approval", "INTEGER NOT NULL DEFAULT 1"],
      ["checks_mode", "TEXT NOT NULL DEFAULT 'shell'"],
      ["checks_command", "TEXT"],
      ["checks_timeout_ms", "INTEGER NOT NULL DEFAULT 1800000"],
      ["required_checks", "TEXT NOT NULL DEFAULT '[]'"],
      ["merge_method", "TEXT NOT NULL DEFAULT 'squash'"],
      ["auto_merge", "INTEGER NOT NULL DEFAULT 1"],
      ["allow_skip_blocked", "INTEGER NOT NULL DEFAULT 0"],
      ["max_worktrees", "INTEGER NOT NULL DEFAULT 3"],
      ["merge_captain", "TEXT NOT NULL DEFAULT 'human'"],
      ["updated_at", "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [name, type] of additions) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE git_repo_config ADD COLUMN ${name} ${type}`);
      }
    }
    this.db
      .prepare("INSERT OR REPLACE INTO git_schema (version, applied_at) VALUES (2, ?)")
      .run(now());
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- config
  getConfig(workspaceId: string): GitSettings {
    const row = this.db
      .prepare("SELECT * FROM git_repo_config WHERE workspace_id = ?")
      .get(workspaceId) as Row | undefined;
    return {
      workspaceId,
      ...DEFAULT_GIT_SETTINGS,
      ...(row
        ? {
            mode: String(row.mode ?? DEFAULT_GIT_SETTINGS.mode) as GitSettings["mode"],
            baseBranch: String(row.base_branch ?? DEFAULT_GIT_SETTINGS.baseBranch),
            remote: row.remote == null ? null : String(row.remote),
            provider: String(row.provider ?? DEFAULT_GIT_SETTINGS.provider) as GitSettings["provider"],
            apiHost: String(row.api_host ?? DEFAULT_GIT_SETTINGS.apiHost),
            autoCreatePr: bool(row.auto_create_pr),
            autoPushWip: bool(row.auto_push_wip),
            pushOnCancel: bool(row.push_on_cancel),
            preserveWorktreeOnCancel: bool(row.preserve_worktree_on_cancel),
            exportCancelPatch: bool(row.export_cancel_patch),
            requireApproval: bool(row.require_approval),
            checksMode: String(row.checks_mode ?? "shell") as GitSettings["checksMode"],
            checksCommand: row.checks_command == null ? null : String(row.checks_command),
            checksTimeoutMs: num(row.checks_timeout_ms),
            requiredChecks: JSON.parse(String(row.required_checks ?? "[]")) as string[],
            mergeMethod: String(row.merge_method ?? "squash") as GitSettings["mergeMethod"],
            autoMerge: bool(row.auto_merge),
            allowSkipBlocked: bool(row.allow_skip_blocked),
            maxWorktrees: num(row.max_worktrees),
            mergeCaptain: String(row.merge_captain ?? "human"),
          }
        : {}),
    };
  }

  saveConfig(settings: GitSettings): GitSettings {
    this.db
      .prepare(
        `INSERT INTO git_repo_config (
          workspace_id, mode, base_branch, remote, provider, api_host,
          auto_create_pr, auto_push_wip, push_on_cancel, preserve_worktree_on_cancel,
          export_cancel_patch, require_approval, checks_mode, checks_command,
          checks_timeout_ms, required_checks, merge_method, auto_merge,
          allow_skip_blocked, max_worktrees, merge_captain, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          mode=excluded.mode, base_branch=excluded.base_branch, remote=excluded.remote,
          provider=excluded.provider, api_host=excluded.api_host,
          auto_create_pr=excluded.auto_create_pr, auto_push_wip=excluded.auto_push_wip,
          push_on_cancel=excluded.push_on_cancel,
          preserve_worktree_on_cancel=excluded.preserve_worktree_on_cancel,
          export_cancel_patch=excluded.export_cancel_patch,
          require_approval=excluded.require_approval,
          checks_mode=excluded.checks_mode, checks_command=excluded.checks_command,
          checks_timeout_ms=excluded.checks_timeout_ms,
          required_checks=excluded.required_checks, merge_method=excluded.merge_method,
          auto_merge=excluded.auto_merge, allow_skip_blocked=excluded.allow_skip_blocked,
          max_worktrees=excluded.max_worktrees, merge_captain=excluded.merge_captain,
          updated_at=excluded.updated_at`,
      )
      .run(
        settings.workspaceId,
        settings.mode,
        settings.baseBranch,
        settings.remote,
        settings.provider,
        settings.apiHost,
        settings.autoCreatePr ? 1 : 0,
        settings.autoPushWip ? 1 : 0,
        settings.pushOnCancel ? 1 : 0,
        settings.preserveWorktreeOnCancel ? 1 : 0,
        settings.exportCancelPatch ? 1 : 0,
        settings.requireApproval ? 1 : 0,
        settings.checksMode,
        settings.checksCommand,
        settings.checksTimeoutMs,
        JSON.stringify(settings.requiredChecks),
        settings.mergeMethod,
        settings.autoMerge ? 1 : 0,
        settings.allowSkipBlocked ? 1 : 0,
        settings.maxWorktrees,
        settings.mergeCaptain,
        now(),
      );
    return this.getConfig(settings.workspaceId);
  }

  // ------------------------------------------------------------- worktrees
  listWorktrees(workspaceId: string): WorktreeRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM git_worktrees WHERE workspace_id = ? ORDER BY created_at ASC")
      .all(workspaceId) as Row[];
    return rows.map((row) => this.toWorktree(row));
  }

  getWorktreeByRun(runId: string): WorktreeRecord | null {
    const row = this.db
      .prepare("SELECT * FROM git_worktrees WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(runId) as Row | undefined;
    return row ? this.toWorktree(row) : null;
  }

  getActiveWorktreeForTask(taskId: string): WorktreeRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM git_worktrees WHERE task_id = ?
         AND state IN ('reserving','creating','ready','active','finalizing')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as Row | undefined;
    return row ? this.toWorktree(row) : null;
  }

  getActiveWorktreeForBranch(workspaceId: string, branch: string): WorktreeRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM git_worktrees WHERE workspace_id = ? AND branch = ?
         AND state IN ('reserving','creating','ready','active','finalizing')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(workspaceId, branch) as Row | undefined;
    return row ? this.toWorktree(row) : null;
  }

  countActiveWorktrees(workspaceId: string): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM git_worktrees WHERE workspace_id = ?
         AND state IN ('reserving','creating','ready','active','finalizing')`,
      )
      .get(workspaceId) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  insertWorktree(record: WorktreeRecord): void {
    this.db
      .prepare(
        `INSERT INTO git_worktrees
         (id, workspace_id, task_id, branch_task_id, run_id, path, branch, state,
          lease_owner, lease_expires_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.taskId,
        record.branchTaskId,
        record.runId,
        record.path,
        record.branch,
        record.state,
        record.leaseOwner,
        record.leaseExpiresAt,
        record.createdAt,
        record.updatedAt,
      );
  }

  updateWorktree(
    id: string,
    patch: Partial<Pick<WorktreeRecord, "state" | "runId" | "path" | "branch" | "leaseOwner" | "leaseExpiresAt">>,
  ): void {
    const columns: Record<string, string> = {
      state: "state",
      runId: "run_id",
      path: "path",
      branch: "branch",
      leaseOwner: "lease_owner",
      leaseExpiresAt: "lease_expires_at",
    };
    const sets: string[] = [];
    const params: Array<string | null> = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      params.push((patch as Record<string, unknown>)[key] as string | null);
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    params.push(now(), id);
    this.db.prepare(`UPDATE git_worktrees SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  private toWorktree(row: Row): WorktreeRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      taskId: String(row.task_id),
      branchTaskId: row.branch_task_id == null ? null : String(row.branch_task_id),
      runId: row.run_id == null ? null : String(row.run_id),
      path: String(row.path),
      branch: String(row.branch),
      state: String(row.state) as WorktreeRecord["state"],
      leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
      leaseExpiresAt: row.lease_expires_at == null ? null : String(row.lease_expires_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // -------------------------------------------------------------- task VCS
  getTaskVcs(taskId: string): TaskVcs | null {
    const row = this.db.prepare("SELECT * FROM task_vcs WHERE task_id = ?").get(taskId) as
      | Row
      | undefined;
    return row ? this.toTaskVcs(row) : null;
  }

  upsertTaskVcs(vcs: TaskVcs): TaskVcs {
    this.db
      .prepare(
        `INSERT INTO task_vcs (
          task_id, workspace_id, mode, branch, base_branch, head_sha, pr_provider,
          pr_number, pr_url, pr_state, checks_state, review_state, merge_state,
          merge_commit_sha, conflict_task_id, target_task_id, target_branch,
          scope_paths, degraded_reason, error_code, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET
          workspace_id=excluded.workspace_id, mode=excluded.mode, branch=excluded.branch,
          base_branch=excluded.base_branch, head_sha=excluded.head_sha,
          pr_provider=excluded.pr_provider, pr_number=excluded.pr_number,
          pr_url=excluded.pr_url, pr_state=excluded.pr_state,
          checks_state=excluded.checks_state, review_state=excluded.review_state,
          merge_state=excluded.merge_state, merge_commit_sha=excluded.merge_commit_sha,
          conflict_task_id=excluded.conflict_task_id, target_task_id=excluded.target_task_id,
          target_branch=excluded.target_branch, scope_paths=excluded.scope_paths,
          degraded_reason=excluded.degraded_reason, error_code=excluded.error_code,
          updated_at=excluded.updated_at`,
      )
      .run(
        vcs.taskId,
        vcs.workspaceId,
        vcs.mode,
        vcs.branch,
        vcs.baseBranch,
        vcs.headSha,
        vcs.pr?.provider ?? null,
        vcs.pr?.number ?? null,
        vcs.pr?.url ?? null,
        vcs.pr?.state ?? null,
        vcs.checksState ?? "none",
        vcs.pr?.review ?? null,
        vcs.merge.state,
        vcs.merge.commitSha,
        vcs.conflictTaskId,
        vcs.targetTaskId ?? null,
        vcs.targetBranch ?? null,
        JSON.stringify(vcs.scopePaths ?? []),
        vcs.degradedReason ?? null,
        vcs.errorCode,
        vcs.updatedAt,
      );
    return vcs;
  }

  private toTaskVcs(row: Row): TaskVcs {
    return {
      taskId: String(row.task_id),
      workspaceId: String(row.workspace_id),
      mode: String(row.mode) as TaskVcs["mode"],
      branch: row.branch == null ? null : String(row.branch),
      baseBranch: row.base_branch == null ? null : String(row.base_branch),
      headSha: row.head_sha == null ? null : String(row.head_sha),
      pr:
        row.pr_provider == null
          ? null
          : {
              provider: String(row.pr_provider),
              number: row.pr_number == null ? null : num(row.pr_number),
              url: row.pr_url == null ? null : String(row.pr_url),
              state: String(row.pr_state ?? "unknown"),
              checks: String(row.checks_state ?? "none"),
              review: String(row.review_state ?? "none"),
            },
      merge: {
        state: String(row.merge_state ?? "none"),
        commitSha: row.merge_commit_sha == null ? null : String(row.merge_commit_sha),
        approvedHeadSha: null,
      },
      checksState: String(row.checks_state ?? "none") as TaskVcs["checksState"],
      conflictTaskId: row.conflict_task_id == null ? null : String(row.conflict_task_id),
      targetTaskId: row.target_task_id == null ? null : String(row.target_task_id),
      targetBranch: row.target_branch == null ? null : String(row.target_branch),
      scopePaths: JSON.parse(String(row.scope_paths ?? "[]")) as string[],
      degradedReason: row.degraded_reason == null ? null : String(row.degraded_reason),
      errorCode: row.error_code == null ? null : String(row.error_code),
      updatedAt: String(row.updated_at),
    };
  }

  // --------------------------------------------------------------- run VCS
  upsertRunVcs(input: {
    runId: string;
    taskId: string;
    worktreePath: string | null;
    branch: string | null;
    baseSha: string | null;
    commitSha: string | null;
    prNumber: number | null;
    mode: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO run_vcs
         (run_id, task_id, worktree_path, branch, base_sha, commit_sha, pr_number, mode, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id) DO UPDATE SET
           worktree_path=excluded.worktree_path, branch=excluded.branch,
           base_sha=excluded.base_sha, commit_sha=excluded.commit_sha,
           pr_number=excluded.pr_number, mode=excluded.mode, updated_at=excluded.updated_at`,
      )
      .run(
        input.runId,
        input.taskId,
        input.worktreePath,
        input.branch,
        input.baseSha,
        input.commitSha,
        input.prNumber,
        input.mode,
        now(),
      );
  }

  getRunVcs(runId: string): Row | null {
    return (this.db.prepare("SELECT * FROM run_vcs WHERE run_id = ?").get(runId) as Row) ?? null;
  }

  // -------------------------------------------------------------- PR record
  upsertPrRecord(input: {
    provider: string;
    workspaceId: string;
    number: number | null;
    branch: string | null;
    url: string | null;
    taskId: string;
    headSha: string;
    baseBranch: string;
    state: string;
    checks: PrInfo["checks"];
    review: string;
    mergeable: string;
  }): void {
    const existing = this.db
      .prepare("SELECT id FROM pr_records WHERE workspace_id = ? AND provider = ? AND task_id = ?")
      .get(input.workspaceId, input.provider, input.taskId) as { id?: string } | undefined;
    const id = existing?.id ?? newId("pr");
    this.db
      .prepare(
        `INSERT INTO pr_records
         (id, provider, workspace_id, number, branch, url, task_id, head_sha, base_branch,
          state, checks_json, review_state, mergeable, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           number=excluded.number, branch=excluded.branch, url=excluded.url,
           head_sha=excluded.head_sha, base_branch=excluded.base_branch,
           state=excluded.state, checks_json=excluded.checks_json,
           review_state=excluded.review_state, mergeable=excluded.mergeable,
           updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.provider,
        input.workspaceId,
        input.number,
        input.branch,
        input.url,
        input.taskId,
        input.headSha,
        input.baseBranch,
        input.state,
        JSON.stringify(input.checks),
        input.review,
        input.mergeable,
        now(),
      );
  }

  // ------------------------------------------------------------- queue CRUD
  nextQueuePosition(workspaceId: string): number {
    const row = this.db
      .prepare("SELECT max(position) AS p FROM merge_queue WHERE workspace_id = ?")
      .get(workspaceId) as { p?: number } | undefined;
    return Number(row?.p ?? 0) + 1;
  }

  insertQueue(item: MergeQueueItem): MergeQueueItem {
    this.db
      .prepare(
        `INSERT INTO merge_queue
         (id, workspace_id, pr_provider, pr_number, branch, task_id, head_sha, base_sha,
          state, position, attempts, last_error, approved_head_sha, checks_waived,
          merge_commit_sha, conflict_task_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        item.id,
        item.workspaceId,
        item.provider,
        item.prNumber,
        item.branch,
        item.taskId,
        item.headSha,
        item.baseSha,
        item.state,
        item.position,
        item.attempts ?? 0,
        item.lastError,
        item.approvedHeadSha,
        item.checksWaived ? 1 : 0,
        item.mergeCommitSha,
        item.conflictTaskId,
        item.createdAt,
        item.updatedAt,
      );
    return item;
  }

  getQueueItem(id: string): MergeQueueItem | null {
    const row = this.db.prepare("SELECT * FROM merge_queue WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toQueue(row) : null;
  }

  getQueueForTask(taskId: string): MergeQueueItem | null {
    const row = this.db
      .prepare("SELECT * FROM merge_queue WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as Row | undefined;
    return row ? this.toQueue(row) : null;
  }

  listQueue(workspaceId: string): MergeQueueItem[] {
    const rows = this.db
      .prepare("SELECT * FROM merge_queue WHERE workspace_id = ? ORDER BY position ASC, created_at ASC")
      .all(workspaceId) as Row[];
    return rows.map((row) => this.toQueue(row));
  }

  updateQueue(
    id: string,
    patch: Partial<{
      state: MergeQueueItem["state"];
      position: number;
      attempts: number;
      lastError: string | null;
      approvedHeadSha: string | null;
      checksWaived: boolean;
      mergeCommitSha: string | null;
      conflictTaskId: string | null;
      baseSha: string | null;
      headSha: string;
    }>,
  ): void {
    const columns: Record<string, string> = {
      state: "state",
      position: "position",
      attempts: "attempts",
      lastError: "last_error",
      approvedHeadSha: "approved_head_sha",
      checksWaived: "checks_waived",
      mergeCommitSha: "merge_commit_sha",
      conflictTaskId: "conflict_task_id",
      baseSha: "base_sha",
      headSha: "head_sha",
    };
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      const value = (patch as Record<string, unknown>)[key];
      sets.push(`${column} = ?`);
      params.push(
        key === "checksWaived" ? (value ? 1 : 0) : ((value as string | number | null) ?? null),
      );
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    params.push(now(), id);
    this.db.prepare(`UPDATE merge_queue SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  private toQueue(row: Row): MergeQueueItem {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      taskId: String(row.task_id),
      taskTitle: "",
      provider: String(row.pr_provider),
      prNumber: row.pr_number == null ? null : num(row.pr_number),
      prUrl: null,
      branch: row.branch == null ? null : String(row.branch),
      state: String(row.state) as MergeQueueItem["state"],
      position: num(row.position),
      headSha: String(row.head_sha),
      baseSha: row.base_sha == null ? null : String(row.base_sha),
      approvedHeadSha: row.approved_head_sha == null ? null : String(row.approved_head_sha),
      checks: { state: "none", summary: "", waived: bool(row.checks_waived) },
      checksWaived: bool(row.checks_waived),
      retryAt: null,
      review: "pending",
      conflictTaskId: row.conflict_task_id == null ? null : String(row.conflict_task_id),
      lastError: row.last_error == null ? null : String(row.last_error),
      mergeCommitSha: row.merge_commit_sha == null ? null : String(row.merge_commit_sha),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // ---------------------------------------------------------------- checks
  upsertCheck(run: CheckRun): void {
    this.db
      .prepare(
        `INSERT INTO check_runs (id, task_id, source, head_sha, name, state, detail, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           state=excluded.state, detail=excluded.detail, updated_at=excluded.updated_at`,
      )
      .run(run.id, run.taskId, run.source, run.headSha, run.name, run.state, run.detail, run.updatedAt);
  }

  listChecks(taskId: string): CheckRun[] {
    const rows = this.db
      .prepare("SELECT * FROM check_runs WHERE task_id = ? ORDER BY updated_at ASC")
      .all(taskId) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      source: String(row.source) as CheckRun["source"],
      headSha: String(row.head_sha),
      name: String(row.name),
      state: String(row.state) as CheckRun["state"],
      detail: row.detail == null ? null : String(row.detail),
      updatedAt: String(row.updated_at),
    }));
  }

  // ------------------------------------------------------------------ jobs
  enqueueJob(input: {
    commandId?: string;
    kind: string;
    workspaceId: string;
    taskId: string;
    runId: string | null;
    payload?: unknown;
    nextAt?: string;
  }): string {
    if (input.commandId) {
      const existing = this.db
        .prepare("SELECT id FROM git_jobs WHERE command_id = ?")
        .get(input.commandId) as { id?: string } | undefined;
      if (existing?.id) return existing.id;
    }
    if (input.runId) {
      const existing = this.db
        .prepare("SELECT id FROM git_jobs WHERE kind = ? AND run_id = ?")
        .get(input.kind, input.runId) as { id?: string } | undefined;
      if (existing?.id) return existing.id;
    }
    const id = newId("gitjob");
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO git_jobs
         (id, command_id, kind, workspace_id, task_id, run_id, payload, state, attempts,
          next_at, lease_owner, lease_expires_at, last_error, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.commandId ?? null,
        input.kind,
        input.workspaceId,
        input.taskId,
        input.runId,
        JSON.stringify(input.payload ?? {}),
        "pending",
        0,
        input.nextAt ?? timestamp,
        null,
        null,
        null,
        timestamp,
        timestamp,
      );
    return id;
  }

  closeJob(id: string, error?: string): void {
    this.db
      .prepare("UPDATE git_jobs SET state = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(error ? "failed" : "done", error ?? null, now(), id);
  }

  pendingJobs(limit = 10): Array<{ id: string; kind: string; payload: string; runId: string | null; taskId: string }> {
    const rows = this.db
      .prepare("SELECT * FROM git_jobs WHERE state = 'pending' ORDER BY next_at ASC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      payload: String(row.payload ?? "{}"),
      runId: row.run_id == null ? null : String(row.run_id),
      taskId: String(row.task_id),
    }));
  }

  setSchemaVersion(version: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO git_schema (version, applied_at) VALUES (?, ?)")
      .run(version, now());
  }

  schemaVersion(): number {
    const row = this.db
      .prepare("SELECT version FROM git_schema ORDER BY version DESC LIMIT 1")
      .get() as { version?: number } | undefined;
    return Number(row?.version ?? 0);
  }

  databaseFile(): string {
    return this.databasePath;
  }
}
