/**
 * MF1-2 panel chunk budget.
 *
 * Budgets are byte ceilings for the seven lazy panel chunks emitted by the
 * current Vite build. They are intentionally modest headroom over the baseline
 * recorded in docs/team/adr-mf1-2-panel-boundary.md; a larger chunk must be
 * split or explicitly reviewed (and this table updated).
 */
export const PANEL_CHUNK_BUDGET_BYTES = {
  settings: 33_000,
  team: 58_000,
  board: 39_000,
  polls: 21_000,
  planDraft: 12_000,
  gitGraph: 66_000,
  mergeQueue: 11_800,
} as const;

export type LazyPanelChunkKey = keyof typeof PANEL_CHUNK_BUDGET_BYTES;

export interface PanelChunkEntry {
  key: LazyPanelChunkKey;
  bytes: number;
}

export interface PanelChunkBudgetViolation {
  key: LazyPanelChunkKey;
  bytes: number;
  budget: number;
}

export function checkPanelChunkBudget(
  entries: readonly PanelChunkEntry[],
  budget: Readonly<Record<LazyPanelChunkKey, number>> = PANEL_CHUNK_BUDGET_BYTES,
): PanelChunkBudgetViolation[] {
  return entries
    .filter((entry) => entry.bytes > budget[entry.key])
    .map((entry) => ({ key: entry.key, bytes: entry.bytes, budget: budget[entry.key] }));
}
