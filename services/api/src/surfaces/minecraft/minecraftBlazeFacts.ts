import { readActResult } from '../../contracts/minecraftActContract.js';
import { progressEvents } from './minecraftProgressEvents.js';
import { carried } from './minecraftConditions.js';
import { marksOf, namesOf } from './minecraftSeenMarks.js';
import { BLOCKS } from './minecraftLlmcPrepRules.js';

/**
 * The blaze camp said as causes and numbers (the arrival scenes of 11/3: with six blazes left every decision of the model stayed in cover and
 * fought on; a clean-up it was never told the reason for was chosen 0 of 4 times). A spawner holds back while six of its kind are around
 * it, so waiting there adds no kill; the lab saw the survivors gone, and the spawn back, after 150 s farther than 32 blocks away (0 to 3
 * left). The head keeps two things for the line: when the blazes came near, and the kills since (the body's `target_killed` and the rush's
 * confirmed death). Numbers and the cause only; the one hand it names is the sword, while a bow and arrows are carried (they are kept for the End).
 */
export const SPAWN_HELD_AT = 6;
const LONG_WATCH_MS = 5 * 60_000;
const SHOW_AFTER_MS = 2 * 60_000;
const QUIET_MS = 3 * 60_000;
const NEAR_BLOCKS = 32;
const KEEP_KILLS = 40;
const RODS = 7;
/** end1108h20 S7 (11/8): cut by hpBelow at 11.3 with two blazes 3 and 5 m off that saw her, the head ate and struck back where she stood,
 * health went 11.3 → 5.8 in 8 s, she burned on and died 48 s later. A blaze's volley is three fireballs of 5 and a burn of 1 a second:
 * from 14 a walk of 20 steps to a footing no blaze sees still arrives with health left; eating where she is seen mends nothing. */
export const RETREAT_HP = 14;
const BACK_HP = 18;
/** end1108h16 S7 (11/8): two chases (attack #id) killed in 0.7 and 2.7 s with no health lost, about 25 holds killed 1, and 32 arrows killed 6 (h15).
 * The owner (11/8): arrows are kept for the dragon, blazes are killed by sword. Said while a bow and arrows are carried, so that they are not spent here. */
/* end1108h21 (11/8): 13 kills by sword, 3 rods: kills on a 1-wide bridge over a 40-block drop sent the rods down; 9 minutes of attacks on
 * blazes hovering 4-8 m up came back 届かない. end1108h23 (11/8): told that a blaze that does not see her flies to her, she held attack
 * behind the room's bricks 51 times for 8 s (10 minutes) and swung 0 times: a blaze behind a wall stays there (it loses her within a
 * second of losing sight, and its straight flight stops at the wall). The kills of h22 (14 in 195 s) were all chases of one seen and reachable. */
const SWORD_FACT = 'ブレイズは剣で倒す: 体力 14 以上の時に、見えている 8m 内の 1 体へ attack target=#id（実測 end1108h16: 追って斬った 2 回は 3 秒以内に倒し傷 0、動かず待つ hold は約 25 回で 1 体）'
  + '。ロッドは倒れた所に落ちる: 幅 1 の橋や足場の外で倒すと下へ落ちて失う（end1108h21: 13 体で 3 本）。湧き場の部屋の床の上で斬り、落ちた棒は pickup target=blaze_rod'
  + '。pickup が「掘らない道が無い」「そこまで着けない」と返した棒は、同じ pickup を出し直さず、1 つの act で go to=棒のマス canDig=[nether_bricks,netherrack] maxDig 6 → pickup target=blaze_rod'
  + '（end1108h27: 同じ pickup 3 回・3 分の間に棒が消えた）'
  + '。上に浮いて、または壁の向こうで attack が「届かない」と返った相手へ、同じ id の attack を出し直さない（h27: 届かない 7 回）。壁の陰で attack hold して寄るのを待つのは効かない: 壁の向こうのブレイズは壁で止まって来ない'
  + '（end1108h23: 煉瓦の陰で hold 8 秒を 51 回・10 分、振れたのは 0 回。h22 の 14 体は全部、見えている届く 1 体を追った attack）'
  + '。attack は体が 2m まで追って斬る: 見えている 8m 内の 1 体は、3m まで来るのを待たずにすぐ attack target=#id（end1109f03: 湧き場から 12〜14m で「3m まで来たら斬る」と wait を 10 分続け、撃破 0。ブレイズは上下に動き、多くは剣の高さへ下りてくる）'
  + '。見えている 8m 内の 1 体がいない時は、体力 18 以上なら野営マス（mc_probe kind=camp の行の、湧き場から 3m 以内で壁のある足場）へ go で入り、そこで見えた 1 体を待たずに斬り続ける（S7 を通った end1108h23・h25 は湧き場から 1〜3m で 11・14 体を斬った。h13 は同じ所で 10 秒待って死んだ＝危ないのは近さではなく待つこと。f07 は 5〜7m の床の縁へ出て数体に撃たれ死んだ）。ただし 8m 内に壁の向こうも含めて 3 体以上いる時は入らない（end1109f16・f17: 3〜6 体の脇へ入り 20 秒で死亡）: 今の陰から壁の 1 マスだけを開けて 1 体ずつ';

