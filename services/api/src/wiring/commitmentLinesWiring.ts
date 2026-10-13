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
}

const MINUTE = 60_000;

export function commitmentLinePreparer(parts: CommitmentLineParts): (at: string, signal?: AbortSignal) => Promise<ReadonlyMap<string, string>> {
  const written = new Map<string, string>();
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
      if (!written.has(key)) written.set(key, await parts.writer?.write(parts.scopeKey, facts, signal) ?? neutralCommitmentLine(facts));
      lines.set(candidate.item_id, written.get(key)!);
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
