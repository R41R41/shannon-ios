import { FCA_TRANSIENT_STATE_RESERVE_TOKENS } from '../../../mind/action/fca/fcaTransientLimits.js';
import { compactedDecision } from './anthropicFcaCompaction.js';
import { estimatedAnthropicTokens } from './anthropicFcaHistory.js';
import type { StateLimit } from './anthropicFcaTransient.js';

/**
 * The most a stored state message (`storedState`, a first `full` or a `changed` one) may weigh: `FCA_TRANSIENT_STATE_RESERVE_TOKENS`.
 * A larger one is shortened as a legacy decision message is (`compactedDecision`: the longest texts cut to one common length, each cut
 * marked, the task, messages and children whole), and the parts that were cut are named in it (`capped`) so that a later state restates
 * each of them whole as soon as it fits: a transiently large part is never kept cut for good.
 */
export const FCA_STATE_LIMIT: StateLimit = {
  maximumTokens: FCA_TRANSIENT_STATE_RESERVE_TOKENS,
  tokens: value => estimatedAnthropicTokens(JSON.stringify(value)),
  cut: (row, maximumTokens) => {
    const compacted = compactedDecision(row, estimatedAnthropicTokens(JSON.stringify(row)), maximumTokens);
    return { row: compacted.fields, level: compacted.level };
  },
};