/** `camped`: blazes were near on this Nether visit. end1108h15 S7 (11/8): at 0 arrows she held attack 7 minutes about 20 m off the spawner;
 * three quiet minutes ended the watch, and with it the line that farther than 16 m nothing spawns. The spawner's lines stay until she leaves. */
interface WatchState { v: 1; since: number | null; lastNear: number; kills: Array<{ key: string; at: number }>; camped?: boolean; unreached?: number[];
  /** The block the last 届かない attack named between her and the blaze (the body says 「間に nether_brick_fence (137,78,72)：掘るか回り込めば近づける」). */
  wall?: Wall | null }
/** A block between her and a blaze, by its name and place. */
export interface Wall { name: string; x: number; y: number; z: number }
const KEEP_UNREACHED = 8;
/** A remembered wall is said while she stands within this many metres of it. */
const WALL_NEAR = 6;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A spawner spawns only while a player is within 16 blocks of it. end1108h12 (11/8): the walks out of the fireballs' line went east 5 m at a
 * time, from 2 m to 24 m off the spawner, and the head waited there 3 minutes at full health for blazes that could not come (0 kills after). */
const SPAWN_RANGE = 16;
const WARN_FROM = 12;
/** A spawner puts its mobs within 4 blocks across and 1 up or down of itself. end1108h13 (11/8): she waited at 2 m from the spawner, blazes
 * came at 0.5 m, health went 18.9 → 9.4 in the 10 s of the wait, and she died 16 s later. */
const SPAWN_BOX_ACROSS = 4.5;
const SPAWN_BOX_UPDOWN = 2;
/** The spawner counts its kind in the box 4 blocks around its own block, every way (a blaze 10 m off does not hold it). end1108h23 (11/8):
 * with blazes counted to 32 m the line said the spawner was held, and the plan went 32 m off to wait 150 s. */
const HELD_BOX = 4;
const BLAZE_HEIGHT = 1.8, BLAZE_HALF = 0.3;

/** The blazes the nearest marked blaze spawner counts (in the box 4 around its block); null with no blaze spawner marked or no position known. */
export function blazesInSpawnerBox(world: Record<string, unknown>): number | null {
  const at = world.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  if (!at || !finite(at.x) || !finite(at.y) || !finite(at.z)) return null;
  const { x, y, z } = at as { x: number; y: number; z: number };
  const mark = marksOf(world.mapLandmarks).filter(item => namesOf(item).includes('blaze_spawner'))
    .sort((a, b) => Math.hypot(a.x - x, a.y - y, a.z - z) - Math.hypot(b.x - x, b.y - y, b.z - z))[0];
  if (!mark) return null;
  const list = Array.isArray(world.nearbyThreats) ? world.nearbyThreats : [];
  let count = 0;
  for (const item of list) {
    const entry = item && typeof item === 'object' ? item as { name?: unknown; position?: { x?: unknown; y?: unknown; z?: unknown } } : null;
    const p = entry?.position;
    if (entry?.name !== 'blaze' || !p || !finite(p.x) || !finite(p.y) || !finite(p.z)) continue;
    const inX = p.x + BLAZE_HALF > mark.x - HELD_BOX && p.x - BLAZE_HALF < mark.x + 1 + HELD_BOX;
    const inZ = p.z + BLAZE_HALF > mark.z - HELD_BOX && p.z - BLAZE_HALF < mark.z + 1 + HELD_BOX;
    const inY = p.y + BLAZE_HEIGHT > mark.y - HELD_BOX && p.y < mark.y + 1 + HELD_BOX;
    if (inX && inY && inZ) count += 1;
  }
  return count;
}

/** How far the nearest blaze spawner the body marked is: inside its spawn box, or from `WARN_FROM` m on (null between, or with no blaze
 * spawner marked). `alarm` is the two that are said even with no blaze near (inside the box, or farther than the spawn range). */
