import { createHash, randomUUID } from "node:crypto";
import { DAY_MS } from "./types.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The application-wide token estimate (DESIGN §7.3 / service.ts). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function normalizeContent(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function contentHash(kind: string, content: string): string {
  return createHash("sha256").update(`${kind}\u0000${normalizeContent(content)}`).digest("hex");
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

export function daysSince(fromIso: string, nowIso: string): number {
  return Math.max(0, (Date.parse(nowIso) - Date.parse(fromIso)) / DAY_MS);
}

export function isOlderThanDays(
  fromIso: string,
  nowIso: string,
  days: number,
  inclusive = true,
): boolean {
  const cut = Date.parse(nowIso) - days * DAY_MS;
  const at = Date.parse(fromIso);
  return inclusive ? at <= cut : at < cut;
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Board names are case/space-insensitive for lookup, display keeps the normalized value. */
export function normalizeBoardName(raw: string): { name: string; key: string } {
  const name = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  return { name, key: name.toLowerCase() };
}

export function firstLine(text: string, max = 120): string {
  const line = text.split(/\r?\n/).find((part) => part.trim().length > 0)?.trim() ?? text.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function snippetAround(text: string, terms: string[], maxChars = 400): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  const lower = normalized.toLowerCase();
  let index = -1;
  for (const term of terms) {
    if (!term) continue;
    const found = lower.indexOf(term.toLowerCase());
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return `${normalized.slice(0, maxChars - 1)}…`;
  const start = Math.max(0, index - Math.floor(maxChars / 3));
  const end = Math.min(normalized.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

export function citationFor(entityType: "board" | "memo" | "summary", id: string): string {
  return `${entityType}:${id}`;
}

export function uniqueStrings(values: string[], max = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

export function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function bool(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

export function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
