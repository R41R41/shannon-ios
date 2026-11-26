import { rec,finite,one,cell,world,holderLine } from './minecraftLlmcHealth.js';
import type { PlanKind, PlanPromise } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActHand,ActInput,ActPos } from '../../contracts/minecraftActContract.js';
import { readActResult } from '../../contracts/minecraftActContract.js';
import { carriedItemCounts,EDIBLE_FOOD } from './minecraftItems.js';
import { FOOD_POINTS,stacks } from './minecraftLlmcLive.js';
import { markDelivered,offer,pending,type OnceFact } from './minecraftLlmcOnceFacts.js';
import { fightLines } from './minecraftLlmcFightFacts.js';
import { dropAdvice,FULL_COST,packFacts,PACK_SLOTS,reportedFree } from './minecraftLlmcPack.js';
import { heldBack,promiseLines } from './minecraftLlmcPromises.js';
import { FOOD_FISH,nearNeeds } from './minecraftLlmcReachWords.js';
import { PLAN_FACTS_KEY,type PlanFacts } from './minecraftPlanFacts.js';
import { round1 } from './minecraftTransientObservation.js';
import { foodChoices, foodYieldWords, huntWeaponIn } from './minecraftFoodAcquisition.js';
import { furnaceFoodOf } from './minecraftFoodWords.js';
import { nearbyLines, nearbyResourcesOf } from './minecraftLlmcNearby.js';
import { agedScan } from './minecraftLlmcScanAge.js';
import { scaffoldLine } from './minecraftLlmcDetour.js';
import { AIRISH, readLayers, type Layers } from './minecraftLlmcPreflightMap.js';
import { burnLine, lavaNearLine, routeEnemiesLine, type Goal } from './minecraftLlmcHazardFacts.js';
export { FACT_WINDOW_MS, controlOf, lifeOf, holderWords, holderLine, createHitWatch } from './minecraftLlmcHealth.js';
export type { Hit, HitWatch } from './minecraftLlmcHealth.js';
/** The creatures that are food are listed within this many metres (the near words' own reach for food animals). */
export const FOOD_NEAR_METERS = 24;
/** Food candidates an urgent or shortened input keeps; the normal input lists up to `FOOD_NORMAL_MAX`, and at
 * least this many when there are. */
export const FOOD_KEPT = 3, FOOD_NORMAL_MAX = 6;

// ---- health, hunger and what she can eat

/** The food she carries as 「bread×1（+11 点）」, the best first. */
function foodItems(observation: BodyObservation | null): { text: string; points: number }[] {
  const out: { text: string; points: number }[] = [];
  const w = world(observation);
  for (const [name, count] of carriedItemCounts(w, observation?.facts)) {
    if (!EDIBLE_FOOD.test(name) && !(name in FOOD_POINTS)) continue;
    const each = FOOD_POINTS[name] ?? 2;
    out.push({ text: `${name}×${count}（+${round1(each * count)} 点）`, points: each * count });
  }
  return out.sort((a, b) => b.points - a.points);
}
/**
 * The effects the body reports on itself (`world.effects`: a name, and the time left in seconds or ticks), as 「weakness 残り 23 秒」, five at most, and
 * 「燃えている」 when it is on fire: weakness takes the damage of the sword and a burning body loses health (the coordinator's list for 11/4, item 6).
 * Nothing when the frame has none.
 */
export function effectWords(w: Record<string, unknown>): string[] {
  const list = Array.isArray(w.effects) ? w.effects : [];
  const named = list.flatMap(raw => {
    const effect = rec(raw), name = typeof effect?.name === 'string' ? effect.name : typeof effect?.id === 'string' ? effect.id : null;
    if (!effect || !name) return [];
    const ticks = finite(effect.remainingTicks) ?? finite(effect.durationTicks), seconds = finite(effect.seconds) ?? (ticks === null ? null : ticks / 20);
    return [seconds === null ? name.replace(/^minecraft:/u, '') : `${name.replace(/^minecraft:/u, '')} 残り ${Math.round(seconds)} 秒`];
  });
  return [...named.slice(0, 5), ...w.onFire === true ? ['燃えている'] : []];
}

/** 「体力 6.4/20・満腹 11/20・食べ物 bread×1（+11 点）」. A part the frame does not say is left out; no food is said (「食べ物 無し」)
 * only when the frame lists a pack. */