export function spawnerReach(world: Record<string, unknown>): { line: string; alarm: boolean } | null {
  const at = world.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  if (!at || !finite(at.x) || !finite(at.y) || !finite(at.z)) return null;
  const { x, y, z } = at as { x: number; y: number; z: number };
  const nearest = marksOf(world.mapLandmarks).filter(mark => namesOf(mark).includes('blaze_spawner'))
    .map(mark => ({ mark, distance: Math.hypot(mark.x + 0.5 - x, mark.y + 0.5 - y, mark.z + 0.5 - z) }))
    .sort((a, b) => a.distance - b.distance)[0];
  if (!nearest) return null;
  const meters = Math.round(nearest.distance), place = `(${nearest.mark.x},${nearest.mark.y},${nearest.mark.z})`;
  const { mark } = nearest;
  const inBox = Math.abs(mark.x + 0.5 - x) <= SPAWN_BOX_ACROSS && Math.abs(mark.z + 0.5 - z) <= SPAWN_BOX_ACROSS && Math.abs(mark.y - y) <= SPAWN_BOX_UPDOWN;
  if (inBox) {
    return { alarm: true, line: `ブレイズのスポナー ${place} まで ${meters}m: 湧く範囲（横 4 マス・上下 1）の中なので、体のすぐ隣に湧く`
      + `（end1108h13: ここで 10 秒待って体力 18.9→9.4、16 秒後に死亡）。ここで hold・wait で待たない: 見えている 1 体へ attack target=#id を続ける（S7 を通った回はこの近さで 11〜17 体を斬った）。体力 12 以下で退く` };
  }
  if (nearest.distance < WARN_FROM) return null;
  return nearest.distance > SPAWN_RANGE
    ? { alarm: true, line: `ブレイズのスポナー ${place} まで ${meters}m: ${SPAWN_RANGE}m より遠いと新しく湧かない（ここで待っても撃破は増えない。湧き場から 3m 以内の野営マスへ戻る）` }
    : { alarm: false, line: `ブレイズのスポナー ${place} まで ${meters}m（${SPAWN_RANGE}m を超えると新しく湧かない）` };
}

/** The blazes in the frame's threat list within reach of the camp (the body lists what is near; the count box is a few blocks around the spawner). */
export function blazesNear(world: Record<string, unknown>): number {
  const list = Array.isArray(world.nearbyThreats) ? world.nearbyThreats : [];
  return list.filter(item => {
    const entry = item && typeof item === 'object' ? item as { name?: unknown; distance?: unknown } : null;
    return entry?.name === 'blaze' && (!finite(entry.distance) || entry.distance <= NEAR_BLOCKS);
  }).length;
}

