import type { FcaToolState } from './fcaToolState.js';

/**
 * Safety net of `SHANNON_FCA_OBS_MODE=transient` (design A2): the provider may refuse the betas of its request shape. When the very first
 * decision of a transient task is refused for them (a 400 naming them), nothing ran and no signed history exists, so the task starts again
 * in the legacy shape: its tool state loses the transient fields and the same decision is asked once more. Logged. Any later refusal is an
 * ordinary failure, never a change of mode (the history would then be shaped for the other one).
 */
export const FCA_TRANSIENT_UNSUPPORTED = 'FCA_MODEL_TRANSIENT_UNSUPPORTED';

export const isTransientUnsupported = (error: unknown): boolean => error instanceof Error && error.message === FCA_TRANSIENT_UNSUPPORTED;

/** The tool state without its transient fields: the legacy state the selection already holds underneath them. */
export function legacyToolState(state: FcaToolState): FcaToolState {
  const { obsMode: _mode, core: _core, announced: _announced, ...legacy } = state;
  return legacy;
}
