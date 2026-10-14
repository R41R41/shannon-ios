import { QUIET_END_HOUR, QUIET_START_HOUR } from '../contracts/initiativeTiming.js';
import { localDateParts } from '../infra/time/localDate.js';
import { dueCommitmentCandidate } from '../mind/action/respond/commitmentInitiative.js';
import { neutralCommitmentLine, type CommitmentFacts, type CommitmentLineWriter } from '../mind/action/respond/commitmentLine.js';

/**
 * A promise's notice in her own words (owner decision 2026-10-14, `commitmentLine.ts`), prepared by the world worker before its
 * initiative run: for each promise of the owner's that is due and not yet told, one line written in her voice from its facts, or
 * the neutral factual line when none could be written or trusted. Each promise is written once per audience in this process, so
 * a run that does not send it (the day's slot, a recent conversation, the gate) never pays for it again. Nothing of her mood or of
 * moments is read: this is system delivery of something he asked for.
 */
export interface CommitmentLineParts {
  writer: CommitmentLineWriter | null;
  scopeKey: string;
  timeZone: string;
  /** The companion state as stored (the promises are read from it as the initiative loop reads them). */
  snapshot: (scopeKey: string) => unknown;
  delivered: (scopeKey: string, itemId: string) => boolean;
  /** Someone other than the owner may see or hear her body now (a stream included). */
  others: (scopeKey: string, at: string) => boolean;
  /** Closed codes only: whether a line is hers or the neutral one, never a word of either. */
  log?: (line: string) => void;
}

const MINUTE = 60_000;
/**
 * A line is written again once it is this old: its facts say how late the promise is (2026-10-14: a line written at 09:22 would
 * have said 「3分過ぎ」 when it was finally told at 10:07). With promises told on time it is written once, when it is due.
 */
const LINE_FRESH_MILLISECONDS = 10 * MINUTE;

export function commitmentLinePreparer(parts: CommitmentLineParts): (at: string, signal?: AbortSignal) => Promise<ReadonlyMap<string, string>> {
  const written = new Map<string, { line: string; at: number }>();
  return async (at, signal) => {
    const lines = new Map<string, string>();
    const hour = localDateParts(new Date(at), parts.timeZone).hour;
    if (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) return lines;
    let others = true;
    try { others = parts.others(parts.scopeKey, at); } catch { others = true; }
    for (const candidate of dueCommitmentCandidate(parts.scopeKey, parts.snapshot(parts.scopeKey), at)) {
      if (parts.delivered(parts.scopeKey, candidate.item_id)) continue;
      const key = `${candidate.item_id}\u0000${others ? 'others' : 'owner'}`;
      const facts = commitmentFacts(candidate, at, parts.timeZone, others);
      const before = written.get(key);
      if (!before || Date.parse(at) - before.at > LINE_FRESH_MILLISECONDS) {
        const hers = await parts.writer?.write(parts.scopeKey, facts, signal) ?? null;
        // The neutral factual line is the fallback only: no writer, a failed write, or a line that did not state the promise.
        const outcome = hers ? 'hers' : parts.writer ? 'neutral:unwritten_or_untrusted' : 'neutral:no_writer';
        try { parts.log?.(`Shannon promise line: ${outcome}`); } catch { /* optional */ }
        written.set(key, { line: hers ?? neutralCommitmentLine(facts), at: Date.parse(at) });
      }
      lines.set(candidate.item_id, written.get(key)!.line);
    }
    if (written.size > 256) written.clear();
    return lines;
  };
}

/** The facts of one due promise: what, when (owner-local), and how late. */
export function commitmentFacts(candidate: { title: string; published_at: string | null }, at: string, timeZone: string, others: boolean): CommitmentFacts {
  const dueAt = candidate.published_at && Number.isFinite(Date.parse(candidate.published_at)) ? candidate.published_at : null;
  const when = dueAt ? new Intl.DateTimeFormat('ja-JP', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(dueAt)) : '今日';
  const overdueMinutes = dueAt ? Math.max(0, Math.round((Date.parse(at) - Date.parse(dueAt)) / MINUTE)) : null;
  return { title: candidate.title, when, overdueMinutes, others };
}