function storedOf(saved: unknown): WatchState {
  const raw = saved && typeof saved === 'object' ? saved as Partial<WatchState> : null;
  const kills = raw?.v === 1 && Array.isArray(raw.kills)
    ? raw.kills.filter(item => item && typeof item.key === 'string' && finite(item.at)).slice(-KEEP_KILLS) : [];
  return { v: 1, since: raw?.v === 1 && finite(raw.since) ? raw.since : null, lastNear: raw?.v === 1 && finite(raw.lastNear) ? raw.lastNear : 0, kills,
    camped: raw?.v === 1 && (raw.camped === true || finite(raw.since)),
    unreached: raw?.v === 1 && Array.isArray(raw.unreached) ? raw.unreached.filter(finite).slice(-KEEP_UNREACHED) : [],
    wall: raw?.v === 1 && raw.wall && typeof raw.wall.name === 'string' && finite(raw.wall.x) && finite(raw.wall.y) && finite(raw.wall.z) ? { ...raw.wall } : null };
}
/** The block the last 届かない attack named between (end1109f07: a nether_brick_fence row between her and the spawner room; she was told to wait for one to come within 8 m and backed off for minutes). */
function wallOf(lines: ReadonlyArray<{ do?: unknown; status?: unknown; line?: unknown }>): Wall | null {
  for (const line of [...lines].reverse()) {
    if (line.do !== 'attack' || line.status === 'done' || typeof line.line !== 'string') continue;
    const match = /間に ([a-z_]+) \((-?\d+),(-?\d+),(-?\d+)\)/u.exec(line.line);
    if (match) return { name: match[1]!, x: Number(match[2]), y: Number(match[3]), z: Number(match[4]) };
  }
  return null;
}
/** The blaze ids an attack came back 届かない on (the body says 「blaze（id 993） に届かない」; review of 11/9 07:40: strikeLine named such an id again, against SWORD_FACT; about 5 s each). */
function unreachedIds(lines: ReadonlyArray<{ do?: unknown; status?: unknown; line?: unknown }>): number[] {
  return lines.flatMap(line => line.do === 'attack' && line.status !== 'done' && typeof line.line === 'string' && line.line.includes('届かない')
    ? [...line.line.matchAll(/(?:#|id )(\d+)/gu)].map(match => Number(match[1])).filter(Number.isFinite) : []);
}

export function createBlazeWatch(saved: unknown) {
  let state = storedOf(saved);
  return {
    /** An act's result came back: its confirmed kills are counted once each (the receipt's id and the lines' order name them). */
    note(id: string | undefined, resultJson: string | undefined, now: number): void {
      const result = readActResult(resultJson);
      if (!result || state.since === null) return;
      const missed = unreachedIds(result.lines as never);
      if (missed.length) state.unreached = [...(state.unreached ?? []).filter(id => !missed.includes(id)), ...missed].slice(-KEEP_UNREACHED);
      const wall = wallOf(result.lines as never);
      if (wall) state.wall = wall;
      const killed = progressEvents([], result.lines).filter(event => event === 'kill').length;
      if (killed > 0) state.wall = null;
      for (let index = 0; index < killed; index += 1) {
        const key = `${id ?? 'none'}:${index}`.slice(0, 80);
        if (!state.kills.some(item => item.key === key)) state.kills = [...state.kills, { key, at: now }].slice(-KEEP_KILLS);
      }
    },
    /** The frame of a decision: the watch starts when blazes are near in the Nether and ends when none were for a while or she left. */
    line(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null, now: number): string | null {
      const near = dimension === 'the_nether' ? blazesNear(world) : 0;
      if (near > 0) {
        if (state.since === null) state = { ...state, since: now, kills: [] };
        state.lastNear = now;
        state.camped = true;
      } else if (dimension !== 'the_nether') {
        if (state.since !== null || state.camped) state = { v: 1, since: null, lastNear: 0, kills: [], camped: false, wall: null };
      } else if (state.since !== null && now - state.lastNear > QUIET_MS) {
        state = { v: 1, since: null, lastNear: 0, kills: [], camped: true };
      }
      const rods = carried(counts, 'blaze_rod');
      const reach = state.camped && dimension === 'the_nether' && rods < RODS ? spawnerReach(world) : null;
      if (state.since === null || near === 0) return reach?.alarm ? reach.line : null;
      const arrows = carried(counts, 'bow') > 0 ? carried(counts, 'arrow') : 0;
      const said = watchLine(near, now - state.since, state.kills.length, rods, arrows, blazesInSpawnerBox(world));
      const joined = reach ? (said ? `${said}。${reach.line}` : reach.line) : said;
      const retreat = rods < RODS ? retreatLine(world.health, near) : null;
      const closing = rods < RODS && !retreat ? strikeLine(world, new Set(state.unreached ?? []), state.wall ?? null) : null;
      const told = closing ? (joined ? `${closing}。${joined}` : closing) : joined;
      return retreat ? (told ? `${retreat}。${told}` : retreat) : told;
    },
    checkpoint: () => ({ minecraftBlazeWatch: { v: state.v, since: state.since, lastNear: state.lastNear, kills: state.kills.map(item => ({ ...item })),
      camped: state.camped === true, unreached: [...(state.unreached ?? [])], wall: state.wall ? { ...state.wall } : null } }),
  };
}
export type BlazeWatch = ReturnType<typeof createBlazeWatch>;

/** Below `RETREAT_HP` with blazes near: the way out comes before a meal or a blow (pure; null above it or with no health known). */
export function retreatLine(health: unknown, near: number): string | null {
  if (!finite(health) || health <= 0 || health >= RETREAT_HP || near <= 0) return null;
  return `体力 ${Math.round(health * 10) / 10}（${RETREAT_HP} 未満）でブレイズ ${near} 体の近く: 今いる所で食べる・斬り返すと撃たれ続けて燃える`
    + `（end1108h20: 体力 11.3 で 2 体から見えたまま食べて斬り返し、8 秒で 5.8、48 秒後に死亡）。先に湧き場から見えない隠れ場所へ go で退く`
    + `（場所は手が止まった行の「隠れ場所」か probe kind=camp）。この act は hands が go 1 つだけで、act の accept に blaze を入れる`
    + `（ブレイズは「go の accept に近接敵を入れない」の近接敵ではない。accept が無いと燃えて見えている間の覆いの反射が go を 0m で止め、eat を前に置くとその間撃たれる:`
    + ` end1109f23 は accept の無い退く go が 0m で止まり、食べてから退くを繰り返して 44 秒で体力 11.9→0）。着いてから食べ、体力 ${BACK_HP} 以上で野営マスへ戻る`;
}

/** A blaze within this many metres that she sees is one the attack reaches by chasing (end1108h16, h22). */
const STRIKE_BLOCKS = 8;
const LOW_DY = 3;
/** Seen blazes within this many metres from which three or more make an open floor deadly. */
const CROWD_METERS = 16;
const CROWD = 3;
/** Seen blazes nearer than this, with others behind the walls, are the crowd of end1109f16・f17 (1.6 m); farther is a place to strike from. */
const CLOSE_BLOCKS = 3;
/**
 * The distance said as numbers each decision (pure; null with no seen blaze or no position). end1109f03 replay (11/9, Haiku 8 of each): told the
 * rule 「8m 内の見える 1 体がいなければ湧き場から 5〜7m の床へ出る」 (11/9 later: the camp cell within 3 m instead), she read 「#1593 は 14.5m で届かない → 待つ」 and attacked 1 of 8;
 * the rule was not applied to the numbers in front of her. So the head applies it: the nearest seen blaze, how many are within 8 m, and the one move.
 */
export function strikeLine(world: Record<string, unknown>, unreached: ReadonlySet<number> = new Set(), wall: Wall | null = null): string | null {
  const list = Array.isArray(world.nearbyThreats) ? world.nearbyThreats : [];
  const seen = list.map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((entry): entry is Record<string, unknown> => !!entry && entry.name === 'blaze' && finite(entry.distance)
      && (entry.lineOfSight === true || entry.reach === 'in_sight' || (entry.lineOfSight === undefined && entry.canSee === true)))
    .sort((a, b) => (a.distance as number) - (b.distance as number));
  const tag = (entry: Record<string, unknown>) => finite(entry.id) ? `#${entry.id}` : 'blaze';
  const missed = seen.filter(entry => finite(entry.id) && unreached.has(entry.id));
  const usable = seen.filter(entry => !missed.includes(entry));
  const first = usable[0];
  // end1109f06: ten blazes behind basalt 6 m under the spawner room, none in sight, and no line at all: she waited behind the walls for minutes.
  const hidden = list.filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).name === 'blaze'
    && ((item as Record<string, unknown>).lineOfSight === false || (item as Record<string, unknown>).canSee === false)).length;
  if (!first && missed.length === 0 && hidden <= 0) return null;
  const meters = (entry: Record<string, unknown>) => Math.round((entry.distance as number) * 10) / 10;
  const near = usable.filter(entry => (entry.distance as number) <= STRIKE_BLOCKS);
  // end1108h21: blazes hovering 4-8 m up came back 届かない for 9 minutes; one at sword height is the one to chase.
  const low = near.filter(entry => !finite(entry.dy) || Math.abs(entry.dy) <= LOW_DY);
  // end1109f16: she dug into the spawner room; the line said 「剣の高さに 3 体 → 今 attack」 and 5-6 blazes at 1-4 m took her from 20 to 0 in 20 s.
  // end1109f17: six round the spawner, four behind the bricks within 5 m and none in sight; she walked into the camp cell beside them, three
  // came to 1-3 m, and the health stopIf ended the attack at 11.9 with nothing behind it: three seconds standing still to the next decision, dead.
  const hiddenNear = list.filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).name === 'blaze'
    && ((item as Record<string, unknown>).lineOfSight === false || (item as Record<string, unknown>).canSee === false)
    && finite((item as Record<string, unknown>).distance) && ((item as Record<string, unknown>).distance as number) <= STRIKE_BLOCKS).length;
  const retreat = '。attack の act の後ろに、今の陰へ戻る go を dependsOn: [] で足す（体力の stopIf で attack が止まった時に体がすぐ下がる。'
    + 'end1109f17: 体力 11.9 で attack が止まり、次の判断までの 3 秒を 1〜2m の 2 体の前に立ったまま 0 に）';
  const at = world.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  const feet = at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: at.x, y: at.y, z: at.z } : null;
  const fence = wall && feet && Math.hypot(wall.x + 0.5 - feet.x, wall.y + 0.5 - feet.y, wall.z + 0.5 - feet.z) <= WALL_NEAR ? wall : null;
  if (near.length > 0 && near.length + hiddenNear >= CROWD) {
    const count = hiddenNear > 0 ? `ブレイズが ${near.length + hiddenNear} 体（見える ${near.length}・壁の向こう ${hiddenNear}）` : `見える射手が ${near.length} 体`;
    // end1109f25: one seen at 5.9 m and four behind the netherrack; told 「ここで斬り合わない…見えるのが 1〜2 体の所で斬る」 from such a place,
    // she read it as 「陰で待つ」 and waited 4 s at a time about 60 times (5 minutes, 0 kills, the run stopped at its yen cap with 3 rods).
    if (near.length <= 2 && hiddenNear > 0 && (near[0]!.distance as number) > CLOSE_BLOCKS) {
      const target = low[0] ?? near[0]!;
      const cell = fence ? `${fence.x},${fence.y},${fence.z}` : '';
      const hands = fence ? `hands: ["dig ${cell} collect=false", "attack target=${tag(target)}"]（attack が「間に ${fence.name} (${cell})」と返したマス）` : `attack target=${tag(target)}`;
      return `ブレイズとの距離: 8m 内に${count}（最寄りの見える ${tag(near[0]!)} は ${meters(near[0]!)}m）→ 見えるのは ${near.length} 体で ${CLOSE_BLOCKS}m より遠い: `
        + `今の陰が「見えるのが 1〜2 体の所」。陰から部屋へ出ず、ここから ${hands}、accept に blaze`
        + `（end1109f25: この形で陰の wait 4 を 約 60 回・5 分続け、撃破 0。壁の向こうの ${hiddenNear} 体は壁で撃てない）。2 体以上が 3m 内に来たら下がる${retreat}`;
    }
    return `ブレイズとの距離: 8m 内に${count}（最寄りの見える ${tag(near[0]!)} は ${meters(near[0]!)}m）→ ここで斬り合わない（end1109f16・f17: 湧き場の脇へ入り、1〜4m の 3〜6 体に 20 秒で体力 20→0）。`
      + `来た穴か岩の陰へ go で下がり（accept に blaze）、見える線を netherrack で塞ぐか壁の 1 マスだけを開け、見えるのが 1〜2 体の所で寄って来た 1 体を attack target=#id で斬る${retreat}`;
  }
  if (low.length > 0) {
    return `ブレイズとの距離: 見えている ${tag(low[0]!)} は ${meters(low[0]!)}m（8m 内の剣の高さに ${low.length} 体）→ 今 attack target=${tag(low[0]!)}（体が 2m まで追って斬る。3m まで来るのを待たない）`;
  }
  // end1109f07: at health 20 she stepped onto the spawner room's edge in sight of 3-4 blazes 4 m up at 7.5-8 m, burned, and died in 24 s.
  const shooters = seen.filter(entry => (entry.distance as number) <= CROWD_METERS).length;
  const crowd = shooters >= CROWD ? `。見えている射手が ${shooters} 体: 覆いの無い床へ出ない（end1109f07: 体力 20 で 3〜4 体の前へ出て 24 秒で死亡）。`
    + `今の陰から、見える線を netherrack で塞ぐか壁の 1 マスだけを開け、見えるのが 1〜2 体の所から 1 体ずつ斬る` : '';
  if (near.length > 0) {
    const dy = near[0]!.dy as number;
    return `ブレイズとの距離: 8m 内の見える ${near.length} 体は高さが ${LOW_DY}m より離れている（${tag(near[0]!)} は${dy < 0 ? '下' : '上'} ${Math.round(Math.abs(dy))}m）→ 届かないので attack を出さず`
      + (crowd || '、湧き場の部屋の床で剣の高さに来た 1 体を斬る');
  }
  if (fence && !(finite(world.health) && world.health < BACK_HP)) {
    const target = first ?? missed[0];
    const cell = `${fence.x},${fence.y},${fence.z}`;
    // end1109f09: the dig hand came back 「届かない（目から5.4m、5m まで）」: dig does not walk, so a cell beyond reach gets a go first.
    const eyes = Math.hypot(fence.x + 0.5 - feet!.x, fence.y + 0.5 - (feet!.y + 1.62), fence.z + 0.5 - feet!.z);
    const walk = eyes > 4.5 ? `"go ${cell} range=3", ` : '';
    return `ブレイズとの距離: 剣の届く 1 体がいない。attack が「間に ${fence.name} (${cell})：掘るか回り込めば近づける」と返した: 柵・壁の向こうのブレイズは待っても寄って来ない`
      + `（end1109f07: 柵の手前で「8m 内に来たら斬る」と下がり続け、4 分で撃破 0）→ 1 つの act で hands: [${walk}"dig ${cell} collect=false", "attack target=${target ? tag(target) : '#id（見えた 1 体）'}"]、`
      + `accept に blaze（入れないとブレイズに身をさらすマスを体が掘らない）。この 1 マスは「壁の向こうは attack の相手にしない」の例外: 掘れば届く${walk ? `（このマスは目から ${Math.round(eyes * 10) / 10}m: dig は歩かず 5m までしか届かないので、先の go で寄る）` : ''}`;
  }
  const skipped = missed.length ? `（${missed.slice(0, 3).map(tag).join('・')} は attack が「届かない」と返した相手: 同じ id を出し直さない）` : '';
  const head = first
    ? `ブレイズとの距離: 一番近い見える ${tag(first)} は ${meters(first)}m、8m 内は 0 体${skipped} → 待っても寄って来ない（ブレイズは見える所から撃つだけ）`
    : `ブレイズとの距離: 届く見える 1 体がいない${skipped}${hidden > 0 ? `（壁の向こうに ${hidden} 体: 壁の陰で待っても見えないし寄って来ない）` : ''}`;
  const health = world.health;
  if (finite(health) && health < BACK_HP) return `${head}。体力 ${Math.round(health * 10) / 10} は ${BACK_HP} 未満なので、見えない所で食べて ${BACK_HP} 以上にしてから湧き場へ寄る`;
  const mark = at && finite(at.x) && finite(at.y) && finite(at.z)
    ? marksOf(world.mapLandmarks).filter(item => namesOf(item).includes('blaze_spawner'))
      .map(item => ({ item, distance: Math.hypot(item.x + 0.5 - (at.x as number), item.y + 0.5 - (at.y as number), item.z + 0.5 - (at.z as number)) }))
      .sort((a, b) => a.distance - b.distance)[0] : undefined;
  if (crowd) return `${head}${crowd}`;
  if (!first && missed.length === 0 && hiddenNear >= CROWD) {
    return `${head}。8m 内の ${hiddenNear} 体はどれも壁の向こう → 野営マスへ入らず、壁を広く掘らない（end1109f17: 湧き場の周りの 6 体の脇の野営マスへ入り、1〜3m の 3 体に体力 20→0）。`
      + `今の陰に立ったまま、湧き場の向きの壁を 1 マスだけ dig（collect=false、accept に blaze）し、同じ act でその穴から見えた 1 体へ attack。2 体以上が見えたら穴を cobblestone で塞ぐ${retreat}`;
  }
  if (!mark) return first ? `${head}。見えた 1 体へ 8m まで go で寄り、attack target=${tag(first)}` : `${head}。湧き場はまだ見つかっていない（mapLandmarks に blaze_spawner が無い）: ここは湧き場ではない。mc_probe kind=camp で湧き場を探し、無ければネザーレンガの続く向きへ 100m 進んで読み直す（要塞の端でうろついても湧かない）`;
  const place = `${mark.item.x},${mark.item.y},${mark.item.z}`;
  if (mark.distance <= 7.5 && !first && missed.length === 0) {
    return `${head}。湧き場から ${Math.round(mark.distance)}m だが壁の陰: 野営マス（mc_probe kind=camp の行の、湧き場から 3m 以内で壁のある足場）へ go ${place} range=3 で入る（間の壁は dig で掘る。act の accept に blaze を入れる）。着いたら見えた 1 体を待たずに attack`;
  }
  if (mark.distance <= 7.5) {
    return `${head}。もう湧き場から ${Math.round(mark.distance)}m の所にいる: 新しいのは湧き場の周り 4 マスに湧くので、見えた 1 体が 8m 内に入ったらすぐ attack`;
  }
  return `${head}。湧き場まで ${Math.round(mark.distance)}m: go ${place} range=3 で湧き場から 3m 以内の野営マスへ入り（壁のある足場が安全。待つと燃やされるので着いたら斬り続ける。間の壁は dig で掘る。act の accept に blaze を入れる: 入れないとブレイズに身をさらす壁を体が掘らない）、着いたら見えた 1 体へ attack target=#id`;
}

