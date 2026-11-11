import type { PlanDraft, PlanSource } from "../shared/planDraft.js";

/** In-flight preview gate: only the latest token may write state. */
export class PlanPreviewGate {
  private token = 0;

  start(): number {
    this.token += 1;
    return this.token;
  }

  invalidate(): void {
    this.token += 1;
  }

  isCurrent(token: number): boolean {
    return token === this.token;
  }
}

export type PlanDraftLeaveReason =
  | "cancel"
  | "close"
  | "replace"
  | "deep-link"
  | "workspace";

/** Session-only dirty state: an accepted draft or an edited/captured goal/messages. */
export function isPlanDraftDirty(
  source: PlanSource | null,
  draft: PlanDraft | null,
): boolean {
  if (draft) return true;
  if (!source) return false;
  return Boolean(source.goal.trim() || source.messages.length);
}

export function planDraftLeaveMessage(reason: PlanDraftLeaveReason): string {
  switch (reason) {
    case "cancel":
      return "取消会丢弃当前计划草案，确定取消？";
    case "close":
      return "关闭计划草案面板？草案会保留，可从面板启动器恢复。";
    case "replace":
      return "当前计划草案尚未确认，重新规划会丢弃它，继续？";
    case "deep-link":
      return "当前计划草案尚未确认，离开会丢弃它，继续？";
    case "workspace":
      return "当前计划草案尚未确认，切换工作区会丢弃它，继续？";
  }
}

/** Close preserves the session draft; cancel/link/workspace replace discards it. */
export function planDraftLeaveDisposition(
  reason: PlanDraftLeaveReason,
): "preserve" | "discard" {
  return reason === "close" ? "preserve" : "discard";
}
