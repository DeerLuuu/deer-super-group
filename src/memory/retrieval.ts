import { DAY_MS, type Confidence, type MemoryBudget, type MemoryConfig, type MemoryHit, type MemoryScoreBreakdown } from "./types.js";
import { clamp, estimateTokens, round6 } from "./util.js";

export interface NormalizedQuery {
  text: string;
  terms: string[];
  ftsQuery: string | null;
  useLike: boolean;
}

export function normalizeQuery(raw: string | undefined): NormalizedQuery {
  const text = (raw ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200);
  const terms = text
    .split(" ")
    .filter((term) => term.length > 0)
    .slice(0, 8);
  const usable = terms.filter((term) => [...term].length >= 3);
  // P0: if any term is shorter than a trigram (notably two-character Chinese),
  // use LIKE rather than mixing channels with incomparable rank scales.
  const useLike = terms.length === 0 || usable.length !== terms.length;
  const ftsQuery =
    !useLike && usable.length > 0
      ? usable.map((term) => `"${term.replace(/"/g, '""')}"`).join(" AND ")
      : null;
  return { text, terms, ftsQuery, useLike };
}

export function likeRelevance(text: string, terms: string[]): number {
  if (terms.length === 0) return 1;
  const normalized = text.normalize("NFKC").toLowerCase();
  const coverage = terms.filter((term) => normalized.includes(term.toLowerCase())).length / terms.length;
  let occurrences = 0;
  for (const term of terms) {
    if (!term) continue;
    const needle = term.toLowerCase();
    let at = 0;
    while (at < normalized.length) {
      const found = normalized.indexOf(needle, at);
      if (found < 0) break;
      occurrences += 1;
      at = found + Math.max(1, needle.length);
    }
  }
  const density = Math.min(1, occurrences / Math.max(1, normalized.length / 50));
  return clamp(0.35 + 0.45 * coverage + 0.2 * density, 0, 1);
}

export interface RawRank {
  key: string;
  rank: number;
}

/** More negative bm25 rank = more relevant. Result-set min-max makes rel monotonic. */
export function minMaxRelevance(rows: RawRank[]): Map<string, number> {
  const out = new Map<string, number>();
  if (rows.length === 0) return out;
  const ranks = rows.map((row) => row.rank);
  const min = Math.min(...ranks);
  const max = Math.max(...ranks);
  for (const row of rows) {
    out.set(row.key, max === min ? 1 : (max - row.rank) / (max - min));
  }
  return out;
}

export interface ScoreParams {
  entityType: "board" | "memo" | "summary";
  boardKind?: string;
  confidence: Confidence;
  relevance: number;
  rawRank: number | null;
  normalization: "minmax" | "like" | "browse";
  createdAt: string;
  lastVerifiedAt: string | null;
  evidenceAt: string | null;
  ttlAt: string | null;
  expiresAt: string | null;
  pinned: boolean;
  nowIso: string;
  staleAfterDays: number;
}

export interface ScoreResult {
  score: number;
  breakdown: MemoryScoreBreakdown;
  stale: boolean;
  expired: boolean;
  verified: boolean;
}

export function confidenceValue(confidence: Confidence): number {
  return confidence === "high" ? 1 : confidence === "medium" ? 0.65 : 0.35;
}

function typeWeight(entityType: "board" | "memo" | "summary", boardKind?: string): number {
  if (entityType === "memo" || entityType === "summary") return 1;
  switch (boardKind) {
    case "decision":
      return 1.1;
    case "warning":
      return 1.05;
    case "fact":
      return 1;
    case "question":
    case "artifact":
      return 0.95;
    case "link":
      return 0.85;
    default:
      return 1;
  }
}

function expiryOf(ttlAt: string | null, expiresAt: string | null, nowIso: string): boolean {
  const limit = ttlAt ?? expiresAt;
  return limit !== null && Date.parse(limit) <= Date.parse(nowIso);
}

export function scoreEntity(params: ScoreParams): ScoreResult {
  const { nowIso } = params;
  const effectiveAt = params.lastVerifiedAt ?? params.createdAt;
  const ageDays = Math.max(0, (Date.parse(nowIso) - Date.parse(effectiveAt)) / DAY_MS);
  const halfLifeDays = params.entityType === "summary" ? 30 : 14;
  const ageDecay = Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
  const ttlAt = params.ttlAt;
  let ttlRemaining = 1;
  if (ttlAt) {
    const ttlStart = Date.parse(params.createdAt);
    const ttlEnd = Date.parse(ttlAt);
    ttlRemaining = ttlEnd > ttlStart ? clamp((ttlEnd - Date.parse(nowIso)) / (ttlEnd - ttlStart), 0, 1) : 0;
  }
  const freshness = clamp(ageDecay * (0.5 + 0.5 * ttlRemaining), 0, 1);
  const stale = ageDays >= params.staleAfterDays;
  const expired = expiryOf(ttlAt, params.expiresAt, nowIso);
  const verified = params.lastVerifiedAt !== null;
  const evidenceRecent =
    params.entityType === "board" &&
    params.evidenceAt !== null &&
    Date.parse(params.evidenceAt) >= Date.parse(nowIso) - 7 * DAY_MS;
  const pinBoost = params.pinned ? 1.15 : 1;
  const verifiedBoost = verified ? 1.1 : 1;
  const evidenceBoost = evidenceRecent ? 1.05 : 1;
  const penalty = expired ? 0.25 : stale ? 0.65 : 1;
  const rel = clamp(params.relevance, 0, 1);
  const weight = typeWeight(params.entityType, params.boardKind);
  const score = round6(
    Math.pow(rel, 0.8) *
      confidenceValue(params.confidence) *
      clamp(freshness, 0.02, 1) *
      weight *
      pinBoost *
      verifiedBoost *
      evidenceBoost *
      penalty,
  );
  return {
    score,
    stale,
    expired,
    verified,
    breakdown: {
      relevance: round6(rel),
      rawRank: params.rawRank,
      normalization: params.normalization,
      confidence: confidenceValue(params.confidence),
      freshness: round6(freshness),
      typeWeight: weight,
      pinBoost,
      verifiedBoost,
      evidenceBoost,
      penalty,
      score,
    },
  };
}

