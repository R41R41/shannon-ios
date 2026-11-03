import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { foodPointsWords } from './minecraftFoodWords.js';
import { wornItems } from './minecraftItems.js';
import { portalCellHand } from './minecraftLlmcGateEntry.js';
import { readLayers } from './minecraftLlmcPreflightMap.js';
import { BEFORE_END, GOLD_ARMOUR, GOLD_FOR_BOOTS } from './minecraftLlmcPrepRules.js';
import { enteringHand, FULLNESS, lackOfTable, readinessOf, recoveryLine } from './minecraftLlmcReadiness.js';

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
const OTHER_STAGE = 'ブレイズの段が進められない間は、先にパールなど他の段の節へ今の節を移して進めてよい'
  + '（plan.update の current。飛ばした節は順のまま残る）';
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
export function blazeLack(facts: Pick<Facts, 'health' | 'hunger' | 'food' | 'counts'>): string | null {
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
/** The hands that are work, not defence: held below `LOW_HEALTH` whether an enemy is near or not (fighting, fleeing, eating, getting into cover go). */
const WORK_HANDS: ReadonlySet<string> = new Set(['mine', 'dig', 'make', 'craft', 'smelt', 'furnace', 'chest', 'obsidian', 'drop', 'pickup']);

const isFood = (name: unknown): boolean => typeof name === 'string' && Object.hasOwn(FULLNESS, name.replace(/^minecraft:/u, ''));
const foodItems = (hand: Record<string, unknown>): boolean => Array.isArray(hand.items) && hand.items.length > 0
  && hand.items.every(entry => isFood(objectOf(entry)?.item));

/**
 * The work that makes the recovery: food made, cooked, taken from a furnace or a chest (review of 11/3: at 5 health with wheat and a table, `make bread` was
 * refused and health could never come back to 8), and the golden armour made (the piglins' gate asks for it first). These go through whatever the health.
 */
function foodWork(hand: Record<string, unknown>): boolean {
  if (hand.do === 'make' || hand.do === 'craft') return isFood(hand.item) || (typeof hand.item === 'string' && GOLD_ARMOUR.test(hand.item));
  if (hand.do === 'furnace') return hand.op === 'take' || hand.op === 'look';
  if (hand.do === 'smelt') return foodItems(hand);
  return hand.do === 'chest' && (hand.op === 'look' || (hand.op === 'take' && foodItems(hand)));
}

/**
 * Work with almost no health (the isolated lab of 11/3: `eat` and `mine iron_ore` at 5.7, a skeleton came to a metre, and the body dropped the
 * `stopIf hpBelow 7` as already true; the first form of this hold let it pass with an enemy near, which is the very case): the first work hand is
 * held below `LOW_HEALTH` (food made, cooked or taken is not work: `foodWork`), an `eat` before it too (the meal does not heal by itself).
 * Fighting, fleeing, eating, equipping and getting into cover are the decision's.
 */
function lowHealthHold(input: unknown, facts: Facts): DeadlyHold | null {
  const hands = (input as { hands?: unknown } | null)?.hands;
  if (!Array.isArray(hands) || facts.health === null || facts.health >= LOW_HEALTH) return null;
  const at = hands.findIndex(raw => WORK_HANDS.has(String(objectOf(raw)?.do ?? '')) && !foodWork(objectOf(raw) ?? {}));
  if (at < 0) return null;
  const back = recoveryLine(facts.hunger, facts.health, facts.food, facts.counts) ?? `体力 ${facts.health}/20`;
  const line = `体力が ${LOW_HEALTH} を切っている間は掘る・作る・拾うなどの作業の手を送らない（敵が近くても）。${back}。`
    + '戦う・逃げる・食べる・遮蔽に入る手は出せる。回復してから作業をもう一度出す（どう回復するかは自分で決める）';
  return { hand: at + 1, kind: 'work', line };
}

/**
 * The hands the piglins' gate holds: the travel of the search (the way to the blazes and the pearls). A retreat, cover, a meal, the food taken from a chest
 * and the golden armour made are not held (review of 11/4: at 5 health a retreating `go`, a `place` for cover and a `chest take` of bread were refused).
 */
const GOLD_FIRST_HANDS: ReadonlySet<string> = new Set(['go', 'walk', 'vertical']);
/** Below this health, or with an enemy near, a move is a retreat and goes through. */
const GOLD_FIRST_HEALTH = 12;
const threatened = (world: Record<string, unknown>): boolean => [world.nearbyThreats, world.threats].some(list => Array.isArray(list) && list.length > 0);

/**
 * Piglins turn on a body with no golden piece worn (run59, 11/3 14:15: dead in the Nether to a piglin; the boots were never made, one ingot in the pack).
 * In the Nether with none worn and the means in the pack (a golden piece carried, or four ingots for the boots), the travel of the search is held
 * while she is well and nothing is near: the armour comes first. Without the means in the pack nothing is held (the way to gold is the
 * decision's).
 */
function goldFirstHold(input: unknown, facts: Facts): DeadlyHold | null {
  const hands = (input as { hands?: unknown } | null)?.hands;
  if (!Array.isArray(hands) || facts.dimension !== 'the_nether') return null;
  if (wornItems(facts.world.worn).some(name => GOLD_ARMOUR.test(name))) return null;
  const piece = [...facts.counts].find(([name, count]) => GOLD_ARMOUR.test(name) && count > 0)?.[0];
  const ingots = facts.counts.get('gold_ingot') ?? 0;
  if (!piece && ingots < GOLD_FOR_BOOTS) return null;
  if (facts.health !== null && facts.health < GOLD_FIRST_HEALTH) return null;
  if (threatened(facts.world)) return null;
  const at = hands.findIndex(raw => GOLD_FIRST_HANDS.has(String(objectOf(raw)?.do ?? '')));
  if (at < 0) return null;
  const means = piece ? `持っている ${piece} を equip で着る`
    : `金の延べ棒 ${ingots} 個でブーツを作って着る（${GOLD_FOR_BOOTS} 個で 1 足）`;
  const line = `金の防具を着ていない間はピグリンが襲う。先に着る前に探索の移動（go・walk・vertical）は送らない: ${means}。`
    + '着てからもう一度出す（どう着るかは自分で決める）';
  return { hand: at + 1, kind: 'gold', line };
}

/** The hold of the deadly gate the act goes into, or null (nothing held). */
export function deadlyGateHold(input: unknown, frame: BodyObservation | null): DeadlyHold | null {
  const facts = readinessOf(frame);
  if (!facts) return null;
  const weak = lowHealthHold(input, facts) ?? goldFirstHold(input, facts);
  if (weak) return weak;
  if (facts.dimension === 'the_nether') {
    const at = blazeEntryHand(input, facts), lack = at >= 0 ? blazeLack(facts) : null;
    return lack ? { hand: at + 1, kind: 'fight', line: `ブレイズの湧き場へ入る手は送らない。${lack}。${AGAIN}。${OTHER_STAGE}` } : null;
  }
  const goldGate = facts.dimension === 'overworld' ? goldAtPortalHold(input, frame, facts) : null;
  if (goldGate) return goldGate;
  const at = facts.dimension === 'overworld' ? portalCellHand(input, frame, 'e') : -1;
  const lack = at >= 0 ? lackOfTable(facts, BEFORE_END) : null;
  return lack ? { hand: at + 1, kind: 'walk', line: `エンドへ入る手は送らない。${lack}。${AGAIN}` } : null;
}

/**
 * The hand that enters the Nether (the portal hand, or a go or a walk into a lit portal cell) is held while no golden piece is worn: the piglins
 * turn on a body without one (run59, 11/3 14:15, dead to a piglin; the boots were a goal in the table and were never made). The line says what
 * is in the pack toward it.
 */
function goldAtPortalHold(input: unknown, frame: BodyObservation | null, facts: Facts): DeadlyHold | null {
  const hands = (input as { hands?: unknown } | null)?.hands;
  const portal = enteringHand(hands), at = portal >= 0 ? portal : portalCellHand(input, frame);
  if (at < 0 || wornItems(facts.world.worn).some(name => GOLD_ARMOUR.test(name))) return null;
  const piece = [...facts.counts].find(([name, count]) => GOLD_ARMOUR.test(name) && count > 0)?.[0];
  const ingots = facts.counts.get('gold_ingot') ?? 0, raw = facts.counts.get('raw_gold') ?? 0;
  const have = piece ? `持っている ${piece} を equip で着る`
    : `金の延べ棒 ${ingots} 個・生の金 ${raw} 個（ブーツは延べ棒 ${GOLD_FOR_BOOTS} 個。生の金はかまどで焼く）`;
  const line = `ネザーへ入る手は送らない。金の防具を 1 つ着ていない（ピグリンが襲う）: ${have}。${AGAIN}`;
  return { hand: at + 1, kind: 'portal', line };
}
