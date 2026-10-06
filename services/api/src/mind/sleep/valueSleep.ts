import type { CompanionStateSnapshot } from '@shannon/cognition';

/**
 * The nightly pass of Syzygy ADR-0008 stage 1 (睡眠: 遅れて分かった結果の割り当て; `docs/cognition-ledger-contract.md`). Core: emotion.
 *
 * Beside the sleep batch, once per scope: open predictions that ran out expire (a story without a reaction counts as none),
 * forgetting is reconciled and predictions older than 90 days go (`PredictionLedger.maintain`); then choices that waited are
 * settled (delayed credit), lost reports are voided and choices older than 90 days go (`ChoiceLedger.sleep`); then the value
 * table writes a version from what was settled, unless the owner froze it (`ValueVersions.nightly`). Its failure is
 * logged and never fails the batch. It calls no model.
 */
/** The parts of the learning part it runs, as functions it is handed (`mind/learning`; wired by the worker). */
export interface ValueSleepParts {
  predictions: { maintain(scopeKey: string, at: string, state: CompanionStateSnapshot | null): { expired: number; pruned: number } } | null;
  choices: { sleep(scopeKey: string, at: string): { settled: number; pruned: number } } | null;
  values?: { nightly(scopeKey: string, at: string): { decision: string; pruned: number } } | null;
  log?: (line: string) => void;
}

export function valueSleep(parts: ValueSleepParts): (scopeKey: string, at: string, state?: () => CompanionStateSnapshot | null) => void {
  const log = parts.log ?? (line => console.log(line));
  return (scopeKey, at, state = () => null) => {
    try {
      const predictions = parts.predictions?.maintain(scopeKey, at, state()) ?? { expired: 0, pruned: 0 };
      const choices = parts.choices?.sleep(scopeKey, at) ?? { settled: 0, pruned: 0 };
      const values = parts.values?.nightly(scopeKey, at) ?? { decision: 'none', pruned: 0 };
      log(`Shannon value sleep: expired=${predictions.expired} predictions_pruned=${predictions.pruned} settled=${choices.settled} choices_pruned=${choices.pruned} version=${values.decision} versions_pruned=${values.pruned}`);
    } catch (error) {
      console.error('Shannon value sleep failed', error instanceof Error ? error.name : 'unknown');
    }
  };
}
