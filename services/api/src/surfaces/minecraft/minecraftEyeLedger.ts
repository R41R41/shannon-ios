import { readActResult } from '../../contracts/minecraftActContract.js';
import {
  bearingBetween,
  compassWord,
  directPoint,
  nearThrowPlace,
  nextThrowPlaces,
  stronghold,
  type DirectPoint,
  type EyeThrow,
  type Fix,
} from './minecraftEyeTriangulation.js';
import type { FramesKnown } from './minecraftSeenMarks.js';

/**
 * The ledger of the eyes of ender she has thrown in this task (the head's own record; the body reports each flight in its act result,
 * `ActResult.eye`, and keeps no list). It lives in the task's checkpoint, so a summary of the talk, a restart or a new step never
 * loses a throw. From the throws it computes the stronghold (`minecraftEyeTriangulation.ts`) and says it as facts, with how sure it is
 * and where to throw from next; it decides nothing.
 *
 * The body's report (S2, 2026-11-02): where she stood (`origin`, exact), the flight's compass bearing and horizontal unit vector, how far
 * it flew, how it ended (`fate`: dropped with the item's id and place, shattered, unknown), `arrived` (it stopped short of the 12 blocks
 * an eye flies toward a farther stronghold) and `down` (it sank where it was thrown: the stronghold is under that place).
 *
 * Only throws in the overworld count. A throw is kept for `KEEP_MS` (and is not read after it, whenever the ledger is read), and the
 * ledger holds the newest `KEEP_THROWS` of them near the newest one (the stronghold of an earlier trek is not this one).
 */
export const KEEP_THROWS = 8;
/** The stronghold does not move: a throw of the trek stays for longer than a whole run's budget (3 hours); a far newer one still forgets it (`NEAR_BLOCKS`). */
const KEEP_MS = 4 * 3_600_000;
const NEAR_BLOCKS = 4_000;
/** Eyes that dropped can be picked up for this long. */
const DROP_MS = 5 * 60_000;

