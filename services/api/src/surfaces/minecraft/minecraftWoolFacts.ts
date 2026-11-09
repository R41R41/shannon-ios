import { carried } from './minecraftConditions.js';

/**
 * Sheep, wool and shears as facts (the whole-run audit of 11/4, order 9: the bed's wool was only ever taken by killing a sheep, one wool a sheep,
 * and the shears the body offers never reached the decision). With a sheep within `NEAR` m in the overworld and fewer than `BED_TARGET` beds
 * carried, the line says what a sheep gives shorn and killed, whether shears are carried (and the iron for them), the wool carried by colour, and
 * how much wool the last decision added, so a shearing is seen to have worked or not. The hand that shears (`use` with the shears on the sheep's
 * id) has not been tried on the body in a lab yet, and the line says so. It decides nothing.
 */
export const BED_TARGET = 10;
const NEAR = 24;
const SHEARS_IRON = 2;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const one = (value: number): string => String(Math.round(value * 10) / 10);

/** The sheep within `NEAR` m, nearest first. */
function sheepOf(world: Record<string, unknown>): Array<{ id: number | null; distance: number }> {
  const list = Array.isArray(world.nearbyEntities) ? world.nearbyEntities : [];
  return list.flatMap(item => {
    const entity = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    return entity?.name === 'sheep' && finite(entity.distance) && entity.distance <= NEAR
      ? [{ id: Number.isInteger(entity.id) ? entity.id as number : null, distance: entity.distance }] : [];
  }).sort((a, b) => a.distance - b.distance);
}

const woolOf = (counts: ReadonlyMap<string, number>): Array<[string, number]> =>
  [...counts].filter(([name, count]) => /_wool$/u.test(name) && count > 0).map(([name, count]) => [name.replace(/^minecraft:|_wool$/gu, ''), count]);

/** The line, or null; `before`: the wool carried at the last decision (null when not known). */
export function woolLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null, before: number | null):
  string | null {
  if (dimension !== 'overworld') return null;
  const beds = carried(counts, 'bed'), sheep = sheepOf(world);
  if (beds >= BED_TARGET || !sheep.length) return null;
  const wool = woolOf(counts), total = wool.reduce((sum, [, count]) => sum + count, 0);
  const nearest = sheep[0]!, others = sheep.length > 1 ? ` ほか ${sheep.length - 1} 頭` : '';
  const change = before !== null && total !== before ? `（前の判断から ${total > before ? '+' : ''}${total - before}）` : '';
  // 1107f: "bed 0/10" with brown×2 in hand read as far from done; one more brown sheep made the first bed. The colour nearest three is named.
  const best = [...wool].sort((a, b) => b[1] - a[1])[0];
  const first = beds === 0 && best ? (best[1] >= 3 ? `（${best[0]}×${best[1]} で今ベッドを作れる）` : `（寝る用の 1 個まで ${best[0]} あと ${3 - best[1]}）`) : '';
  const carriedWool = wool.length ? wool.map(([colour, count]) => `${colour}×${count}`).join('・') : 'なし';
  const shears = carried(counts, 'shears') > 0 ? 'ハサミ 有り'
    : `ハサミ 無し（鉄 ${SHEARS_IRON} で作れる。鉄は ${carried(counts, 'iron_ingot')} 個）`;
  return `羊${nearest.id !== null ? ` #${nearest.id}` : ''} ${one(nearest.distance)}m${others}・ベッド ${beds}/${BED_TARGET}・羊毛 ${carriedWool}${change}${first}: `
    + `羊毛はハサミで刈ると 1 頭 1〜3 個（羊は残り、毛はまた生える）、殺すと 1 個。${shears}。刈る手は use item=shears target=#id（体のラボでは未確認。`
    + '刈れたかはこの行の羊毛の数で見る）、落ちた羊毛は pickup。ベッド 1 個は同じ色の羊毛 3＋板 3';
}

export function createWoolWatch() {
  let last: number | null = null;
  return {
    line(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null): string | null {
      const line = woolLine(world, counts, dimension, last);
      last = woolOf(counts).reduce((sum, [, count]) => sum + count, 0);
      return line;
    },
  };
}
