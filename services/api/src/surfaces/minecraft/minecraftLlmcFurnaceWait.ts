import type { BodyObservation } from '../../contracts/bodyControlContract.js';

/**
 * mb-llmc v2 (実走37: 鉄 22 個を 1 つのかまどに入れ、wait×6 で 175 秒立って待った。他の手は何も入れなかった): an act with a long wait while a furnace works
 * is told, in its result, how long the furnace has left and that the wait can hold other hands. The furnace's job is the frame's own
 * (`state.world.jobs`: `status`, `remainingEstimateMs`, `input`, `count`, `position`). A fact added to the result; the act goes as it is.
 */
type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
/** A wait this long (the hand's seconds, or the waits of the act added up) is a stand. */
export const LONG_WAIT_SECONDS = 10;

/** The furnaces still working, soonest first: where, what and the seconds left. */
function working(frame: BodyObservation | null): Array<{ at: string; what: string; left: number }> {
  const jobs = rec(frame?.state.world)?.jobs;
  return (Array.isArray(jobs) ? jobs : []).flatMap(item => {
    const job = rec(item), at = rec(job?.position), ms = num(job?.remainingEstimateMs);
    if (!job || !at || ms === null || ms <= 0 || job.status !== 'waiting_external') return [];
    const where = `(${String(at.x)},${String(at.y)},${String(at.z)})`;
    return [{ at: where, what: `${String(job.input ?? '')}×${String(job.count ?? '')}`, left: Math.round(ms / 1000) }];
  }).sort((a, b) => a.left - b.left);
}

/** The note for an act whose waits add up to a long stand while a furnace works, or null. */
export function furnaceWaitNote(input: unknown, frame: BodyObservation | null): string | null {
  const hands = Array.isArray(rec(input)?.hands) ? rec(input)!.hands as unknown[] : [];
  const waits = hands.flatMap((raw, index) => {
    const hand = rec(raw), seconds = num(hand?.seconds);
    return hand?.do === 'wait' && seconds !== null ? [{ hand: index + 1, seconds }] : [];
  });
  const total = waits.reduce((sum, item) => sum + item.seconds, 0);
  const furnaces = working(frame);
  if (total < LONG_WAIT_SECONDS || !furnaces.length) return null;
  const shown = furnaces.slice(0, 2).map(item => `${item.at} の ${item.what} はあと約 ${item.left} 秒`).join('、');
  return `手 ${waits[0]!.hand} wait（合わせて ${Math.round(total)} 秒）: かまどの焼き上がりまで ${shown}。立って待たず、その間に掘る・集める・作る手を入れられる`;
}
