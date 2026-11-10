import type { Store } from "../kernel/store.js";
import type { ReviewDiffProvider } from "./diff.js";
import type { ReviewThread } from "./types.js";
import { ReviewStore } from "./store.js";
import type { ReviewTarget } from "./types.js";

export interface ReanchorResult {
  result: "moved" | "outdated" | "unchanged";
  line?: number;
  reason?: string;
}

export function matchThread(
  thread: Pick<ReviewThread, "lineStart" | "lineEnd" | "contextBefore" | "contextAfter">,
  oldLines: string[],
  newLines: string[],
): ReanchorResult {
  if (thread.lineStart < 1 || thread.lineStart > oldLines.length) return { result: "outdated", reason: "old_line_missing" };
  const oldLine = oldLines[thread.lineStart - 1];
  const before = thread.contextBefore.length
    ? thread.contextBefore
    : oldLines.slice(Math.max(0, thread.lineStart - 4), thread.lineStart - 1);
  const after = thread.contextAfter.length
    ? thread.contextAfter
    : oldLines.slice(thread.lineStart, thread.lineStart + 3);
  const candidates: number[] = [];
  for (let index = 0; index < newLines.length; index += 1) {
    if (newLines[index] !== oldLine) continue;
    const beforeOk = before.every((line, offset) => newLines[index - before.length + offset] === line);
    const afterOk = after.every((line, offset) => newLines[index + 1 + offset] === line);
    if (beforeOk && afterOk) candidates.push(index + 1);
  }
  if (candidates.length === 1) return { result: "moved", line: candidates[0] };
  if (candidates.length > 1) return { result: "outdated", reason: "ambiguous_context" };
  return { result: "outdated", reason: "line_changed" };
}

export async function reanchorTargets(input: {
  store: Store;
  reviewStore: ReviewStore;
  diffs: ReviewDiffProvider;
  workspaceId: string;
  oldTarget: ReviewTarget;
  newTarget: ReviewTarget;
}): Promise<void> {
  const { reviewStore, diffs } = input;
  const threads = reviewStore.listThreads(input.oldTarget.id);
  if (threads.length === 0) return;
  const renames = await diffs.nameStatus(input.workspaceId, input.oldTarget.headSha, input.newTarget.headSha).catch(() => new Map<string, string>());
  for (const thread of threads) {
    const mapped = renames.get(thread.filePath) ?? renames.get(thread.oldPath ?? "");
    const mappedPath = mapped ? mapped.split("\0")[0] : thread.filePath;
    const status = mapped ? mapped.split("\0")[1] : "M";
    if (status === "D") {
      markOutdated(reviewStore, thread, "file_deleted");
      continue;
    }
    const oldBlob = await diffs.readBlob(input.workspaceId, input.oldTarget.headSha, thread.filePath);
    const newBlob = await diffs.readBlob(input.workspaceId, input.newTarget.headSha, mappedPath);
    if (oldBlob == null || newBlob == null || oldBlob.includes("\0") || newBlob.includes("\0")) {
      markOutdated(reviewStore, thread, "binary_or_deleted");
      continue;
    }
    if (oldBlob.length > 1024 * 1024 || newBlob.length > 1024 * 1024) {
      markOutdated(reviewStore, thread, "too_large");
      continue;
    }
    const result = matchThread(thread, oldBlob.split(/\r?\n/), newBlob.split(/\r?\n/));
    if (result.result === "moved" && result.line) {
      reviewStore.store.db
        .prepare(
          `UPDATE review_threads SET anchor_head_sha = ?, line_start = ?, line_end = ?, reanchored_at = ?
           WHERE id = ?`,
        )
        .run(input.newTarget.headSha, result.line, result.line, new Date().toISOString(), thread.id);
      reviewStore.store.db
        .prepare(
          `INSERT INTO review_reanchor_log(id, thread_id, from_head_sha, to_head_sha, from_line, to_line, result, reason, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          `reanchor_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          thread.id,
          input.oldTarget.headSha,
          input.newTarget.headSha,
          thread.lineStart,
          result.line,
          "moved",
          "unique_context",
          new Date().toISOString(),
        );
    } else {
      markOutdated(reviewStore, thread, result.reason ?? "not_found");
    }
  }
}

function markOutdated(reviewStore: ReviewStore, thread: ReviewThread, reason: string): void {
  reviewStore.store.db
    .prepare("UPDATE review_threads SET status = 'outdated', outdated_reason = ?, reanchored_at = ? WHERE id = ?")
    .run(reason, new Date().toISOString(), thread.id);
  reviewStore.store.db
    .prepare(
      `INSERT INTO review_reanchor_log(id, thread_id, from_head_sha, to_head_sha, from_line, to_line, result, reason, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      `reanchor_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      thread.id,
      thread.anchorHeadSha,
      thread.anchorHeadSha,
      thread.lineStart,
      null,
      "outdated",
      reason,
      new Date().toISOString(),
    );
}
