import { carried } from './minecraftConditions.js';

/**
 * The night with nothing to fight with, said as a fact (run60, 11/4 01:47: three minutes before night she kept taking planks from a village for sticks,
 * with no sword made after the iron was smelted; two to four zombies came with 7.6 health left). The line comes in the overworld within three minutes
 * of the night and through it, while no sword and no axe is carried. It names no hand: what to make, where to go and when to eat stay the decision's.
 */
const NIGHT_FROM = 13_000, NIGHT_TO = 23_000, DAY_LENGTH = 24_000, TICKS_PER_MINUTE = 1_200;
const NEAR_TICKS = 3 * TICKS_PER_MINUTE;
const WEAPON = /(?:^|:)(?:wooden|stone|golden|iron|diamond|netherite)_(?:sword|axe)$/u;

const minutes = (ticks: number): string => ticks < 2 * TICKS_PER_MINUTE
  ? `${Math.max(1, Math.round(ticks / 20))} 秒` : `約 ${Math.round(ticks / TICKS_PER_MINUTE)} 分`;

/** The line for a decision, or null: not the overworld, the night not near, or a sword or an axe in the pack. */
export function nightArmsLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null): string | null {
  if (dimension !== 'overworld' || typeof world.time !== 'string' || !/^\d+$/u.test(world.time.trim())) return null;
  if ([...counts.keys()].some(name => WEAPON.test(name) && carried(counts, name) > 0)) return null;
  const tick = Number(world.time.trim()) % DAY_LENGTH;
  if (tick >= NIGHT_TO || tick < NIGHT_FROM - NEAR_TICKS) return null;
  const when = tick >= NIGHT_FROM ? `夜（朝まで ${minutes(NIGHT_TO - tick)}）` : `夜まで ${minutes(NIGHT_FROM - tick)}`;
  return `${when}: 剣も斧も荷に無い。夜は地上にゾンビ・スケルトンが湧く`;
}

/** The bed in the pack. */
const BED = /(?:^|:)[a-z_]+_bed$/u;
/** A bed can be slept in from tick 12,542 (the game's dusk, before the hostiles of 13,000); the line comes a minute before that. */
const BED_FROM = 12_542, BED_NEAR_TICKS = 1_200;
const BED_ENEMY_BLOCKS = 8;

const enemyNear = (world: Record<string, unknown>): boolean => (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).some(item => {
  const entry = item && typeof item === 'object' ? item as { distance?: unknown } : null;
  return typeof entry?.distance === 'number' && entry.distance <= BED_ENEMY_BLOCKS;
});

/**
 * The bed against the night, as the facts of the game (the coordinator's wording of 11/4, after run60 and run61 both ended in a night): within a minute of
 * the night and through it, with a bed in the pack and no enemy within 8 blocks. A sleep skips the night and makes the morning; it cannot begin with an
 * enemy near; it works underground too. It names no hand.
 */
export function nightBedLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null): string | null {
  if (dimension !== 'overworld' || typeof world.time !== 'string' || !/^\d+$/u.test(world.time.trim())) return null;
  const bed = [...counts].find(([name, count]) => BED.test(name) && count > 0);
  if (!bed || enemyNear(world)) return null;
  const tick = Number(world.time.trim()) % DAY_LENGTH;
  if (tick >= NIGHT_TO || tick < BED_FROM - BED_NEAR_TICKS) return null;
  const name = bed[0].replace(/^minecraft:/u, '');
  if (tick < BED_FROM) return `夜まで ${minutes(NIGHT_FROM - tick)}: ベッドを持っている（${name}）。寝られるのは夜になってから（あと ${minutes(BED_FROM - tick)}）。寝れば夜が飛び、朝になる`;
  return `夜（朝まで ${minutes(NIGHT_TO - tick)}）: ベッドを持っている（${name}）。寝れば夜が飛び、朝になる（近くに敵がいる間は寝られない）。地下でも寝られる`;
}
