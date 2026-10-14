import { QUIET_END_HOUR, QUIET_START_HOUR } from '../contracts/initiativeTiming.js';
import { localDateParts } from '../infra/time/localDate.js';
import { dueCommitmentCandidate } from '../mind/action/respond/commitmentInitiative.js';
import { commitmentFacts, commitmentMessage, type CommitmentLineWriter, type PromisePhraseChoice } from '../mind/action/respond/commitmentLine.js';
export { commitmentFacts } from '../mind/action/respond/commitmentLine.js';

/**
 * A promise's notice (owner decision 2026-10-14, by form: 「事実は決まった文＋シャノンの一言」, `commitmentLine.ts`), prepared by the
 * world worker on each pass: for each promise of the owner's that is due and not yet told, the fixed fact sentence of this moment
 * (its time, its words, how late) with one phrase of hers from the list when the model chose one. Her choice is asked once per
 * promise and audience and kept ten minutes; the message is built again on every pass, so the lateness it states is always that of
 * the moment it is told. Nothing of her mood or of moments is read: this is system delivery of something he asked for.
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
  /** Closed codes only: whether her phrase was chosen, never a word. */
  log?: (line: string) => void;
}

const MINUTE = 60_000;
/** Her choice of phrase is asked again once it is this old (late phrases become possible as a promise waits). */
const CHOICE_FRESH_MILLISECONDS = 10 * MINUTE;

export function commitmentLinePreparer(parts: CommitmentLineParts): (at: string, signal?: AbortSignal) => Promise<ReadonlyMap<string, string>> {
  const chosen = new Map<string, { choice: PromisePhraseChoice | null; at: number }>();
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
      const before = chosen.get(key);
      const stale = !before || Date.parse(at) - before.at > CHOICE_FRESH_MILLISECONDS;
      if (stale) chosen.set(key, { choice: await choose(parts, facts, signal), at: Date.parse(at) });
      // The fact of this moment, with her phrase checked again against it.
      lines.set(candidate.item_id, commitmentMessage(chosen.get(key)!.choice, facts));
    }
    if (chosen.size > 256) chosen.clear();
    return lines;
  };
}

/** Her choice of phrase, asked only while he alone may hear it; logged as closed codes. */
async function choose(parts: CommitmentLineParts, facts: ReturnType<typeof commitmentFacts>, signal?: AbortSignal): Promise<PromisePhraseChoice | null> {
  const choice = facts.others || !parts.writer ? null : await parts.writer.write(parts.scopeKey, facts, signal).catch(() => null);
  const outcome = facts.others ? 'fact_only:others' : !parts.writer ? 'fact_only:no_writer' : choice ? 'phrase' : 'fact_only:none';
  try { parts.log?.(`Shannon promise line: ${outcome}`); } catch { /* optional */ }
  return choice;
}
