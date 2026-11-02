import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carried, doneFacts, type DoneFacts } from './minecraftConditions.js';
import { createEyeLedger, type EyeLedger } from './minecraftEyeLedger.js';
import { crystalLine, deathLine, dragonApproachLine, dragonLine, endFightLines, frameLine, placeLine } from './minecraftEndFacts.js';
import { endViewOf, type EndView } from './minecraftEndView.js';

/**
 * What a task that goes for the dragon keeps and says of the way after the Nether, as facts for the live state (one object a task, made
 * from its checkpoint like the journey and the worksite memory):
 * - the ledger of the thrown eyes and the stronghold they give (`minecraftEyeLedger.ts`), the one thing here the head keeps itself;
 * - the dragon, the crystals, the breath, the fireballs and the perch in the End (the body's own fields, `minecraftEndView.ts`), the frames of
 *   the portal room and the eyes they still need, her last death with where it was, and the places the body remembers for the way
 *   (`minecraftEndFacts.ts`), read from the frame each time.
 * It decides nothing and sends nothing; a field the body does not send leaves its line out.
 */
export interface EndgameLines {
  /** The normal version's lines, and the shorter set an urgent or a shortened live state keeps. */
  lines: string[];
  short: string[];
}
const NONE: EndgameLines = { lines: [], short: [] };
const HAZARD_HEADS = ['竜の息の雲:', '火の玉:'];

const worldOf = (observation: BodyObservation | null): Record<string, unknown> | null => {
  const world = observation?.state.world;
  return world && typeof world === 'object' && !Array.isArray(world) ? world as Record<string, unknown> : null;
};
const some = (line: string | null): string[] => line ? [line] : [];

/** The lines of one decision from the frame and the ledger's lines (pure). */
function compose(world: Record<string, unknown>, end: EndView | null, facts: DoneFacts, eyeLines: readonly string[]): EndgameLines {
  const fight = endFightLines(end);
  const frames = some(frameLine(world, carried(facts.counts, 'ender_eye')));
  const death = some(deathLine(world));
  const places = some(placeLine(world));
  const urgent = [...some(dragonLine(end, true)), ...some(crystalLine(end, true)),
    ...fight.filter(line => HAZARD_HEADS.some(head => line.startsWith(head))), ...some(dragonApproachLine(end, true))];
  return { lines: [...fight, ...eyeLines, ...frames, ...death, ...places], short: [...urgent, ...frames, ...death] };
}

/** The ledger's lines while the stronghold is still to be found: in the overworld, before the portal room's frames are in view. */
function eyeLinesOf(ledger: EyeLedger, facts: DoneFacts, now: number): string[] {
  const looking = facts.dimension === 'overworld' && facts.seen?.has('end_portal_frame') !== true;
  if (!looking) return [];
  return ledger.lines(facts.feet ? { x: facts.feet.x, z: facts.feet.z } : null, now);
}

export function createEndgame(saved: unknown, now: () => number = Date.now) {
  const ledger = createEyeLedger((saved as { minecraftEyes?: unknown } | null)?.minecraftEyes);
  return {
    /** An act's result (the receipt's id and its result JSON): a thrown eye goes in the ledger. */
    noteResult(id: string | undefined, resultJson: string | undefined, observation: BodyObservation | null): void {
      ledger.note(id, resultJson, doneFacts(observation)?.dimension ?? null, now());
    },
    /** The lines of this decision: empty for a task that is not after the dragon. */
    lines(observation: BodyObservation | null, dragonTask: boolean): EndgameLines {
      const world = worldOf(observation);
      const facts = doneFacts(observation);
      if (!dragonTask || !world || !facts) return NONE;
      if (facts.seen?.has('end_portal_frame') || facts.dimension === 'the_end') ledger.clear();
      return compose(world, endViewOf(observation), facts, eyeLinesOf(ledger, facts, now()));
    },
    checkpoint: ledger.checkpoint,
  };
}
export type Endgame = ReturnType<typeof createEndgame>;
