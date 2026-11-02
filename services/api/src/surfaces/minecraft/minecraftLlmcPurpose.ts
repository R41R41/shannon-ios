import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActHand, ActInput, ActPos, ActStopIf } from '../../contracts/minecraftActContract.js';
import type { ActClause } from '../../contracts/minecraftActCondition.js';
import { carried, doneFacts } from './minecraftConditions.js';
import { validSkillInput } from './minecraftControlValidation.js';
import { BODY_RULES, mapView, readLayers, SOLID } from './minecraftLlmcPreflightMap.js';
import { recipeOf, type Material } from './minecraftLlmcRecipes.js';
import { TABLE_REACH_METERS } from './minecraftLlmcTableNote.js';

/** Head-only entry: it is expanded to one ordinary act, never sent as a body skill. */
export const MC_MAKE_AT_TOOL = 'mc.make_at';
export const PURPOSE_DESCRIPTION = '指定の作業台で指定数を作る。材料不足・失敗・反射で止まり、集め直し・再開はしない。';
export interface MakeAtPurpose {
  item: string;
  count: number;
  table: ActPos | 'place_here';
  allowPlace: boolean;
  maxSeconds: number;
  abortIf: Pick<ActStopIf, 'hpBelow' | 'hostileWithin'>;
}
export const PURPOSE_INPUT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['item', 'count', 'table', 'allowPlace', 'maxSeconds', 'abortIf'],
  properties: {
    item: { type: 'string', minLength: 1, maxLength: 64, description: '作る品の id。手持ちの直接材料だけ使う' },
    count: { type: 'integer', minimum: 1, maximum: 64, description: '追加で作る数（所持総数ではない）' },
    table: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['x', 'y', 'z'], properties: {
        x: { type: 'integer' }, y: { type: 'integer', minimum: -64, maximum: 319 }, z: { type: 'integer' },
      } },
      { type: 'string', enum: ['place_here'] },
    ], description: '作業台のマス。place_here は現在の足の東隣1マス（塞がっていたら止める）' },
    allowPlace: { type: 'boolean', description: '指定マスに作業台が無い時だけ作業台の作成・設置を許す' },
    maxSeconds: { type: 'number', minimum: 1, maximum: 180, description: 'act 全体の実行上限秒。移動が要る場合は5秒以上' },
    abortIf: { type: 'object', additionalProperties: false, required: [], properties: {
      hpBelow: { type: 'number', minimum: 1, maximum: 20 },
      hostileWithin: { type: 'number', minimum: 1, maximum: 32 },
    }, description: 'stopIf にそのまま渡す。既に満たしていても外さない' },
  },
});

type PurposeFailure = 'invalid_input' | 'unobserved' | 'no_table' | 'cannot_place' | 'ambiguous_table' | 'missing' | 'time_limit';
export type PurposePlan = { ok: true; input: ActInput; maxMs: number; table: ActPos }
  | { ok: false; code: PurposeFailure; text: string; missing?: readonly Material[] };
const refused = (code: PurposeFailure, text: string): PurposePlan => ({ ok: false, code, text });
const sameCell = (a: ActPos, b: ActPos): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/**
 * One purpose, one immutable sequence. No IO, clock, target search, permission widening, pickup or retry.
 * Only the requested cell is approached/placed. Unknown map cells are refused, never treated as empty.
 * `craft` is deliberate: `make` may place another table when the requested one disappears. The narrow
 * primitive fails instead, and direct recipe materials are checked before *any* hand is sent.
 */
