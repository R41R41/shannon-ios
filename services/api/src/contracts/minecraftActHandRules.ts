import { handDependsProblem } from './continueContract.js';
import { VERTICAL_DIRS, VERTICAL_LIQUIDS, VERTICAL_SHAPES, VERTICAL_TOWARDS, type ActHand, type HandKind } from './minecraftActContract.js';

/**
 * What each kind of hand takes and the checks a kind adds (the schema of `mc.act` is the widest of any kind; this is where a kind's own ranges are kept).
 */
/** What each kind takes: required fields, then the optional ones; any other field is a problem. */
export const HAND_FIELDS: Readonly<Record<HandKind, { needs: readonly (readonly string[])[]; may: readonly string[] }>> = {
  walk: { needs: [['to', 'path']], may: ['sprint', 'range'] },
  go: { needs: [['to', 'goals']], may: ['range', 'canDig', 'canPlace', 'maxDrop', 'waterOk', 'seconds', 'maxDig', 'maxPlace', 'sprint'] },
  dig: { needs: [['at']], may: ['tool', 'collect', 'exposeOk', 'takeOk'] },
  place: { needs: [['at'], ['block']], may: ['face'] },
  pillarUp: { needs: [['n']], may: ['block'] },
  use: { needs: [['item']], may: ['at', 'face', 'target'] },
  look: { needs: [['to', 'yaw']], may: ['pitch'] },
  jump: { needs: [], may: ['n'] },
  sneak: { needs: [['on']], may: [] },
  equip: { needs: [['item']], may: ['slot'] },
  craft: { needs: [['item']], may: ['count'] },
  furnace: { needs: [['at'], ['op']], may: ['item', 'count', 'fuel', 'fuelCount'] },
  chest: { needs: [['at'], ['op']], may: ['items'] },
  attack: { needs: [['target']], may: ['untilDead', 'seconds', 'hold'] },
  shoot: { needs: [['target', 'at']], may: ['item', 'charge', 'n'] },
  eat: { needs: [], may: ['item'] },
  drop: { needs: [['items']], may: ['target', 'at'] },
  pickup: { needs: [], may: ['target', 'range'] },
  wait: { needs: [['seconds']], may: [] },
  obsidian: { needs: [['at']], may: ['count', 'seconds', 'canPlace', 'maxPlace'] },
  fight: { needs: [['target']], may: ['stance', 'item', 'retreatHp', 'range', 'seconds'] },
  mine: { needs: [['block'], ['at']], may: ['count', 'tool', 'collect', 'seconds', 'canDig', 'maxDig'] },
  make: { needs: [['item']], may: ['count'] },
  portal: { needs: [['at'], ['axis']], may: ['block', 'enter', 'canPlace', 'maxPlace', 'seconds'] },
  smelt: { needs: [['items']], may: ['fuel', 'fuelCount', 'furnaces', 'at', 'seconds'] },
  vertical: { needs: [['dir'], ['shape'], ['toY'], ['canDig'], ['liquid']], may: ['toward', 'maxDig', 'canPlace', 'maxPlace', 'range', 'seconds'] },
};
const COMMON = new Set(['do', 'rel', 'note', 'onFail', 'dependsOn']);
/** The fields a kind of hand takes (needed, then optional, then the common ones), for a refusal that names them. */
export function handFieldNames(kind: HandKind): string[] {
  const fields = HAND_FIELDS[kind];
  return fields ? [...fields.needs.flat(), ...fields.may, 'rel', 'note', 'onFail'] : [];
}
/**
 * Continue contract 2: a hand's `dependsOn` is a list of the numbers of earlier hands of the same act (1 up). Itself, a later hand, a number out of range and a number
 * twice are refused before the body sees them (`handDependsProblem`); the list is of whole numbers. `index` is the hand's own number (1 up), `count` the hands in the act.
 */
