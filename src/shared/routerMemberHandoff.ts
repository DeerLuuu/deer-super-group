import type { MemberCandidate, RecommendMembersResponse } from "./types.js";

/**
 * Only an explicit `/team` command (optionally with a description) opens the
 * member handoff. Ordinary chat mentions of hiring/recommendation must not
 * trigger recommendation calls or modals.
 */
export function parseTeamCommand(text: string): { description: string | null } | null {
  const match = /^\/team(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const description = (match[1] ?? "").trim();
  return { description: description || null };
}

export type ChatSubmissionHandlers = {
  clear: () => void;
  compact: () => void;
  team: (description: string | null) => void;
  send: (text: string) => void;
};

/** App-level deterministic dispatch for /clear, /compact, /team and chat. */
export function dispatchChatSubmission(
  text: string,
  handlers: ChatSubmissionHandlers,
): "clear" | "compact" | "team" | "send" {
  const value = text.trim();
  const lower = value.toLowerCase();
  if (lower === "/clear" || value === "/清空") {
    handlers.clear();
    return "clear";
  }
  if (lower === "/compact" || value === "/压缩") {
    handlers.compact();
    return "compact";
  }
  const team = parseTeamCommand(value);
  if (team) {
    handlers.team(team.description);
    return "team";
  }
  handlers.send(text);
  return "send";
}

function isCandidate(value: unknown): value is MemberCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MemberCandidate>;
  return (
    typeof candidate.candidateId === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.responsibilities === "string" &&
    typeof candidate.reason === "string"
  );
}

/** Normalize a `team.recommend` tool result into candidates for the handoff. */
export function extractRecommendationCandidates(value: unknown): MemberCandidate[] | null {
  if (!value || typeof value !== "object") return null;
  const response = value as Partial<RecommendMembersResponse>;
  if (!response.ok || !response.result || !Array.isArray(response.result.candidates)) return null;
  const candidates = response.result.candidates.filter(isCandidate);
  return candidates.length > 0 ? candidates : null;
}
