import type { CompanionStateSnapshot } from '@shannon/cognition';

/**
 * The nightly pass of Syzygy ADR-0008 stage 1 (睡眠: 遅れて分かった結果の割り当て; `docs/cognition-ledger-contract.md`). Core: emotion.
 *
 * Once a day per scope, on its own trigger in the background worker (`valueNightSchedule`, from the sleep hour, whatever the
 * conversation's sleep batch did): open predictions that ran out expire (a story without a reaction counts as none),
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

/**
 * Its own daily trigger (independent of the conversation's sleep batch): from the sleep hour on, once per owner-local day, the
 * pass runs for every scope `scopes` names. A restart on the same day runs it again, which changes nothing (every part of the
 * pass is idempotent). Returns whether it ran; never throws.
 */
export function valueNightSchedule(options: {
  timeZone: string; sleepHour: number; scopes: () => readonly string[]; run: (scopeKey: string, at: string) => void;
}): (at: string) => boolean {
  let lastDay: string | null = null;
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-CA', { timeZone: options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); } catch { format = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); }
  return at => {
    try {
      const parts = Object.fromEntries(format.formatToParts(new Date(Date.parse(at))).map(part => [part.type, part.value]));
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      if (Number(parts.hour) < options.sleepHour || day === lastDay) return false;
      lastDay = day;
      for (const scopeKey of options.scopes()) options.run(scopeKey, at);
      return true;
    } catch (error) {
      console.error('Shannon value sleep schedule failed', error instanceof Error ? error.name : 'unknown');
      return false;
    }
  };
}
