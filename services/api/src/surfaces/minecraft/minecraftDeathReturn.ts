import type { DoneFacts } from './minecraftConditions.js';
import { acquired } from './minecraftConditions.js';
import { WALK_METRES_PER_SECOND } from './minecraftDropsAdvice.js';
import { bearingBetween, compassWord } from './minecraftEyeTriangulation.js';
import { PEARL_TARGET, RODS_FOR_EYES, SECONDS_PER_PEARL, SECONDS_PER_ROD, WALK_BLOCKS_PER_SECOND as NETHER_WALK_BLOCKS_PER_SECOND } from './minecraftPearlFacts.js';

/**
 * The way back to the drops of a death in another dimension, as one block for the decision (11/15c: c1 burned at the blaze spawner at 417 s and
 * w1109r at 649 s, both woke in the overworld, and neither went back nor gathered the rods again: c1's d0094, an urgent decision, said 「the portal
 * location unknown」 (the 控え line of the remembered gate is not in the urgent version), d0137 took the drops for gone after 5 minutes, and r's
 * d0361 knew they wait but not where its gate was, 1,056 m off). The body ages a death's drops only while their chunk is loaded (it counts the
 * time she is within 160 m of them in that dimension), so the block says that as a condition, not that they stay.
 *
 * While the newest death is in another dimension than hers, the body still says its drops can be picked up (`world.lastDeath` 「…→拾いに戻れる」),
 * it was not in lava or the void (what falls there is gone), and she has not given it up (`givenUp`, the act whose why says 「落とし物は捨てる」),
 * the block says: where the drops are and what (the death's dimension and place), the way back by the gate the body remembers in this dimension
 * (`rememberedPlaces`: its place and distance, its other end, and from there to the drops), the condition of their lifetime, what the road's
 * targets lack now (the rods and the pearls, with what lies in the drops and what gathering it again takes), and her health, hunger and food.
 * Up to `SHOWN_MINUTES` after the death it is the whole block; after that, while the body still says they can be picked up (far off they do not
 * age, for up to a day), it is two short sentences: where they are with what of the road lies there, why that is still said, and the way back
 * (11/15c: r's d0361–d0363 came 41 minutes after its death and c1's d0540 65 minutes after, and neither had a word of the way back).
 * Fixed words with closed facts: whether to go back or leave them is the decision's; the body goes nowhere by itself.
 *
 * What the death dropped: the body names only a few items of it (11/15c: four, the fewest first, and 「ほか25種」, so c1's five rods and iron
 * armour were never named), so the head keeps what she carried of the road's things (`createDeathWatch`: the frames before the death) and names
 * those the body's list leaves out. A full list from the body (no 「ほかN種」) is taken as it is. The body may say what the rest holds of note
 * (「ほか25種（うち iron_boots×1, diamond_sword×1 など）」): those are named as the body says them, and the rest is what is left of the count.
 */
export const SHOWN_MINUTES = 20;
/** The words of an act's why that give the drops up (the block says the first). */
export const GIVE_UP_WORDS = '落とし物は捨てる';
/** Those words, but not when what follows denies them: 「捨てずに取りに戻る」「諦めない」「捨てるか戻るか」 keep the drops (the review of 11/15c:
 * a why that goes back is the one that most needs the way back). 「拾わない」「取りに戻らない」 are the giving up, unless 「と」 makes them a must. */