/** The line from the numbers (pure). */
export function watchLine(near: number, elapsedMs: number, kills: number, rods: number, arrows = 0, boxed: number | null = null): string | null {
  if (rods >= RODS) return null;
  const counted = countedLine(near, elapsedMs, kills, rods, boxed);
  if (arrows <= 0) return counted;
  const sword = `${SWORD_FACT}。矢 ${arrows} 本はエンド用に残す（クリスタルとドラゴンに 30 本）`;
  return counted ? `${counted}。${sword}` : sword;
}

function countedLine(near: number, elapsedMs: number, kills: number, rods: number, boxed: number | null = null): string | null {
  const minutes = Math.floor(elapsedMs / 60_000), seconds = Math.floor(elapsedMs / 1000) % 60;
  const spent = elapsedMs >= SHOW_AFTER_MS ? `湧き場の近くで ${minutes} 分 ${seconds} 秒: 撃破 ${kills} 体・棒 ${rods}/${RODS}。` : '';
  if (boxed !== null) {
    // The spawner known: only the ones in its box hold it, and they are within 5 m of it, where the sword reaches them.
    if (boxed >= SPAWN_HELD_AT) {
      return `${spent}湧き場の周り 4 マスにブレイズ ${boxed} 体: スポナーは止まっている（周り 4 マスに ${SPAWN_HELD_AT} 体いると新しく湧かない）。`
        + 'この中の見えている 1 体ずつを attack target=#id で斬ると（体が追って斬る）、5 体以下で湧きが戻る';
    }
    if (kills === 0 && elapsedMs >= LONG_WATCH_MS) return `${spent}いま周りに ${near} 体・湧き場の周り 4 マスに ${boxed} 体（4 マスの中に ${SPAWN_HELD_AT} 体いると新しく湧かない）。`
      + '待っていても 3m までは来ない: 見えている 8m 内の 1 体へ今 attack target=#id（体が追って斬る）';
    return spent ? spent.slice(0, -1) : null;
  }
  if (near >= SPAWN_HELD_AT) {
    return `${spent}ブレイズ ${near} 体が残っている: スポナーは止まっている（周りに ${SPAWN_HELD_AT} 体いると新しく湧かない）。ここで待っても撃破は増えない。`
      + '32 マスより遠くで 150 秒待つと生き残りが消え、湧きが戻る（ラボ実測: 戻った時 0〜3 体）';
  }
  if (kills === 0 && elapsedMs >= LONG_WATCH_MS) return `${spent}いま周りに ${near} 体（${SPAWN_HELD_AT} 体いると新しく湧かない）`;
  return spent ? spent.slice(0, -1) : null;
}

