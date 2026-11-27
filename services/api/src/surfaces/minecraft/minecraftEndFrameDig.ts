import { framesOf } from './minecraftSeenMarks.js';
import { carried } from './minecraftConditions.js';

/** A stone pickaxe is 131 uses; the pickaxes that dig stone without the diamond one kept for obsidian. */
const SPARE_PICK = /^(?:stone|iron)_pickaxe$/u;
/** Frames this much below her feet or less are not a descent (she is in the room, or at its edge). */
const DESCENT_FROM = 8;
const rec = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * The descent to the portal room digs straight down from above the frames (`maxDig 150` in the knowledge's two-hand act): about as many blocks as the frames are below her feet, one use of the
 * pickaxe each. When she carries no crafting table and no log or plank to make one, the line says the numbers side by side (the digs against what a stone or iron pickaxe has left, the ways to
 * make a table), since a pickaxe that breaks 30 blocks down cannot be made again without one. Facts only; nothing is asked or held. Null: no frames in view, they are not far below, or a table
 * (or what makes one) is carried.
 */
export function frameDigLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, feet: { x: number; y: number; z: number } | null): string | null {
  if (world.dimension !== undefined && world.dimension !== 'overworld') return null;
  const frames = framesOf(world);
  if (!frames || !feet) return null;
  const down = Math.round(feet.y - frames.at.y);
  if (down < DESCENT_FROM) return null;
  const hasTable = carried(counts, 'crafting_table') > 0;
  const wood = [...counts].reduce((sum, [name, n]) => sum + (/(?:^|_)(?:log|planks)$/u.test(name) ? n : 0), 0);
  if (hasTable || wood > 0) return null;
  const picks = (Array.isArray(world.inventory) ? world.inventory : []).flatMap(raw => {
    const item = rec(raw), durability = rec(item?.durability), name = String(item?.name ?? '').replace(/^minecraft:/u, '');
    const left = durability?.left, max = durability?.max;
    return item && SPARE_PICK.test(name) && typeof left === 'number' && typeof max === 'number' ? [{ name, left, max }] : [];
  }).sort((a, b) => b.left - a.left);
  const best = picks[0];
  const pick = best
    ? `${best.name} 残り ${best.left}/${best.max}（1 マス 1 使い）→ 約 ${down} マスを掘るのに${best.left >= down ? '足りる' : `足りない（あと約 ${down - best.left}）`}`
    : '石以上のつるはし（ダイヤのは黒曜石用）が荷に無い';
  return `枠の部屋へ下りる前の事実: 枠は約 ${down}m 下（真上から掘ると約 ${down} マス）。掘る道具: ${pick}。`
    + '作業台は荷に無く、原木・板も無い（つるはしが壊れた時の作り直しに作業台が要る）。作業台を作って持つ: 原木 1 本で板 4・板 4 で作業台（石のつるはしは丸石 3＋棒 2）';
}