const KEPT = '(?!ず|ない|なかっ|たくない|ませ|られ|るか|るべきで|ては)';
const GIVE_UP = new RegExp(`落とし物(?:は|を)?(?:捨て${KEPT}|諦め${KEPT}|あきらめ${KEPT}|放棄(?!しない|せず|しなかっ|しませ|するか|すべきで)|拾わない(?!と)|取りに戻らない(?!と))`, 'u');
/** The body's line of the last death: 「3分前 the_nether (149,74,75)「…」 落とした物: …。消えるまで最長約5分（近くにいる間だけ減る）→拾いに戻れる」. */
const DEATH_HEAD = /^(\d+)\s*(分|秒)前 (?:minecraft:)?([a-z_]+) \((-?\d+),(-?\d+),(-?\d+)\)/u;
/** A remembered place's row: 「87m 北 (138,79,102) ↔nether(17,70,12)」 (the pair is the body's note of a gate gone through). */
const PLACE_ROW = /^(\d{1,6})m\s+\S{1,4}\s+\((-?\d+),(-?\d+),(-?\d+)\)/u;
const PAIR_NOTE = /↔([a-z_]+)\((-?\d+),(-?\d+),(-?\d+)\)/u;
const GONE_IN = /lava|溶岩|void|虚空|out of the world/iu;
const ITEM = /^([a-z_]+)×(\d+)$/u;
/** 「ほかN種」, with the body's note of what the rest holds of note: 「ほか25種（うち iron_boots×1, diamond_sword×1 など）」 (05a6bd24). */
const MORE = /^ほか(\d+)種(?:（うち([^）]*)）)?$/u;
const AMONG = /([a-z_]+)×(\d+)/gu;
/** The road's things a death costs time to make again, in the order they are named (beds after the arrows; the rest of the body's list follows). */
const PROGRESS = ['blaze_rod', 'ender_eye', 'ender_pearl', 'blaze_powder', 'diamond_pickaxe', 'diamond_sword', 'diamond_axe', 'diamond_chestplate',
  'diamond_leggings', 'diamond_helmet', 'diamond_boots', 'iron_chestplate', 'iron_leggings', 'iron_helmet', 'iron_boots', 'iron_sword', 'iron_pickaxe',
  'shield', 'bow', 'arrow', 'obsidian', 'flint_and_steel'];
const rank = (name: string): number => { const at = PROGRESS.indexOf(name); return at >= 0 ? at : name.endsWith('_bed') ? PROGRESS.indexOf('arrow') + 0.5 : -1; };
/** A frame that shows her empty of those things counts as the moment of the death for this long, should the body's death come a frame later. */
const EMPTY_GRACE_MS = 120_000;
/** The other end of a gate and the gate she remembers there agree when they are this near in the Nether's blocks (a gate looks for one within 16). */
const PAIR_NEAR = 16;

