import type { CompanionStateSnapshot } from '@shannon/cognition';

/**
 * The nightly pass of Syzygy ADR-0008 stage 1 (睡眠: 遅れて分かった結果の割り当て; `docs/cognition-ledger-contract.md`). Core: emotion.
 *
 * Once a day per scope, on its own trigger in the background worker (`valueNightSchedule`, from the sleep hour, whatever the
 * conversation's sleep batch did): open predictions that ran out expire (a story without a reaction counts as none),
 * forgetting is reconciled and predictions older than 90 days go (`PredictionLedger.maintain`); then choices that waited are
 * settled (delayed credit), lost reports are voided and choices older than 90 days go (`ChoiceLedger.sleep`); then the value
 * table writes a version from what was settled, unless the owner froze it or a `sleep` version was already made since
 * today's sleep-hour boundary (`ValueVersions.nightly`; durable, so a restart later in the day moves no V). Its failure is
 * logged and never fails anything else. It calls no model.
 */
/** The parts of the learning part it runs, as functions it is handed (`mind/learning`; wired by the worker). */
export interface ValueSleepParts {
  predictions: { maintain(scopeKey: string, at: string, state: CompanionStateSnapshot | null): { expired: number; pruned: number } } | null;
  choices: { sleep(scopeKey: string, at: string): { settled: number; pruned: number } } | null;
  values?: { nightly(scopeKey: string, at: string, notBefore?: string): { decision: string; pruned: number } } | null;
  log?: (line: string) => void;
}

export function valueSleep(parts: ValueSleepParts): (scopeKey: string, at: string, state?: () => CompanionStateSnapshot | null, notBefore?: string) => void {
  const log = parts.log ?? (line => console.log(line));
  return (scopeKey, at, state = () => null, notBefore) => {
    try {
      const predictions = parts.predictions?.maintain(scopeKey, at, state()) ?? { expired: 0, pruned: 0 };
      const choices = parts.choices?.sleep(scopeKey, at) ?? { settled: 0, pruned: 0 };
      const values = parts.values?.nightly(scopeKey, at, notBefore) ?? { decision: 'none', pruned: 0 };
      log(`Shannon value sleep: expired=${predictions.expired} predictions_pruned=${predictions.pruned} settled=${choices.settled} choices_pruned=${choices.pruned} version=${values.decision} versions_pruned=${values.pruned}`);
    } catch (error) {
      console.error('Shannon value sleep failed', error instanceof Error ? error.name : 'unknown');
    }
  };
}

/**
 * Its own daily trigger (independent of the conversation's sleep batch): from the sleep hour on, once per owner-local day, the
 * pass runs for every scope `scopes` names, handed today's sleep-hour boundary (the instant the owner-local day reached the
 * sleep hour). The day it last ran is kept in memory only, so a restart on the same day runs the pass again: expiry, lost
 * reports and retention may run again (they depend on the time only), and the value table writes no second version because
 * one made since the boundary is in the table. Returns whether it ran; never throws.
 */
export function valueNightSchedule(options: {
  timeZone: string; sleepHour: number; scopes: () => readonly string[]; run: (scopeKey: string, at: string, notBefore: string) => void;
}): (at: string) => boolean {
  let lastDay: string | null = null;
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-CA', { timeZone: options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); } catch { format = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  return at => {
    try {
      const now = new Date(Date.parse(at));
      const parts = Object.fromEntries(format.formatToParts(now).map(part => [part.type, part.value]));
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      if (Number(parts.hour) < options.sleepHour || day === lastDay) return false;
      // Back from now to the sleep hour of the same owner-local day (whole seconds; a DST change in between may shift it an hour).
      const sinceBoundary = ((Number(parts.hour) - options.sleepHour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 + now.getUTCMilliseconds();
      const notBefore = new Date(now.getTime() - sinceBoundary).toISOString();
      lastDay = day;
      for (const scopeKey of options.scopes()) options.run(scopeKey, at, notBefore);
      return true;
    } catch (error) {
      console.error('Shannon value sleep schedule failed', error instanceof Error ? error.name : 'unknown');
      return false;
    }
  };
}