/**
 * end1109f05 (11/9, Haiku, c1): the 128 cobblestone and 76 netherrack she was given were all laid by the body's bridges and stairs in the first
 * eight decisions; she went on toward the raised spawner with 0 blocks (her go's canPlace listed netherrack and nether_bricks she no longer had),
 * the bridge stopped at its tip, she broke the floor behind her for blocks, and waited 15 decisions (about 15 minutes) on a 1-wide footing over a
 * 37-block drop, never mining the netherrack that is everywhere. The count and the one move, while it is low in the Nether before the rods.
 * end1109f14 (11/9, Haiku, random world): the walk to the fortress laid 130 of her 144 blocks and the line (then below 24) first spoke inside the
 * fortress, on a 1-wide bridge over a 22-deep lava drop where no netherrack was; one mine walked her past wither skeletons (health 18 to 6.4), and she
 * spent the next 18 minutes 40 m short of the spawner digging bricks three at a time and laying them again, with 0 rods at the 25-minute line.
 * So it speaks below 48, while she is still on the netherrack land, and aims at 64.
 */
export const FOOTING_LOW = 48;
const FOOTING_AIM = 64;
export function footingLine(counts: ReadonlyMap<string, number>, dimension: string | null): string | null {
  if (dimension !== 'the_nether' || carried(counts, 'blaze_rod') >= RODS) return null;
  let total = 0;
  for (const [name, count] of counts) if (BLOCKS.test(name.replace(/^minecraft:/u, '')) && Number.isFinite(count)) total += count;
  if (total >= FOOTING_LOW) return null;
  const head = `積める物 ${total} 個（丸石・ネザーラック・ネザーレンガなど）: go の橋・階段・覆いは 1 マスに 1 個使い、切れると橋の先端で止まる`
    + `（end1109f05: 最初の 8 分で約 200 個を使い切り、0 個のまま湧き場へ go して幅 1 の足場の先に 15 分立ち往生。`
    + `end1109f14: 13 個で要塞へ入り、湧き場の 40m 手前の橋でレンガを 1 判断 3 個ずつ掘っては置き 18 分、ロッド 0）`;
  const move = `→ 次の手: 進む前に mine netherrack <見えているネザーラックのマス> count=${FOOTING_AIM}（つながったものを体がたどって掘り拾う）で ${FOOTING_AIM} 個にする。`
    + `要塞の中・橋の上にはネザーラックが無いので、要塞へ入る前のネザーラックの陸で足す`;
  const stuck = total === 0 ? '。0 個で足場の先から動けない時は、立っていない横の固いブロック（要塞のレンガなど）を dig → pickup して置く物にする（wait では増えない）' : '';
  return `${head}${move}${stuck}`;
}
