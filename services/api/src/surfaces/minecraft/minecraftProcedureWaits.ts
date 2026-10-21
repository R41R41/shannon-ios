import type { ProcedureMemory } from '@shannon/mind';
import { doing, type McDo } from './minecraftProcedureMoves.js';
import { finalFailure } from './minecraftProcedureUpkeep.js';

/**
 * The body's refusal of a wait is its judgement, not a failure of the work (mb-r22, run 22: the iron procedure asked the body to wait
 * for a furnace, the body refused twice because coal and iron lay 2 and 4 m off, and the whole procedure ended `できなかった` at 627 s and
 * again at 649 s, two failed calls in a row for the planner and five stops away). `wait-time` and a `withdraw-from-furnace` that waits
 * answer `wait_refused` when there is something definite to do meanwhile, and say what: "その間にできること: mine-block で近くの
 * iron_ore (x, y, z) 約9m・coal_ore (…) 約4mを掘る". So the refusal is taken as done and noted, the ore it names is dug (once for
 * each refusal), and what is left of the wait is spent in waits of five seconds or less, which the body never refuses.
 */
export const WAIT_REFUSED = 'wait_refused';
/** A wait this short is never refused by the body (`wait-time`: "a beat between two actions"). */
export const FREE_WAIT_MS = 5_000;

export interface MeanwhileOre { name: string; distance: number }

const ORE = /(?:^|[^a-z_])((?:deepslate_)?(?:iron|coal)_ore)\s*\(\s*-?\d+\s*,\s*-?\d+\s*,\s*-?\d+\s*\)\s*約\s*(\d+)\s*m/gu;

/** The ores a refusal names, nearest first (deepslate counted as the same kind). */
export function meanwhileOres(text: string): MeanwhileOre[] {
  const found = [...text.matchAll(ORE)].map(match => ({ name: match[1]!.replace(/^deepslate_/u, ''), distance: Number(match[2]) }));
  return found.sort((a, b) => a.distance - b.distance);
}

const count = (memory: ProcedureMemory, note: string) => Number(memory.notes.get(note) ?? 0);
/** How many waits the body has refused in this run. */
export const refusals = (memory: ProcedureMemory) => count(memory, 'wait:refused');

/** A refusal taken in: counted, the ores it names kept, and the hold for a furnace is off (the dig goes on). */
function noteRefusal(memory: ProcedureMemory, text: string): void {
  memory.notes.set('wait:refused', refusals(memory) + 1);
  memory.notes.set('wait:ores', meanwhileOres(text));
  memory.notes.set('hold:off', true);
}

/** The `accepts` of a wait: the body's refusal is a wait done (and noted); any other failure goes the usual way. */
export function refusedWait(memory: ProcedureMemory) {
  return (failure: string, text: string): boolean => {
    if (failure !== WAIT_REFUSED) return false;
    noteRefusal(memory, text);
    return true;
  };
}

/**
 * What fills the time after the body refused a wait: the nearest ore it named, dug (a miss, or a nothing-to-dig, ends nothing), else a wait
 * of five seconds. `remainingMs` keeps the short waits' keys apart as the furnace runs down.
 */
export function afterRefusal(memory: ProcedureMemory, remainingMs: number): McDo {
  const taken = refusals(memory);
  const ores = (memory.notes.get('wait:ores') as MeanwhileOre[] | undefined) ?? [];
  const ore = count(memory, 'wait:dug') < taken ? ores[0] : undefined;
  if (ore) {
    return doing({ tool: 'mc.mine-block', input: { blockName: ore.name, count: 3, searchRadius: Math.min(32, ore.distance + 8) },
      why: 'かまどの焼ける間に、体が勧めた近くの鉱石を掘る', expectMs: 20_000, key: `furnace:meanwhile:${taken}:${ore.name}`,
      accepts: failure => !finalFailure(failure),
      then: () => {
        memory.notes.set('wait:dug', taken);
        return null;
      } });
  }
  return doing({ tool: 'mc.wait-time', input: { milliseconds: FREE_WAIT_MS }, why: 'かまどの焼ける間を短く待つ', expectMs: FREE_WAIT_MS + 2_000,
    key: `furnace:short:${Math.round(remainingMs / 5_000)}:${taken}` });
}