export function vitalsLine(observation: BodyObservation | null): string | null {
  const w = world(observation), health = finite(w.health), hunger = finite(w.food);
  if (health === null && hunger === null) return null;
  const food = foodItems(observation), listed = Array.isArray(w.inventory) || rec(w.inventory) !== null;
  const flesh = carriedItemCounts(w, observation?.facts).get('rotten_flesh') ?? 0;
  // 11/26: a furnace's cooking is food that is not in the pack (the line said 無し beside 20 porkchops 84 s from done).
  const furnace = furnaceFoodOf(w.jobs, FOOD_POINTS), furnaceNote = furnace ? `（${furnace.words}）` : '';
  return [...health !== null ? [`体力 ${round1(health)}/20`] : [], ...hunger !== null ? [`満腹 ${round1(hunger)}/20`] : [],
    ...food.length ? [`食べ物 ${food.slice(0, 5).map(item => item.text).join('・')}${furnaceNote}`] : listed ? [`${flesh ? '通常の食べ物 無し' : '食べ物 無し'}${furnaceNote}`] : [],
    ...flesh ? [`非常食 rotten_flesh×${flesh}（1個で満腹+4、空腹の効果の恐れ。通常の食料点には含めない）`] : [],
    ...effectWords(w).length ? [`効果 ${effectWords(w).join('・')}`] : []].join('・');
}

const FOOD_ANIMAL = new Set(['cow', 'pig', 'chicken', 'rabbit', 'mooshroom', 'sheep']);
/** The creatures within 24 m that are food: animals and fish, nearest first, as 「cod #501 18.2m (x,y,z)」. */
export function foodCandidates(observation: BodyObservation | null): { name: string; id: number | null; distance: number; at: ActPos | null }[] {
  const list = Array.isArray(world(observation).nearbyEntities) ? world(observation).nearbyEntities as unknown[] : [];
  return list.flatMap(item => {
    const entity = rec(item), distance = finite(entity?.distance);
    if (!entity || typeof entity.name !== 'string' || distance === null || distance > FOOD_NEAR_METERS) return [];
    if (!FOOD_ANIMAL.has(entity.name) && !FOOD_FISH.has(entity.name)) return [];
    const at = rec(entity.position);
    return [{ name: entity.name, id: Number.isInteger(entity.id) ? entity.id as number : null, distance,
      at: at && finite(at.x) !== null ? { x: Math.floor(Number(at.x)), y: Math.floor(Number(at.y)), z: Math.floor(Number(at.z)) } : null }];
  }).sort((a, b) => a.distance - b.distance);
}
/**
 * Whether food is what the situation is short of: the near words' own reading (food level 14 or less, food
 * points under 40, a food node under the plan, the shortage or the
 * recovery naming food), so the candidates and the near lines (`nearWorthy`) agree. `body` is a live body's parts.
 */
export function wantsFood(parts: { fullness: number | null; points: number; shortage?: string | null; recovery?: readonly string[] | null;
   planFacts?: PlanFacts | null }): boolean {
  return nearNeeds({ state: { ...parts.fullness !== null ? { fullness: parts.fullness } : {} }, foodPoints: { total: parts.points },
     ...parts.shortage ? { shortage: parts.shortage } : {},
    ...parts.recovery?.length ? { recovery: [...parts.recovery] } : {}, ...parts.planFacts ? { [PLAN_FACTS_KEY]: parts.planFacts } : {} }).food;
}
/**
 * The village's food from the body: the hay, the fields and the crops of its nearby count (`nearbyResources`, purpose food_village), else the scan's rows (read once, kept; aged and marked as a scan).
 * Said before the animals (run 7: a cow was the first candidate, with points, and the village's hay none, so a cow was hunted bare-handed): the foods that
 * need no fire first, with their points, then the animals with what they need. Null when none is known.
 */