export function purposeHands(input: unknown, frame: BodyObservation | null): PurposePlan {
  if (!validSkillInput(input, PURPOSE_INPUT_SCHEMA)) return refused('invalid_input', '目的の引数が形式に合わない（品・数・作業台・設置許可・上限秒・中止条件が必要）');
  const purpose = input as MakeAtPurpose;
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(purpose.item)) return refused('invalid_input', 'item は名前空間なしの品の id');
  const recipe = recipeOf(purpose.item);
  if (!recipe) return refused('invalid_input', `材料を数えられるレシピが無い: ${purpose.item}`);
  const facts = doneFacts(frame);
  const world = frame?.state.world as { localMap?: string; inventory?: unknown } | undefined;
  const layers = typeof world?.localMap === 'string' ? readLayers(world.localMap, BODY_RULES) : null;
  if (!frame?.connected || !facts?.feet || !layers) return refused('unobserved', '現在の位置と作業台のマスを観測できない。体には何も送らない');
  if (!world?.inventory || typeof world.inventory !== 'object') return refused('unobserved', '現在の持ち物を観測できない。材料不足とは決めず、体には何も送らない');
  const feet = facts.feet, cell = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
  if (!sameCell(cell, layers.feet)) return refused('unobserved', '地図と現在の足のマスが一致しない。体には何も送らない');
  const table = purpose.table === 'place_here' ? { ...cell, x: cell.x + 1 } : { ...purpose.table };
  const view = mapView(layers), there = view.symbol(table.x, table.y, table.z);
  if (there === undefined || there === '?') return refused('unobserved', '指定の作業台のマスは未観測。別の作業台は選ばない');
  const placing = there !== 'T';
  if (placing && !purpose.allowPlace) return refused('no_table', '指定マスに作業台が無い。allowPlace=false なので設置せず止める');
  if (placing) {
    const under = view.symbol(table.x, table.y - 1, table.z);
    if (!['.', '*'].includes(there) || !under || !SOLID.has(under)
      || (table.x === cell.x && table.z === cell.z && (table.y === cell.y || table.y === cell.y + 1))) {
      return refused('cannot_place', '指定マスは空気と固い支えを確認できないか、自分が立っている。別の設置場所は選ばない');
    }
  }
  // Go's contract permits range <=4, inside the crafting reach of 4.5m. No dig/place authority is added.
  const distance = Math.hypot(feet.x - table.x, feet.y - table.y, feet.z - table.z);
  const walking = distance > TABLE_REACH_METERS;
  if (walking && purpose.maxSeconds < 5) return refused('time_limit', '移動する go の最小上限は5秒。maxSeconds を増やさず止める');
  // craft has no table argument. Do not silently let it select another visible table in reach, including
  // any table that could be reached from go's stopping sphere. This is a refusal, never a target choice.
  for (const [y, layer] of layers.layers) for (const [key, symbol] of layer) {
    if (symbol !== 'T') continue;
    const [x, z] = key.split(',').map(Number), other = { x: x!, y, z: z! };
    const center = walking ? table : feet, reach = TABLE_REACH_METERS + (walking ? 4 : 0);
    if (!sameCell(other, table) && Math.hypot(center.x - other.x, center.y - other.y, center.z - other.z) <= reach) {
      return refused('ambiguous_table', '指定台以外にも届く作業台が見える。craft は台を指定できないので、別の台を選ばず止める');
    }
  }

  const needs = new Map<string, number>();
  const add = (material: Material, batches: number) => needs.set(material.item, (needs.get(material.item) ?? 0) + material.count * batches);
  for (const material of recipe.needs) add(material, Math.ceil(purpose.count / recipe.yields));
  const makeTable = placing && carried(facts.counts, 'crafting_table') < 1;
  if (makeTable) for (const material of recipeOf('crafting_table')!.needs) add(material, 1);
  else if (placing) add({ item: 'crafting_table', count: 1 }, 1);
  const missing = [...needs].flatMap(([item, n]) => {
    const shortage = n - carried(facts.counts, item);
    return shortage > 0 ? [{ item, count: shortage }] : [];
  });
  if (missing.length) return { ok: false, code: 'missing', missing,
    text: `材料不足: ${missing.map(part => `${part.item} が ${part.count} 個不足`).join('、')}。移動・設置・作成はせず止める` };

  const hands: ActHand[] = [];
  const append = (hand: ActHand) => hands.push({ ...hand, onFail: 'stop', ...(hands.length ? { dependsOn: [hands.length] } : {}) });
  if (walking) append({ do: 'go', to: table, range: 4, seconds: Math.min(120, purpose.maxSeconds), maxDig: 0, maxPlace: 0 });
  if (makeTable) append({ do: 'craft', item: 'crafting_table', count: 1 });
  if (placing) append({ do: 'place', block: 'crafting_table', at: [table] });
  append({ do: 'craft', item: purpose.item, count: purpose.count });
  // The body checks the same material counts again immediately before starting. Anchor place_here (and
  // every other expansion) to this frame so an intervening move cannot silently change its meaning.
  const pre: ActClause[] = [...needs].map(([item, n]) => ({ k: 'have', item, n }));
  pre.push({ k: 'at', ...feet, r: 0.25 });
  return { ok: true, table, maxMs: Math.floor(purpose.maxSeconds * 1000), input: { hands,
    pre: [pre], stopIf: { ...purpose.abortIf }, why: `指定作業台で ${purpose.item} を ${purpose.count} 個作る` } };
}