export function dependsProblem(index: number, hand: ActHand, count: number): string | null {
  if (hand.dependsOn === undefined) return null;
  if (!Array.isArray(hand.dependsOn)) return 'dependsOn は手の番号の並び（何にも頼らないなら []）';
  return handDependsProblem(index, hand.dependsOn, count);
}
const ONE_AT: ReadonlySet<HandKind> = new Set(['use', 'furnace', 'chest', 'shoot', 'drop']);
/** The blocks a hand may be given in `canDig` / `canPlace` / `block`: ids in lower case, or the words stone, dirt, sand and wood. */
const BLOCK_NAME = /^[a-z][a-z0-9_]{0,39}$/u;

/** What is wrong with an act's hands beyond the schema (a field a kind does not take, a missing one), or null. Closed words, Japanese. */

export function handProblem(hand: ActHand): string | null {
  const fields = HAND_FIELDS[hand.do];
  if (!fields) return 'do が分からない';
  const allowed = new Set([...COMMON, ...fields.may, ...fields.needs.flat()]);
  const extra = Object.keys(hand).filter(key => !allowed.has(key));
  if (extra.length) return `${extra.join('・')} は使えない（${hand.do} の欄: ${handFieldNames(hand.do).join('・')}）`;
  const missing = fields.needs.find(group => !group.some(key => (hand as unknown as Record<string, unknown>)[key] !== undefined));
  if (missing) return `${missing.join(' か ')} が要る`;
  if (ONE_AT.has(hand.do) && hand.at && hand.at.length !== 1) return 'at は 1 つ';
  return KIND_CHECKS[hand.do]?.(hand) ?? null;
}
const KIND_CHECKS: Partial<Record<HandKind, (hand: ActHand) => string | null>> = {
  furnace: hand => !['put', 'take'].includes(hand.op!) ? 'op は put か take' : hand.op === 'put' && !hand.item && !hand.fuel ? 'put には item か fuel' : null,
  chest: hand => hand.op === 'put' && !hand.items?.length ? 'put には items' : null,
  wait: hand => hand.seconds! < 0.5 || hand.seconds! > 30 ? 'seconds は 0.5〜30' : null,
  attack: hand => hand.seconds !== undefined && hand.seconds > 30 ? 'seconds は 30 まで' : null,
  go: goProblem,
  obsidian: hand => seconds(hand, 5, 120) ?? (hand.at!.length > 8 ? 'at は溶岩の源のマス 8 つまで' : null) ?? count(hand, 64) ?? names(hand),
  fight: hand => seconds(hand, 5, 60) ?? (hand.range !== undefined && hand.range > 16 ? 'range は 0〜16' : null),
  mine: hand => seconds(hand, 5, 120) ?? count(hand, 64) ?? (hand.at!.length > 4 ? 'at は鉱脈のマス 4 つまで（つながった同じ種類を体がたどる）' : null)
    ?? (BLOCK_NAME.test(hand.block!) ? null : 'block はブロックの id（例 iron_ore）') ?? names(hand),
  make: hand => count(hand, 64),
  portal: hand => seconds(hand, 5, 120) ?? (hand.at!.length !== 1 ? 'at は枠の内側の左下のマス 1 つ' : null) ?? names(hand),
  vertical: verticalProblem,
  smelt: hand => seconds(hand, 5, 60) ?? (hand.items!.length < 1 || hand.items!.length > 4 ? 'items は 1〜4 種類' : null)
    ?? (hand.items!.some(entry => entry.count === undefined) ? 'items には個数が要る' : null) ?? (hand.at !== undefined && hand.at.length > 4 ? 'at は 4 つまで' : null),
};
/** A hand's `seconds` within a kind's own range. */
const seconds = (hand: ActHand, least: number, most: number): string | null =>
  hand.seconds !== undefined && (hand.seconds < least || hand.seconds > most) ? `seconds は ${least}〜${most}` : null;
