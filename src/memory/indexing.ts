import { contentHash, firstLine, normalizeContent } from "./util.js";
import type { BoardEntry, Memo, TaskSummary } from "./types.js";

/** A row projected into the FTS index. */
export interface SearchDoc {
  entityType: "board" | "memo" | "summary";
  entityId: string;
  workspaceId: string;
  title: string;
  body: string;
  tags: string;
  contentHash: string;
}

export function boardDoc(entry: BoardEntry): SearchDoc {
  return {
    entityType: "board",
    entityId: entry.id,
    workspaceId: entry.workspaceId,
    title: firstLine(entry.content),
    body: entry.content,
    tags: [...entry.refs, entry.board, entry.kind].join(" "),
    contentHash: entry.contentHash,
  };
}

export function memoDoc(memo: Memo): SearchDoc {
  return {
    entityType: "memo",
    entityId: memo.id,
    workspaceId: memo.workspaceId,
    title: memo.kind,
    body: memo.content,
    tags: memo.tags.join(" "),
    contentHash: memo.contentHash,
  };
}

export function summaryDoc(summary: TaskSummary): SearchDoc {
  const body = [
    summary.goal,
    ...summary.changes,
    ...summary.files,
    ...summary.decisions,
    ...summary.risks,
    ...summary.nextSteps,
  ].join("\n");
  return {
    entityType: "summary",
    entityId: summary.id,
    workspaceId: summary.workspaceId,
    title: summary.goal,
    body,
    tags: summary.evidenceRefs.join(" "),
    contentHash: summary.contentHash,
  };
}

export function boardContentHash(entry: Pick<BoardEntry, "content" | "board" | "kind">): string {
  return contentHash(`board:${entry.board}:${entry.kind}`, entry.content);
}

export function memoContentHash(memo: Pick<Memo, "content">): string {
  return contentHash("memo", memo.content);
}

export function summaryContentHash(
  summary: Pick<
    TaskSummary,
    "goal" | "changes" | "decisions" | "risks" | "nextSteps" | "openQuestions"
  >,
): string {
  return contentHash(
    "summary",
    JSON.stringify({
      goal: summary.goal,
      changes: summary.changes,
      decisions: summary.decisions,
      risks: summary.risks,
      nextSteps: summary.nextSteps,
      openQuestions: summary.openQuestions,
    }),
  );
}

/** Searchable text used by the LIKE fallback; intentionally excludes private memo owners. */
export function searchableText(entityType: "board" | "memo" | "summary", row: {
  content: string;
  tags?: string[];
  board?: string;
  goal?: string;
  refs?: string[];
}): string {
  const parts = [row.content, row.goal ?? "", ...(row.tags ?? []), ...(row.refs ?? []), row.board ?? ""];
  return normalizeContent(parts.join(" "));
}
