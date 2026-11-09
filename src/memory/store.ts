import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../kernel/store.js";
import { SystemClock } from "./clock.js";
import {
  boardContentHash,
  boardDoc,
  memoContentHash,
  memoDoc,
  summaryContentHash,
  summaryDoc,
} from "./indexing.js";
import {
  dedupeHits,
  likeRelevance,
  minMaxRelevance,
  normalizeQuery,
  scoreEntity,
  truncateBudget,
  type RawRank,
} from "./retrieval.js";
import {
  DAY_MS,
  DEFAULT_MEMORY_CONFIG,
  BOARD_KINDS,
  CONFIDENCES,
  MEMO_KINDS,
  MemoryError,
  type ArchiveReason,
  type BoardArchiveProposal,
  type BoardDomain,
  type BoardEntry,
  type BoardEntrySnapshot,
  type BoardStatus,
  type Clock,
  type Confidence,
  type MemoryBudget,
  type MemoryConfig,
  type MemoryCounts,
  type MemoryHit,
  type MemoryMaintenanceResult,
  type MemoryScope,
  type MemorySearchInput,
  type MemorySearchResult,
  type MemorySnapshot,
  type MemorySnapshotOptions,
  type MemoryStoreOptions,
  type Memo,
  type MemoKind,
  type TaskSummary,
} from "./types.js";
import {
  addDays,
  bool,
  clamp,
  escapeLike,
  firstLine,
  isOlderThanDays,
  isoOrNull,
  newId,
  normalizeBoardName,
  normalizeContent,
  parseJson,
  snippetAround,
  uniqueStrings,
} from "./util.js";

type Row = Record<string, unknown>;
type Entity = BoardEntry | Memo | TaskSummary;

interface Candidate {
  entityType: "board" | "memo" | "summary";
  entity: Entity;
  rawRank: number | null;
  relevance: number;
  normalization: "minmax" | "like" | "browse";
}

const BOARD_EXTRA_COLUMNS: Array<[string, string]> = [
  ["source", "TEXT NOT NULL DEFAULT 'agent'"],
  ["source_ref", "TEXT"],
  ["ttl_at", "TEXT"],
  ["last_verified_at", "TEXT"],
  ["verified_by", "TEXT"],
  ["evidence_at", "TEXT"],
  ["status", "TEXT NOT NULL DEFAULT 'active'"],
  ["archived_at", "TEXT"],
  ["archived_by", "TEXT"],
  ["archive_reason", "TEXT"],
  ["promoted_to_id", "TEXT"],
  ["stale", "INTEGER NOT NULL DEFAULT 0"],
  ["updated_at", "TEXT"],
  ["content_hash", "TEXT"],
];

const MEMO_EXTRA_COLUMNS: Array<[string, string]> = [
  ["confidence", "TEXT NOT NULL DEFAULT 'medium'"],
  ["source", "TEXT NOT NULL DEFAULT 'agent'"],
  ["source_ref", "TEXT"],
  ["source_task_id", "TEXT"],
  ["source_run_id", "TEXT"],
  ["expires_at", "TEXT"],
  ["status", "TEXT NOT NULL DEFAULT 'active'"],
  ["stale", "INTEGER NOT NULL DEFAULT 0"],
  ["last_verified_at", "TEXT"],
  ["verified_by", "TEXT"],
  ["promoted_to_board_id", "TEXT"],
  ["updated_at", "TEXT"],
  ["content_hash", "TEXT"],
];

const SUMMARY_EXTRA_COLUMNS: Array<[string, string]> = [
  ["workspace_id", "TEXT NOT NULL DEFAULT ''"],
  ["attempt", "INTEGER NOT NULL DEFAULT 1"],
  ["outcome", "TEXT"],
  ["next_steps", "TEXT NOT NULL DEFAULT '[]'"],
  ["evidence_refs", "TEXT NOT NULL DEFAULT '[]'"],
  ["agent_id", "TEXT"],
  ["agent_name", "TEXT"],
  ["model", "TEXT"],
  ["token_in", "INTEGER NOT NULL DEFAULT 0"],
  ["token_out", "INTEGER NOT NULL DEFAULT 0"],
  ["duration_ms", "INTEGER NOT NULL DEFAULT 0"],
  ["content_hash", "TEXT"],
  ["embedding", "BLOB"],
];

/**
 * Memory core. It is deliberately independent from AppService/tools/UI: those
 * integration layers are outside t99's scope and will consume this API later.
 */
export class MemoryStore {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly config: MemoryConfig;
  backupPath: string | null = null;
  private readonly store: Store;
  private readonly ftsEnabled: boolean;
  private ftsReady = false;
  private migrated = false;