const count = (hand: ActHand, most: number): string | null => hand.count !== undefined && hand.count > most ? `count は ${most} まで` : null;
/** The names a hand lists (`canDig`, `canPlace`) are block ids. */
const names = (hand: ActHand): string | null => [...(hand.canDig ?? []), ...(hand.canPlace ?? [])].some(name => !BLOCK_NAME.test(name))
  ? 'canDig・canPlace はブロックの id（小文字の英字と _）か stone・dirt・sand・wood' : null;
const oneOf = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);
/**
 * vertical (continue contract 6): a way and a form that do not fit each other are refused before the body sees them (the head checks the combination, it never
 * mends it): `shaft` goes down only, `pillar` goes up only, `stairs` needs `toward` and the other two take none, `canDig` is written, and the ranges.
 * `rel` is not taken: `toY` is the feet's own y.
 */
function verticalProblem(hand: ActHand): string | null {
  if (hand.rel !== undefined) return 'rel は使えない（toY は足の y そのもの）';
  if (!oneOf(VERTICAL_DIRS, hand.dir)) return 'dir は down か up';
  if (!oneOf(VERTICAL_SHAPES, hand.shape)) return 'shape は stairs・shaft・pillar';
  if (hand.shape === 'shaft' && hand.dir !== 'down') return 'shaft は down だけ（上るなら pillar か stairs）';
  if (hand.shape === 'pillar' && hand.dir !== 'up') return 'pillar は up だけ（下りるなら shaft か stairs）';
  if (hand.shape === 'stairs' && hand.toward === undefined) return 'stairs には toward（north・east・south・west）が要る';
  if (hand.shape !== 'stairs' && hand.toward !== undefined) return `${hand.shape} に toward は使わない（stairs だけ）`;
  if (hand.toward !== undefined && !oneOf(VERTICAL_TOWARDS, hand.toward)) return 'toward は north・east・south・west';
  if (!oneOf(VERTICAL_LIQUIDS, hand.liquid)) return 'liquid は stop・seal・seal_water';
  if (!Number.isInteger(hand.toY) || hand.toY! < -64 || hand.toY! > 320) return 'toY は -64〜320 の整数';
  if (!hand.canDig?.length || hand.canDig.length > 12) return hand.canDig?.length ? 'canDig は 12 種類まで' : 'canDig が要る（掘ってよい物。pillar でも頭の上を掘るのに使う）';
  if (hand.canPlace !== undefined && (hand.canPlace.length < 1 || hand.canPlace.length > 6)) return 'canPlace は 1〜6 種類';
  if (hand.maxDig !== undefined && !(Number.isInteger(hand.maxDig) && hand.maxDig >= 0 && hand.maxDig <= 200)) return 'maxDig は 0〜200 の整数';
  if (hand.maxPlace !== undefined && !(Number.isInteger(hand.maxPlace) && hand.maxPlace >= 0 && hand.maxPlace <= 100)) return 'maxPlace は 0〜100 の整数';
  if (hand.range !== undefined && !(Number.isInteger(hand.range) && hand.range >= 1 && hand.range <= 2)) return 'range は 1 か 2';
  return seconds(hand, 5, 120) ?? names(hand);
}
/** go's fields against its limits (the schema's ranges are the widest of any kind): where to, the allowed blocks, the time and the counts. */
function goProblem(hand: ActHand): string | null {
  if (hand.to !== undefined && hand.goals !== undefined) return 'to と goals は片方だけ（候補を並べるなら goals）';
  if (hand.goals !== undefined && (hand.goals.length < 2 || hand.goals.length > 8)) return 'goals は 2〜8 マス（1 つなら to）';
  if (hand.range !== undefined && (hand.range < 0 || hand.range > 4)) return 'range は 0〜4';
  if (hand.seconds !== undefined && (hand.seconds < 5 || hand.seconds > 120)) return 'seconds は 5〜120';
  return names(hand);
}

