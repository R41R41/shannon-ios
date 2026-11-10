import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { holdChoices, letteredChoices } from './minecraftFurnaceMeanwhile.js';
import { readinessOf } from './minecraftLlmcReadiness.js';

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

/**
 * The furnace ledger (run 5, 2026-11-11: 5 stands, 233 s of 1,261, beside the furnace; the frame said only "seconds left"): one line per furnace the
 * body's jobs list, with where it is, what goes in and what comes out, how long it has, and what to do meanwhile (the body does not wait for a
 * furnace: another act goes on while it burns, and a `furnace … take` act is sent when its event comes; the body walks to the furnace to take).
 * A line is a reading of the frame's jobs (`remainingEstimateMs`, `expects`, `from`), made again every decision. Null when the jobs are not a list the body wrote.
 * The instruction is said once, in the first line (not once per furnace); the furnace lines are short, soonest first, 4 at most with the rest counted.
 */
const LEDGER_HEAD = 'かまど帳: 焼く間は待たずに別の作業（かまどの近くの作業が良い。手は planNow の A/B/C）の act を足す。「furnace X,Y,Z take」の act は早めに足してもよい（残りが 15 秒以内なら体が待って取る。長ければ「まだ」と返る）。離れ切る前に取る';
const LEDGER_MAX = 4;
export function furnaceLedgerLines(jobs: unknown): string[] | null {
  if (!Array.isArray(jobs) || !jobs.length) return null;
  const rows: Array<{ ms: number; line: string }> = [];
  for (const item of jobs) {
    const job = rec(item), at = rec(job?.position), ms = num(job?.remainingEstimateMs);
    if (!job || !at || ms === null || typeof job.status !== 'string') return null;
    const cell = `${String(at.x)},${String(at.y)},${String(at.z)}`;
    const from = typeof job.from === 'string' && job.from ? `（${job.from.slice(0, 20)}）` : '';
    const what = `${String(job.input ?? '')}×${String(job.count ?? '')}${typeof job.expects === 'string' && job.expects ? ` → ${job.expects.slice(0, 30)}` : ''}`;
    const lack = num(job.unfueledInputCount) ? `。燃料が足りず ${job.unfueledInputCount} 個は焼けない（石炭か板を足す）` : '';
    if (job.status === 'different_dimension') { rows.push({ ms: Number.MAX_SAFE_INTEGER, line: `かまど (${cell}): ${what}。別のディメンションにある${lack}` }); continue; }
    rows.push({ ms, line: ms > 0 ? `かまど (${cell})${from}: ${what}、あと約 ${Math.round(ms / 1000)} 秒${lack}` : `かまど (${cell})${from}: ${what}、時間は来た（take）${lack}` });
  }
  rows.sort((x, y) => x.ms - y.ms);
  const shown = rows.slice(0, LEDGER_MAX).map(row => row.line);
  const head = rows.some(row => row.ms < Number.MAX_SAFE_INTEGER) ? [LEDGER_HEAD] : [];
  return [...head, ...shown, ...(rows.length > LEDGER_MAX ? [`ほか ${rows.length - LEDGER_MAX} 基`] : [])];
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
 * run 26 (2026-10-26, 「エンドラを討伐して」, Sonnet: 4 stands at the furnace, 244 s of 1,340) put a first, one-time refusal on a stand of waits; run 6 (2026-11-11) showed it
 * fires once in seven: it looked only at acts of wait/furnace/equip/look/eat hands (a `mine` in the act or ahead of it made it "work"), it read the new act joined to the
 * ones ahead, it refused once only (the re-send went through, and the head answered the refusal with a LONGER wait, 30 s to 90 s), and a put in the same act was
 * invisible. It is a hold now (like `nightWaitHold`): any `wait` of 10 s or more of the NEW item, while a furnace works (the frame's jobs) or a `furnace put` / `smelt`
 * comes before it (this act or the ones ahead), is held at that hand (the hands before it are sent), up to `FURNACE_STAND_HOLDS` times in `FURNACE_STAND_WINDOW_MS`
 * for a task; the line carries the choices of `minecraftFurnaceMeanwhile` as hands. With no choice (no iron or coal in reach, no open section that does not need the
 * furnace's output) nothing is held: waiting is then the best there is. Not in an urgent decision. After the holds, a wait right before a `furnace take` is taken out
 * (`dropWaitBeforeTake`; the body waits a remainder of 15 s or less by itself and says 「まだ」 for a longer one, and `furnace.done` wakes the head).
 * Pieces to smelt are split over more furnaces (a furnace takes 10 s a piece): the line says so when one furnace holds `SPLIT_PIECES` or more.
 */
export const FURNACE_STAND_HOLDS = 3;
export const FURNACE_STAND_WINDOW_MS = 10 * 60_000;
/** A run of waits (the new item's own) adding up to this is a stand too, even if no one of them is `LONG_WAIT_SECONDS`. */
export const STAND_TOTAL_SECONDS = 20;
const SPLIT_PIECES = 5;
/** The body waits this many seconds of a furnace's remainder before a take itself (utils/primitives: furnace take). */
const TAKE_WAITS_SECONDS = 15;
const MAX_DROPS = 2;
const drops = new Map<string, number[]>();
const stands = new Map<string, number[]>();
const recentStands = (taskId: string, now: number): number[] => (stands.get(taskId) ?? []).filter(when => now - when < FURNACE_STAND_WINDOW_MS);
const isPut = (hand: Rec | null): boolean => !!hand && (hand.do === 'smelt' || (hand.do === 'furnace' && hand.op !== 'take' && (hand.op === 'put' || typeof hand.item === 'string')));
const waitSeconds = (hand: Rec | null): number => hand?.do === 'wait' ? num(hand.seconds) ?? 1 : 0;

/**
 * The hold (the hand, 1-based in the act as given, its kind and its line) of a stand beside a furnace, or null; `commit` counts it when it stops the act.
 * `ownFrom`: the number of hands ahead (the items ahead of the new one in the queue): only the hands from there on are the new item's.
 */
export function furnaceStandHold(input: unknown, frame: BodyObservation | null, taskId: string, urgent = false, ownFrom = 0, now: () => number = Date.now):
  { hand: number; kind: string; line: string; commit(): void } | null {
  if (urgent) return null;
  const hands = Array.isArray(rec(input)?.hands) ? (rec(input)!.hands as unknown[]).map(rec) : [];
  const own = hands.slice(ownFrom);
  const total = own.reduce((sum, hand) => sum + waitSeconds(hand), 0);
  const at = hands.findIndex((hand, index) => index >= ownFrom && waitSeconds(hand) >= LONG_WAIT_SECONDS);
  const index = at >= 0 ? at : total >= STAND_TOTAL_SECONDS ? hands.findIndex((hand, i) => i >= ownFrom && waitSeconds(hand) > 0) : -1;
  if (index < 0) return null;
  const furnaces = working(frame);
  const putBefore = hands.slice(0, index).some(isPut);
  if (!furnaces.length && !putBefore) return null;
  const facts = readinessOf(frame);
  if (!facts) return null;
  const choices = holdChoices(facts.world, facts.counts, taskId);
  if (!choices.length) return null;
  const clock = now(), recent = recentStands(taskId, clock);
  if (recent.length >= FURNACE_STAND_HOLDS) return null;
  const left = furnaces[0];
  const seconds = Math.round(hands.slice(index).reduce((sum, hand) => sum + waitSeconds(hand), 0));
  const many = furnaces.find(item => item.count >= SPLIT_PIECES);
  const split = many ? `（${many.what} を1基で焼くと ${many.count * 10} 秒かかる。1個 10 秒。基数に分けると並んで焼ける）` : '';
  const line = `${left ? `かまど ${left.at} の ${left.what} はあと約 ${left.left} 秒` : '焼いている最中'}${split}。立って待つ wait（${seconds} 秒）は送らない`
    + `（${recent.length + 1}/${FURNACE_STAND_HOLDS} 回目。${FURNACE_STAND_HOLDS} 回止めた後は通す）: 立って待つと焼く間の ${seconds} 秒がそのまま止まる（実走 6 は 1564 秒中 270 秒）。`
    + `take は待たなくてよい（早めに足しても、残りが短ければ体が待って取り、長ければ「まだ」と返る）。次の 1 手はどれか: ${letteredChoices(choices)}`;
  return { hand: index + 1, kind: 'wait', line, commit: () => { stands.set(taskId, [...recent, clock]); if (stands.size > 32) stands.delete(stands.keys().next().value as string); } };
}

/**
 * After the holds (`FURNACE_STAND_HOLDS` of them) a wait of 10 s or more right before a `furnace take` (the new item's own hands) is taken out: it was the head's timer for the
 * take, and the take needs none. The act goes without it, and the result says so (a fix the head made, said first). Null: nothing to take out, holds not used up,
 * or an act whose hands name each other (`dependsOn` counts hands: taking one out would move them).
 */
export function dropWaitBeforeTake(input: unknown, taskId: string, ownFrom = 0, now: () => number = Date.now, frame: BodyObservation | null = null): { input: unknown; note: string } | null {
  const act = rec(input);
  const hands = Array.isArray(act?.hands) ? (act!.hands as unknown[]).map(rec) : [];
  if (!act || hands.length < 2 || hands.some(hand => Array.isArray(hand?.dependsOn))) return null;
  if (recentStands(taskId, now()).length < FURNACE_STAND_HOLDS) return null;
  const cut = hands.flatMap((hand, index) => index >= ownFrom && waitSeconds(hand) >= LONG_WAIT_SECONDS && hands[index + 1]?.do === 'furnace' && hands[index + 1]?.op === 'take' ? [index] : []);
  if (!cut.length) return null;
  // Review of run 6's fixes: the wait comes out only when the take can then work (the furnace is done or has 15 s or less: the body waits that itself) or when other work stands open
  // (the take answers 「まだ」 at once and the next decision is that work). With neither, waiting is the best there is; and a repeat of the same act is let through after `MAX_DROPS`
  // drops of a task in the window (a head with nothing else to do sent `wait 30, take` again and again, a decision and a 「まだ」 with no progress).
  const furnaces = working(frame), left = furnaces[0]?.left ?? 0;
  const facts = readinessOf(frame);
  const otherWork = !!facts && holdChoices(facts.world, facts.counts, taskId).length > 0;
  if (left > TAKE_WAITS_SECONDS && !otherWork) return null;
  const clock = now(), recent = (drops.get(taskId) ?? []).filter(when => clock - when < FURNACE_STAND_WINDOW_MS);
  if (recent.length >= MAX_DROPS) return null;
  drops.set(taskId, [...recent, clock]);
  if (drops.size > 32) drops.delete(drops.keys().next().value as string);
  const kept = (act.hands as unknown[]).filter((_hand, index) => !cut.includes(index));
  const words = cut.map(index => `手 ${index + 1} の wait ${Math.round(waitSeconds(hands[index]))} 秒`).join('・');
  return { input: { ...act, hands: kept }, note: `（頭が形を直して送った: ${words}は take の前だったので外した。take は早くても、残りが短ければ体が待って取り、長ければ「まだ」と返り、焼き上がりの知らせで起こす${left > TAKE_WAITS_SECONDS ? `。今はあと約 ${left} 秒あるので「まだ」と返る。その間は別の作業を` : ''}）` };
}
/** For tests: no task has been held at a stand. */
export function forgetFurnaceStands(): void { stands.clear(); drops.clear(); }