export type EyeFate = 'dropped' | 'shattered' | 'unknown';
export interface StoredThrow extends EyeThrow {
  id: string;
  at: number;
  /** Where it came down (for picking it up): the dropped item's place when the body saw it, else where the eye was last seen. */
  toX: number;
  toZ: number;
  fate?: EyeFate;
  /** The dropped item's entity id (what `pickup` takes by id). */
  dropId?: number;
}
interface LedgerState {
  v: 1;
  throws: StoredThrow[];
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const xz = (value: unknown): { x: number; z: number } | null => {
  const item = rec(value);
  return item && finite(item.x) && finite(item.z) ? { x: item.x, z: item.z } : null;
};
const fateOf = (value: unknown): EyeFate | null => value === 'dropped' || value === 'shattered' || value === 'unknown' ? value : null;
/** The optional fields of a throw, from a report or from a checkpoint (the same names). */
function extrasOf(item: Rec): Pick<StoredThrow, 'down' | 'arrived' | 'unit' | 'fate' | 'dropId'> {
  const unit = xz(item.unit);
  const fate = fateOf(item.fate);
  return { ...(item.down === true ? { down: true } : {}), ...(item.arrived === true && item.down !== true ? { arrived: true } : {}),
    ...(unit ? { unit } : {}), ...(fate ? { fate } : {}), ...(finite(item.dropId) ? { dropId: item.dropId } : {}) };
}

function storedOf(raw: unknown): StoredThrow | null {
  const item = rec(raw);
  if (!item || typeof item.id !== 'string' || ![item.x, item.z, item.bearingDeg, item.flew, item.at, item.toX, item.toZ].every(finite)) return null;
  return { id: item.id.slice(0, 80), x: item.x as number, z: item.z as number, bearingDeg: item.bearingDeg as number, flew: item.flew as number,
    broke: item.broke === true, at: item.at as number, toX: item.toX as number, toZ: item.toZ as number, ...extrasOf(item) };
}

/** A flight from an act result (the receipt's JSON), or null when the act threw no eye. */
export function flightOf(resultJson: string | undefined): Omit<StoredThrow, 'id' | 'at'> | null {
  const eye = rec(readActResult(resultJson)?.eye);
  const from = xz(eye?.from);
  const to = xz(eye?.to);
  if (!eye || !from || !to || ![eye.bearingDeg, eye.flew].every(finite)) return null;
  const origin = xz(eye.origin) ?? from;
  const landed = xz(rec(eye.drop)?.at) ?? to;
  const dropId = rec(eye.drop)?.id;
  return { x: origin.x, z: origin.z, bearingDeg: eye.bearingDeg as number, flew: eye.flew as number, broke: eye.broke === true || eye.fate === 'shattered',
    toX: landed.x, toZ: landed.z, ...extrasOf({ ...eye, dropId }) };
}

const place = (x: number, z: number): string => `(${Math.round(x)},${Math.round(z)})`;
const grouped = (value: number): string => Math.round(value).toLocaleString('en-US');
const tenth = (value: number): string => String(Math.round(value * 10) / 10);
const FRAME_SEARCH = '枠は mc_probe kind=frames（x z にその所・radius 128）で探す。部屋は入口から 7〜72 ブロック離れていた（隔離ラボの 5 世界）';

/**
 * The frames' probe before a throw: `mc_probe kind=frames` takes 0.3 seconds and no eye, and it reads the frames of every loaded chunk (about 200 m round her), past the radius it is given.
 * A fourth eye was thrown at a point 155 m from frames the body already remembered; the eye broke. Said with its reason wherever a throw is offered.
 */
export const PROBE_FIRST = '投げる前に先に mc_probe kind=frames を撃つ（0.3 秒で済み、目を使わない。半径の外でも読み込まれた範囲の約 200m まで枠を拾う）。枠が見えれば、投げる必要も目を割るおそれも無い';

/**
 * The frames are known in this world (in view, or in the body's own record): where, how many hold an eye, how many more are needed, and why no throw. With the eye count known, an
 * empty-frame count that the hand reaches opens the portal for certain, and a throw that breaks leaves one short; unknown, it is read at the frames.
 */
export function frameFoundWords(known: FramesKnown, feet: { x: number; z: number } | null, held: number): string {
  const spot = `(${Math.round(known.at.x)},${Math.round(known.at.y)},${Math.round(known.at.z)})`;
  const there = feet ? `の ${grouped(Math.hypot(known.at.x - feet.x, known.at.z - feet.z))}m ${compassWord(bearingBetween(feet, known.at))}` : '';
  const inEye = known.eyes === null ? '目入りは枠のそばで読む（mc_probe kind=frames）まで分からない' : `目入り ${known.eyes}`;
  const need = known.eyes === null ? `必要は ${known.frames} 個まで（目入りの分だけ減る）` : `必要 ${Math.max(0, known.frames - known.eyes)}`;
  const reach = known.eyes === null ? '' : held >= known.frames - known.eyes
    ? `。手持ちが必要数に届いている間は、枠は開く（投げて割れると 1 個足りなくなる）` : `。手持ちが必要数に ${known.frames - known.eyes - held} 個足りない（アイ 1 個＝パール 1＋粉 1）`;
  return `枠は ${spot}${there ? ` ${there}` : ''}で見つかっている（枠 ${known.frames}・${inEye}・${need}・手持ち ${held}）${reach}。`
    + 'もう投げない: 投げると 5 回に 1 回割れ、割れた時はパールがもう 1 個要る。枠へ歩く';
}

function pickWords(item: StoredThrow, now: number): string {
  if (item.broke) return '（割れた）';
  if (item.fate === 'unknown') return '（落ちたか割れたか見えなかった）';
  if (now - item.at >= DROP_MS) return '（落ちた: 拾える期限が過ぎたかもしれない）';
  return `（落ちた: ${place(item.toX, item.toZ)} で拾える${item.dropId === undefined ? '' : `・pickup target=#${item.dropId}`}）`;
}

function throwWords(item: StoredThrow, now: number): string {
  if (item.down) return `${place(item.x, item.z)} から投げたら真下へ沈んだ${pickWords(item, now)}`;
  const flight = `方位 ${tenth(item.bearingDeg)}°（${compassWord(item.bearingDeg)}）に ${Math.round(item.flew)} 飛んだ`;
  return `${place(item.x, item.z)} から ${flight}${item.arrived ? '（そこで止まった）' : ''}${pickWords(item, now)}`;
}

/** The lines the throws say: the count, the latest ones, the point they give (or why none) and where to throw from next. */
export function ledgerLines(throws: readonly StoredThrow[], feet: { x: number; z: number } | null, now: number, known?: { frames: FramesKnown; held: number }): string[] {
  if (!throws.length) return [];
  const broke = throws.filter(item => item.broke).length;
  const head = `目玉の帳簿: 投げた ${throws.length} 個（割れた ${broke}）。新しい順: ${throws.slice(-3).reverse().map(item => throwWords(item, now)).join(' / ')}`;
  // The frames are known in this world: they are the place to walk to, and the point the lines give is no longer a guide to look for (nothing is offered to throw).
  if (known) return [head, frameFoundWords(known.frames, feet, known.held)];
  const direct = directPoint(throws);
  if (direct) return [head, directLine(direct, feet)];
  const fix = honestFix(throws);
  if (!fix) return [head, noFixLine(throws, throws[throws.length - 1]!)];
  return [head, ...fixLines(fix, feet, spreadDegrees(throws))];
}

/** A throw this near the line of an earlier one, sideways, draws the same line (S5's rig of 11/5: the throws along the line counted as tries). */
const SAME_LINE_BLOCKS = 12;
/**
 * The sideways tries that gave no point: the lines drawn from places at least `SAME_LINE_BLOCKS` sideways of every earlier line, less the first.
 * A throw further along the same line is no try (its place stays 24 m sideways, the first of the table).
 */
export function sidewaysTries(throws: readonly StoredThrow[]): number {
  const lines: StoredThrow[] = [];
  for (const item of throws) {
    if (item.down || !Number.isFinite(item.bearingDeg)) continue;
    const apart = lines.every(line => {
      const r = line.bearingDeg * Math.PI / 180;
      return Math.abs((item.x - line.x) * -Math.cos(r) - (item.z - line.z) * Math.sin(r)) >= SAME_LINE_BLOCKS;
    });
    if (apart) lines.push(item);
  }
  return Math.max(0, lines.length - 1);
}

function noFixLine(throws: readonly StoredThrow[], last: StoredThrow): string {
  const why = throws.length < 2 ? '線が 1 本だけ' : '線が近すぎるか、誤差が大きい（誤差 600m 超）';
  const places = nextThrowPlaces(last, sidewaysTries(throws));
  if (!places.length) return `交点はまだ無い（${why}）`;
  const where = places.map(item => place(item.x, item.z)).join(' か ');
  const north = Math.abs(Math.cos(last.bearingDeg * Math.PI / 180)) >= Math.SQRT1_2;
  const along = north ? '南北' : '東西', across = north ? '東西' : '南北';
  return `交点はまだ無い（${why}）。次は ${where}（最後の線の横 ${across} ${places[0]!.from}m）で投げる。`
    + `最後の線は${along}に走る: 線の先へ進んで投げても同じ線になり、交点は出ない`;
}

/** A sunk or a stopped eye: the place itself, with no lines. */
function directLine(direct: DirectPoint, feet: { x: number; z: number } | null): string {
  const spot = place(direct.x, direct.z);
  const there = feet ? `あなたから ${compassWord(bearingBetween(feet, direct))} ${grouped(Math.hypot(direct.x - feet.x, direct.z - feet.z))}m。` : '';
  if (direct.kind === 'down') return `目玉が真下へ沈んだ ${spot}: 要塞はその真下かすぐ近く（地下）。${there}${FRAME_SEARCH}`;
  return `目玉が ${Math.round(direct.from.flew)}m で止まった: 要塞の入口は止まった先 ${spot}（12m 以内だと目玉は入口まで行って止まる。隔離ラボで 6/6）。`
    + `${there}${FRAME_SEARCH}`;
}

/**
 * The chance that the 12 frames open with `eyes` eyes in hand: each frame holds an eye from the start with chance 0.1, so the frames still empty are 12 minus a
 * binomial(12, 0.1) count, and the eyes fill them when `eyes` is at least that many (Java: 0.1 a frame). 11 eyes: 71.8%, 10: 34.1%, 9: 11.1%, 8: 3.3%, 12 or more: 100%.
 */
export function frameOpenChance(eyes: number): number {
  const need = 12 - Math.max(0, Math.floor(eyes));
  if (need <= 0) return 1;
  let below = 0, term = Math.pow(0.9, 12);
  for (let filled = 0; filled < need; filled += 1) {
    below += term;
    term *= (12 - filled) / (filled + 1) * (0.1 / 0.9);
  }
  return Math.max(0, 1 - below);
}

/**
 * Speeds in metres a second. Land: 4 over dry land, 2 where it is rough (S9: the long walks over land and sea). Sea: the run of 2026-11-26, 0:41:17 to 0:47:58,
 * 197 m in 401 s, 0.49 m/s on average and 0.8 to 0.9 in the best 90 s (short single go hands gave 2 to 2.7); the whole 14 minutes of swimming, with the way back and the
 * stops, came to a net 0.18 m/s. Two yardsticks are given on purpose: the best stretches (`SEA_FAST`, `SEA_SLOW`) say what a go that keeps moving does; the net
 * 0.2 m/s of the whole run (the way back, the stops) says what the plan will really get. One run, one sea: not a law.
 * `minecraftFoodPreparation.ts` imports the sea's speeds.
 */
export const WALK_FAST = 4, WALK_SLOW = 2;
export const SEA_FAST = 1, SEA_SLOW = 0.5;
export const SEA_NET = 0.2;
const seconds = (distance: number, speed: number): string => grouped(distance / speed);
/** The time over a distance by how much of it is water (the head decides from the map: the ledger does not know the water). */
export const walkWords = (distance: number): string =>
  `約 ${grouped(distance)} m。地上なら 約 ${seconds(distance, WALK_FAST)}〜${seconds(distance, WALK_SLOW)} 秒（${WALK_SLOW}〜${WALK_FAST} m/s）、`
  + `海の泳ぎなら 約 ${seconds(distance, SEA_FAST)}〜${seconds(distance, SEA_SLOW)} 秒（${SEA_SLOW}〜${SEA_FAST} m/s。実測 0.5 前後、往復や止まりを含む通しは ${SEA_NET} m/s）。水の割合で間を取る`;

/**
 * Two lines that meet at under a degree cross far from where either is wrong: the point slides along them (a fact of the geometry). That the bearing could be trusted and the point stayed within
 * 30 m was seen in one run only, so it is said as a hypothesis, and the third throw the owner allowed stays open while no frames are in sight.
 */
function slideWords(spread: number | null): string {
  if (spread === null || spread >= 1) return '';
  return `線のなす角は ${tenth(spread)}°（1° 未満）: 交点は線に沿って滑りやすい。仮説（1 回の実走の観測）: 線の向きは確かで、点は線に沿って ±30m ほどのずれに収まり、投げ直さずに向きを信じて進めた。`
    + '枠が見えない間は、近づいてからの 3 本目は許されている。';
}

function fixLines(fix: Fix, feet: { x: number; z: number } | null, spread: number | null = null): string[] {
  const ring = Math.round(Math.hypot(fix.x, fix.z));
  const there = feet ? `あなたから ${compassWord(bearingBetween(feet, fix))} ${grouped(Math.hypot(fix.x - feet.x, fix.z - feet.z))}m。` : '';
  const far = fix.errorBlocks > 150 ? '誤差が大きい間は方角の目安。近づいてから投げ直す（0.5° 以上の 2 本なら誤差は ±数十 m。枠が見えない・近づいて線が食い違った時は 3 本目を投げてよい）。' : '';
  const walk = feet ? `交点まで${walkWords(Math.hypot(fix.x - feet.x, fix.z - feet.z))}。` : '';
  const line = `交点 ${place(fix.x, fix.z)}（計算上の見積り ±${fix.errorBlocks}m・${fix.throws} 本が一致）。${there}${walk}${far}${slideWords(spread)}${PROBE_FIRST}。`
    + `原点から ${grouped(ring)}m（最初の 3 つの要塞は 1,280〜2,816m の輪）`;
  // At 128 m of error or less the frames' probe reaches from the point and the hold keeps the eyes (`minecraftEyeThrowHold.ts`): no throw before it is offered.
  const near = feet && fix.errorBlocks > 128 ? nearThrowPlace(feet, fix, Math.max(60, fix.errorBlocks)) : null;
  return near ? [line, `近づいたら、交点の ${Math.max(60, fix.errorBlocks)}m 手前 ${place(near.x, near.z)} から投げ直すと誤差が小さくなる`] : [line];
}

/**
 * Run 7 (11/27): after a trek the lines thrown before it come from places far behind her, and their bearings are worth less than the newer ones. When the throws made near the newest one
 * (within `FAR_OLD_LINE_BLOCKS` of where it was thrown) give a point of their own, the far older lines are left out of it; with fewer, they stay (they still say which way to walk).
 */
export const FAR_OLD_LINE_BLOCKS = 500;
function withoutFarOld(throws: readonly StoredThrow[]): readonly StoredThrow[] {
  const newest = throws[throws.length - 1];
  if (!newest || throws.length < 3) return throws;
  const near = throws.filter(item => Math.hypot(item.x - newest.x, item.z - newest.z) <= FAR_OLD_LINE_BLOCKS);
  return near.length < throws.length && near.length >= 2 && stronghold(near) !== null ? near : throws;
}

/** The throws still worth reading at `now` (all of them when no time is given). */
const alive = (throws: readonly StoredThrow[], now: number | undefined): readonly StoredThrow[] =>
  withoutFarOld(now === undefined ? throws : throws.filter(item => now - item.at <= KEEP_MS));

/**
 * A bearing kept to 0.1 degree (the body's record) is known to 0.05 degree, which does not matter for lines 8 degrees apart but moves the crossing of two lines 0.7 degrees apart by
 * about 14% of its distance (run 7: the point from the unrounded unit vectors was 111 m from the one from the rounded bearings, at 1.8 km). A throw whose unit vector is only its
 * rounded bearing's is marked by that (a real unit does not equal it); the error of a point that rests on two or more of them is not smaller than that rounding's.
 */
const ROUNDING_RAD = 0.07 * Math.PI / 180;
const fromRoundedBearing = (item: StoredThrow): boolean => {
  if (!item.unit || item.down || item.arrived) return false;
  const r = item.bearingDeg * Math.PI / 180;
  return Math.abs(item.unit.x - Math.sin(r)) < 1e-6 && Math.abs(item.unit.z + Math.cos(r)) < 1e-6 && Math.abs(item.bearingDeg * 10 - Math.round(item.bearingDeg * 10)) < 1e-6;
};
export function honestFix(throws: readonly StoredThrow[]): Fix | null {
  const fix = stronghold(throws);
  const rounded = throws.filter(fromRoundedBearing);
  if (!fix || fix.throws < 2 || rounded.length < 2) return fix;
  const spread = spreadDegrees(rounded);
  if (spread === null || spread <= 0) return fix;
  const away = Math.max(...rounded.map(item => Math.hypot(fix.x - item.x, fix.z - item.z)));
  const error = Math.round(away * ROUNDING_RAD / Math.sin(Math.max(spread, 0.1) * Math.PI / 180));
  return error > fix.errorBlocks ? { ...fix, errorBlocks: error } : fix;
}

/**
 * The eyes the body keeps for this world (`world.eyeThrows`, oldest first: where it stood, the flight's compass bearing as `yawDeg` (north 0, east 90, the same as `bearingDeg`), how far it
 * flew, whether it broke, when, and in which dimension) as the ledger's own throws. Only the overworld's count. A record that does not read is left out; the flight's end is worked out
 * from its start, bearing and length (the body does not send it, nor the item's id). The body writes a record only from a flight whose direction it read from the eye's own positions,
 * and its bearing is that direction (`huntEyeFlight.ts`: `bearingDeg` from `unit`), so the unit vector is the bearing's, and a flight shorter than `ARRIVED_BELOW` is the body's `arrived`.
 */
const ARRIVED_BELOW = 11.9;
export function throwsFromBody(raw: unknown): StoredThrow[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredThrow[] = [];
  for (const row of raw) {
    const item = rec(row);
    if (!item || item.dim !== 'overworld' || ![item.x, item.z, item.yawDeg, item.flewM, item.atMs].every(finite) || typeof item.broke !== 'boolean') continue;
    const bearing = ((item.yawDeg as number) % 360 + 360) % 360, flew = Math.max(0, item.flewM as number), r = bearing * Math.PI / 180;
    out.push({ id: `body:${Math.round(item.x as number)}:${Math.round(item.z as number)}:${bearing}`.slice(0, 80), x: item.x as number, z: item.z as number, bearingDeg: bearing, flew,
      broke: item.broke, at: item.atMs as number, toX: (item.x as number) + flew * Math.sin(r), toZ: (item.z as number) - flew * Math.cos(r),
      unit: { x: Math.sin(r), z: -Math.cos(r) }, ...(flew < ARRIVED_BELOW ? { arrived: true } : {}) });
  }
  return out.sort((a, b) => a.at - b.at).slice(-KEEP_THROWS);
}

/** The angle between the two lines that most differ among the throws (degrees, 0 to 90), or null with fewer than two. */
function spreadDegrees(throws: readonly StoredThrow[]): number | null {
  let widest: number | null = null;
  for (let i = 0; i < throws.length; i += 1) for (let j = i + 1; j < throws.length; j += 1) {
    const turn = Math.abs(throws[i]!.bearingDeg - throws[j]!.bearingDeg) % 180;
    const angle = Math.min(turn, 180 - turn);
    if (widest === null || angle > widest) widest = angle;
  }
  return widest;
}

/**
 * One fact line of the ledger for the first plan's input (`firstPlanInput`), from the eyes the body reports: the point the lines give, how sure it is, which way and how far from where she is
 * now, and where to throw again from; or that the lines give none. Empty with no throw in the overworld. A point is a guide, not a place to walk to: the reason is in the line.
 */
export function eyeLedgerFact(rawThrows: unknown, feet: { x: number; z: number } | null, now: number): string[] {
  const throws = alive(throwsFromBody(rawThrows), now);
  if (!throws.length) return [];
  const count = `目玉を ${throws.length} 本投げた（割れた ${throws.filter(item => item.broke).length}）`;
  const direct = directPoint(throws);
  if (direct) return [`${count}。${directLine(direct, feet)}`];
  const fix = honestFix(throws);
  if (!fix) return [`${count}。交点はまだ無い（線が ${throws.length < 2 ? '1 本だけ' : '近すぎるか誤差が大きい'}）。近づいて別の場所から投げ直す`];
  const spread = spreadDegrees(throws);
  const there = feet ? `あなたから ${compassWord(bearingBetween(feet, fix))} ${grouped(Math.hypot(fix.x - feet.x, fix.z - feet.z))}m。` : '';
  const near = feet && fix.errorBlocks > 128 ? nearThrowPlace(feet, fix, Math.max(60, fix.errorBlocks)) : null;
  const again = near ? `投げ直しは交点の ${Math.max(60, fix.errorBlocks)}m 手前 ${place(near.x, near.z)} から。` : '';
  const weak = fix.errorBlocks > 150 || (spread !== null && spread < 2)
    ? `交点は点でなく目安（見積り ±${fix.errorBlocks}m・線のなす角 ${spread === null ? '不明' : tenth(spread)}°。角が小さい線は遠くで少しずれるだけで大きく動く）。近づいて 1〜2 本投げ直す前提で歩く。` : '';
  return [`${count}。交点 ${place(fix.x, fix.z)}（見積り ±${fix.errorBlocks}m・${fix.throws} 本が一致）。${there}${weak}${slideWords(spread)}${again}${PROBE_FIRST}。`.trim()];
}

/** The point the eyes give, as the plan's node shows it (11/27, run 9: the node of the walk to it said nothing of how far it was). */
export interface Crossing { x: number; z: number; errorBlocks: number; meters: number | null }
/**
 * The point the lines give from the eyes the body keeps (`world.eyeThrows`, the same throws, the same `honestFix` and `directPoint` as the ledger's lines and the first plan's fact), and how far it is from
 * her feet. Null: not in the overworld, no throw, or no point.
 */
export function crossingOfWorld(world: Rec | null, now: number): Crossing | null {
  if (!world || String(world.dimension ?? '').replace(/^minecraft:/u, '') !== 'overworld') return null;
  const throws = alive(throwsFromBody(world.eyeThrows), now);
  if (!throws.length) return null;
  const direct = directPoint(throws);
  const fix = direct ? null : honestFix(throws);
  const at = direct ?? fix;
  if (!at) return null;
  const feet = xz(world.position);
  return { x: at.x, z: at.z, errorBlocks: at.errorBlocks, meters: feet ? Math.hypot(at.x - feet.x, at.z - feet.z) : null };
}
/** 「交点まで 1,625m（地上で約 406〜813 秒）」: the distance and the walk's seconds on land (`WALK_FAST`, `WALK_SLOW`), as `walkWords` says them. */
export const crossingWords = (meters: number): string => `交点まで ${grouped(meters)}m（地上で約 ${seconds(meters, WALK_FAST)}〜${seconds(meters, WALK_SLOW)} 秒）`;

/** The ledger of one task. `saved` is what the checkpoint held (`checkpoint()`), read with care: a malformed one is a fresh ledger. */
export function createEyeLedger(saved: unknown) {
  const raw = saved && typeof saved === 'object' ? (saved as { v?: unknown; throws?: unknown }) : null;
  let state: LedgerState = { v: 1, throws: raw?.v === 1 && Array.isArray(raw.throws)
    ? raw.throws.map(storedOf).filter((item): item is StoredThrow => item !== null).slice(-KEEP_THROWS) : [] };
  // The body's eyes are read in at most once per ledger, and never after the ledger was cleared (the room found or the End entered: they would come back as a point to walk to).
  let spent = false;
  return {
    /** An act's result came back: its thrown eye (if it threw one in the overworld) goes in the ledger once. True when it was added. */
    note(id: string | undefined, resultJson: string | undefined, dimension: string | null, now: number): boolean {
      // A frame that is not there (null: a reflex, a respawn) does not forget a flight the body saw; only another dimension does.
      const flight = dimension === 'overworld' || dimension === null ? flightOf(resultJson) : null;
      if (!flight) return false;
      // The key is cut to what is stored, so the same result noted again (a long command id) is found.
      const key = `${id ?? 'none'}:${Math.round(flight.x)}:${Math.round(flight.z)}:${flight.bearingDeg}`.slice(0, 80);
      if (state.throws.some(item => item.id === key)) return false;
      const newest: StoredThrow = { ...flight, id: key, at: now };
      const kept = alive(state.throws, now).filter(item => Math.hypot(item.x - flight.x, item.z - flight.z) <= NEAR_BLOCKS);
      state = { v: 1, throws: [...kept, newest].slice(-KEEP_THROWS) };
      return true;
    },
    /**
     * The task's first read of the eyes the body keeps for this world (`throwsFromBody`): taken in only when this ledger holds no throw (a restart of the same task has its own in the
     * checkpoint, and is not doubled). True when they were taken in.
     */
    seed(rawThrows: unknown, now: number): boolean {
      if (spent || state.throws.length) return false;
      const seeded = alive(throwsFromBody(rawThrows), now);
      if (!seeded.length) return false;
      spent = true;
      state = { v: 1, throws: [...seeded] };
      return true;
    },
    throws: (now?: number): readonly StoredThrow[] => alive(state.throws, now),
    fix: (now?: number): Fix | null => honestFix(alive(state.throws, now)),
    lines: (feet: { x: number; z: number } | null, now: number, known?: { frames: FramesKnown; held: number }): string[] => ledgerLines(alive(state.throws, now), feet, now, known),
    /** The room was found or the End entered: the throws are of no more use. */
    clear(): void {
      spent = true;
      state = { v: 1, throws: [] };
    },
    checkpoint: () => ({ minecraftEyes: { v: state.v, throws: state.throws.map(item => ({ ...item })) } }),
  };
}
export type EyeLedger = ReturnType<typeof createEyeLedger>;
