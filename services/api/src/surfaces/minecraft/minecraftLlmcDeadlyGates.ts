import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { foodPointsWords } from './minecraftFoodWords.js';
import { portalCellHand } from './minecraftLlmcGateEntry.js';
import { readLayers } from './minecraftLlmcPreflightMap.js';
import { BEFORE_END } from './minecraftLlmcPrepRules.js';
import { lackOfTable, readinessOf, recoveryLine } from './minecraftLlmcReadiness.js';

/**
 * The deadly gates, in `gateHold`'s form (the coordinator's list for 11/4, item 2; the owner: a death after the iron gear is out): the hand that
 * goes in is held, as the portal hand is, while what the place needs is missing, and the line names what is missing and what going on costs. How
 * to gather it is the decision's. Two places:
 * - the blaze spawner (the Nether): a fight or an attack on a blaze when none is within 16 m (the hand that begins it), and a go or a walk that ends
 *   within 8 m of a spawner (`S` of the map) from farther than 10 m: health 20, hunger 18, 150 food points carried, a shield (S2's loads carried one).
 * - the End: a walk that ends in an end portal cell (`e`): blocks to stand and cover on, the water bucket, four beds, 80 food points
 *   (`BEFORE_END`).
 * The body's own version (S2's) is not read: the frame has no field for it.
 */
export interface DeadlyHold { hand: number; kind: string; line: string }
const BLAZE_RISK = 'ブレイズの火の玉と炎の傷が重なる。体力・満腹度・食料・盾が足りないと足場で死に、ここまでの装備と時間を失う。作れない・材料が無いと見えた時は、後回しにせず取りに行く';
const AGAIN = 'そろえてからもう一度出す（理由を書いても省けない。どう取るかは自分で決める）';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
type Facts = NonNullable<ReturnType<typeof readinessOf>>;
type Cell = { x: number; y: number; z: number };
const objectOf = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' ? value as Record<string, unknown> : null;

/** The live lists of the frame (`#id name 12.3m …`), as strings. */
const liveLines = (world: Record<string, unknown>): string[] => [world.threats, world.urgent]
  .flatMap(list => Array.isArray(list) ? list : []).filter((line): line is string => typeof line === 'string');