type Cell = { x: number; y: number; z: number };
type Rec = Record<string, unknown>;
type Items = Record<string, number>;
/** A gate the body remembered in a dimension (its 控え row, the newest seen there) and its other end when the body noted one. */
export type Gate = { at: Cell; pair: { dimension: string; at: Cell } | null };
/** What the head knows besides the frame: what she carried of the road's things when she died (by the death's key), and the gates of each dimension. */
export interface DeathKnown { lost: { key: string; items: Items } | null; gates: Readonly<Record<string, Gate>> }
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const bare = (dimension: string): string => dimension.replace(/^minecraft:/u, '').replace(/^the_/u, '');
const metres = (a: Cell, b: Cell): number => Math.round(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.round(Math.hypot(a.x - b.x, a.z - b.z));
const walk = (distance: number, dimension: string): number =>
  Math.round(distance / (bare(dimension) === 'nether' ? NETHER_WALK_BLOCKS_PER_SECOND : WALK_METRES_PER_SECOND));
const cellOf = (match: RegExpExecArray, from: number): Cell => ({ x: Number(match[from]), y: Number(match[from + 1]), z: Number(match[from + 2]) });
/** The Nether's coordinates are an eighth of the overworld's; null between other dimensions. `scale` takes `from`'s to `to`'s. */
const scale = (from: string, to: string): number | null => bare(from) === 'overworld' && bare(to) === 'nether' ? 1 / 8 : bare(from) === 'nether' && bare(to) === 'overworld' ? 8 : null;

/** The newest death the block is for: its dimension, place, age, the minutes its drops have left and its key; null when there is no block. */
export function deathAway(world: Rec, here: string | null): { dimension: string; at: Cell; minutes: number; left: number | null; key: string } | null {
  const said = typeof world.lastDeath === 'string' ? world.lastDeath.trim() : '';
  const head = DEATH_HEAD.exec(said);
  if (!head || !said.includes('拾いに戻れる') || !here) return null;
  const dimension = head[3]!, minutes = head[2] === '秒' ? 0 : Number(head[1]);
  if (bare(dimension) === bare(here)) return null;
  const last = rec((Array.isArray(world.deaths) ? world.deaths : []).at(-1));
  if (GONE_IN.test(`${/「([^」]*)」/u.exec(said)?.[1] ?? ''} ${typeof last?.cause === 'string' ? last.cause : ''}`)) return null;
  const at = cellOf(head, 4);
  const left = /最長約(\d+)分/u.exec(said);
  return { dimension, at, minutes, left: left ? Number(left[1]) : null, key: `${bare(dimension)}:${at.x},${at.y},${at.z}` };
}

/** The key of the death an act's why gives up (its words, `GIVE_UP`), or null. */
export function givenUpBy(why: unknown, world: Rec | null, here: string | null): string | null {
  return typeof why === 'string' && GIVE_UP.test(why) && world ? deathAway(world, here)?.key ?? null : null;
}

/** The newest death the body keeps: its key as `deathAway` makes it, and the same with its time (two deaths at one block are two deaths). */
function newestDeath(world: Rec): { key: string; seen: string } | null {
  const last = rec((Array.isArray(world.deaths) ? world.deaths : []).at(-1));
  const at = rec(last?.position);
  if (last && typeof last.dimension === 'string' && at && [at.x, at.y, at.z].every(value => typeof value === 'number' && Number.isFinite(value))) {
    const key = `${bare(last.dimension)}:${Math.round(at.x as number)},${Math.round(at.y as number)},${Math.round(at.z as number)}`;
    return { key, seen: `${key}|${typeof last.at === 'string' ? last.at : ''}` };
  }
  const head = DEATH_HEAD.exec(typeof world.lastDeath === 'string' ? world.lastDeath.trim() : '');
  if (!head) return null;
  const key = `${bare(head[3]!)}:${head[4]},${head[5]},${head[6]}`;
  return { key, seen: `${key}|` };
}

/** The road's things in the frame's counts (worn included). */
function progressOf(counts: ReadonlyMap<string, number>): Items {
  const items: Items = {};
  for (const [name, count] of counts) if (count > 0 && rank(name) >= 0) items[name] = (items[name] ?? 0) + count;
  return items;
}
const itemsOf = (value: unknown): Items | null => {
  const raw = rec(value);
  if (!raw) return null;
  const items: Items = {};
  for (const [name, count] of Object.entries(raw)) if (rank(name) >= 0 && typeof count === 'number' && count > 0) items[name] = Math.floor(count);
  return items;
};
const cellIn = (value: unknown): Cell | null => {
  const raw = rec(value);
  return raw && [raw.x, raw.y, raw.z].every(part => typeof part === 'number' && Number.isFinite(part)) ? { x: raw.x as number, y: raw.y as number, z: raw.z as number } : null;
};

/**
 * What the head keeps of a death the frame does not say whole (one a task, kept in its checkpoint): what she carried of the road's things in the
 * frames before it (the newest frame that had any; a frame emptied just before the body's death counts as the death), taken as what was dropped
 * when the body's newest death changes; and the gate the body remembered in each dimension (its 控え row and other end, the newest seen there:
 * in the overworld the gate of a death in the Nether is not in the 控え).
 */
export function createDeathWatch(saved: unknown) {
  const kept = rec(rec(saved)?.minecraftDeathWatch);
  let carried = itemsOf(kept?.carried);
  let emptySince = typeof kept?.emptySince === 'number' ? kept.emptySince : null;
  let seen = typeof kept?.seen === 'string' ? kept.seen.slice(0, 120) : null;
  let primed = kept?.primed === true;
  const keptLost = rec(kept?.lost);
  let lost: DeathKnown['lost'] = keptLost && typeof keptLost.key === 'string' && itemsOf(keptLost.items)
    ? { key: keptLost.key.slice(0, 80), items: itemsOf(keptLost.items)! } : null;
  const gates: Record<string, Gate> = {};
  for (const [dimension, raw] of Object.entries(rec(kept?.gates) ?? {})) {
    const at = cellIn(rec(raw)?.at), pair = rec(rec(raw)?.pair), pairAt = cellIn(pair?.at);
    if (at && ['overworld', 'nether', 'end'].includes(dimension)) gates[dimension] = { at, pair: pairAt && typeof pair?.dimension === 'string' ? { dimension: bare(pair.dimension), at: pairAt } : null };
  }
  const learnGate = (world: Rec, dimension: string | null): void => {
    const row = rec(world.rememberedPlaces)?.nether_portal;
    const place = typeof row === 'string' ? PLACE_ROW.exec(row.trim()) : null;
    if (!place || !dimension) return;
    const here = bare(dimension), noted = typeof row === 'string' ? PAIR_NOTE.exec(row) : null;
    const pair = noted && bare(noted[1]!) !== here ? { dimension: bare(noted[1]!), at: cellOf(noted, 2) } : null;
    gates[here] = { at: cellOf(place, 2), pair };
    // the body noted the other end: it is that dimension's gate, known exactly
    if (pair) gates[pair.dimension] = { at: pair.at, pair: { dimension: here, at: cellOf(place, 2) } };
  };
  return {
    /** A frame (each decision's and each act's): the gates, what she carries, and a new death's drops. */
    note(world: Rec | null, facts: DoneFacts | null, at: number): void {
      if (!world || !facts) return;
      learnGate(world, facts.dimension);
      const items = progressOf(facts.counts), has = Object.keys(items).length > 0;
      const death = newestDeath(world);
      if (death && death.seen !== seen) {
        // A frame before this one is needed: a death already in the first frame the task sees is not one whose carrying the head saw.
        const before = has ? items : carried && (emptySince === null || at - emptySince <= EMPTY_GRACE_MS) ? carried : null;
        if (primed) lost = before && Object.keys(before).length ? { key: death.key, items: { ...before } } : null;
        seen = death.seen;
      }
      if (has) { carried = items; emptySince = null; } else if (emptySince === null) emptySince = at;
      primed = true;
    },
    known: (): DeathKnown => ({ lost: lost ? { key: lost.key, items: { ...lost.items } } : null, gates: { ...gates } }),
    checkpoint: () => ({ minecraftDeathWatch: { carried, emptySince, seen, primed, lost, gates } }),
  };
}
export type DeathWatch = ReturnType<typeof createDeathWatch>;

/**
 * What the death dropped: the body's list (`world.deaths`, or its last death's line: 「name×n」 and 「ほかN種」) with, when that list is cut, the
 * road's things she carried that it does not name (`carried`); the road's things first. `entries` is all of it, `shown` what the block names.
 */
function dropped(world: Rec, carried: Items | null): { entries: string[]; shown: string; progress: string[] } {
  const lost = rec((Array.isArray(world.deaths) ? world.deaths : []).at(-1))?.lostItems;
  let said = (Array.isArray(lost) ? lost : []).filter((item): item is string => typeof item === 'string');
  // the 「（うち …）」 is taken with its 「ほかN種」: the names in it are of the rest, not more kinds
  if (!said.length) said = /落とした物: ([^。]*)。/u.exec(typeof world.lastDeath === 'string' ? world.lastDeath : '')?.[1]?.match(/[a-z_]+×\d+|ほか\d+種(?:（うち[^）]*）)?/gu) ?? [];
  const named = new Map<string, number>();
  let more = 0;
  for (const item of said) {
    const found = ITEM.exec(item.trim()), rest = MORE.exec(item.trim());
    if (found) named.set(found[1]!, (named.get(found[1]!) ?? 0) + Number(found[2]));
    else if (rest) {
      more += Number(rest[1]);
      for (const [, name, count] of (rest[2] ?? '').matchAll(AMONG)) {
        if (!named.has(name!)) more = Math.max(0, more - 1);
        named.set(name!, (named.get(name!) ?? 0) + Number(count));
      }
    }
  }
  const kinds = named.size + more;
  const guessed = more > 0 && carried ? Object.entries(carried).filter(([name]) => !named.has(name)) : [];
  const all = [...named, ...guessed];
  const order = (name: string): number => { const at = rank(name); return at >= 0 ? at : PROGRESS.length + 1; };
  const sorted = all.map(([name, count], index) => ({ name, count, index })).sort((a, b) => order(a.name) - order(b.name) || a.index - b.index);
  const entries = sorted.map(item => `${item.name}×${item.count}`);
  const progress = sorted.filter(item => rank(item.name) >= 0).map(item => `${item.name}×${item.count}`);
  const others = sorted.filter(item => rank(item.name) < 0).map(item => `${item.name}×${item.count}`);
  const names = [...progress.slice(0, 8), ...others.slice(0, Math.max(0, 6 - Math.min(progress.length, 8)))];
  const rest = Math.max(0, kinds - names.length);
  const shown = names.length ? `${names.join('・')}${rest ? `・ほか${rest}種` : ''}${guessed.length ? '（体の行に名前の無い物は、死ぬ直前の持ち物から）' : ''}` : '';
  return { entries, shown, progress };
}
const countIn = (items: readonly string[], name: RegExp): number => items.reduce((sum, item) => {
  const found = ITEM.exec(item);
  return found && name.test(found[1]!) ? sum + Number(found[2]) : sum;
}, 0);

/**
 * The way back: the gate she remembers in this dimension (the 控え, else the one the head saw there), its other end (the body's pair note, else
 * the gate remembered in the death's dimension when their coordinates agree) and from there to the drops. With no gate of this dimension known and
 * the gate of the death's dimension known, an estimate by the eighth (said as one: a gate can join another frame than the one it was made with,
 * 11/15c's three were 25–90 m from their ×8), and where a gate made here would come out.
 */
function wayBack(world: Rec, death: { dimension: string; at: Cell }, here: string, feet: Cell | null, gates: Readonly<Record<string, Gate>>): string {
  const kind = bare(death.dimension) === 'end' ? 'end_portal_frame' : 'nether_portal';
  const row = rec(world.rememberedPlaces)?.[kind];
  const place = typeof row === 'string' ? PLACE_ROW.exec(row.trim()) : null;
  const own = kind === 'nether_portal' ? gates[bare(here)] ?? null : null;
  const far = kind === 'nether_portal' ? gates[bare(death.dimension)] ?? null : null;
  const across = scale(here, death.dimension);
  const gate = place ? { at: cellOf(place, 2), distance: Number(place[1]), from: '' }
    : own && feet ? { at: own.at, distance: metres(own.at, feet), from: '（前にこの次元の控えにあった）' } : null;
  if (!gate) {
    const lack = `帰り道: この次元のゲートは体の控えに無い（${kind === 'nether_portal' ? 'ゲートを見つけるか組む' : 'エンドポータルの枠を探す'}）`;
    if (!across || !feet) return lack;
    const guess = far ? { x: Math.round(far.at.x / across), z: Math.round(far.at.z / across) } : null;
    const estimate = guess ? `。目安: ${death.dimension} 側のゲート (${far!.at.x},${far!.at.y},${far!.at.z}) の座標の${across < 1 ? '×8' : '÷8'}は x ${guess.x}・z ${guess.z}、`
      + `あなたから ${compassWord(bearingBetween(feet, guess))} 約 ${flat(feet, guess)}m（目安で、本当の位置は数十〜百数十 m 違いうる。近くで枠が見えれば控えに入る）` : '';
    const arrive = { x: Math.round(feet.x * across), z: Math.round(feet.z * across) };
    return `${lack}${estimate}。ここで黒曜石 10 と火打ち石でゲートを組むと、向こうでは x ${arrive.x}・z ${arrive.z} あたりに出て、落とし物まで約 ${flat(arrive, death.at)}m`;
  }
  const head = `帰り道: ゲート ${gate.distance}m (${gate.at.x},${gate.at.y},${gate.at.z})${gate.from}（歩いて約 ${walk(gate.distance, here)} 秒）`;
  const noted = typeof row === 'string' && place ? PAIR_NOTE.exec(row) : null;
  const pair = noted && bare(noted[1]!) === bare(death.dimension) ? cellOf(noted, 2)
    : !place && own?.pair && bare(own.pair.dimension) === bare(death.dimension) ? own.pair.at : null;
  // the gate remembered over there, when it sits where this gate's other end would (in the Nether's blocks)
  const agrees = !pair && far && across && flat(across < 1 ? { x: gate.at.x * across, z: gate.at.z * across } : gate.at,
    across < 1 ? far.at : { x: far.at.x / 8, z: far.at.z / 8 }) <= PAIR_NEAR;
  const other = pair ?? (agrees ? far!.at : null);
  if (!other) return `${head}。向こう側の場所は控えに無い`;
  const onward = metres(other, death.at);
  return `${head}→ 向こう側 (${other.x},${other.y},${other.z})${pair ? '' : '（前に向こうの控えにあったゲート。座標の 8 倍が合う）'} から落とし物まで ${onward}m（約 ${walk(onward, death.dimension)} 秒）`;
}

/**
 * What the road's targets lack now (rods, pearls and eyes), with what lies in the drops and what gathering that again takes; null when nothing
 * lacks, and null once the gathering is behind her (the review of 11/15c: after the eyes were made the rods are 0 and are no lack): a death in
 * the End or a decision there, or the portal's frames found (remembered or in view; the frame line then counts the eyes exactly). The rods count
 * what was made of them back (`acquired`: an eye or two powder is half a rod), the pearls the eyes made of them.
 */
function shortOf(world: Rec, facts: DoneFacts, deathDimension: string, items: readonly string[]): string | null {
  const counts = facts.counts;
  const framesFound = typeof rec(world.rememberedPlaces)?.end_portal_frame === 'string' || facts.seen?.has('end_portal_frame') === true;
  if (bare(deathDimension) === 'end' || bare(facts.dimension ?? '') === 'end' || framesFound) return null;
  const rods = acquired(counts, 'blaze_rod'), pearls = acquired(counts, 'ender_pearl');
  const lostRods = countIn(items, /^blaze_rod$/u) + Math.floor(countIn(items, /^blaze_powder$/u) / 2), lostPearls = countIn(items, /^ender_(?:pearl|eye)$/u);
  const parts = [...rods < RODS_FOR_EYES ? [`ロッド 今 ${rods}/${RODS_FOR_EYES}${lostRods ? `（落とし物に ${lostRods}）` : ''}`] : [],
    ...pearls < PEARL_TARGET ? [`パール・アイ 今 ${pearls}/${PEARL_TARGET}${lostPearls ? `（落とし物に ${lostPearls}）` : ''}`] : []];
  if (!parts.length) return null;
  const again = lostRods * SECONDS_PER_ROD + lostPearls * SECONDS_PER_PEARL;
  return `区間の目標まで: ${parts.join('・')}${again ? `。落とし物の分を集め直すと約 ${Math.round(again / 10) * 10} 秒` : ''}`;
}

/** The block for a decision, or null (see the head of the file). `givenUp`: the key of the death she gave up, if any; `known`: the head's own (`createDeathWatch`). */
export function deathReturnLine(world: Rec, facts: DoneFacts, givenUp: string | null, known: DeathKnown | null = null): string | null {
  const death = deathAway(world, facts.dimension);
  if (!death || death.key === givenUp || !facts.dimension) return null;
  const items = dropped(world, known?.lost?.key === death.key ? known.lost.items : null);
  const way = wayBack(world, death, facts.dimension, facts.feet, known?.gates ?? {});
  const where = `${death.dimension} (${death.at.x},${death.at.y},${death.at.z})`;
  if (death.minutes > SHOWN_MINUTES) {
    // Past the whole block: while the body says they can still be picked up, the place, the road's things there and the way back.
    const what = items.progress.length ? items.progress.slice(0, 8).join('・') : items.shown;
    return [`別の次元の落とし物（${death.minutes} 分前に死んだ所）: ${where}${what ? ` に ${what}` : ''}。体はまだ拾えると言っている（離れている間は消えるまでの時間が減らない`
      + `${death.left !== null ? `。残り最長約 ${death.left} 分` : ''}）`, way].join('。') + `（作り直しと比べて決める。捨てるなら why に「${GIVE_UP_WORDS}」）`;
  }
  const left = death.left !== null ? `消えるまで残り最長約 ${death.left} 分` : '残りの時間は最後の死の行';
  const vitals = [facts.hp !== null && facts.hp !== undefined ? `体力 ${Math.round(facts.hp * 10) / 10}` : null,
    facts.hunger !== null && facts.hunger !== undefined ? `満腹 ${facts.hunger}` : null, `食べ物 ${Math.round(facts.food)} 点`].filter(Boolean).join('・');
  return [`別の次元の落とし物（${death.minutes} 分前に死んだ所）: ${where}${items.shown ? ` に ${items.shown}` : ''}。${left}`,
  `この時間は、落とし物の所のチャンクが読み込まれている間（同じ次元で約 160m 以内にいる間）だけ減る。今は別の次元にいて、そこが読み込まれていなければ減らない`,
  way, ...[shortOf(world, facts, death.dimension, items.entries)].filter((line): line is string => line !== null), `今: ${vitals}`,
  `戻って拾うか捨てて作り直すかは、道のりと集め直しの時間を比べて決める（体は勝手に戻らない）。捨てるなら act の why に「${GIVE_UP_WORDS}」と書く（この行は消える）`].join('。');
}
