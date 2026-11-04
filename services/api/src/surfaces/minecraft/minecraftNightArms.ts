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