function villageFoodWords(observation: BodyObservation | null): string | null {
  const w = world(observation), at = rec(w.position);
  const feet = at && finite(at.x) !== null && finite(at.y) !== null && finite(at.z) !== null
    ? { x: Math.floor(Number(at.x)), y: Math.floor(Number(at.y)), z: Math.floor(Number(at.z)) } : null;
  const body = nearbyLines(nearbyResourcesOf(w.nearbyResources).filter(item => item.purpose === 'food_village' && item.count > 0), feet);
  const stateAt = Date.parse(observation?.stateAt ?? '');
  // The scan is read once at a spawn: its rows go through `agedScan` (the one judgment of age and base) and are said as a scan, never as what is seen now.
  const scan = agedScan(w.scan, Number.isFinite(stateAt) ? stateAt : null, feet);
  const rows = scan.rows.filter(row => /^(?:干し草|畑|作物)/u.test(row)).slice(0, 3).map(row => row.slice(0, 80));
  const seenHay = (Array.isArray(rec(w.scan)?.rows) ? rec(w.scan)!.rows as unknown[] : []).some(row => typeof row === 'string' && /^干し草/u.test(row));
  // The know-how of hay is not a row: it stays when a row is dropped for its age (she may be standing in the village).
  const knowHow = `（${HAY_KNOW_HOW}）`;
  if (body.length) return `村の食べ物: ${body.map(line => line.replace(/^食料（村）: /u, '')).join('・')}${knowHow}`;
  if (rows.length) return `村の食べ物（${scan.mark}）: ${rows.join('・')}${knowHow}`;
  return seenHay ? `村の食べ物: 干し草などの走査の行は古いので今は未確認${knowHow}` : null;
}
const HAY_KNOW_HOW = '干し草は 1 個でパン 3＝約 33 点・焼かずに食べられる。hay_block→wheat→bread は make。育った作物は収穫';
/** 11/26: six attacks at cod in the water, none reached (the fish flees under water; the reach is 3 m from the eyes): said beside the fish, as the facts of the hand. */
const FISH_NOTE = '（魚は水中で逃げる・attack は目から 3 m 以内でないと届かない）';
export function foodLine(observation: BodyObservation | null, shown: number): string | null {
  const list = foodChoices(foodCandidates(observation), shown, FOOD_FISH);
  const village = villageFoodWords(observation);
  if (!list.length) return village;
  const bare = list.some(item => !FOOD_FISH.has(item.name)) && !huntWeaponIn(carriedItemCounts(world(observation), observation?.facts))
    ? '（狩りは石以上の剣か斧が要る: 今 無し）' : '';
  const animals = `近くの食べ物の候補（${FOOD_NEAR_METERS} m 以内・1個の食料点、経路/回収/個数は未確認）: ${list.map(item =>
    `[${FOOD_FISH.has(item.name) ? '魚' : '陸'}]${item.name}${item.id !== null ? ` #${item.id}` : ''} ${one(item.distance)}m`
      + `${item.at ? ` ${cell(item.at)}` : ''}${foodYieldWords(item.name, FOOD_POINTS)}`).join('・')}${bare}${list.some(item => FOOD_FISH.has(item.name)) ? FISH_NOTE : ''}`;
  return village ? `${village}／${animals}` : animals;
}

// ---- the map's diamonds and the flint (run 9, 11/13: M2, M4)