export function sortHits(hits: MemoryHit[]): MemoryHit[] {
  return [...hits].sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.pinned) - Number(a.pinned) ||
      Number(b.verified) - Number(a.verified) ||
      b.breakdown.freshness - a.breakdown.freshness ||
      (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) ||
      compareIds(a.id, b.id),
  );
}

/** Locale-independent id comparator; sorted output must not depend on ICU locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Merge content duplicates and same-source duplicates, then cap each
 * board/agent group (and summaries) to maxPerSource. Citations are merged.
 */
export function dedupeHits(hits: MemoryHit[], maxPerSource = 3): MemoryHit[] {
  const byContent = new Map<string, MemoryHit>();
  const bySource = new Map<string, MemoryHit>();
  const groupCounts = new Map<string, number>();
  const out: MemoryHit[] = [];
  for (const hit of sortHits(hits)) {
    const contentHit = byContent.get(hit.contentHash);
    if (contentHit) {
      contentHit.citations = [...new Set([...contentHit.citations, ...hit.citations])].slice(0, 5);
      continue;
    }
    const sourceKey = `${hit.entityType}\u0000${hit.source}\u0000${hit.sourceRef ?? ""}\u0000${hit.kind}`;
    const sourceHit = hit.sourceRef ? bySource.get(sourceKey) : undefined;
    if (sourceHit) {
      sourceHit.citations = [...new Set([...sourceHit.citations, ...hit.citations])].slice(0, 5);
      continue;
    }
    const groupKey =
      hit.entityType === "board"
        ? `board\u0000${hit.board ?? ""}`
        : hit.entityType === "memo"
          ? `agent\u0000${hit.agentId ?? ""}`
          : "summary";
    const count = groupCounts.get(groupKey) ?? 0;
    if (count >= maxPerSource) continue;
    const copy: MemoryHit = { ...hit, citations: [...hit.citations] };
    byContent.set(hit.contentHash, copy);
    if (hit.sourceRef) bySource.set(sourceKey, copy);
    groupCounts.set(groupKey, count + 1);
    out.push(copy);
  }
  return out;
}

function renderedTokens(hit: MemoryHit): number {
  return estimateTokens(`${hit.title} ${hit.citations.join(" ")} ${hit.snippet}`);
}

export function truncateBudget(
  hits: MemoryHit[],
  maxTokens: number,
  caps: { episodic: number; semantic: number },
): { hits: MemoryHit[]; budget: MemoryBudget } {
  const budget: MemoryBudget = {
    maxTokens,
    usedTokens: 0,
    truncated: false,
    omitted: 0,
    perLayer: { working: 0, episodic: 0, semantic: 0 },
  };
  const selected: MemoryHit[] = [];
  for (const hit of hits) {
    const layer = hit.entityType === "summary" ? "episodic" : "semantic";
    const tokens = renderedTokens(hit);
    const cap = caps[layer];
    if (budget.perLayer[layer] + tokens > cap || budget.usedTokens + tokens > maxTokens) {
      budget.omitted += 1;
      continue;
    }
    selected.push(hit);
    budget.usedTokens += tokens;
    budget.perLayer[layer] += tokens;
  }
  budget.truncated = budget.omitted > 0;
  return { hits: selected, budget };
}

export function contextBudget(config: MemoryConfig, mode: "worker" | "router"): number {
  return mode === "router" ? config.routerMaxTokens : config.maxContextTokens;
}

/** DESIGN §8.4: min(contextWindow*15%, remaining, mode cap). */
export function resolveContextBudget(
  config: MemoryConfig,
  mode: "worker" | "router",
  contextWindow?: number,
  remaining?: number,
): number {
  const modeCap = contextBudget(config, mode);
  const windowCap = contextWindow && contextWindow > 0 ? Math.floor(contextWindow * 0.15) : modeCap;
  const remainingCap = remaining === undefined ? modeCap : Math.max(0, remaining);
  return Math.max(0, Math.min(modeCap, windowCap, remainingCap));
}

export function renderHitLine(hit: MemoryHit): string {
  const source = hit.citations[0] ?? hit.entityType;
  return `- [${source}] ${hit.title}${hit.stale ? " (stale)" : ""}${hit.expired ? " (expired)" : ""}: ${hit.snippet}`;
}

export function renderHitCitation(hit: MemoryHit): string {
  return `${hit.citations.join(", ")}${hit.breakdown.rawRank === null ? "" : ` · rank=${hit.breakdown.rawRank}`}`;
}
