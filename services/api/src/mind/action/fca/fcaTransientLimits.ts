/**
 * The room a transient body task keeps for what one step adds to its replay (observation redesign P3, review M1/M2): the state message it
 * stores (a first `full` or a `changed` one, never more than this many estimated tokens: a larger one is cut and marked,
 * `anthropicFcaStateCap.ts`), taken off the replay bound (`fcaCoreHistory.ts`). So a replay that just fits its bound plus the state
 * a step adds stays below the replay bound's own headroom under the 100,000-token price step, and a new epoch's first `full` (cut to this)
 * fits the next steps without a summary every step.
 */
export const FCA_TRANSIENT_STATE_RESERVE_TOKENS = 12_000;