/** The blazes of the live lists within `meters`. */
const blazesWithin = (world: Record<string, unknown>, meters: number): number => liveLines(world)
  .filter(line => Number(/^#\d+ blaze ([\d.]+)m/u.exec(line)?.[1] ?? Infinity) <= meters).length;

/** What the blaze spawner needs and the body does not have, in words (each with the way it is usually made up), or null. */
export function blazeLack(facts: Facts): string | null {
  const shields = [...facts.counts].reduce((sum, [name, count]) => sum + (name === 'shield' ? count : 0), 0);
  const lacks = [facts.health !== null && facts.health < 20 ? `体力 ${facts.health}/20（食べて回復を待つ）` : '',
    facts.hunger !== null && facts.hunger < 18 ? `満腹度 ${facts.hunger}/18（食べる）` : '',
    facts.food < 150 ? `持ち物の食料 ${foodPointsWords(facts.food, 150)}（焼く・狩る・拾う）` : '',
    shields < 1 ? '盾 0/1（板 6 と鉄 1 で作業台で作る。作れない時は missing の行を読んで材料を取る）' : ''].filter(Boolean);
  const head = '未達の必須（ブレイズの湧き場に入る前に必ず）';
  return lacks.length ? `${head}— ${lacks.join('・')}。欠けたまま進むと: ${BLAZE_RISK}` : null;
}

const cellOf = (value: unknown): Cell | null => {
  const at = objectOf(value);
  return at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } : null;
};

/** Whether a hand is a fight or an attack on a blaze (named, or the id of a blaze of the live lists). */
function onBlaze(hand: Record<string, unknown>, world: Record<string, unknown>): boolean {
  if (hand.do !== 'fight' && hand.do !== 'attack') return false;
  const target = typeof hand.target === 'string' ? hand.target : '';
  const id = /^#(\d+)$/u.exec(target)?.[1];
  return /blaze/u.test(target) || (id !== undefined && liveLines(world).some(line => line.startsWith(`#${id} blaze `)));
}

/** The spawners (`S`) the map shows. */
function spawnersOf(map: unknown): Cell[] {
  const layers = typeof map === 'string' ? readLayers(map) : null;
  const out: Cell[] = [];
  for (const [y, cells] of layers?.layers ?? []) {
    for (const [key, symbol] of cells) if (symbol === 'S') out.push({ x: Number(key.split(',')[0]), y, z: Number(key.split(',')[1]) });
  }
  return out;
}
const near = (a: Cell, b: Cell, meters: number): boolean => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= meters;

/** The cell a go or a walk ends at (relative cells counted from her feet). */
function endOf(hand: Record<string, unknown>, feet: Cell): Cell | null {
  const named = hand.do === 'go' ? hand.to : hand.do === 'walk' ? (Array.isArray(hand.path) && hand.path.length ? hand.path.at(-1) : hand.to) : null;
  const end = cellOf(named);
  return end && hand.rel === true ? { x: feet.x + end.x, y: feet.y + end.y, z: feet.z + end.z } : end;
}

/** The first go or walk that ends within 8 m of a spawner while she stands farther than 10 m from it. */
function nearSpawnerHand(hands: readonly unknown[], world: Record<string, unknown>): number {
  const feet = cellOf(world.position), spawners = spawnersOf(world.localMap);
  if (!feet || !spawners.length || spawners.some(spawner => near(spawner, feet, 10))) return -1;
  return hands.findIndex(raw => {
    const end = endOf(objectOf(raw) ?? {}, feet);
    return end !== null && spawners.some(spawner => near(spawner, end, 8));
  });
}

/** The first hand (0-based) that begins the blaze fight or goes up to a spawner, or -1. */
function blazeEntryHand(input: unknown, facts: Facts): number {
  const hands = (input as { hands?: unknown } | null)?.hands;
  if (!Array.isArray(hands)) return -1;
  const fresh = blazesWithin(facts.world, 16) === 0;
  const fight = fresh ? hands.findIndex(raw => onBlaze(objectOf(raw) ?? {}, facts.world)) : -1;
  return fight >= 0 ? fight : nearSpawnerHand(hands, facts.world);
}

const LOW_HEALTH = 8;
const NEAR_HOSTILE_METERS = 8;

/**
 * Mining with almost no health (the isolated lab of 11/3: `eat` and `mine iron_ore` at 5.7, a skeleton came to a metre, and the body dropped the
 * `stopIf hpBelow 7` as already true): a `mine` hand is held below `LOW_HEALTH` while nothing hostile is within `NEAR_HOSTILE_METERS`. With an enemy
 * near, the hands that fight or flee are the decision's; eating comes first and a meal does not heal by itself.
 */
function lowHealthHold(input: unknown, facts: Facts): DeadlyHold | null {
  const hands = (input as { hands?: unknown } | null)?.hands;
  if (!Array.isArray(hands) || facts.health === null || facts.health >= LOW_HEALTH) return null;
  if (liveLines(facts.world).some(line => Number(/^#\d+ \S+ ([\d.]+)m/u.exec(line)?.[1] ?? Infinity) <= NEAR_HOSTILE_METERS)) return null;
  const at = hands.findIndex(raw => objectOf(raw)?.do === 'mine');
  if (at < 0) return null;
  const back = recoveryLine(facts.hunger, facts.health, facts.food, facts.counts) ?? `体力 ${facts.health}/20`;
  const line = `体力が ${LOW_HEALTH} を切っている間は掘る手を送らない。${back}。回復してからもう一度出す（どう回復するかは自分で決める）`;
  return { hand: at + 1, kind: 'mine', line };
}

/** The hold of the deadly gate the act goes into, or null (nothing held). */
export function deadlyGateHold(input: unknown, frame: BodyObservation | null): DeadlyHold | null {
  const facts = readinessOf(frame);
  if (!facts) return null;
  const weak = lowHealthHold(input, facts);
  if (weak) return weak;
  if (facts.dimension === 'the_nether') {
    const at = blazeEntryHand(input, facts), lack = at >= 0 ? blazeLack(facts) : null;
    return lack ? { hand: at + 1, kind: 'fight', line: `ブレイズの湧き場へ入る手は送らない。${lack}。${AGAIN}` } : null;
  }
  const at = facts.dimension === 'overworld' ? portalCellHand(input, frame, 'e') : -1;
  const lack = at >= 0 ? lackOfTable(facts, BEFORE_END) : null;
  return lack ? { hand: at + 1, kind: 'walk', line: `エンドへ入る手は送らない。${lack}。${AGAIN}` } : null;
}
