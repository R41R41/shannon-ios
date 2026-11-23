import type { PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { readWhere } from './minecraftPlanFacts.js';
import { nearbyResourcesOf } from './minecraftLlmcNearby.js';
import { feetOf } from './minecraftLlmcReadiness.js';

/**
 * The place a plan node names, read against where she stands and what the body sees now.
 *
 * A node's `where` is a coordinate written when the plan was made, from the scan, the map or a memory: the model copies it, and nothing in the land updates it.
 * A field, a crop or an ore moves or goes within minutes, so in the replay of a morning's decisions she walked to a field's coordinate that was bare cobblestone and
 * went on looking for the field: the node line still said 「畑・作物 (x,y,z)」, the one result that said cobblestone was a line in an earlier message, and the sentence
 * that says to trust the result and mend the `where` stood in the stage's knowledge, far from the decision. This line is said at the node itself, where the coordinate is:
 * - far from it: the coordinate is what was read when the plan was written (so she looks again on arriving);
 * - at it (within `ARRIVED_METERS`): what the body's count of the plants round her says of the thing the node is about: the thing is there (nothing is said), is
 *   elsewhere (its nearest place is given) or is not in the count (said, with the way to mend the `where`).
 * Facts only: nothing is moved here, the model mends the `where` with `plan_update`. Nothing is said for a thing the body's count cannot tell (ore, wood), for a body whose
 * count was not read, or outside the overworld.
 */
export const ARRIVED_METERS = 16;
/** A plant within this of the node's place is at it. */
const AT_PLACE_METERS = 24;
const FIELD = /畑|作物|小麦|麦|干し草|ニンジン|人参|ジャガイモ|ビートルート|farm|wheat|crop|carrot|potato|beetroot|hay/iu;
const CANE = /サトウキビ|砂糖|sugar/iu;
const IRON = /鉄鉱|鉄イン|鉄\d|鉄を[掘集採探]|iron_ore|iron_ingot|raw_iron/iu;
const CROP_KINDS: ReadonlySet<string> = new Set(['wheat', 'carrots', 'potatoes', 'beetroots', 'hay_block']);

type Thing = { name: string; words: string; count: boolean };
/** What a node is about, when its place is the kind that goes or moves (null: nothing to say of it). */
function thingOf(node: Pick<PlanNode, 'title' | 'where' | 'note' | 'doneWhen'>): Thing | null {
  const text = `${node.title ?? ''} ${node.where ?? ''} ${node.note ?? ''} ${node.doneWhen ?? ''}`;
  if (FIELD.test(text)) return { name: '畑・作物', words: '畑・作物', count: true };
  if (CANE.test(text)) return { name: 'サトウキビ', words: 'サトウキビ', count: true };
  if (IRON.test(text)) return { name: '鉄鉱石', words: '鉄鉱石', count: false };
  return null;
}

/** The line for the current node, or null (no place, no frame, nothing the body can tell, or what the node is about is where the node says). */
export function whereCheckLine(node: Pick<PlanNode, 'state' | 'title' | 'where' | 'note' | 'doneWhen'> | undefined, observation: BodyObservation | null): string | null {
  if (!node || node.state === 'done' || !node.where) return null;
  const place = readWhere(node.where, 'any');
  const thing = place ? thingOf(node) : null;
  if (!place || !thing) return null;
  const world = (observation?.state.world ?? {}) as Record<string, unknown>, feet = feetOf(world);
  if (!feet) return null;
  const meters = Math.round(Math.hypot(place.x - feet.x, place.z - feet.z));
  const at = `(${place.x},${place.y},${place.z})`;
  if (meters > ARRIVED_METERS) {
    return `（場所 ${at} は足元から水平 ${meters}m。座標は計画を書いた時に読んだ物で、着く頃には変わる。着いたら今の観測で ${thing.words} を確かめる）`;
  }
  const dimension = typeof world.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : 'overworld';
  const counted = nearbyResourcesOf(world.nearbyResources);
  if (!thing.count || dimension !== 'overworld' || !counted.length) return null;
  const sites = counted.filter(item => item.count > 0 && (item.purpose === 'plant' || item.purpose === 'food_village')
    && (thing.name === 'サトウキビ' ? item.kind === 'sugar_cane' : CROP_KINDS.has(item.kind))).flatMap(item => item.sites.map(site => ({ ...site, kind: item.kind })));
  if (sites.some(site => Math.hypot(site.x - place.x, site.z - place.z) <= AT_PLACE_METERS)) return null;
  const arrived = `場所 ${at} に着いている（足元から水平 ${meters}m）`;
  const mend = 'この where は古い読み取りの写し。plan_update の set で where を直す（最寄りが分かればその座標、無ければ ""）。同じ座標をもう確かめに行かない';
  if (sites.length) {
    const nearest = [...sites].sort((a, b) => Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z))[0]!;
    const from = Math.round(Math.hypot(nearest.x - place.x, nearest.z - place.z));
    return `（${arrived}が、そこに ${thing.words} は見えない。体の観測の最寄りは ${nearest.kind} (${nearest.x},${nearest.y},${nearest.z})・where から ${from}m。${mend}）`;
  }
  return `（${arrived}が、体の観測（周りの作物・村の畑の数え）に ${thing.words} は載っていない。${mend}。探すなら mc_view の only= か mc_probe を 1 手）`;
}
