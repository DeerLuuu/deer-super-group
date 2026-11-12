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
