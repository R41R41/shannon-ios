import { anthropicApiKey } from '../infra/models/anthropic/anthropicConfig.js';
import { DEFAULT_HAIKU_MODEL } from '../infra/models/anthropic/haikuConfig.js';
import { createAnthropicFcaSummarizer } from '../infra/models/anthropic/anthropicFcaSummary.js';
import type { createAnthropicFcaModel } from '../infra/models/anthropic/anthropicFcaModel.js';
import { FCA_BODY_HISTORY_POLICY } from '../mind/action/fca/fcaHistory.js';
import type { FcaHistoryPolicy, FcaHistorySummarizer } from '../mind/action/fca/fcaHistoryPorts.js';

/** What a step's history takes from the summaries wiring: its summarizer and, for a body task under Haiku, its own policy. */
export interface FcaStepSummary { summarizer: FcaHistorySummarizer; policy?: Partial<FcaHistoryPolicy> }

/**
 * `SHANNON_FCA_SUMMARY_MODEL` (owner decision 2026-10-17, P4): unset or `decision` keeps every task's history summarizer on the
 * decision model and its history policy as it is (`body` is then `decision`, with no policy). `haiku` moves only a body task's
 * summaries to claude-haiku-5-5, rare (`FCA_BODY_HISTORY_POLICY`), with the body goal text; those calls are recorded at Haiku's
 * prices under that model (`usage.model`). Whether a task is a body task is asked at each step (`keepBodyTools`), so it may change
 * mid-task (a body bound later); its history then follows the new policy from that step, which is harmless.
 * Any other value, or `haiku` without a key, is a mistake that must not change the running behaviour or stop the API: it is
 * ignored and logged without its value.
 */
export function configuredFcaSummaries(values: Readonly<Record<string, string | undefined>>, decision: FcaHistorySummarizer,
  recordUsage: Parameters<typeof createAnthropicFcaModel>[0]['recordUsage'], ownPrompt = false): { decision: FcaHistorySummarizer; body: FcaStepSummary } {
  const same = { decision, body: { summarizer: decision } };
  const choice = values.SHANNON_FCA_SUMMARY_MODEL?.trim().toLowerCase();
  if (!choice || choice === 'decision') return same;
  if (choice !== 'haiku') {
    console.warn('Shannon FCA summary model ignored: SHANNON_FCA_SUMMARY_MODEL must be haiku or decision');
    return same;
  }
  const apiKey = values.SHANNON_HAIKU_API_KEY?.trim() || anthropicApiKey(values);
  if (!apiKey) {
    // A summary setting never stops production: without a key every task keeps summarizing with the decision model.
    console.warn('Shannon FCA summary model ignored: SHANNON_FCA_SUMMARY_MODEL=haiku has no key '
      + '(SHANNON_HAIKU_API_KEY, SHANNON_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY); the decision model summarizes');
    return same;
  }
  // `ownPrompt` (SHANNON_MINECRAFT_OWN_PROMPT): the body summary reads the body task's own words; absent, as before.
  return { decision, body: { summarizer: createAnthropicFcaSummarizer({ model: DEFAULT_HAIKU_MODEL, apiKey, recordUsage, body: true,
    ...(ownPrompt ? { minecraftOwnPrompt: true } : {}) }),
    policy: FCA_BODY_HISTORY_POLICY } };
}
