import type { CompanionStateSnapshot } from '@shannon/cognition';
import type { ChoiceLedger } from '../learning/choiceLedger.js';
import type { PredictionLedger } from '../learning/predictionLedger.js';

/**
 * The nightly pass of Syzygy ADR-0008 stage 1 (睡眠: 遅れて分かった結果の割り当て; `docs/cognition-ledger-contract.md`). Core: emotion.
 *
 * Beside the sleep batch, once per scope: open predictions that ran out expire (a story without a reaction counts as none),
 * forgetting is reconciled and predictions older than 90 days go (`PredictionLedger.maintain`); then choices that waited are
 * settled (delayed credit), lost reports are voided and choices older than 90 days go (`ChoiceLedger.sleep`). Its failure is
 * logged and never fails the batch. It calls no model.
 */
export interface ValueSleepParts {
  predictions: Pick<PredictionLedger, 'maintain'> | null;
  choices: Pick<ChoiceLedger, 'sleep'> | null;
  log?: (line: string) => void;
}

export function valueSleep(parts: ValueSleepParts): (scopeKey: string, at: string, state?: () => CompanionStateSnapshot | null) => void {
  const log = parts.log ?? (line => console.log(line));
  return (scopeKey, at, state = () => null) => {
    try {
      const predictions = parts.predictions?.maintain(scopeKey, at, state()) ?? { expired: 0, pruned: 0 };
      const choices = parts.choices?.sleep(scopeKey, at) ?? { settled: 0, pruned: 0 };
      log(`Shannon value sleep: expired=${predictions.expired} predictions_pruned=${predictions.pruned} settled=${choices.settled} choices_pruned=${choices.pruned}`);
    } catch (error) {
      console.error('Shannon value sleep failed', error instanceof Error ? error.name : 'unknown');
    }
  };
}