  constructor(store: Store, options: MemoryStoreOptions = {}) {
    this.store = store;
    this.db = store.db;
    this.clock = options.clock ?? new SystemClock();
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...(options.config ?? {}) };
    this.ftsEnabled = options.ftsEnabled ?? true;
    this.migrate(options.migrationFault ?? null);
    this.migrated = true;
  }

  // ---------------------------------------------------------------- migration

  get schemaVersion(): number {
    if (!this.tableExists("memory_schema")) return 0;
    const row = this.db.prepare("SELECT MAX(version) AS version FROM memory_schema").get() as Row | undefined;
    return Number(row?.version ?? 0);
  }

  get ftsAvailable(): boolean {
    return this.ftsReady;
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as Row | undefined;
    return Boolean(row);
  }

  private ensureColumn(table: string, name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  private databaseFile(): string | null {
    const rows = this.db.prepare("PRAGMA database_list").all() as Array<{ name?: string; file?: string }>;
    const main = rows.find((row) => row.name === "main");
    return main?.file && main.file.length > 0 ? main.file : null;
  }

  private migrate(fault: "after-ddl" | null): void {
    const version = this.schemaVersion;
    const upgrade = version >= 1;
    if (version >= 2) {
      this.ensureFts();
      return;
    }
    if (!this.tableExists("board_entries") || !this.tableExists("memos") || !this.tableExists("summaries")) {
      throw new MemoryError("MEMORY_UNAVAILABLE", "base kernel tables are missing");
    }

    let backupPath: string | null = null;
    if (this.databaseFile()) {
      // t68 Store already owns a VACUUM INTO backup implementation.
      backupPath = this.store.backupDatabase();
      this.backupPath = backupPath;
    }

    this.store.withTransaction(() => {
      for (const [name, definition] of BOARD_EXTRA_COLUMNS) {
        this.ensureColumn("board_entries", name, definition);
      }
      for (const [name, definition] of MEMO_EXTRA_COLUMNS) {
        this.ensureColumn("memos", name, definition);
      }
      for (const [name, definition] of SUMMARY_EXTRA_COLUMNS) {
        this.ensureColumn("summaries", name, definition);
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_schema (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS board_domains (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          default_ttl_days INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(workspace_id, name_key)
        );
        CREATE INDEX IF NOT EXISTS idx_board_domains_ws ON board_domains(workspace_id);
        CREATE TABLE IF NOT EXISTS board_archive_proposals (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          board TEXT NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          entry_snapshot TEXT,
          proposed_by TEXT NOT NULL,
          proposed_at TEXT NOT NULL,
          decided_by TEXT,
          decided_at TEXT,
          note TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_archive_ws_status
          ON board_archive_proposals(workspace_id, status, proposed_at);
        CREATE INDEX IF NOT EXISTS idx_archive_entry_status_decided
          ON board_archive_proposals(entry_id, status, decided_at);
        CREATE UNIQUE INDEX IF NOT EXISTS ux_archive_pending_entry
          ON board_archive_proposals(entry_id) WHERE status = 'pending';
        CREATE TABLE IF NOT EXISTS memory_index_state (
          id TEXT PRIMARY KEY,
          dirty INTEGER NOT NULL DEFAULT 0,
          entry_count INTEGER NOT NULL DEFAULT 0,
          fts_available INTEGER NOT NULL DEFAULT 0,
          last_indexed_at TEXT
        );
      `);
      // Early/dev databases may have the proposal table without the snapshot
      // column. CREATE TABLE IF NOT EXISTS does not add columns, so guard it.
      this.ensureColumn("board_archive_proposals", "entry_snapshot", "TEXT");

      if (fault === "after-ddl") throw new Error("injected memory migration fault");

      const now = this.clock.now();
      const sourceExpr = upgrade
        ? "CASE WHEN lower(author) = 'user' AND source = 'agent' THEN 'user' ELSE COALESCE(NULLIF(source, ''), CASE WHEN lower(author) = 'user' THEN 'user' ELSE 'agent' END) END"
        : "CASE WHEN lower(author) = 'user' THEN 'user' ELSE 'agent' END";
      this.db.prepare(`
        UPDATE board_entries
           SET source = ${sourceExpr},
               source_ref = CASE WHEN lower(author) = 'user' THEN NULL
                                 ELSE COALESCE(source_ref,
                                   (SELECT a.name FROM agents a
                                     WHERE a.workspace_id = board_entries.workspace_id
                                       AND a.name = board_entries.author LIMIT 1), author)
                            END,
               status = COALESCE(NULLIF(status, ''), 'active'),
               stale = COALESCE(stale, 0),
               updated_at = COALESCE(updated_at, created_at)
      `).run();
      this.db.prepare(`
        UPDATE memos
           SET source = COALESCE(NULLIF(source, ''), 'agent'),
               source_ref = COALESCE(source_ref, agent_id),
               confidence = COALESCE(NULLIF(confidence, ''), 'medium'),
               status = COALESCE(NULLIF(status, ''), 'active'),
               stale = COALESCE(stale, 0),
               updated_at = COALESCE(updated_at, created_at)
      `).run();
      this.db.prepare("UPDATE summaries SET workspace_id = COALESCE(NULLIF(workspace_id, ''), (SELECT t.workspace_id FROM tasks t WHERE t.id = summaries.task_id), '')").run();
      this.db.prepare("UPDATE summaries SET outcome = COALESCE(NULLIF(outcome, ''), CASE (SELECT status FROM tasks WHERE id = summaries.task_id) WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'failed' END), attempt = CASE WHEN attempt IS NULL OR attempt < 1 THEN 1 ELSE attempt END").run();
      this.db.prepare("UPDATE summaries SET agent_id = COALESCE(agent_id, (SELECT owner_id FROM tasks WHERE id = summaries.task_id), (SELECT agent_id FROM runs WHERE task_id = summaries.task_id ORDER BY started_at DESC LIMIT 1)), agent_name = COALESCE(agent_name, (SELECT a.name FROM agents a JOIN runs r ON r.agent_id = a.id WHERE r.task_id = summaries.task_id ORDER BY r.started_at DESC LIMIT 1)), model = COALESCE(model, (SELECT r.model_id FROM runs r WHERE r.task_id = summaries.task_id ORDER BY r.started_at DESC LIMIT 1)), token_in = COALESCE(token_in, (SELECT r.token_in FROM runs r WHERE r.task_id = summaries.task_id ORDER BY r.started_at DESC LIMIT 1), 0), token_out = COALESCE(token_out, (SELECT r.token_out FROM runs r WHERE r.task_id = summaries.task_id ORDER BY r.started_at DESC LIMIT 1), 0), duration_ms = COALESCE(duration_ms, 0)").run();

      // Legacy Store.postBoard/addMemo paths do not know about source metadata.
      // Triggers keep those integration paths correct without touching Store.
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_board_source_user
        AFTER INSERT ON board_entries
        WHEN NEW.source = 'agent' AND lower(NEW.author) = 'user'
        BEGIN
          UPDATE board_entries SET source = 'user', source_ref = NULL WHERE id = NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_board_source_ref
        AFTER INSERT ON board_entries
        WHEN NEW.source = 'agent' AND NEW.source_ref IS NULL
        BEGIN
          UPDATE board_entries
             SET source_ref = COALESCE(
               (SELECT a.name FROM agents a
                 WHERE a.workspace_id = NEW.workspace_id AND a.name = NEW.author LIMIT 1),
               NEW.author)
           WHERE id = NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_memo_source_ref
        AFTER INSERT ON memos
        WHEN NEW.source_ref IS NULL
        BEGIN
          UPDATE memos SET source_ref = NEW.agent_id WHERE id = NEW.id;
        END;
      `);

      this.backfillDomains();
      this.backfillHashes();
      this.db.prepare("INSERT OR IGNORE INTO memory_schema (version, applied_at) VALUES (2, ?)").run(now);
      this.db.prepare("INSERT OR IGNORE INTO memory_index_state (id, dirty, entry_count, fts_available, last_indexed_at) VALUES ('memory', 1, 0, 0, NULL)").run();
      this.store.appendEvent({
        aggregateType: "memory",
        aggregateId: "memory",
        type: "memory.migrated",
        actor: "system",
        payload: { schemaVersion: 2, fromVersion: version, backup: backupPath !== null },
      });
    });

    this.ensureFts();
  }

  private backfillDomains(): void {
    const rows = this.db.prepare("SELECT DISTINCT workspace_id, board FROM board_entries").all() as Row[];
    const now = this.clock.now();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO board_domains
         (id, workspace_id, name, name_key, description, default_ttl_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', NULL, ?, ?)`,
    );
    for (const row of rows) {
      const ws = String(row.workspace_id);
      const normalized = normalizeBoardName(String(row.board));
      if (!normalized.name) continue;
      insert.run(newId("dom"), ws, normalized.name, normalized.key, now, now);
    }
  }

  private backfillHashes(): void {
    const boardRows = this.db.prepare("SELECT * FROM board_entries").all() as Row[];
    for (const row of boardRows) {
      if (!row.content_hash) {
        const hash = boardContentHash({
          board: String(row.board),
          kind: String(row.kind) as BoardEntry["kind"],
          content: String(row.content),
        });
        this.db.prepare("UPDATE board_entries SET content_hash = ? WHERE id = ?").run(hash, String(row.id));
      }
    }
    const memoRows = this.db.prepare("SELECT * FROM memos").all() as Row[];
    for (const row of memoRows) {
      if (!row.content_hash) {
        this.db.prepare("UPDATE memos SET content_hash = ? WHERE id = ?").run(
          memoContentHash({ content: String(row.content) }),
          String(row.id),
        );
      }
    }
    const summaryRows = this.db.prepare("SELECT * FROM summaries").all() as Row[];
    for (const row of summaryRows) {
      if (!row.content_hash) {
        const summary = this.toSummary(row);
        this.db.prepare("UPDATE summaries SET content_hash = ? WHERE id = ?").run(
          summary.contentHash,
          String(row.id),
        );
      }
    }
  }

  private ensureFts(): void {
    if (!this.ftsEnabled) {
      this.ftsReady = false;
      this.setIndexState(0, 1);
      return;
    }
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
        USING fts5(entity_type UNINDEXED, entity_id UNINDEXED, workspace_id UNINDEXED,
                   title, body, tags, tokenize = 'trigram')
      `);
      this.ftsReady = true;
      this.rebuildIndex();
    } catch {
      this.ftsReady = false;
      this.setIndexState(0, 1);
    }
  }

  private setIndexState(dirty: number, available: number): void {
    if (!this.tableExists("memory_index_state")) return;
    this.db.prepare(
      "UPDATE memory_index_state SET dirty = ?, fts_available = ? WHERE id = 'memory'",
    ).run(dirty, available);
  }

  /** Rebuilds the FTS projection from content tables; safe to call repeatedly. */
  rebuildIndex(): void {
    if (!this.ftsReady) return;
    this.store.withTransaction(() => {
      this.db.exec("DELETE FROM memory_fts");
      const boardRows = this.db.prepare("SELECT * FROM board_entries").all() as Row[];
      for (const row of boardRows) {
        const entry = this.toBoard(row);
        this.insertIndex(boardDoc(entry));
      }
      const memoRows = this.db.prepare("SELECT * FROM memos").all() as Row[];
      for (const row of memoRows) {
        const memo = this.toMemo(row);
        this.insertIndex(memoDoc(memo));
      }
      const summaryRows = this.db.prepare("SELECT * FROM summaries").all() as Row[];
      for (const row of summaryRows) {
        const summary = this.toSummary(row);
        this.insertIndex(summaryDoc(summary));
      }
      const count = Number((this.db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as Row).n ?? 0);
      this.db.prepare(
        "UPDATE memory_index_state SET dirty = 0, entry_count = ?, fts_available = 1, last_indexed_at = ? WHERE id = 'memory'",
      ).run(count, this.clock.now());
    });
  }

  private insertIndex(doc: {
    entityType: string;
    entityId: string;
    workspaceId: string;
    title: string;
    body: string;
    tags: string;
  }): void {
    if (!this.ftsReady) return;
    this.db
      .prepare(
        `INSERT INTO memory_fts (entity_type, entity_id, workspace_id, title, body, tags)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(doc.entityType, doc.entityId, doc.workspaceId, doc.title, doc.body, doc.tags);
  }

  private indexBoard(entry: BoardEntry): void {
    if (!this.ftsReady) return;
    this.db.prepare("DELETE FROM memory_fts WHERE entity_type = 'board' AND entity_id = ?").run(entry.id);
    this.insertIndex(boardDoc(entry));
  }

  private indexMemo(memo: Memo): void {
    if (!this.ftsReady) return;
    this.db.prepare("DELETE FROM memory_fts WHERE entity_type = 'memo' AND entity_id = ?").run(memo.id);
    this.insertIndex(memoDoc(memo));
  }

  private indexSummary(summary: TaskSummary): void {
    if (!this.ftsReady) return;
    this.db.prepare("DELETE FROM memory_fts WHERE entity_type = 'summary' AND entity_id = ?").run(summary.id);
    this.insertIndex(summaryDoc(summary));
  }

  // ---------------------------------------------------------------- row mappers

  private toBoard(row: Row): BoardEntry {
    const now = this.clock.now();
    const createdAt = String(row.created_at);
    const lastVerifiedAt = isoOrNull(row.last_verified_at);
    const stale = isOlderThanDays(lastVerifiedAt ?? createdAt, now, this.config.staleAfterDays);
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      board: String(row.board),
      author: String(row.author),
      kind: String(row.kind) as BoardEntry["kind"],
      content: String(row.content),
      refs: parseJson<string[]>(row.refs, []),
      confidence: String(row.confidence) as Confidence,
      pinned: bool(row.pinned),
      source: String(row.source ?? "agent") as BoardEntry["source"],
      sourceRef: isoOrNull(row.source_ref),
      ttlAt: isoOrNull(row.ttl_at),
      lastVerifiedAt,
      verifiedBy: isoOrNull(row.verified_by),
      evidenceAt: isoOrNull(row.evidence_at),
      status: String(row.status ?? "active") as BoardStatus,
      archivedAt: isoOrNull(row.archived_at),
      archivedBy: isoOrNull(row.archived_by),
      archiveReason: isoOrNull(row.archive_reason),
      promotedToId: isoOrNull(row.promoted_to_id),
      stale,
      createdAt,
      updatedAt: String(row.updated_at ?? createdAt),
      contentHash: String(row.content_hash ?? boardContentHash({
        board: String(row.board),
        kind: String(row.kind) as BoardEntry["kind"],
        content: String(row.content),
      })),
    };
  }

  private toMemo(row: Row): Memo {
    const now = this.clock.now();
    const createdAt = String(row.created_at);
    const lastVerifiedAt = isoOrNull(row.last_verified_at);
    const stale = isOlderThanDays(lastVerifiedAt ?? createdAt, now, this.config.staleAfterDays);
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      agentId: String(row.agent_id),
      kind: String(row.kind) as MemoKind,
      content: String(row.content),
      tags: parseJson<string[]>(row.tags, []),
      confidence: String(row.confidence ?? "medium") as Confidence,
      source: String(row.source ?? "agent") as Memo["source"],
      sourceRef: isoOrNull(row.source_ref),
      sourceTaskId: isoOrNull(row.source_task_id),
      sourceRunId: isoOrNull(row.source_run_id),
      expiresAt: isoOrNull(row.expires_at),
      status: String(row.status ?? "active") as Memo["status"],
      stale,
      lastVerifiedAt,
      verifiedBy: isoOrNull(row.verified_by),
      promotedToBoardId: isoOrNull(row.promoted_to_board_id),
      createdAt,
      updatedAt: String(row.updated_at ?? createdAt),
      contentHash: String(row.content_hash ?? memoContentHash({ content: String(row.content) })),
    };
  }

  private toSummary(row: Row): TaskSummary {
    const goal = String(row.goal);
    const changes = parseJson<string[]>(row.changes, []);
    const files = parseJson<string[]>(row.files, []);
    const tests = parseJson<TaskSummary["tests"]>(row.tests, []);
    const decisions = parseJson<string[]>(row.decisions, []);
    const risks = parseJson<string[]>(row.risks, []);
    const openQuestions = parseJson<string[]>(row.open_questions, []);
    const nextSteps = parseJson<string[]>(row.next_steps, []);
    const evidenceRefs = parseJson<string[]>(row.evidence_refs, []);
    const createdAt = String(row.created_at);
    const summary: TaskSummary = {
      id: String(row.id),
      taskId: String(row.task_id),
      runId: String(row.run_id),
      workspaceId: String(row.workspace_id ?? ""),
      attempt: Number(row.attempt ?? 1),
      outcome: String(row.outcome ?? "failed") as TaskSummary["outcome"],
      goal,
      changes,
      files,
      tests,
      decisions,
      risks,
      openQuestions,
      nextSteps,
      evidenceRefs,
      agentId: isoOrNull(row.agent_id),
      agentName: isoOrNull(row.agent_name),
      model: isoOrNull(row.model),
      tokenIn: Number(row.token_in ?? 0),
      tokenOut: Number(row.token_out ?? 0),
      durationMs: Number(row.duration_ms ?? 0),
      createdAt,
      contentHash: String(row.content_hash ?? summaryContentHash({ goal, changes, decisions, risks, nextSteps, openQuestions })),
    };
    return summary;
  }

  private toProposal(row: Row): BoardArchiveProposal {
    const raw = typeof row.entry_snapshot === "string" ? parseJson<unknown>(row.entry_snapshot, null) : null;
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      entryId: String(row.entry_id),
      board: String(row.board),
      reason: String(row.reason) as BoardArchiveProposal["reason"],
      status: String(row.status) as BoardArchiveProposal["status"],
      entrySnapshot: raw && typeof raw === "object" ? (raw as BoardEntrySnapshot) : null,
      proposedBy: String(row.proposed_by),
      proposedAt: String(row.proposed_at),
      decidedBy: isoOrNull(row.decided_by),
      decidedAt: isoOrNull(row.decided_at),
      note: isoOrNull(row.note),
    };
  }

  private toDomain(row: Row): BoardDomain {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      nameKey: String(row.name_key),
      description: String(row.description ?? ""),
      defaultTtlDays: row.default_ttl_days == null ? null : Number(row.default_ttl_days),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // ---------------------------------------------------------------- board CRUD

  createBoard(input: {
    workspaceId: string;
    board: string;
    author: string;
    kind: BoardEntry["kind"];
    content: string;
    refs?: string[];
    confidence?: Confidence;
    source?: BoardEntry["source"];
    sourceRef?: string | null;
    ttlDays?: number | null;
    pinned?: boolean;
  }): BoardEntry {
    this.assertMigrated();
    this.ensureWorkspace(input.workspaceId);
    const now = this.clock.now();
    const normalized = normalizeBoardName(input.board);
    if (!normalized.name || normalized.name.length > 40) throw new MemoryError("MEMORY_INVALID_INPUT", "invalid board");
    if (!input.content.trim() || input.content.length > 2000) throw new MemoryError("MEMORY_INVALID_INPUT", "content must be 1..2000 chars");
    if (!BOARD_KINDS.includes(input.kind)) throw new MemoryError("MEMORY_INVALID_INPUT", "invalid board kind");
    if (input.confidence && !CONFIDENCES.includes(input.confidence)) throw new MemoryError("MEMORY_INVALID_INPUT", "invalid confidence");
    const ttlDays = input.ttlDays == null ? null : Number(input.ttlDays);
    if (ttlDays !== null && (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365)) {
      throw new MemoryError("MEMORY_INVALID_INPUT", "ttlDays must be 1..365 or null");
    }
    const source = input.source ?? (input.author.toLowerCase() === "user" ? "user" : "agent");
    const sourceRef = input.sourceRef ?? (source === "user" ? null : this.resolveAgentSourceRef(input.workspaceId, input.author));
    const entry: BoardEntry = {
      id: newId("board"),
      workspaceId: input.workspaceId,
      board: normalized.name,
      author: input.author,
      kind: input.kind,
      content: normalizeContent(input.content),
      refs: uniqueStrings(input.refs ?? [], 20),
      confidence: input.confidence ?? "medium",
      pinned: input.pinned === true,
      source,
      sourceRef,
      ttlAt: ttlDays === null ? null : addDays(now, ttlDays),
      lastVerifiedAt: null,
      verifiedBy: null,
      evidenceAt: null,
      status: "active",
      archivedAt: null,
      archivedBy: null,
      archiveReason: null,
      promotedToId: null,
      stale: false,
      createdAt: now,
      updatedAt: now,
      contentHash: "",
    };
    entry.contentHash = boardContentHash(entry);
    this.store.withTransaction(() => {
      this.ensureDomain(entry.workspaceId, entry.board, now);
      this.db.prepare(
        `INSERT INTO board_entries
          (id, workspace_id, board, author, kind, content, refs, confidence, pinned, created_at,
           source, source_ref, ttl_at, last_verified_at, verified_by, evidence_at, status,
           archived_at, archived_by, archive_reason, promoted_to_id, stale, updated_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.id, entry.workspaceId, entry.board, entry.author, entry.kind, entry.content,
        JSON.stringify(entry.refs), entry.confidence, entry.pinned ? 1 : 0, entry.createdAt,
        entry.source, entry.sourceRef, entry.ttlAt, null, null, null, entry.status,
        null, null, null, null, 0, entry.updatedAt, entry.contentHash,
      );
      this.indexBoard(entry);
      this.store.appendEvent({
        aggregateType: "board",
        aggregateId: entry.id,
        type: "board.posted",
        actor: entry.author,
        payload: { workspaceId: entry.workspaceId, board: entry.board, kind: entry.kind, refsCount: entry.refs.length },
      });
    });
    return entry;
  }

  private ensureDomain(workspaceId: string, board: string, now: string): BoardDomain {
    const normalized = normalizeBoardName(board);
    const existing = this.db
      .prepare("SELECT * FROM board_domains WHERE workspace_id = ? AND name_key = ?")
      .get(workspaceId, normalized.key) as Row | undefined;
    if (existing) return this.toDomain(existing);
    const domain: BoardDomain = {
      id: newId("dom"),
      workspaceId,
      name: normalized.name,
      nameKey: normalized.key,
      description: "",
      defaultTtlDays: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(
      `INSERT INTO board_domains (id, workspace_id, name, name_key, description, default_ttl_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', NULL, ?, ?)`,
    ).run(domain.id, domain.workspaceId, domain.name, domain.nameKey, now, now);
    this.store.appendEvent({
      aggregateType: "board",
      aggregateId: domain.workspaceId,
      type: "board.domain_created",
      actor: "system",
      payload: { workspaceId, nameKey: domain.nameKey },
    });
    return domain;
  }

  listBoard(
    workspaceId: string,
    options: {
      board?: string;
      status?: BoardStatus;
      stale?: boolean;
      includeArchived?: boolean;
      limit?: number;
    } = {},
  ): BoardEntry[] {
    this.assertMigrated();
    this.ensureWorkspace(workspaceId);
    const clauses = ["workspace_id = ?"];
    const params: Array<string | number> = [workspaceId];
    if (options.board) {
      clauses.push("board = ?");
      params.push(normalizeBoardName(options.board).name);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    } else if (!options.includeArchived) {
      clauses.push("status = 'active'");
    } else {
      clauses.push("status IN ('active','archived')");
    }
    if (options.stale !== undefined) {
      clauses.push("stale = ?");
      params.push(options.stale ? 1 : 0);
    }
    params.push(clamp(options.limit ?? 200, 1, 500));
    const rows = this.db
      .prepare(`SELECT * FROM board_entries WHERE ${clauses.join(" AND ")} ORDER BY pinned DESC, updated_at DESC, created_at DESC LIMIT ?`)
      .all(...params) as Row[];
    return rows.map((row) => this.toBoard(row));
  }

  getBoard(workspaceId: string, entryId: string): BoardEntry | null {
    this.assertMigrated();
    this.ensureWorkspace(workspaceId);
    const row = this.db
      .prepare("SELECT * FROM board_entries WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, entryId) as Row | undefined;
    return row ? this.toBoard(row) : null;
  }

  setBoardPinned(workspaceId: string, entryId: string, pinned: boolean, actor: string): BoardEntry {
    return this.store.withTransaction(() => {
      const entry = this.requireBoard(workspaceId, entryId);
      if (entry.status !== "active") throw new MemoryError("MEMORY_CONFLICT", "entry is not active");
      const now = this.clock.now();
      this.db.prepare("UPDATE board_entries SET pinned = ?, updated_at = ? WHERE id = ?").run(pinned ? 1 : 0, now, entryId);
      this.supersedePending(entryId, actor, now);
      const updated = this.requireBoard(workspaceId, entryId);
      this.store.appendEvent({ aggregateType: "board", aggregateId: entryId, type: "board.pinned", actor, payload: { pinned, workspaceId } });
      return updated;
    });
  }

  verifyBoard(
    workspaceId: string,
    entryId: string,
    actor: string,
    confidence?: Confidence,
  ): BoardEntry {
    return this.store.withTransaction(() => {
      const entry = this.requireBoard(workspaceId, entryId);
      if (entry.status !== "active") throw new MemoryError("MEMORY_CONFLICT", "entry is not active");
      if (entry.ttlAt && Date.parse(entry.ttlAt) <= Date.parse(this.clock.now())) {
        throw new MemoryError("MEMORY_CONFLICT", "entry is expired; renew TTL before verify");
      }
      const now = this.clock.now();
      this.db.prepare(
        "UPDATE board_entries SET last_verified_at = ?, verified_by = ?, stale = 0, confidence = ?, updated_at = ? WHERE id = ?",
      ).run(now, actor, confidence ?? entry.confidence, now, entryId);
      this.supersedePending(entryId, actor, now);
      this.store.appendEvent({ aggregateType: "board", aggregateId: entryId, type: "board.verified", actor, payload: { workspaceId } });
      return this.requireBoard(workspaceId, entryId);
    });
  }

  setBoardTtl(workspaceId: string, entryId: string, ttlDays: number | null, actor: string): BoardEntry {
    if (ttlDays !== null && (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365)) {
      throw new MemoryError("MEMORY_INVALID_INPUT", "ttlDays must be 1..365 or null");
    }
    return this.store.withTransaction(() => {
      const entry = this.requireBoard(workspaceId, entryId);
      if (entry.status !== "active") throw new MemoryError("MEMORY_CONFLICT", "entry is not active");
      const now = this.clock.now();
      const ttlAt = ttlDays === null ? null : addDays(now, ttlDays);
      this.db.prepare("UPDATE board_entries SET ttl_at = ?, updated_at = ? WHERE id = ?").run(ttlAt, now, entryId);
      this.supersedePending(entryId, actor, now);
      this.store.appendEvent({ aggregateType: "board", aggregateId: entryId, type: "board.ttl_changed", actor, payload: { workspaceId, ttlDays } });
      return this.requireBoard(workspaceId, entryId);
    });
  }

  proposeArchive(input: {
    workspaceId: string;
    entryId: string;
    reason?: ArchiveReason;
    proposedBy: string;
    note?: string | null;
    enforceCooldown?: boolean;
  }): BoardArchiveProposal {
    return this.store.withTransaction(() => {
      const entry = this.requireBoard(input.workspaceId, input.entryId);
      if (entry.status === "archived") throw new MemoryError("MEMORY_CONFLICT", "entry is archived");
      if (entry.pinned) throw new MemoryError("MEMORY_PINNED", "pinned entry cannot be archived");
      const now = this.clock.now();
      if (input.enforceCooldown && this.recentlyRejected(entry.id, now)) {
        throw new MemoryError("MEMORY_CONFLICT", "recently rejected; cooldown active");
      }
      const pending = this.db.prepare(
        "SELECT * FROM board_archive_proposals WHERE entry_id = ? AND status = 'pending'",
      ).get(entry.id) as Row | undefined;
      if (pending) return this.toProposal(pending);
      const proposal: BoardArchiveProposal = {
        id: newId("prop"),
        workspaceId: entry.workspaceId,
        entryId: entry.id,
        board: entry.board,
        reason: input.reason ?? "manual",
        status: "pending",
        entrySnapshot: this.snapshotOf(entry),
        proposedBy: input.proposedBy,
        proposedAt: now,
        decidedBy: null,
        decidedAt: null,
        note: input.note ?? null,
      };
      this.db.prepare(
        `INSERT INTO board_archive_proposals
          (id, workspace_id, entry_id, board, reason, status, entry_snapshot, proposed_by, proposed_at, decided_by, decided_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(
        proposal.id, proposal.workspaceId, proposal.entryId, proposal.board, proposal.reason,
        proposal.status, JSON.stringify(proposal.entrySnapshot), proposal.proposedBy,
        proposal.proposedAt, proposal.note,
      );
      this.store.appendEvent({
        aggregateType: "board",
        aggregateId: entry.id,
        type: "board.archive_proposed",
        actor: input.proposedBy,
        payload: { proposalId: proposal.id, reason: proposal.reason, workspaceId: entry.workspaceId },
      });
      return proposal;
    });
  }

  decideArchive(input: {
    workspaceId: string;
    proposalId: string;
    decision: "approve" | "reject";
    actor: string;
    note?: string | null;
  }): BoardArchiveProposal {
    return this.store.withTransaction(() => {
      const row = this.db.prepare("SELECT * FROM board_archive_proposals WHERE id = ? AND workspace_id = ?").get(input.proposalId, input.workspaceId) as Row | undefined;
      if (!row) throw new MemoryError("MEMORY_NOT_FOUND", "proposal not found");
      const proposal = this.toProposal(row);
      if (proposal.status !== "pending") throw new MemoryError("MEMORY_PROPOSAL_CLOSED", "proposal is closed");
      const entry = this.requireBoard(input.workspaceId, proposal.entryId);
      if (entry.pinned) throw new MemoryError("MEMORY_PINNED", "pinned entry cannot be archived");
      if (input.decision === "approve" && entry.status !== "active") {
        throw new MemoryError("MEMORY_CONFLICT", "entry must be active to approve archive");
      }
      const now = this.clock.now();
      const status = input.decision === "approve" ? "approved" : "rejected";
      this.db.prepare(
        "UPDATE board_archive_proposals SET status = ?, decided_by = ?, decided_at = ?, note = COALESCE(?, note) WHERE id = ?",
      ).run(status, input.actor, now, input.note ?? null, proposal.id);
      if (input.decision === "approve") {
        this.db.prepare(
          "UPDATE board_entries SET status = 'archived', archived_at = ?, archived_by = ?, archive_reason = ?, updated_at = ? WHERE id = ?",
        ).run(now, input.actor, proposal.reason, now, entry.id);
        this.store.appendEvent({ aggregateType: "board", aggregateId: entry.id, type: "board.archived", actor: input.actor, payload: { proposalId: proposal.id, workspaceId: input.workspaceId } });
      } else {
        this.store.appendEvent({ aggregateType: "board", aggregateId: entry.id, type: "board.archive_rejected", actor: input.actor, payload: { proposalId: proposal.id, workspaceId: input.workspaceId } });
      }
      return this.toProposal(this.db.prepare("SELECT * FROM board_archive_proposals WHERE id = ?").get(proposal.id) as Row);
    });
  }

  listProposals(workspaceId: string, status?: BoardArchiveProposal["status"], limit = 100): BoardArchiveProposal[] {
    this.ensureWorkspace(workspaceId);
    const rows = status
      ? (this.db.prepare("SELECT * FROM board_archive_proposals WHERE workspace_id = ? AND status = ? ORDER BY proposed_at DESC LIMIT ?").all(workspaceId, status, clamp(limit, 1, 200)) as Row[])
      : (this.db.prepare("SELECT * FROM board_archive_proposals WHERE workspace_id = ? ORDER BY proposed_at DESC LIMIT ?").all(workspaceId, clamp(limit, 1, 200)) as Row[]);
    return rows.map((row) => this.toProposal(row));
  }

  promoteBoard(workspaceId: string, entryId: string, actor: string, kind: "decision" | "fact" = "decision"): BoardEntry {
    return this.store.withTransaction(() => {
      const entry = this.requireBoard(workspaceId, entryId);
      if (entry.status !== "active") throw new MemoryError("MEMORY_CONFLICT", "entry is not active");
      if (entry.ttlAt && Date.parse(entry.ttlAt) <= Date.parse(this.clock.now())) {
        throw new MemoryError("MEMORY_CONFLICT", "entry is expired; cannot promote");
      }
      if (entry.kind === "decision") return entry;
      const promoted = this.createBoard({
        workspaceId,
        board: entry.board,
        author: actor,
        kind,
        content: entry.content,
        refs: uniqueStrings([...entry.refs, `board:${entry.id}`]),
        confidence: entry.confidence,
        source: "user",
      });
      this.db.prepare("UPDATE board_entries SET promoted_to_id = ?, updated_at = ? WHERE id = ?").run(promoted.id, this.clock.now(), entry.id);
      this.store.appendEvent({ aggregateType: "board", aggregateId: entry.id, type: "board.promoted", actor, payload: { promotedId: promoted.id, workspaceId } });
      return promoted;
    });
  }

  private requireBoard(workspaceId: string, entryId: string): BoardEntry {
    const entry = this.getBoard(workspaceId, entryId);
    if (!entry) throw new MemoryError("MEMORY_NOT_FOUND", "board entry not found");
    return entry;
  }

  private snapshotOf(entry: BoardEntry): BoardEntrySnapshot {
    return {
      board: entry.board,
      kind: entry.kind,
      confidence: entry.confidence,
      ttlAt: entry.ttlAt,
      lastVerifiedAt: entry.lastVerifiedAt,
      verifiedBy: entry.verifiedBy,
      pinned: entry.pinned,
      status: entry.status,
      contentHash: entry.contentHash,
      contentPreview: snippetAround(entry.content, [], 280),
    };
  }

  private supersedePending(entryId: string, actor: string, now: string): void {
    const pending = this.db.prepare("SELECT id FROM board_archive_proposals WHERE entry_id = ? AND status = 'pending'").all(entryId) as Row[];
    for (const row of pending) {
      this.db.prepare("UPDATE board_archive_proposals SET status = 'superseded', decided_by = ?, decided_at = ? WHERE id = ?").run(actor, now, String(row.id));
      this.store.appendEvent({ aggregateType: "board", aggregateId: entryId, type: "board.archive_superseded", actor, payload: { proposalId: String(row.id) } });
    }
  }

  private recentlyRejected(entryId: string, now: string): boolean {
    const cutoff = new Date(Date.parse(now) - this.config.rejectCooldownDays * DAY_MS).toISOString();
    const row = this.db.prepare(
      "SELECT 1 AS hit FROM board_archive_proposals WHERE entry_id = ? AND status = 'rejected' AND decided_at IS NOT NULL AND decided_at > ? LIMIT 1",
    ).get(entryId, cutoff) as Row | undefined;
    return Boolean(row);
  }

  /** Rejection audit; deliberately contains no rejected content or query text. */
  auditRejected(actor: string, workspaceId: string, operation: string): void {
    this.store.appendEvent({
      aggregateType: "memory",
      aggregateId: workspaceId || "memory",
      type: "memory.command_rejected",
      actor,
      payload: { operation, code: "MEMORY_FORBIDDEN" },
    });
  }

  /** Context skip/failure diagnostics; no query, hit content, or private data. */
  recordContextEvent(
    type: "memory.context_skipped" | "memory.context_failed",
    workspaceId: string,
    payload: Record<string, unknown> = {},
  ): void {
    this.store.appendEvent({
      aggregateType: "memory",
      aggregateId: workspaceId || "memory",
      type,
      actor: "system",
      payload,
    });
  }

  /**
   * Successful Run evidence refresh (design §9.4). Only board entries have
   * evidenceAt; memo provenance is sourceTaskId/sourceRunId and is not changed here.
   */
  onRunCompleted(taskId: string, runId: string, workspaceId?: string): number {
    const resolvedWorkspace = workspaceId
      ?? (this.db.prepare("SELECT workspace_id FROM tasks WHERE id = ?").get(taskId) as Row | undefined)?.workspace_id;
    if (!resolvedWorkspace) throw new MemoryError("MEMORY_INVALID_INPUT", "task/workspace not found");
    const ws = String(resolvedWorkspace);
    this.ensureWorkspace(ws);
    this.ensureTask(ws, taskId);
    this.ensureRun(ws, taskId, runId);
    return this.store.withTransaction(() => {
      const rows = this.db.prepare(
        "SELECT * FROM board_entries WHERE workspace_id = ? AND status = 'active'",
      ).all(ws) as Row[];
      const now = this.clock.now();
      let updated = 0;
      for (const row of rows) {
        const refs = parseJson<string[]>(row.refs, []);
        if (!refs.includes(`task:${taskId}`) && !refs.includes(`run:${runId}`)) continue;
        this.db.prepare("UPDATE board_entries SET evidence_at = ?, updated_at = ? WHERE id = ?").run(now, now, String(row.id));
        updated += 1;
      }
      if (updated > 0) {
        this.store.appendEvent({
          aggregateType: "memory",
          aggregateId: ws,
          type: "memory.evidence_updated",
          actor: "system",
          payload: { workspaceId: ws, taskId, runId, updated },
        });
      }
      return updated;
    });
  }

  // ---------------------------------------------------------------- memos

  createMemo(input: {
    workspaceId: string;
    agentId: string;
    kind: MemoKind;
    content: string;
    tags?: string[];
    confidence?: Confidence;
    source?: Memo["source"];
    sourceRef?: string | null;
    sourceTaskId?: string | null;
    sourceRunId?: string | null;
    expiresInDays?: number | null;
  }): Memo {
    this.assertMigrated();
    this.ensureWorkspace(input.workspaceId);
    this.ensureAgent(input.workspaceId, input.agentId);
    if (!input.content.trim() || input.content.length > 2000) throw new MemoryError("MEMORY_INVALID_INPUT", "memo content must be 1..2000 chars");
    if (!MEMO_KINDS.includes(input.kind)) throw new MemoryError("MEMORY_INVALID_INPUT", "invalid memo kind");
    if (input.confidence && !CONFIDENCES.includes(input.confidence)) throw new MemoryError("MEMORY_INVALID_INPUT", "invalid confidence");
    if (input.sourceTaskId) this.ensureTask(input.workspaceId, input.sourceTaskId);
    if (input.sourceRunId) this.ensureRun(input.workspaceId, input.sourceTaskId ?? null, input.sourceRunId);
    const tags = this.normalizeTags(input.tags ?? []);
    const expiresInDays = input.expiresInDays == null ? null : Number(input.expiresInDays);
    if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365)) {
      throw new MemoryError("MEMORY_INVALID_INPUT", "expiresInDays must be 1..365 or null");
    }
    const now = this.clock.now();
    const source = input.source ?? "agent";
    const memo: Memo = {
      id: newId("memo"),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      kind: input.kind,
      content: normalizeContent(input.content),
      tags,
      confidence: input.confidence ?? "medium",
      source,
      sourceRef: input.sourceRef ?? (source === "agent" ? input.agentId : null),
      sourceTaskId: input.sourceTaskId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      expiresAt: expiresInDays === null ? null : addDays(now, expiresInDays),
      status: "active",
      stale: false,
      lastVerifiedAt: null,
      verifiedBy: null,
      promotedToBoardId: null,
      createdAt: now,
      updatedAt: now,
      contentHash: "",
    };
    memo.contentHash = memoContentHash(memo);
    this.store.withTransaction(() => {
      this.db.prepare(
        `INSERT INTO memos
          (id, workspace_id, agent_id, kind, content, tags, created_at, confidence, source, source_ref,
           source_task_id, source_run_id, expires_at, status, stale, last_verified_at, verified_by,
           promoted_to_board_id, updated_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        memo.id, memo.workspaceId, memo.agentId, memo.kind, memo.content, JSON.stringify(memo.tags),
        memo.createdAt, memo.confidence, memo.source, memo.sourceRef, memo.sourceTaskId,
        memo.sourceRunId, memo.expiresAt, memo.status, 0, null, null, null, memo.updatedAt, memo.contentHash,
      );
      this.indexMemo(memo);
      this.store.appendEvent({
        aggregateType: "memo",
        aggregateId: memo.id,
        type: "memo.created",
        actor: `agent:${memo.agentId}`,
        payload: { workspaceId: memo.workspaceId, agentId: memo.agentId, kind: memo.kind, tagsCount: memo.tags.length, hasExpiry: memo.expiresAt !== null },
      });
    });
    return memo;
  }

  listMemos(
    workspaceId: string,
    agentId: string,
    options: { status?: Memo["status"]; stale?: boolean; includeArchived?: boolean; limit?: number } = {},
  ): Memo[] {
    this.assertMigrated();
    if (!agentId) return [];
    this.ensureWorkspace(workspaceId);
    this.ensureAgent(workspaceId, agentId);
    const clauses = ["workspace_id = ?", "agent_id = ?"];
    const params: Array<string | number> = [workspaceId, agentId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    } else if (!options.includeArchived) {
      clauses.push("status IN ('active','expired')");
    } else {
      clauses.push("status IN ('active','expired','archived')");
    }
    if (options.stale !== undefined) {
      clauses.push("stale = ?");
      params.push(options.stale ? 1 : 0);
    }
    params.push(clamp(options.limit ?? 200, 1, 500));
    const rows = this.db.prepare(`SELECT * FROM memos WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(...params) as Row[];
    return rows.map((row) => this.toMemo(row));
  }

  getMemo(workspaceId: string, agentId: string, memoId: string): Memo | null {
    const row = this.db.prepare("SELECT * FROM memos WHERE workspace_id = ? AND agent_id = ? AND id = ?").get(workspaceId, agentId, memoId) as Row | undefined;
    return row ? this.toMemo(row) : null;
  }

  verifyMemo(workspaceId: string, agentId: string, memoId: string, actor: string): Memo {
    return this.store.withTransaction(() => {
      const memo = this.getMemo(workspaceId, agentId, memoId);
      if (!memo) throw new MemoryError("MEMORY_NOT_FOUND", "memo not found");
      if (memo.status !== "active") throw new MemoryError("MEMORY_CONFLICT", "memo is not active");
      if (memo.expiresAt && Date.parse(memo.expiresAt) <= Date.parse(this.clock.now())) {
        throw new MemoryError("MEMORY_CONFLICT", "memo is expired");
      }
      const now = this.clock.now();
      this.db.prepare("UPDATE memos SET last_verified_at = ?, verified_by = ?, stale = 0, updated_at = ? WHERE id = ?").run(now, actor, now, memoId);
      this.store.appendEvent({ aggregateType: "memo", aggregateId: memoId, type: "memo.verified", actor, payload: { workspaceId, agentId } });
      return this.getMemo(workspaceId, agentId, memoId) as Memo;
    });
  }

  archiveMemo(workspaceId: string, agentId: string, memoId: string, actor: string): Memo {
    return this.store.withTransaction(() => {
      const memo = this.getMemo(workspaceId, agentId, memoId);
      if (!memo) throw new MemoryError("MEMORY_NOT_FOUND", "memo not found");
      const now = this.clock.now();
      this.db.prepare("UPDATE memos SET status = 'archived', updated_at = ? WHERE id = ?").run(now, memoId);
      this.store.appendEvent({ aggregateType: "memo", aggregateId: memoId, type: "memo.archived", actor, payload: { workspaceId, agentId } });
      return this.getMemo(workspaceId, agentId, memoId) as Memo;
    });
  }

  promoteMemo(workspaceId: string, agentId: string, memoId: string, actor: string, board: string): BoardEntry {
    return this.store.withTransaction(() => {
      const memo = this.getMemo(workspaceId, agentId, memoId);
      if (!memo) throw new MemoryError("MEMORY_NOT_FOUND", "memo not found");
      if (memo.status !== "active") throw new MemoryError("MEMORY_CONFLICT", "memo is not active");
      if (memo.promotedToBoardId) throw new MemoryError("MEMORY_CONFLICT", "memo already promoted");
      const entry = this.createBoard({
        workspaceId,
        board,
        author: actor,
        kind: "fact",
        content: memo.content,
        refs: [`memo:${memo.id}`],
        confidence: memo.confidence,
        source: "user",
      });
      this.db.prepare("UPDATE memos SET promoted_to_board_id = ?, updated_at = ? WHERE id = ?").run(entry.id, this.clock.now(), memo.id);
      this.store.appendEvent({ aggregateType: "memo", aggregateId: memo.id, type: "memo.promoted", actor, payload: { workspaceId, agentId, boardId: entry.id } });
      return entry;
    });
  }

  // ---------------------------------------------------------------- summaries

  saveSummary(input: {
    taskId: string;
    runId: string;
    workspaceId: string;
    goal: string;
    changes?: string[];
    files?: string[];
    tests?: TaskSummary["tests"];
    decisions?: string[];
    risks?: string[];
    openQuestions?: string[];
    nextSteps?: string[];
    evidenceRefs?: string[];
    agentId?: string | null;
    attempt?: number;
    outcome?: TaskSummary["outcome"];
    agentName?: string | null;
    model?: string | null;
    tokenIn?: number;
    tokenOut?: number;
    durationMs?: number;
  }): TaskSummary {
    this.assertMigrated();
    this.ensureWorkspace(input.workspaceId);
    this.ensureTask(input.workspaceId, input.taskId);
    this.ensureRun(input.workspaceId, input.taskId, input.runId);
    const agentId = input.agentId ?? this.resolveSummaryAgentId(input.taskId, input.runId);
    if (agentId) this.ensureAgent(input.workspaceId, agentId);
    const summary: TaskSummary = {
      id: "",
      taskId: input.taskId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      attempt: Math.max(1, input.attempt ?? 1),
      outcome: input.outcome ?? "completed",
      goal: input.goal,
      changes: input.changes ?? [],
      files: input.files ?? [],
      tests: input.tests ?? [],
      decisions: input.decisions ?? [],
      risks: input.risks ?? [],
      openQuestions: input.openQuestions ?? [],
      nextSteps: input.nextSteps ?? [],
      evidenceRefs: uniqueStrings(input.evidenceRefs ?? [`task:${input.taskId}`, `run:${input.runId}`]),
      agentId,
      agentName: input.agentName ?? null,
      model: input.model ?? null,
      tokenIn: input.tokenIn ?? 0,
      tokenOut: input.tokenOut ?? 0,
      durationMs: input.durationMs ?? 0,
      createdAt: this.clock.now(),
      contentHash: "",
    };
    summary.contentHash = summaryContentHash(summary);
    return this.store.withTransaction(() => {
      const existing = this.db.prepare("SELECT * FROM summaries WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(input.runId) as Row | undefined;
      if (existing) {
        summary.id = String(existing.id);
        summary.createdAt = String(existing.created_at);
        this.db.prepare(
          `UPDATE summaries SET workspace_id = ?, attempt = ?, outcome = ?, goal = ?, changes = ?, files = ?, tests = ?,
             decisions = ?, risks = ?, open_questions = ?, next_steps = ?, evidence_refs = ?, agent_id = ?, agent_name = ?, model = ?,
             token_in = ?, token_out = ?, duration_ms = ?, content_hash = ?
           WHERE id = ?`,
        ).run(
          summary.workspaceId, summary.attempt, summary.outcome, summary.goal,
          JSON.stringify(summary.changes), JSON.stringify(summary.files), JSON.stringify(summary.tests),
          JSON.stringify(summary.decisions), JSON.stringify(summary.risks), JSON.stringify(summary.openQuestions),
          JSON.stringify(summary.nextSteps), JSON.stringify(summary.evidenceRefs), summary.agentId,
          summary.agentName, summary.model, summary.tokenIn, summary.tokenOut, summary.durationMs, summary.contentHash, summary.id,
        );
      } else {
        summary.id = newId("sum");
        this.db.prepare(
          `INSERT INTO summaries
            (id, task_id, run_id, goal, changes, files, tests, decisions, risks, open_questions, created_at,
             workspace_id, attempt, outcome, next_steps, evidence_refs, agent_id, agent_name, model, token_in, token_out, duration_ms, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          summary.id, summary.taskId, summary.runId, summary.goal, JSON.stringify(summary.changes),
          JSON.stringify(summary.files), JSON.stringify(summary.tests), JSON.stringify(summary.decisions),
          JSON.stringify(summary.risks), JSON.stringify(summary.openQuestions), summary.createdAt,
          summary.workspaceId, summary.attempt, summary.outcome, JSON.stringify(summary.nextSteps),
          JSON.stringify(summary.evidenceRefs), summary.agentId, summary.agentName, summary.model,
          summary.tokenIn, summary.tokenOut, summary.durationMs, summary.contentHash,
        );
      }
      this.indexSummary(summary);
      const event = this.store.appendEventIdempotent({
        aggregateType: "memory",
        aggregateId: summary.id,
        type: "memory.summary_ingested",
        actor: "system",
        payload: { workspaceId: summary.workspaceId, taskId: summary.taskId, runId: summary.runId, outcome: summary.outcome, agentId: summary.agentId },
        idempotencyKey: `memory:run:${summary.runId}:summary`,
      });
      void event;
      return summary;
    });
  }

  getSummaryForTask(taskId: string): TaskSummary | null {
    const row = this.db.prepare("SELECT * FROM summaries WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId) as Row | undefined;
    return row ? this.toSummary(row) : null;
  }

  listSummaries(workspaceId: string, limit = 50): TaskSummary[] {
    this.ensureWorkspace(workspaceId);
    const rows = this.db.prepare("SELECT * FROM summaries WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?").all(workspaceId, clamp(limit, 1, 200)) as Row[];
    return rows.map((row) => this.toSummary(row));
  }

  // ---------------------------------------------------------------- retrieval

  search(input: MemorySearchInput): MemorySearchResult {
    this.assertMigrated();
    this.ensureWorkspace(input.workspaceId);
    if (input.agentId) this.ensureAgent(input.workspaceId, input.agentId);
    const now = this.clock.now();
    const query = normalizeQuery(input.query);
    const scopes = new Set<MemoryScope>(input.scopes ?? ["board", "memo", "summary"]);
    const limit = clamp(input.limit ?? this.config.searchLimit, 1, 50);
    let candidates: Candidate[];
    if (query.text.length === 0) {
      candidates = this.browseCandidates(input, scopes, now);
    } else if (!this.ftsReady || query.useLike || !query.ftsQuery) {
      candidates = this.likeCandidates(input, scopes, query.text, query.terms, now);
    } else {
      candidates = this.ftsCandidates(input, scopes, query.ftsQuery, now);
    }
    const hits = this.candidatesToHits(candidates, now);
    const deduped = dedupeHits(hits);
    const maxTokens = clamp(input.budgetTokens ?? this.config.maxContextTokens, 0, this.config.maxContextTokens);
    const truncated = truncateBudget(deduped, maxTokens, {
      episodic: this.config.episodicMaxTokens,
      semantic: this.config.semanticMaxTokens,
    });
    return {
      hits: truncated.hits.slice(0, limit),
      total: candidates.length,
      budget: truncated.budget,
      generatedAt: now,
    };
  }

  private browseCandidates(input: MemorySearchInput, scopes: Set<MemoryScope>, now: string): Candidate[] {
    const out: Candidate[] = [];
    if (scopes.has("board")) {
      for (const entry of this.listBoard(input.workspaceId, {
        board: input.board,
        includeArchived: input.includeArchived,
        limit: this.config.candidateLimit,
      })) {
        if (!this.includeEntry(entry, input)) continue;
        out.push({ entityType: "board", entity: entry, rawRank: null, relevance: 1, normalization: "browse" });
      }
    }
    if (scopes.has("memo") && input.agentId) {
      for (const memo of this.listMemos(input.workspaceId, input.agentId, { includeArchived: input.includeArchived, limit: this.config.candidateLimit })) {
        if (!this.includeMemo(memo, input)) continue;
        out.push({ entityType: "memo", entity: memo, rawRank: null, relevance: 1, normalization: "browse" });
      }
    }
    if (scopes.has("summary")) {
      for (const summary of this.listSummaries(input.workspaceId, this.config.candidateLimit)) {
        out.push({ entityType: "summary", entity: summary, rawRank: null, relevance: 1, normalization: "browse" });
      }
    }
    return out;
  }

  private ftsCandidates(input: MemorySearchInput, scopes: Set<MemoryScope>, ftsQuery: string, now: string): Candidate[] {
    const rows = this.db.prepare(
      `SELECT entity_type, entity_id,
              bm25(memory_fts, 0.0, 0.0, 0.0, 4.0, 1.0, 2.0) AS rank
         FROM memory_fts
        WHERE workspace_id = ? AND memory_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?`,
    ).all(input.workspaceId, ftsQuery, this.config.candidateLimit) as Row[];
    const byType = new Map<string, string[]>();
    for (const row of rows) {
      const type = String(row.entity_type);
      if (!scopes.has(type as MemoryScope)) continue;
      const list = byType.get(type) ?? [];
      list.push(String(row.entity_id));
      byType.set(type, list);
    }
    const entities = this.loadEntities(input.workspaceId, byType, input.agentId ?? null);
    const raw: Array<{ row: Row; entity: Entity; entityType: Candidate["entityType"] }> = [];
    for (const row of rows) {
      const type = String(row.entity_type) as Candidate["entityType"];
      if (!scopes.has(type)) continue;
      const entity = entities.get(`${type}:${String(row.entity_id)}`);
      if (!entity) continue;
      if (type === "board" && !this.includeEntry(entity as BoardEntry, input)) continue;
      if (type === "memo" && !this.includeMemo(entity as Memo, input)) continue;
      if (type === "board" && input.board && (entity as BoardEntry).board !== normalizeBoardName(input.board).name) continue;
      raw.push({ row, entity, entityType: type });
    }
    const rels = minMaxRelevance(raw.map(({ row, entity, entityType }) => ({
      key: `${entityType}:${(entity as Entity).id}`,
      rank: Number(row.rank ?? 0),
    })));
    return raw.map(({ row, entity, entityType }) => ({
      entityType,
      entity,
      rawRank: Number(row.rank ?? 0),
      relevance: rels.get(`${entityType}:${entity.id}`) ?? 0,
      normalization: "minmax",
    }));
  }

  private likeCandidates(input: MemorySearchInput, scopes: Set<MemoryScope>, text: string, terms: string[], now: string): Candidate[] {
    const needle = `%${escapeLike(text)}%`;
    const out: Candidate[] = [];
    if (scopes.has("board")) {
      const rows = this.db.prepare(
        `SELECT * FROM board_entries
          WHERE workspace_id = ?
            AND (content LIKE ? ESCAPE '\\' OR board LIKE ? ESCAPE '\\' OR refs LIKE ? ESCAPE '\\')
          ORDER BY created_at DESC, id ASC LIMIT ?`,
      ).all(input.workspaceId, needle, needle, needle, this.config.candidateLimit) as Row[];
      for (const row of rows) {
        const entry = this.toBoard(row);
        if (!this.includeEntry(entry, input)) continue;
        if (input.board && entry.board !== normalizeBoardName(input.board).name) continue;
        out.push({ entityType: "board", entity: entry, rawRank: null, relevance: likeRelevance(`${entry.content} ${entry.board} ${entry.refs.join(" ")}`, terms), normalization: "like" });
      }
    }
    if (scopes.has("memo") && input.agentId) {
      const rows = this.db.prepare(
        `SELECT * FROM memos
          WHERE workspace_id = ? AND agent_id = ?
            AND (content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
          ORDER BY created_at DESC, id ASC LIMIT ?`,
      ).all(input.workspaceId, input.agentId, needle, needle, this.config.candidateLimit) as Row[];
      for (const row of rows) {
        const memo = this.toMemo(row);
        if (!this.includeMemo(memo, input)) continue;
        out.push({ entityType: "memo", entity: memo, rawRank: null, relevance: likeRelevance(`${memo.content} ${memo.tags.join(" ")}`, terms), normalization: "like" });
      }
    }
    if (scopes.has("summary")) {
      const rows = this.db.prepare(
        `SELECT * FROM summaries
          WHERE workspace_id = ?
            AND (goal LIKE ? ESCAPE '\\' OR changes LIKE ? ESCAPE '\\' OR files LIKE ? ESCAPE '\\'
                 OR decisions LIKE ? ESCAPE '\\' OR risks LIKE ? ESCAPE '\\' OR next_steps LIKE ? ESCAPE '\\')
          ORDER BY created_at DESC, id ASC LIMIT ?`,
      ).all(input.workspaceId, needle, needle, needle, needle, needle, needle, this.config.candidateLimit) as Row[];
      for (const row of rows) {
        const summary = this.toSummary(row);
        out.push({ entityType: "summary", entity: summary, rawRank: null, relevance: likeRelevance(`${summary.goal} ${summary.changes.join(" ")} ${summary.decisions.join(" ")} ${summary.nextSteps.join(" ")}`, terms), normalization: "like" });
      }
    }
    return out;
  }

  private loadEntities(workspaceId: string, byType: Map<string, string[]>, agentId: string | null): Map<string, Entity> {
    const out = new Map<string, Entity>();
    const boardIds = byType.get("board") ?? [];
    if (boardIds.length > 0) {
      const placeholders = boardIds.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT * FROM board_entries WHERE workspace_id = ? AND id IN (${placeholders})`).all(workspaceId, ...boardIds) as Row[];
      for (const row of rows) out.set(`board:${String(row.id)}`, this.toBoard(row));
    }
    const memoIds = byType.get("memo") ?? [];
    if (agentId && memoIds.length > 0) {
      const placeholders = memoIds.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT * FROM memos WHERE workspace_id = ? AND agent_id = ? AND id IN (${placeholders})`,
      ).all(workspaceId, agentId, ...memoIds) as Row[];
      for (const row of rows) out.set(`memo:${String(row.id)}`, this.toMemo(row));
    }
    const summaryIds = byType.get("summary") ?? [];
    if (summaryIds.length > 0) {
      const placeholders = summaryIds.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT * FROM summaries WHERE workspace_id = ? AND id IN (${placeholders})`).all(workspaceId, ...summaryIds) as Row[];
      for (const row of rows) out.set(`summary:${String(row.id)}`, this.toSummary(row));
    }
    return out;
  }

  private includeEntry(entry: BoardEntry, input: MemorySearchInput): boolean {
    if (entry.status === "archived" && !input.includeArchived) return false;
    if (entry.status === "active" && entry.archivedAt && !input.includeArchived) return false;
    const expired = entry.ttlAt !== null && Date.parse(entry.ttlAt) <= Date.parse(this.clock.now());
    if (expired && !input.includeExpired && !input.includeArchived) return false;
    return entry.status === "active" || entry.status === "archived";
  }

  private includeMemo(memo: Memo, input: MemorySearchInput): boolean {
    // Memos are owner-scoped at the SQL/load layer too; no agentId means no memo rows.
    if (!input.agentId || memo.agentId !== input.agentId) return false;
    if (memo.status === "archived" && !input.includeArchived) return false;
    if (memo.status === "expired" && !input.includeExpired && !input.includeArchived) return false;
    return true;
  }

  private candidatesToHits(candidates: Candidate[], now: string): MemoryHit[] {
    const hits: MemoryHit[] = [];
    for (const candidate of candidates) {
      const { entityType, entity } = candidate;
      if (entityType === "board") {
        const entry = entity as BoardEntry;
        const scored = scoreEntity({
          entityType, boardKind: entry.kind, confidence: entry.confidence,
          relevance: candidate.relevance, rawRank: candidate.rawRank, normalization: candidate.normalization,
          createdAt: entry.createdAt, lastVerifiedAt: entry.lastVerifiedAt, evidenceAt: entry.evidenceAt,
          ttlAt: entry.ttlAt, expiresAt: null, pinned: entry.pinned, nowIso: now,
          staleAfterDays: this.config.staleAfterDays,
        });
        hits.push(this.hit({ entityType, entry, kind: entry.kind, sourceRef: entry.sourceRef, title: firstLine(entry.content), content: entry.content, snippet: snippetAround(entry.content, [], 400), source: entry.source, confidence: entry.confidence, citations: [`board:${entry.id}`], scored, board: entry.board, agentId: null }));
      } else if (entityType === "memo") {
        const memo = entity as Memo;
        const scored = scoreEntity({
          entityType, confidence: memo.confidence, relevance: candidate.relevance, rawRank: candidate.rawRank,
          normalization: candidate.normalization, createdAt: memo.createdAt, lastVerifiedAt: memo.lastVerifiedAt,
          evidenceAt: null, ttlAt: null, expiresAt: memo.expiresAt, pinned: false, nowIso: now,
          staleAfterDays: this.config.staleAfterDays,
        });
        hits.push(this.hit({ entityType, entry: memo, kind: memo.kind, sourceRef: memo.sourceRef, title: memo.kind, content: memo.content, snippet: snippetAround(memo.content, [], 400), source: memo.source, confidence: memo.confidence, citations: [`memo:${memo.id}`], scored, board: null, agentId: memo.agentId }));
      } else {
        const summary = entity as TaskSummary;
        const confidence: Confidence = summary.outcome === "completed" ? "high" : "medium";
        const scored = scoreEntity({
          entityType, confidence, relevance: candidate.relevance, rawRank: candidate.rawRank,
          normalization: candidate.normalization, createdAt: summary.createdAt, lastVerifiedAt: null,
          evidenceAt: null, ttlAt: null, expiresAt: null, pinned: false, nowIso: now,
          staleAfterDays: this.config.staleAfterDays,
        });
        hits.push(this.hit({ entityType, entry: summary, kind: "summary", sourceRef: null, title: summary.goal, content: summary.goal, snippet: snippetAround(summary.goal, [], 400), source: "task", confidence, citations: [`summary:${summary.id}`], scored, board: null, agentId: summary.agentId }));
      }
    }
    return hits;
  }

  private hit(input: {
    entityType: Candidate["entityType"];
    entry: Entity;
    kind: string;
    sourceRef: string | null;
    title: string;
    content: string;
    snippet: string;
    source: BoardEntry["source"];
    confidence: Confidence;
    citations: string[];
    scored: ReturnType<typeof scoreEntity>;
    board: string | null;
    agentId: string | null;
  }): MemoryHit {
    const entity = input.entry;
    return {
      id: entity.id,
      entityType: input.entityType,
      entityId: entity.id,
      workspaceId: entity.workspaceId,
      board: input.board,
      agentId: input.agentId,
      kind: input.kind,
      sourceRef: input.sourceRef,
      title: input.title,
      snippet: input.snippet,
      content: input.content,
      contentHash: entity.contentHash,
      citations: input.citations,
      source: input.source,
      confidence: input.confidence,
      pinned: input.entityType === "board" ? (entity as BoardEntry).pinned : false,
      verified: input.scored.verified,
      stale: input.scored.stale,
      expired: input.scored.expired,
      createdAt: entity.createdAt,
      lastVerifiedAt: input.entityType === "memo" ? (entity as Memo).lastVerifiedAt : input.entityType === "board" ? (entity as BoardEntry).lastVerifiedAt : null,
      score: input.scored.score,
      breakdown: input.scored.breakdown,
    };
  }

  // ---------------------------------------------------------------- snapshot

  snapshot(workspaceId: string, options: MemorySnapshotOptions = {}): MemorySnapshot {
    this.assertMigrated();
    this.ensureWorkspace(workspaceId);
    if (options.agentId) this.ensureAgent(workspaceId, options.agentId);
    const now = this.clock.now();
    const entries = this.listBoard(workspaceId, {
      board: options.board,
      includeArchived: options.includeArchived,
      limit: clamp(options.entriesLimit ?? 500, 1, 500),
    });
    const memos = options.agentId
      ? this.listMemos(workspaceId, options.agentId, { includeArchived: options.includeArchived, limit: clamp(options.memosLimit ?? 200, 1, 200) })
      : [];
    const proposals = this.listProposals(workspaceId, "pending", clamp(options.proposalsLimit ?? 100, 1, 100));
    const summaries = this.listSummaries(workspaceId, 50);
    const boardRows = this.db.prepare("SELECT status, stale, ttl_at FROM board_entries WHERE workspace_id = ?").all(workspaceId) as Row[];
    const memoRows = options.agentId
      ? (this.db.prepare("SELECT status, stale, expires_at FROM memos WHERE workspace_id = ? AND agent_id = ?").all(workspaceId, options.agentId) as Row[])
      : [];
    const counts: MemoryCounts = {
      boardActive: boardRows.filter((row) => row.status === "active").length,
      boardArchived: boardRows.filter((row) => row.status === "archived").length,
      boardStale: boardRows.filter((row) => Number(row.stale) === 1).length,
      boardExpired: boardRows.filter((row) => row.ttl_at != null && Date.parse(String(row.ttl_at)) <= Date.parse(now)).length,
      memosActive: memoRows.filter((row) => row.status === "active").length,
      memosStale: memoRows.filter((row) => Number(row.stale) === 1).length,
      memosExpired: memoRows.filter((row) => row.status === "expired" || (row.expires_at != null && Date.parse(String(row.expires_at)) <= Date.parse(now))).length,
      summaries: Number((this.db.prepare("SELECT COUNT(*) AS n FROM summaries WHERE workspace_id = ?").get(workspaceId) as Row).n ?? 0),
      proposalsPending: proposals.length,
    };
    return {
      workspaceId,
      entries,
      domains: this.listDomains(workspaceId),
      memos,
      proposals,
      summaries,
      counts,
      ftsAvailable: this.ftsReady,
      degradedReason: this.ftsReady ? null : "FTS unavailable; LIKE fallback active",
      generatedAt: now,
    };
  }

  listDomains(workspaceId: string): BoardDomain[] {
    const rows = this.db.prepare("SELECT * FROM board_domains WHERE workspace_id = ? ORDER BY name_key").all(workspaceId) as Row[];
    return rows.map((row) => this.toDomain(row));
  }

  /** Up to three dependency summaries, one per task, newest first. */
  listSummariesForTasks(workspaceId: string, taskIds: string[], limit = 3): TaskSummary[] {
    this.assertMigrated();
    if (taskIds.length === 0) return [];
    this.ensureWorkspace(workspaceId);
    const ids = [...new Set(taskIds)].slice(0, 20);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM summaries WHERE workspace_id = ? AND task_id IN (${placeholders}) ORDER BY created_at DESC`,
    ).all(workspaceId, ...ids) as Row[];
    const byTask = new Map<string, TaskSummary>();
    for (const row of rows) {
      const summary = this.toSummary(row);
      if (!byTask.has(summary.taskId)) byTask.set(summary.taskId, summary);
      if (byTask.size >= limit) break;
    }
    return [...byTask.values()].slice(0, limit);
  }

  /** Up to three pinned/decision board entries, used for the working/semantic prelude. */
  pinnedDecisionHits(workspaceId: string, limit = 3): MemoryHit[] {
    this.assertMigrated();
    this.ensureWorkspace(workspaceId);
    const now = this.clock.now();
    const entries = this.listBoard(workspaceId, { limit: 500 })
      .filter((entry) => entry.status === "active" && (entry.pinned || entry.kind === "decision"))
      .slice(0, Math.max(0, Math.min(3, limit)));
    return entries.map((entry) => {
      const scored = scoreEntity({
        entityType: "board",
        boardKind: entry.kind,
        confidence: entry.confidence,
        relevance: 1,
        rawRank: null,
        normalization: "browse",
        createdAt: entry.createdAt,
        lastVerifiedAt: entry.lastVerifiedAt,
        evidenceAt: entry.evidenceAt,
        ttlAt: entry.ttlAt,
        expiresAt: null,
        pinned: entry.pinned,
        nowIso: now,
        staleAfterDays: this.config.staleAfterDays,
      });
      return this.hit({
        entityType: "board",
        entry,
        kind: entry.kind,
        sourceRef: entry.sourceRef,
        title: firstLine(entry.content),
        content: entry.content,
        snippet: snippetAround(entry.content, [], 400),
        source: entry.source,
        confidence: entry.confidence,
        citations: [`board:${entry.id}`],
        scored,
        board: entry.board,
        agentId: null,
      });
    });
  }

  // ---------------------------------------------------------------- maintenance

  sweep(workspaceId?: string, options: { faultWorkspace?: string } = {}): MemoryMaintenanceResult {
    this.assertMigrated();
    if (workspaceId) this.ensureWorkspace(workspaceId);
    const started = Date.now();
    const now = this.clock.now();
    const nowMs = Date.parse(now);
    const staleCutoff = new Date(nowMs - this.config.staleAfterDays * DAY_MS).toISOString();
    const rejectCutoff = new Date(nowMs - this.config.rejectCooldownDays * DAY_MS).toISOString();
    const proposalCutoff = new Date(nowMs - this.config.archiveProposalTtlDays * DAY_MS).toISOString();
    const workspaceRows = workspaceId
      ? [{ id: workspaceId }]
      : (this.db.prepare("SELECT id FROM workspaces").all() as Row[]);
    const result: MemoryMaintenanceResult = {
      workspaceIds: workspaceRows.map((row) => String(row.id)),
      staleMarked: 0,
      ttlProposed: 0,
      cooldownSkipped: 0,
      memosExpired: 0,
      proposalsExpired: 0,
      failedWorkspaces: 0,
      indexRepaired: false,
      durationMs: 0,
    };
    for (const row of workspaceRows) {
      const ws = String(row.id);
      try {
        this.store.withTransaction(() => {
          if (options.faultWorkspace === ws) throw new Error("injected sweep failure");
          // Count only 0 -> 1 transitions; clearing a refreshed entry is not "staleMarked".
          this.db.prepare(
            "UPDATE board_entries SET stale = 0 WHERE workspace_id = ? AND status = 'active' AND stale = 1 AND COALESCE(last_verified_at, created_at) > ?",
          ).run(ws, staleCutoff);
          this.db.prepare(
            "UPDATE memos SET stale = 0 WHERE workspace_id = ? AND status = 'active' AND stale = 1 AND COALESCE(last_verified_at, created_at) > ?",
          ).run(ws, staleCutoff);
          const boardStale = this.db.prepare(
            "UPDATE board_entries SET stale = 1 WHERE workspace_id = ? AND status = 'active' AND stale = 0 AND COALESCE(last_verified_at, created_at) <= ?",
          ).run(ws, staleCutoff);
          const memoStale = this.db.prepare(
            "UPDATE memos SET stale = 1 WHERE workspace_id = ? AND status = 'active' AND stale = 0 AND COALESCE(last_verified_at, created_at) <= ?",
          ).run(ws, staleCutoff);
          result.staleMarked += Number(boardStale.changes ?? 0) + Number(memoStale.changes ?? 0);

          const candidates = this.db.prepare(
            `SELECT e.* FROM board_entries e
              WHERE e.workspace_id = ? AND e.status = 'active' AND e.pinned = 0
                AND e.ttl_at IS NOT NULL AND e.ttl_at <= ?
                AND NOT EXISTS (SELECT 1 FROM board_archive_proposals p WHERE p.entry_id = e.id AND p.status = 'pending')
                AND NOT EXISTS (SELECT 1 FROM board_archive_proposals p WHERE p.entry_id = e.id AND p.status = 'rejected' AND p.decided_at IS NOT NULL AND p.decided_at > ?)`,
          ).all(ws, now, rejectCutoff) as Row[];
          for (const candidate of candidates) {
            const entry = this.toBoard(candidate);
            this.proposeArchive({ workspaceId: ws, entryId: entry.id, reason: "ttl_expired", proposedBy: "system", enforceCooldown: true });
            result.ttlProposed += 1;
          }
          const skipped = this.db.prepare(
            `SELECT COUNT(*) AS n FROM board_entries e
              WHERE e.workspace_id = ? AND e.status = 'active' AND e.pinned = 0 AND e.ttl_at IS NOT NULL AND e.ttl_at <= ?
                AND EXISTS (SELECT 1 FROM board_archive_proposals p WHERE p.entry_id = e.id AND p.status = 'rejected' AND p.decided_at IS NOT NULL AND p.decided_at > ?)`,
          ).get(ws, now, rejectCutoff) as Row;
          result.cooldownSkipped += Number(skipped.n ?? 0);

          const expiredMemos = this.db.prepare(
            "SELECT id, agent_id FROM memos WHERE workspace_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
          ).all(ws, now) as Row[];
          this.db.prepare(
            "UPDATE memos SET status = 'expired', updated_at = ? WHERE workspace_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
          ).run(now, ws, now);
          for (const memo of expiredMemos) {
            this.store.appendEvent({
              aggregateType: "memo",
              aggregateId: String(memo.id),
              type: "memo.expired",
              actor: "system",
              payload: { workspaceId: ws, agentId: String(memo.agent_id) },
            });
          }
          result.memosExpired += expiredMemos.length;

          const expiredProposals = this.db.prepare(
            "SELECT id, entry_id FROM board_archive_proposals WHERE workspace_id = ? AND status = 'pending' AND proposed_at <= ?",
          ).all(ws, proposalCutoff) as Row[];
          this.db.prepare(
            "UPDATE board_archive_proposals SET status = 'expired' WHERE workspace_id = ? AND status = 'pending' AND proposed_at <= ?",
          ).run(ws, proposalCutoff);
          for (const proposal of expiredProposals) {
            this.store.appendEvent({
              aggregateType: "board",
              aggregateId: String(proposal.entry_id),
              type: "board.proposal_expired",
              actor: "system",
              payload: { workspaceId: ws, proposalId: String(proposal.id) },
            });
          }
          result.proposalsExpired += expiredProposals.length;
        });
      } catch {
        result.failedWorkspaces += 1;
        this.store.appendEvent({
          aggregateType: "memory",
          aggregateId: ws,
          type: "memory.sweep_failed",
          actor: "system",
          payload: { workspaceId: ws, code: "SWEEP_FAILED" },
        });
      }
    }
    const state = this.db.prepare("SELECT dirty, entry_count FROM memory_index_state WHERE id = 'memory'").get() as Row | undefined;
    if (this.ftsReady && state && (Number(state.dirty) === 1 || Number(state.entry_count) < 1)) {
      this.rebuildIndex();
      result.indexRepaired = true;
    }
    result.durationMs = Date.now() - started;
    if (
      result.staleMarked > 0 ||
      result.ttlProposed > 0 ||
      result.memosExpired > 0 ||
      result.proposalsExpired > 0 ||
      result.failedWorkspaces > 0 ||
      result.indexRepaired
    ) {
      this.store.appendEvent({
        aggregateType: "memory",
        aggregateId: "memory",
        type: "memory.sweep_completed",
        actor: "system",
        payload: { ...result, workspaceIds: result.workspaceIds.length },
      });
    }
    return result;
  }

  // ---------------------------------------------------------------- validation

  ensureWorkspace(workspaceId: string): void {
    const row = this.db.prepare("SELECT 1 AS hit FROM workspaces WHERE id = ?").get(workspaceId) as Row | undefined;
    if (!row) throw new MemoryError("MEMORY_INVALID_INPUT", "workspace not found");
  }

  ensureAgent(workspaceId: string, agentId: string): void {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM agents WHERE id = ? AND workspace_id = ?")
      .get(agentId, workspaceId) as Row | undefined;
    if (!row) throw new MemoryError("MEMORY_INVALID_INPUT", "agent does not belong to workspace");
  }

  ensureTask(workspaceId: string, taskId: string): void {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM tasks WHERE id = ? AND workspace_id = ?")
      .get(taskId, workspaceId) as Row | undefined;
    if (!row) throw new MemoryError("MEMORY_INVALID_INPUT", "task does not belong to workspace");
  }

  ensureRun(workspaceId: string, taskId: string | null, runId: string): void {
    const row = this.db
      .prepare(
        `SELECT r.id AS id, r.task_id AS task_id, r.agent_id AS agent_id, t.workspace_id AS workspace_id
           FROM runs r JOIN tasks t ON t.id = r.task_id
          WHERE r.id = ? AND t.workspace_id = ?${taskId ? " AND r.task_id = ?" : ""}`,
      )
      .get(...(taskId ? [runId, workspaceId, taskId] : [runId, workspaceId])) as Row | undefined;
    if (!row) throw new MemoryError("MEMORY_INVALID_INPUT", "run does not belong to workspace/task");
  }

  ensureRunActor(workspaceId: string, runId: string, agentId: string): void {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM runs r JOIN tasks t ON t.id = r.task_id
          WHERE r.id = ? AND t.workspace_id = ? AND r.agent_id = ?`,
      )
      .get(runId, workspaceId, agentId) as Row | undefined;
    if (!row) throw new MemoryError("MEMORY_FORBIDDEN", "run does not belong to actor");
  }

  resolveSummaryAgentId(taskId: string, runId: string): string | null {
    const task = this.db.prepare("SELECT owner_id FROM tasks WHERE id = ?").get(taskId) as Row | undefined;
    if (task?.owner_id) return String(task.owner_id);
    const run = this.db.prepare("SELECT agent_id FROM runs WHERE id = ?").get(runId) as Row | undefined;
    return run?.agent_id ? String(run.agent_id) : null;
  }

  workspaceForTask(taskId: string): string | null {
    const row = this.db.prepare("SELECT workspace_id FROM tasks WHERE id = ?").get(taskId) as Row | undefined;
    return row?.workspace_id ? String(row.workspace_id) : null;
  }

  private resolveAgentSourceRef(workspaceId: string, author: string): string | null {
    const row = this.db
      .prepare("SELECT name FROM agents WHERE workspace_id = ? AND name = ? LIMIT 1")
      .get(workspaceId, author) as Row | undefined;
    return row?.name ? String(row.name) : author;
  }

  private normalizeTags(raw: string[]): string[] {
    const tags = [...new Set(raw.map((tag) => tag.normalize("NFKC").trim()).filter(Boolean))];
    if (tags.length > 10) throw new MemoryError("MEMORY_INVALID_INPUT", "at most 10 tags");
    for (const tag of tags) {
      if (tag.length > 24) throw new MemoryError("MEMORY_INVALID_INPUT", "tag must be <=24 chars");
    }
    return tags;
  }

  private assertMigrated(): void {
    if (!this.migrated) throw new MemoryError("MEMORY_UNAVAILABLE", "memory store is not migrated");
  }
}
