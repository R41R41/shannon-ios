import type { LlmUsageSummaryRow } from '../../../llmUsage.js';

/**
 * Jev's cost (Syzygy ADR-0008 stage 1; owner override 3: the price is left unset). Core: response path.
 *
 * Jev's calls are counted from the decision traces (`mind/inhibition/decisionTraces.ts`), never in `llm_usage_events`: that
 * table's `voice` lane is what the transcription cap of 0.10 USD a day counts (`voiceTranscription.ts`), and Jev must not
 * spend it. The price per call is `SHANNON_JEV_USD_PER_CALL` in USD; unset, a call's cost is unknown (null), and the usage
 * summary shows it as 未設定 (`costUnknown`).
 */
export function jevUsdPerCall(environment: Readonly<Record<string, string | undefined>> = process.env): number | null {
  const text = environment.SHANNON_JEV_USD_PER_CALL?.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The row of the usage summary for Jev: calls, no tokens, the known cost, and whether some calls have no price. */
export interface JevUsageRow extends Omit<LlmUsageSummaryRow, 'lane'> {
  lane: 'jev';
  /** Set while any call of the month has no price: the cost is 未設定, and `estimatedCostUsd` is only the known part. */
  costUnknown?: true;
}

export function jevUsageRow(month: { calls: number; knownCostUsd: number; unpriced: number } | null): JevUsageRow | null {
  if (!month || month.calls === 0) return null;
  return Object.freeze({
    lane: 'jev', calls: month.calls, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
    estimatedCostUsd: Math.round(month.knownCostUsd * 1e9) / 1e9, ...(month.unpriced > 0 ? { costUnknown: true as const } : {}),
  });
}
