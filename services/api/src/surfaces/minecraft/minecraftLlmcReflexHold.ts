import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { finite, plain } from './minecraftLlmcProbeInput.js';

/**
 * mb-llmc r10 (H2; run 34, 2026-10-22, the seventh unknown: the flee reflex held the body at 17:30:00–12 and dug her down nine blocks; an
 * urgent act sent at 17:30:05 was cut by the reflex's lease, sat unsettled 4 s and made the step unknown, and the recovery limit stopped the
 * task): an act does not start while a reflex is holding the body. The decision still runs at once and is told (`reflexLine`, first among
 * the urgent lines); only the start waits, and the body does the waiting for every item of its queue (`afterReflex`, `controlLoop`/`nativeBody`).
 * How the head knows, in order:
 * - the body's r10 says it in the observation: `facts.reflexHeld`, the name of the reflex that holds the body (`floor-flee`, `floor-last-stand`,
 *   `floor-cover`, `floor-melee`, `floor-eat`, `floor-armor`, `floor-retreat`, `lava-escape`, `auto-swim`) or null; the gap between two hands of an
 *   episode counts as held. A key that is there decides (null: free);
 * - a body without the key: its ledger (`state.world.reflexes.recent`, newest first: `{ageSec, kind, detail}`; a hand of an episode writes its
 *   entry when it ends, the next follows within a second or two): held while the newest hand of a multi-hand kind is under
 *   `REFLEX_SILENT_SECONDS` old.
 */
export const REFLEX_HOLD_KINDS: ReadonlySet<string> = new Set(['flee', 'cover', 'melee']);
/** Seconds without a new hand of the episode after which the reflex has let go (a ledger entry's age is whole seconds, so 2 is 1.5 s or more). */
export const REFLEX_SILENT_SECONDS = 2;

export interface ReflexHold { kind: string; detail: string; ageSec: number; by: 'facts' | 'ledger' }
const newestEntry = (observation: BodyObservation | null, wanted?: (kind: string) => boolean) => {
  const reflexes = plain(plain(observation?.state.world)?.reflexes);
  for (const item of Array.isArray(reflexes?.recent) ? reflexes.recent : []) {
    const entry = plain(item), age = finite(entry?.ageSec);
    if (entry && age !== null && typeof entry.kind === 'string' && (!wanted || wanted(entry.kind))) {
      return { kind: entry.kind, ageSec: age, detail: typeof entry.detail === 'string' ? entry.detail : '' };
    }
  }
  return null;
};
/** The reflex that holds the body in this frame, or null (free, or nothing said). */
export function reflexHolding(observation: BodyObservation | null): ReflexHold | null {
  const facts = plain(observation?.facts);
  if (facts && 'reflexHeld' in facts) {
    const name = facts.reflexHeld;
    if (typeof name !== 'string' || !name) return null;
    const kind = name.replace(/^(floor|auto)-/u, '').replace(/^constant:/u, ''), entry = newestEntry(observation, found => found === kind);
    return { kind, detail: entry?.detail ?? '', ageSec: entry?.ageSec ?? 0, by: 'facts' };
  }
  // The ledger lists the newest first: the first of a holding kind decides.
  const entry = newestEntry(observation, kind => REFLEX_HOLD_KINDS.has(kind));
  return entry && entry.ageSec < REFLEX_SILENT_SECONDS ? { ...entry, by: 'ledger' } : null;
}

/** The urgent line while a reflex holds the body: what it is doing and that an act waits for it. */
export function reflexLine(hold: ReflexHold | null): string | null {
  if (!hold) return null;
  const doing = hold.detail ? `（${hold.detail.slice(0, 60)}）` : '';
  const until = hold.by === 'facts' ? '反射が放した（観測の reflexHeld が空に戻った）' : `反射が放した（${REFLEX_SILENT_SECONDS}秒 反射の記録が止まった）`;
  return `反射の最中: ${hold.kind}${doing}。体は反射が握っている。act は${until}後に体へ送る`;
}

/** The urgent line of the reflex that holds the body in this frame: one line, or none. */
export function reflexLines(observation: BodyObservation | null): string[] {
  const line = reflexLine(reflexHolding(observation));
  return line ? [line] : [];
}