type Cell3 = { x: number; y: number; z: number };
const feetCell = (w: Record<string, unknown>, layers: Layers | null): Cell3 | null => {
  const at = rec(w.position);
  if (at && [at.x, at.y, at.z].every(value => finite(value) !== null)) return { x: Math.floor(Number(at.x)), y: Math.floor(Number(at.y)), z: Math.floor(Number(at.z)) };
  return layers?.feet ?? null;
};
/** The cells of the map that show a symbol, each with its place. */
function symbolCells(layers: Layers, symbol: string): Cell3[] {
  const out: Cell3[] = [];
  for (const [y, cells] of layers.layers) for (const [key, found] of cells) {
    if (found !== symbol) continue;
    const [x, z] = key.split(',').map(Number);
    out.push({ x: x!, y, z: z! });
  }
  return out;
}
const farFrom = (feet: Cell3 | null, cell: Cell3): number => feet ? Math.round(Math.hypot(cell.x - feet.x, cell.y - feet.y, cell.z - feet.z)) : 0;
/** The diamond ore the map shows, joined where cells touch (a vein). */
function diamondClusters(layers: Layers): Cell3[][] {
  const left = new Map(symbolCells(layers, 'd').map(cell => [`${cell.x},${cell.y},${cell.z}`, cell] as const));
  const clusters: Cell3[][] = [];
  for (const [key, first] of [...left]) {
    if (!left.has(key)) continue;
    left.delete(key);
    const cluster = [first], queue = [first];
    while (queue.length) {
      const at = queue.pop()!;
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
        const next = `${at.x + dx},${at.y + dy},${at.z + dz}` as const, found = left.get(next);
        if (!found) continue;
        left.delete(next);
        cluster.push(found);
        queue.push(found);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}
const DIAMOND_MARK = /ダイヤ\[(?:deepslate_)?diamond_ore\] \((-?\d+),(-?\d+),(-?\d+)\)[^×]*×(\d+)/u;
/** Whether the map shows air within three cells under an ore: she falls through it when the ore is dug out. */
const airBelow = (layers: Layers, cell: Cell3): boolean => [1, 2, 3].some(down => {
  const symbol = layers.layers.get(cell.y - down)?.get(`${cell.x},${cell.z}`);
  return symbol !== undefined && AIRISH.has(symbol);
});
/**
 * Run 9 (11/13, M2): the map showed diamond ore and the three at one place were not told apart from the one far off. While the plan's section is the diamonds'
 * and two or more are in view: the veins (ore touching ore, the three nearest) with their count, the metres, and whether air lies within three cells under any of them.
 * Null with fewer than two in view, or in another section.
 */
export function diamondClusterLine(w: Record<string, unknown>, kinds: readonly PlanKind[] | undefined): string | null {
  if (kinds?.[0] !== 'diamond') return null;
  const layers = readLayers(typeof w.localMap === 'string' ? w.localMap : undefined);
  const feet = feetCell(w, layers);
  const veins = layers ? diamondClusters(layers).map(cluster => {
    const nearest = [...cluster].sort((a, b) => farFrom(feet, a) - farFrom(feet, b))[0]!;
    return { at: nearest, n: cluster.length, far: farFrom(feet, nearest), fall: cluster.some(cell => airBelow(layers, cell)) };
  }) : [];
  if (veins.reduce((sum, vein) => sum + vein.n, 0) >= 2) {
    const shown = veins.sort((a, b) => a.far - b.far).slice(0, 3)
      .map(vein => `(${vein.at.x},${vein.at.y},${vein.at.z}) ${vein.n} 個・${vein.far}m${vein.fall ? '・下が空所（落ちる）' : ''}`);
    return `ダイヤの群れ: ${shown.join('／')}`;
  }
  // The map's grid does not hold them: the body's mark says the nearest and how many are in view.
  const mark = (Array.isArray(w.mapLandmarks) ? w.mapLandmarks : []).flatMap(line => {
    const m = typeof line === 'string' ? DIAMOND_MARK.exec(line) : null;
    return m ? [{ at: { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }, n: Number(m[4]) }] : [];
  })[0];
  return mark && mark.n >= 2 ? `ダイヤの群れ: 最寄り (${mark.at.x},${mark.at.y},${mark.at.z}) を含め見えているのは ${mark.n} 個・${farFrom(feet, mark.at)}m` : null;
}

const FLINT_KINDS: ReadonlySet<PlanKind> = new Set<PlanKind>(['diamond', 'obsidian', 'portal']);
/**
 * Run 9 (11/13, M4; the same count as the obsidian tidy): no flint and no flint and steel while the plan is at the diamonds, the obsidian or the gate: gravel gives
 * flint one dig in ten, and the tidy keeps up to 10 gravel. The nearest sand-or-gravel cell of the map is added when one is in view.
 */
export function flintLine(observation: BodyObservation | null, kinds: readonly PlanKind[] | undefined): string | null {
  if (!kinds?.[0] || !FLINT_KINDS.has(kinds[0])) return null;
  const w = world(observation), counts = carriedItemCounts(w, observation?.facts);
  if ((counts.get('flint') ?? 0) > 0 || (counts.get('flint_and_steel') ?? 0) > 0) return null;
  const layers = readLayers(typeof w.localMap === 'string' ? w.localMap : undefined), feet = feetCell(w, layers);
  const gravel = layers ? symbolCells(layers, 's').sort((a, b) => farFrom(feet, a) - farFrom(feet, b))[0] : undefined;
  return '火打石 0。砂利は掘ると 10% で火打石（10 個で約 35 秒）。片付けは砂利を 10 個まで残す。通り道の砂利を先に掘る'
    + (gravel ? `。見えている砂か砂利（地図 s）の最寄り (${gravel.x},${gravel.y},${gravel.z}) ${farFrom(feet, gravel)}m` : '');
}

/** The lines of the live facts of this section: the diamonds' veins and the flint (the normal version only). */
export function liveFactLines(observation: BodyObservation | null, kinds: readonly PlanKind[] | undefined): string[] {
  return [diamondClusterLine(world(observation), kinds), flintLine(observation, kinds)].filter((line): line is string => !!line);
}

// ---- the pack, and the queue

/** What one hand does, in the hand's own words, for the queue's line: where it goes, what it places, digs, makes,
 * whom it hits. */
function travelEffect(hand: ActHand): string | null {
const where = (at: readonly ActPos[] | undefined, extra = '') => at?.length ? ` ${cell(at[0])}${at.length > 1 ? `ほか ${at.length - 1}` : ''}${extra}` : '';
  const rel = hand.rel ? '（足元からの相対）' : '';
  switch (hand.do) {
case 'go':
case 'walk': return `${hand.do}${hand.to ? ` ${cell(hand.to)}` : hand.goals?.length ? ` ${hand.goals.length} か所のどれか ${cell(
      hand.goals[0])}` : hand.path?.length ? ` ${cell(hand.path.at(-1))}` : ''}${rel}`;
case 'dig': return `dig${where(hand.at, rel)}`;
default: return null;
}
}
function buildingEffect(hand: ActHand): string | null {
const where = (at: readonly ActPos[] | undefined, extra = '') => at?.length ? ` ${cell(at[0])}${at.length > 1 ? `ほか ${at.length - 1}` : ''}${extra}` : '';
  const rel = hand.rel ? '（足元からの相対）' : '';
  switch (hand.do) {
case 'place': return `place ${hand.block ?? ''}${where(hand.at, rel)}`.replace(/\s+/gu, ' ').trim();
case 'pillarUp': return `pillarUp${hand.n ? ` ${hand.n} 段` : ''}${hand.block ? ` ${hand.block}` : ''}`;
case 'vertical': return `vertical ${hand.dir ?? ''} ${hand.shape ?? ''} y=${hand.toY ?? '?'}`.replace(/\s+/gu, ' ');
default: return null;
}
}
function creationEffect(hand: ActHand): string | null {
const where = (at: readonly ActPos[] | undefined, extra = '') => at?.length ? ` ${cell(at[0])}${at.length > 1 ? `ほか ${at.length - 1}` : ''}${extra}` : '';
  const rel = hand.rel ? '（足元からの相対）' : '';
  switch (hand.do) {
case 'make':
case 'craft':
case 'mine': return `${hand.do} ${hand.item ?? hand.block ?? ''}${hand.count && hand.count > 1 ? `×${hand.count}` : ''}`.trim();
case 'smelt': return `smelt ${hand.item ?? ''}${hand.count && hand.count > 1 ? `×${hand.count}` : ''}`.trim();
default: return null;
}
}
function itemEffect(hand: ActHand): string | null {
const where = (at: readonly ActPos[] | undefined, extra = '') => at?.length ? ` ${cell(at[0])}${at.length > 1 ? `ほか ${at.length - 1}` : ''}${extra}` : '';
  const rel = hand.rel ? '（足元からの相対）' : '';
  switch (hand.do) {
case 'eat':
case 'equip':
case 'use': return `${hand.do}${hand.item ? ` ${hand.item}` : ''}`;
case 'chest':
case 'furnace': return `${hand.do}${hand.op ? ` ${hand.op}` : ''}${where(hand.at)}`;
default: return null;
}
}
function targetEffect(hand: ActHand): string | null {
const where = (at: readonly ActPos[] | undefined, extra = '') => at?.length ? ` ${cell(at[0])}${at.length > 1 ? `ほか ${at.length - 1}` : ''}${extra}` : '';
  const rel = hand.rel ? '（足元からの相対）' : '';
  switch (hand.do) {
case 'attack':
case 'fight':
case 'pickup':
case 'shoot': return `${hand.do}${hand.target ? ` ${hand.target}` : ''}`;
case 'hunt': return `hunt${hand.target ? ` ${hand.target}` : ''}${hand.count && hand.count > 1 ? `×${hand.count}` : ''}`;
case 'wait': return `wait${hand.seconds ? ` ${hand.seconds} 秒` : ''}`;
default: return null;
}
}
export function handEffect(hand: ActHand): string {
 return travelEffect(hand) ?? buildingEffect(hand) ?? creationEffect(hand) ?? itemEffect(hand) ?? targetEffect(hand) ?? hand.do;
}
/** The effects of an item's hands, in order (three at most). */
export function inputEffect(input: ActInput): string {
  const hands = input.hands.slice(0, 3).map(handEffect);
  return `${hands.join(' → ')}${input.hands.length > 3 ? ` ほか ${input.hands.length - 3} 手` : ''}${input.repeat &&
     input.repeat > 1 ? `（${input.repeat} 回繰り返す）` : ''}`;
}
const ITEM_LINE = /^(▶|・) /u;
/**
 * The queue's lines with what each item's hands will do (「予定: go (172,-19,236)」) and its time left as 「残り 20 秒（見込み）」 (the queue's
 * own words are 「残り約 20 秒」). `ahead` is the
 * open items' inputs in the queue's order. Nothing is checked against another item's work: that two items aim at the same cell is
 * for the model to see.
 */
export function queueNowLines(lines: readonly string[], ahead: readonly ActInput[]): string[] {
  let at = 0;
  return lines.map(line => {
    if (!ITEM_LINE.test(line)) return line;
    const input = ahead[at++];
    const timed = line.replace(/残り約 (\d+) 秒/u, '残り $1 秒（見込み）');
    return input ? `${timed}${/: /u.test(timed) ? '・' : ': '}予定: ${inputEffect(input)}` : timed;
  });
}

/** What the next hands add to the pack, from the queue's inputs: a make or craft adds its item; a dig or mine,
 * pickup and chest take add what they get. */
export function nextGains(ahead: readonly ActInput[]): string[] {
  const out: string[] = [];
  for (const input of ahead) {
    for (const hand of input.hands) {
const noteNextGain = () => {
      const n = Math.max(1, hand.count ?? 1);
      const createsItems = () => ((hand.do === 'make' || hand.do === 'craft') && hand.item);
      if (createsItems()) out.push(`${hand.do} ${hand.item} で +${n} 個`);
      else if (hand.do === 'mine' && (hand.item ?? hand.block)) out.push(`mine ${hand.item ?? hand.block} で +${n} 個（拾う）`);
      else if (hand.do === 'dig') out.push('dig で掘った物（collect が真なら拾う）');
      else if (hand.do === 'pickup') out.push('pickup で拾う物');
      else if (hand.do === 'hunt') out.push(`hunt${hand.target ? ` ${hand.target}` : ''} の肉・革・羊毛（拾う）`);
      else if (hand.do === 'smelt' && hand.item) out.push(`smelt ${hand.item} の取り出しで増える`);
      else if (hand.do === 'chest' && (hand.op === 'take' || hand.op === 'takeAll')) out.push('chest から取る物');

};
noteNextGain();
}
  }
  return [...new Set(out)].slice(0, 3);
}
const STACK_KIND = /^([a-z_0-9]+)×(\d+)/u;
/** The kinds that take the most slots, from the pack's lines: 「cobbled_deepslate×105（2 マス）」. A kind of one slot
 * is told only when that stack is more than half full. */
function takers(lines: readonly string[]): string[] {
  const kinds = new Map<string, { n: number; slots: number }>();
  for (const line of lines) {
    const match = STACK_KIND.exec(line);
    if (!match) continue;
    const kind = kinds.get(match[1]!) ?? { n: 0, slots: 0 };
    kinds.set(match[1]!, { n: kind.n + Number(match[2]), slots: kind.slots + 1 });
  }
  return [...kinds].filter(([, kind]) => kind.slots >= 2 || kind.n > 32).sort((a, b) => b[1].slots - a[1].slots || b[1].n - a[1].n).slice(0,
     4).map(([name, kind]) => `${name}×${kind.n}（${kind.slots} マス）`);
}
/** Does a hand dig (and so pick up what it digs)? A go that may dig (`canDig`, `maxDig` not 0), a vertical, a mine, a dig. */
const diggingHand = (hand: ActHand): boolean => hand.do === 'vertical' || hand.do === 'mine' || hand.do === 'dig'
  || (hand.do === 'go' && (hand.canDig?.length ?? 0) > 0 && hand.maxDig !== 0);
const toldPack = new Map<string, number>();
/**
 * Run 47 (hold 5: 2 slots free of 36, a go with a lot of digging was sent, and the cobbled deepslate it dug
 * filled the pack a few blocks short of the goal): with 3 free slots or fewer,
 * an act that has a digging hand is answered, beside the line of the queue (nothing is refused), with what that
 * means and what can be dropped before the digging, from the pack's
 * own count (`reportedFree`) and the candidates of the full pack (`dropCandidates`). Said once for a free count:
 * the same count is not said again by the next act.
 */
export function digPackLine(observation: BodyObservation | null, hands: readonly ActHand[] | undefined, promises: readonly PlanPromise[],
   taskId: string): string | null {
  const inventory = world(observation).inventory;
  if (!Array.isArray(inventory) || !hands?.some(diggingHand)) return null;
  const packed = packFacts(stacks(inventory)), free = reportedFree(world(observation).freeSlots) ?? Math.max(0, PACK_SLOTS - packed.used);
  if (free > NEAR_FULL) {
    toldPack.delete(taskId);
    return null;
  }
  if (toldPack.get(taskId) === free) return null;
  toldPack.set(taskId, free);
  if (toldPack.size > 32) toldPack.delete(toldPack.keys().next().value as string);
  const spare = dropAdvice(free === 0 ? packed : { ...packed, worn: [] }, item => heldBack(promises, item));
  return `空き ${free}/${PACK_SLOTS}：掘って出る石・深層岩・土は ${free === 0 ? '1 つも拾えない' : `${free} マスより多くは拾えない`}。`
    + (spare ? `drop で空けられる物（約束に回していない分）: ${spare}` : '約束に回していない石・土の余りは無い（空けるのは drop）');
}
/** Free slots at or under this: the line also says what fills the pack. */
const NEAR_FULL = 3;
/**
 * The pack's free slots, what the next hands add, and (nearly full) what takes the slots. Normal: the free slots
 * with the gains, and the takers on a line of their own.
 * Shortened: one line. The count is the body's own inventory lines (`packFacts`), the omitted ones (「ほか N件」) counted.
 */
export function packLines(observation: BodyObservation | null, ahead: readonly ActInput[], short: boolean, promises: readonly PlanPromise[] = []): string[] {
  const inventory = world(observation).inventory;
  if (!Array.isArray(inventory)) return [];
  const lines = stacks(inventory), packed = packFacts(lines), free = reportedFree(world(observation).freeSlots) ?? Math.max(0, PACK_SLOTS - packed.used);
  const gains = nextGains(ahead);
  // Full (run 46): what it means comes in the line's first words, and what can be dropped is counted from the
// plan's promises (what they hold back is not offered), in the short line too.
  const head = `持ち物の空き ${free}/${PACK_SLOTS}${free === 0 ? `（満杯）：${FULL_COST}` : free <= NEAR_FULL ? '（もうすぐ満杯）' :
     ''}${gains.length ? `・次の手で増える見込み: ${gains.join('・')}` : ''}`;
  if (free === 0) {
    const spare = dropAdvice(packed, item => heldBack(promises, item));
    const drop = spare ? `drop で空けられる物（約束に回していない分）: ${spare}` : '約束に回していない石・土の余りは無い（空けるのは drop）';
    return [head, drop];
  }
  if (short || free > NEAR_FULL) return [head];
  const fills = takers(lines);
  return fills.length ? [head, `場所を取っている物: ${fills.join('・')}`] : [head];
}

// ---- where a go or a vertical stopped

/**
 * A go's or a vertical's stop, from the act's result (the receipt's `result` JSON, not its words): 「go の止まり:
 * 止まった位置 (x,y,z) から行き先まで 35.9 m（道探しの先端からは 27.5 m）」.
 * Only hands that did not reach what they aimed at. The result's own sentences carry the same, in a text that a
 * long result or a shortened input can cut; this line cannot be.
 */
export function stopFactsOf(resultJson: string | undefined, spotStops?: (at: unknown) => number): string[] {
  return stopFactLines(resultJson, spotStops).map(entry => typeof entry === 'function' ? entry() : entry);
}
/**
 * The same, with the sentence of a stuck go left to be said when the decision reads it (a function): the count
 * of stops in the same place is the stall watch's, and it has counted
 * this result by then. Run 47 (hold 3): 「行き先まで 1.4 m（道探しの先端からは 0 m）」 after a go that was stuck read as nearly
 * there, and the same go was sent again; a stuck go is
 * said as what it is: the way is found, the body cannot move on it, and the nth time at this place.
 */
export function stopFactLines(resultJson: string | undefined, spotStops?: (at: unknown) => number): Array<string | (() => string)> {
  const result = readActResult(resultJson);
  if (!result) return [];
  const out: Array<string | (() => string)> = [];
  for (const line of result.lines) {
    const progress = line.progress;
    if (!progress || line.goal === 'done' || line.goal === 'already') continue;
    const num = (value: number) => String(Math.round(value * 10) / 10);
    const stuckWalk = () => (progress.unit === 'meter' && progress.fromStopM !== undefined && (line.do === 'go' || line.do === 'walk') &&
       line.code === 'stuck');
    if (stuckWalk()) {
      const where = progress.at ? `止まった位置 ${cell(progress.at)} で` : '止まった位置で';
      out.push(() => {
        // The count is the stall watch's, in this process; without it (a result read after a restart) no number is said
// rather than a wrong one.
        const times = spotStops ? Math.max(1, spotStops(progress.at)) : 0;
        return `${line.do} の止まり: ${where}、道は見つかるが体が進めない${times ? `（同じ所で ${times} 回目）` : ''}`;
      });
    } else if (progress.unit === 'meter' && progress.fromStopM !== undefined && (line.do === 'go' || line.do === 'walk')) {
      out.push(`${line.do} の止まり: ${progress.at ? `止まった位置 ${cell(progress.at)} から` : '止まった位置から'}行き先まで ${num(progress.fromStopM)} m`
        + `${progress.searchEndM !== undefined ? `（道探しの先端からは ${num(progress.searchEndM)} m）` : ''}`);
    } else if (line.do === 'vertical') {
      const verticalStopWords = () => (`vertical の止まり: ${progress.at ? `${cell(progress.at)} で止まった・` : ''}今も有効な段 ${num(
        progress.done)}${progress.left === null ? '・残りは分からない' : `・残り ${num(progress.left)} 段`}${line.code ? `（${line.code}）` : ''}`);
      out.push(verticalStopWords());
    }
  }
  return out;
}

// ---- the facts of one input
// -------------------------------------------------------------------------------------------------------------------

export interface FactsContext {
  /** The blows line (`HitWatch.line`), or null. */
  hits?: string | null;
  /** The plan's promises, and the time of the previous decision (ISO) their 「直前に」 counts from. */
  promises?: readonly PlanPromise[];
  since?: string;
  /** The open queue items' inputs in order. */
  ahead?: readonly ActInput[];
  /** Food is short (`wantsFood`): the candidates are listed. */
  wantsFood?: boolean;
  /** The stops of the last results (`stopFactsOf`). */
  stops?: readonly string[];
  /** The node's gos back to the same relay point and the distance to it (`detourLines`): said at every decision while it holds, not once. */
  detour?: readonly string[];
  /** Typed body failures, including only candidates checked against the frame being shown. */
  failures?: readonly string[];
  /** The way to the dragon (`minecraftEndgame.ts`): the lines of the normal version, and the shorter set an urgent or shortened one keeps. */
  endgame?: { lines: readonly string[]; short: readonly string[] };
  /** The plan's kinds now: the current node's kind, then those above it (`nowKinds`). The diamond veins and flint lines read them. */
  nowKinds?: readonly PlanKind[];
  /** The request is one thing (`planFacts.request`): the night line's limit is said beside the distance to the enemy. */
  request?: boolean;
  /** A blow of fire or lava was taken within `BURN_WINDOW_MS` (`burnedRecently`): the burning line is said though the body does not send `onFire`. */
  burning?: boolean;
  /** Where the hands go (the queue's last go, else the plan's place): the enemies beside the line to it are said (`routeEnemiesLine`). */
  goal?: Goal | null;
}
export interface InputFacts { lines: string[]; compressed: string[] }
/**
 * The facts of one input, for the normal version (`urgent` false) or the urgent one. `compressed` is the same
 * facts as the version
 * after the live state was shortened keeps
 * them: the pack in one line, three food candidates at most. Every line is short (under a few hundred
 * characters), so a shortening
 * of a long text does not reach it.
 */
export function inputFacts(observation: BodyObservation | null, context: FactsContext, urgent: boolean): InputFacts {
  const ahead = context.ahead ?? [];
  const head = [vitalsLine(observation), context.hits ?? null, burnLine(observation, context.burning === true), lavaNearLine(observation), holderLine(observation),
    routeEnemiesLine(observation, context.goal ?? null), ...fightLines(observation, context.request === true)];
  const promises = promiseLines(context.promises ?? [], { ...context.since ? { since: context.since } : {}, observation, limit: 4 });
  const stops = [...context.stops ?? []];
  const food = (shown: number) => context.wantsFood ? [foodLine(observation, shown)] : [];
  const endgame = (short: boolean) => (short || urgent ? context.endgame?.short : context.endgame?.lines) ?? [];
  const make = (short: boolean) => [...head, ...endgame(short), ...food(short || urgent ? FOOD_KEPT : FOOD_NORMAL_MAX), ...packLines(observation, ahead, short,
     context.promises ?? []), ...(short || urgent ? [] : liveFactLines(observation, context.nowKinds)), ...(urgent ? [] : [scaffoldLine(observation)]), ...promises, ...stops,
     ...(context.detour ?? []), ...(context.failures ?? [])]
    .filter((line): line is string => !!line);
  return { lines: make(false), compressed: make(true) };
}

// ---- the facts said once
// --------------------------------------------------------------------------------------------------------------
// ---------

/** The facts said once that the preparation node's alone (`minecraftLlmcBody.ts`, `prep_unmet:`) is for the normal input only
 * (chapter 8's table: 「1 度出す」, 「—」, 「—」). */
const NORMAL_ONLY = ['prep_unmet:'];
/** The facts said once that an input of this version takes: the normal one all, the urgent one all but the
 * preparation's, the shortened one none. */
export function onceFor(taskId: string, version: 'normal' | 'urgent' | 'compressed'): OnceFact[] {
  if (version === 'compressed') return [];
  const all = pending(taskId);
  return version === 'normal' ? all : all.filter(fact => !NORMAL_ONLY.some(prefix => fact.key.startsWith(prefix)));
}
/**
 * The facts said once that other owners make (chapter 8's table: a placement that was ok and the world differs after it - a block
 * update, a push-back, the steps counted again;
 * a resume - the earlier result, whether it was sent again, how the old command and the new one are related):
 * `kind` and an `id` of
 * the occasion make the key, so that the same
 * occasion is offered once and a later one again. They go with the normal and the urgent input and not the
 * shortened one (`onceFor`).
 */
export const ONCE_KINDS = ['placement_corrected', 'resume'] as const;
export function offerOnce(taskId: string, kind: typeof ONCE_KINDS[number], id: string, text: string): boolean {
  return offer(taskId, `${kind}:${id}`, text);
}
/** The text of the request's last message (the live state), as a string. */
function lastMessageText(request: unknown): string {
  const messages = rec(request)?.messages;
  const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
  const content = rec(last)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}
/**
 * The request is going out (`MinecraftV2Hooks.requestSent`, called by the model right before it dispatches): the
 * facts said once whose words are in the last message are
 * delivered; the rest are kept and offered with the next input. Returns the keys marked.
 */
export function deliverOnceFacts(taskId: string, request: unknown): string[] {
  const facts = pending(taskId);
  if (!facts.length) return [];
  const text = lastMessageText(request);
  const sent = facts.filter(fact => text.includes(JSON.stringify(fact.text).slice(1, -1))).map(fact => fact.key);
  if (sent.length) markDelivered(taskId, sent);
  return sent;
}
