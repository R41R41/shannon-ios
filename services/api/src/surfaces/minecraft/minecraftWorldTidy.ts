import type { BodyValue } from '../../contracts/bodyControlContract.js';
import { EDIBLE_FOOD, carriedItemCounts, countMatching } from './minecraftItems.js';
import { BED_HEIGHT_REACH } from './minecraftWorkingArbiter.js';
import { tripSeconds } from './minecraftProcedureTrip.js';
import { FOOD_STOCK } from './minecraftStage.js';

/**
 * Two parts of the body's world frame that told the decision to do what the head's own rules do not want (mb-r23, Minecraft run 23):
 *
 * - `rememberedPlaces`: the row of a bed 147 m away and 83 m below her ("置かれたベッド: dig-block-at takeEquipment=true で掘れば持てる") read as a
 *   thing to fetch, and the planner sent a move there that the body turned down at once (a 4.5 s decision). A row whose height differs from
 *   hers by more than `BED_HEIGHT_REACH` is a thing in rock or on a roof: the hint to dig it is taken off and the height and what the way
 *   would cost are put in its place.
 * - `margin.descentKit`: `cooked_food` in `missing` while the pack holds `FOOD_STOCK` pieces of food (raw: the furnaces' waits cook it) sent
 *   the planner after more animals, the stock the procedure and the milestone already call enough.
 *
 * Closed numbers and the body's own words, as the observation carries them; nothing here adds an instruction.
 */
export interface TidyContext { food: number; at: { x: number; y: number; z: number } | null }

/** The food she carries and where she stands, from a world frame and its facts. */
export function tidyContext(world: Readonly<Record<string, unknown>>, facts: Readonly<Record<string, unknown>> | null): TidyContext {
  const position = world.position && typeof world.position === 'object' ? world.position as Record<string, unknown> : null;
  const at = position && [position.x, position.y, position.z].every(value => typeof value === 'number')
    ? { x: position.x as number, y: position.y as number, z: position.z as number } : null;
  return { food: countMatching(carriedItemCounts(world, facts), EDIBLE_FOOD), at };
}

const record = (value: BodyValue | undefined): value is { readonly [key: string]: BodyValue } => !!value && typeof value === 'object' && !Array.isArray(value);
const CELL = /\((-?\d{1,8}),\s*(-?\d{1,4}),\s*(-?\d{1,8})\)/u;
const DIG_HINT = /(?:[^\s、。]*dig-block-at\s*)?(?:takeEquipment=true\s*で)?掘れば持てる/gu;

/** One remembered-place row: the dig hint off and the height said when the place is far above or below her. */
export function tidyPlaceRow(row: string, at: TidyContext['at']): string {
  const found = CELL.exec(row);
  if (!found || !at) return row;
  const cell = { x: Number(found[1]), y: Number(found[2]), z: Number(found[3]) };
  const rise = Math.round(cell.y - at.y);
  if (Math.abs(rise) <= BED_HEIGHT_REACH) return row;
  const kept = row.replace(DIG_HINT, '').replace(/[:：]\s*(?=$|\s)/gu, '').replace(/\s{2,}/gu, ' ').trim();
  const seconds = Math.round(tripSeconds(at, cell));
  return `${kept}（高さ${rise > 0 ? '+' : ''}${rise}m・${rise > 0 ? '高所' : '岩の中'}。歩いては行けない、掘り進むと約${seconds}秒）`;
}

export function tidyWorldPart(key: string, value: BodyValue, context: TidyContext): BodyValue {
  if (key === 'rememberedPlaces' && record(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, row]) => [name, typeof row === 'string' ? tidyPlaceRow(row, context.at) : row]));
  }
  if (key === 'margin' && record(value) && record(value.descentKit) && Array.isArray(value.descentKit.missing) && context.food >= FOOD_STOCK) {
    const kit = value.descentKit;
    const missing = (kit.missing as readonly BodyValue[]).filter(item => item !== 'cooked_food');
    if (missing.length === (kit.missing as readonly BodyValue[]).length) return value;
    return { ...value, descentKit: { ...kit, missing } };
  }
  return value;
}
