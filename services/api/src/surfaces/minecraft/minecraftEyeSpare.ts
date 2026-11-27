import { throwsFromBody } from './minecraftEyeLedger.js';
import { framesKnownOf } from './minecraftSeenMarks.js';

/**
 * How many eyes she is to hold, as one measure for every place that says it (the shortage's eye fact, the End's check line, the pearl line in the Nether, the hunt's line, the plan's
 * nodes). Before the portal room's frames are found the eyes are also what finds them (throws that give the stronghold's crossing), and a throw breaks one time in five: the frames
 * take 12, so the number to hold is 12 plus the eyes that the throws still to come are expected to break. Once the frames are found no eye is thrown, and what is needed is the
 * empty frames' number, with no spare.
 *
 * The throws to come: two give the crossing, and the crossing is narrowed by a throw every 300 to 500 m of a walk of about 1,600 m (4 more); the throws made are taken off. The spare
 * is the mean of the breaks they bring (a fifth of each), rounded up and never under 1: one eye short at the frames costs a wait for a pearl (the night's endermen) in front of the
 * stronghold. A mean only; no drop sequence of any world is read.
 */
export const FRAME_EYES = 12;
export const BREAK_ONE_IN = 5;
export const THROWS_BEFORE_FRAMES = 6;
export const MIN_SPARE = 1;

/** The spare for `thrown` throws already made: the breaks expected of the throws still to come, rounded up, at least 1. */
export function eyeSpare(thrown: number): number {
  const ahead = Math.max(0, THROWS_BEFORE_FRAMES - Math.max(0, Math.floor(thrown)));
  return Math.max(MIN_SPARE, Math.ceil(ahead / BREAK_ONE_IN - 1e-9));
}
/** The eyes to hold before the frames are found, with no throw made yet (what the Nether's pearl stage aims at). */
export const EYES_AT_DEPARTURE = FRAME_EYES + eyeSpare(0);

export interface EyeBasis {
  /** `frames`: the frames are found, no spare; `search`: the frames are still to be found by throwing. */
  kind: 'frames' | 'search';
  need: number;
  spare: number;
  /** Throws still to come (search only). */
  ahead: number;
  thrown: number;
  /** Eyes already in the frames, when read (frames only). */
  inFrames: number | null;
}

/** The throws made in this world, from the body's own record. */
export const thrownOf = (world: Record<string, unknown>): number => throwsFromBody(world.eyeThrows).length;

/** The one measure: the empty frames' number when the frames are known (the ones in view or the body's remembered row), else 12 plus the spare. */
export function eyeBasisOf(world: Record<string, unknown>): EyeBasis {
  const known = framesKnownOf(world), thrown = thrownOf(world);
  if (known) return { kind: 'frames', need: known.eyes === null ? known.frames : Math.max(0, known.frames - known.eyes), spare: 0, ahead: 0, thrown, inFrames: known.eyes };
  const spare = eyeSpare(thrown);
  return { kind: 'search', need: FRAME_EYES + spare, spare, ahead: Math.max(0, THROWS_BEFORE_FRAMES - thrown), thrown, inFrames: null };
}

/** The reason of the spare, as it is said beside the count (before the frames are found). */
export function spareReason(basis: EyeBasis): string {
  return `枠 ${FRAME_EYES}＋予備 ${basis.spare}。予備は、枠が見つかるまでにこれから投げる約 ${basis.ahead} 本が ${BREAK_ONE_IN} 回に 1 回割れる分（最低 ${MIN_SPARE}）。`
    + '無いと割れた 1 個で空き枠に 1 個足りず、要塞の前でパール待ちになる';
}
