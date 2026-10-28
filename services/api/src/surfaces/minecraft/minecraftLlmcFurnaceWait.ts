import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { HandStop } from './minecraftLlmcHandGuards.js';

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
function working(frame: BodyObservation | null): Array<{ at: string; what: string; left: number; count: number }> {
  const jobs = rec(frame?.state.world)?.jobs;
  return (Array.isArray(jobs) ? jobs : []).flatMap(item => {
    const job = rec(item), at = rec(job?.position), ms = num(job?.remainingEstimateMs);
    if (!job || !at || ms === null || ms <= 0 || job.status !== 'waiting_external') return [];
    const where = `(${String(at.x)},${String(at.y)},${String(at.z)})`;
    return [{ at: where, what: `${String(job.input ?? '')}×${String(job.count ?? '')}`, left: Math.round(ms / 1000), count: num(job.count) ?? 0 }];
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
  return `手 ${waits[0]!.hand} wait（合わせて ${Math.round(total)} 秒）: かまどの焼き上がりまで ${shown}`;
}

/**
 * run 26 (2026-10-26, 「エンドラを討伐して」, Sonnet: 4 stands at the furnace, 244 s of 1,340, each time 6〜7 pieces in one furnace; the note above was in
 * the result every time and the next act was wait only, four times of four; one of them wrote 「焼き上がりまで待ちつつ、足元の鉄を掘る」 and sent wait 30 + wait 30):
 * an act whose hands are only waits (and the furnace's own, equip, look, eat) that add up to `STAND_REFUSE_SECONDS` while a furnace works is not sent the first
 * time, and the fact comes back at once. The same act again, straight after, is sent: waiting may be the best there is. Not in an urgent decision.
 * GPT's review 2026-10-28: the result says the fact only (not sent, the furnace's seconds); it no longer tells that the same act sent again goes
 * (a mechanism that is unchanged), and the rule for a wait is in the instructions (「体を止めない」).
 * Pieces to smelt are split over more furnaces (a furnace takes 10 s a piece): the fact says so when one furnace holds `SPLIT_PIECES` or more.
 */
export const STAND_REFUSE_SECONDS = 20;
const SPLIT_PIECES = 5;
const STAND_KINDS = new Set(['wait', 'furnace', 'equip', 'look', 'eat']);
const refused = new Map<string, number>();
export function furnaceStandStop(input: unknown, frame: BodyObservation | null, taskId: string, urgent = false): HandStop | null {
  const hands = Array.isArray(rec(input)?.hands) ? (rec(input)!.hands as unknown[]).map(rec) : [];
  const total = hands.reduce((sum, hand) => sum + (hand?.do === 'wait' ? num(hand.seconds) ?? 0 : 0), 0);
  const furnaces = working(frame);
  const standing = hands.length > 0 && hands.every(hand => hand !== null && STAND_KINDS.has(String(hand.do)));
  if (urgent || !standing || total < STAND_REFUSE_SECONDS || !furnaces.length) {
    refused.delete(taskId);
    return null;
  }
  if (refused.has(taskId)) {
    refused.delete(taskId);
    return null;
  }
  refused.set(taskId, 1);
  if (refused.size > 32) refused.delete(refused.keys().next().value as string);
  const first = hands.findIndex(hand => hand?.do === 'wait') + 1;
  const shown = furnaces.slice(0, 2).map(item => `${item.at} の ${item.what} はあと約 ${item.left} 秒`).join('、');
  const many = furnaces.find(item => item.count >= SPLIT_PIECES);
  const split = many ? `。${many.what} を1基で焼くと ${many.count * 10} 秒かかる（1個 10 秒。基数に分けると並んで焼ける）` : '';
  return { hand: Math.max(1, first), kind: 'wait', code: 'furnace_stand',
    line: `立って待つだけの手（合わせて ${Math.round(total)} 秒）は送っていない（手は動いていない）。かまどの焼き上がりまで ${shown}${split}` };
}
/** For tests: no task has been refused a stand. */
export function forgetFurnaceStands(): void { refused.clear(); }
