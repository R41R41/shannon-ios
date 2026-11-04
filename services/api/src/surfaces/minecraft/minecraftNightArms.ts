import { carried } from './minecraftConditions.js';

/**
 * The night with nothing to fight with, said as a fact (run60, 11/4 01:47: three minutes before night she kept taking planks from a village for sticks,
 * with no sword made after the iron was smelted; two to four zombies came with 7.6 health left). The line comes in the overworld within three minutes
 * of the night and through it, while no sword and no axe is carried. It names no hand: what to make, where to go and when to eat stay the decision's.
 */
export const NIGHT_FROM = 13_000, NIGHT_TO = 23_000, DAY_LENGTH = 24_000, TICKS_PER_MINUTE = 1_200;
const NEAR_TICKS = 3 * TICKS_PER_MINUTE;
const WEAPON = /(?:^|:)(?:wooden|stone|golden|iron|diamond|netherite)_(?:sword|axe)$/u;
/** The blade of the iron gear: the weapon the night and the gate are met with (a stone one is what the first hour makes). */
const IRON_BLADE = /(?:^|:)(?:iron|diamond|netherite)_sword$/u;
const IRON_FOR_SWORD = 2;

export const minutes = (ticks: number): string => ticks < 2 * TICKS_PER_MINUTE
  ? `${Math.max(1, Math.round(ticks / 20))} 秒` : `約 ${Math.round(ticks / TICKS_PER_MINUTE)} 分`;

/** The tick of the day (0–23,999): the body's numeric `timeOfDay` first, else its `time` string of digits; null when neither. */
export function dayTick(world: Record<string, unknown>): number | null {
  const raw = world.timeOfDay;
  if (typeof raw === 'number' && Number.isFinite(raw)) return ((Math.floor(raw) % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH;
  return typeof world.time === 'string' && /^\d+$/u.test(world.time.trim()) ? Number(world.time.trim()) % DAY_LENGTH : null;
}

const carriedNames = (counts: ReadonlyMap<string, number>, pattern: RegExp): string[] =>
  [...counts].filter(([name, count]) => pattern.test(name) && count > 0).map(([name]) => name.replace(/^minecraft:/u, ''));

/**
 * What she holds against the dark, as a fact: nothing, or only blades that are not iron while iron for a sword is in the pack (the iron was
 * smelted and the sword not made); and no shield once iron is in the pack (the whole-run audit of 11/4, order 1: the sword and the shield right
 * after the iron).
 */
function armsWords(counts: ReadonlyMap<string, number>): string | null {
  const iron = carried(counts, 'iron_ingot');
  const ironPick = carriedNames(counts, /(?:^|:)iron_pickaxe$/u).length > 0, ironAge = iron > 0 || ironPick;
  const words: string[] = [];
  if (!carriedNames(counts, IRON_BLADE).length) {
    const weapons = carriedNames(counts, WEAPON);
    if (!weapons.length) words.push('剣も斧も荷に無い');
    else if (iron >= IRON_FOR_SWORD || ironPick) {
      words.push(`荷の剣・斧は ${weapons.join('・')} だけ（鉄の剣は無い。鉄の剣は鉄 ${IRON_FOR_SWORD} 個で作れる。鉄は ${iron} 個）`);
    }
  }
  if (ironAge && carried(counts, 'shield') === 0) words.push(`盾が無い（盾は板 6 と鉄 1 で作れる。鉄は ${iron} 個）`);
  return words.length ? words.join('。') : null;
}

/**
 * The line for a decision, or null: not the overworld, the dark not near (the night within three minutes and through it; underground at any
 * hour, where the light is out and hostiles spawn: `underground`), or an iron sword in the pack (or, with no iron for one, any blade).
 */
export function nightArmsLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null,
  underground = false): string | null {
  if (dimension !== 'overworld') return null;
  const time = dayTick(world);
  const night = time !== null && time < NIGHT_TO && time >= NIGHT_FROM - NEAR_TICKS;
  if (!night && !underground) return null;
  const arms = armsWords(counts);
  if (!arms) return null;
  if (!night || time === null) return `地下は昼でも暗く、ゾンビ・スケルトンが湧く: ${arms}`;
  const when = time >= NIGHT_FROM ? `夜（朝まで ${minutes(NIGHT_TO - time)}）` : `夜まで ${minutes(NIGHT_FROM - time)}`;
  return `${when}: ${arms}。夜は地上にゾンビ・スケルトンが湧く`;
}

/** The bed in the pack. */
export const BED = /(?:^|:)[a-z_]+_bed$/u;
/** A bed can be slept in from tick 12,542 (the game's dusk, before the hostiles of 13,000); the line comes a minute before that. */
export const BED_FROM = 12_542;
const BED_NEAR_TICKS = 1_200;
export const BED_ENEMY_BLOCKS = 8;

export const enemyNear = (world: Record<string, unknown>): boolean => (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).some(item => {
  const entry = item && typeof item === 'object' ? item as { distance?: unknown } : null;
  return typeof entry?.distance === 'number' && entry.distance <= BED_ENEMY_BLOCKS;
});

/**
 * The bed against the night, as the facts of the game (the coordinator's wording of 11/4, after run60 and run61 both ended in a night): within a minute of
 * the night and through it, with a bed in the pack and no enemy within 8 blocks. A sleep skips the night and makes the morning; it cannot begin with an
 * enemy near; it works underground too. It names no hand.
 */
export function nightBedLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null): string | null {
  const tick = dayTick(world);
  if (dimension !== 'overworld' || tick === null) return null;
  const bed = [...counts].find(([name, count]) => BED.test(name) && count > 0);
  if (!bed || enemyNear(world)) return null;
  if (tick >= NIGHT_TO || tick < BED_FROM - BED_NEAR_TICKS) return null;
  const name = bed[0].replace(/^minecraft:/u, '');
  if (tick < BED_FROM) return `夜まで ${minutes(NIGHT_FROM - tick)}: ベッドを持っている（${name}）。寝られるのは夜になってから（あと ${minutes(BED_FROM - tick)}）。寝れば夜が飛び、朝になる`;
  return `夜（朝まで ${minutes(NIGHT_TO - tick)}）: ベッドを持っている（${name}）。寝れば夜が飛び、朝になる（近くに敵がいる間は寝られない）。地下でも寝られる`;
}
