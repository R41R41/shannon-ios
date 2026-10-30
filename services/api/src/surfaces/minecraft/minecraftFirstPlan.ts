export { FIRST_PLAN, CHECK_FORBID } from './minecraftFirstPlanPrompts.js';
import { FIRST_PLAN,CHECK_FORBID } from './minecraftFirstPlanPrompts.js';
import { FIRST_PLAN_SYSTEM,FIRST_PLAN_SYSTEM_R4 } from './minecraftFirstPlanPrompts.js';
import { applyPlanUpdate,orderedPlan,planFromSeeds,PLAN_LIMITS,promiseItemFits,type PlanCondition,type PlanOp,type PlanSeed,
  type PlanTree } from '@shannon/mind';
import type { FcaPlanInbox } from '../../mind/action/fca/fcaPlanTools.js';
import { scanForPlan } from './minecraftLlmcProbe.js';
import { carriedItemCounts } from './minecraftItems.js';
import { carriedFood } from './minecraftLlmcLive.js';
import { preparationShortage,recoveryLine } from './minecraftLlmcReadiness.js';
import { parseCondition } from '../../contracts/minecraftActCondition.js';
import { parseDoneWhen } from './minecraftPlanDone.js';
import { kindOf } from './minecraftPlanFacts.js';
import { foodPointsWords } from './minecraftFoodWords.js';
export { FIRST_PLAN_SCHEMA, FIRST_PLAN_SYSTEM, FIRST_PLAN_SCHEMA_R4, FIRST_PLAN_SYSTEM_R4, FIRST_PLAN_SYSTEM_R5, FIRST_PLAN_SYSTEM_R6,
   FIRST_PLAN_SYSTEM_R7, FIRST_PLAN_SYSTEM_R8, FIRST_PLAN_SYSTEM_R9 } from './minecraftFirstPlanPrompts.js';

type Goal = 'dragon' | 'nether' | null;
/** What the goal asks the whole game for (the dragon, the End) or the way to the Nether; null: a goal of another
 * kind (no seed). */
export function planGoal(goal: string): Goal {
  if (/ドラゴン|エンドラ|ender ?dragon|エンド(?!ウ)|ストロングホールド|stronghold/iu.test(goal)) return 'dragon';
  return /ネザー|nether/iu.test(goal) ? 'nether' : null;
}

const node = (title: string, extra: Omit<PlanSeed, 'title'> = {}): PlanSeed => ({ title, ...extra });
/**
 * r5: each `doneWhen` that an observation can show is written as one (`minecraftPlanDone.ts`): the head marks
 * the node done when it holds.
 * The continue contract (chapter 7): every node of a seed has its `kind`, the word the code reads (the stage
 * whose check holds, the
 * gate back, the knowledge of a
 * stage, what holds the now…); the code never reads a seed's title for it. The first plan's strong model writes
 * the kinds of its own
 * nodes the same way.
 */
const TO_NETHER: readonly PlanSeed[] = [
  node('木と石の道具', { kind: 'stone_tools', doneWhen: 'have:stone_pickaxe|have:iron_pickaxe|have:diamond_pickaxe', children: [
    node('原木を集める', { kind: 'wood', doneWhen: 'have:log>=8|have:planks>=24', note: '作業台・木のツルハシ・斧と石の道具の棒の分（ツルハシ 1 つで済みにしない）' }),
    node('作業台と木のツルハシ', { kind: 'wood', doneWhen: 'have:wooden_pickaxe|have:stone_pickaxe|have:iron_pickaxe' }),
    node('丸石で石のツルハシ・斧・剣', { kind: 'stone_tools', doneWhen: 'have:stone_pickaxe&have:stone_axe&have:stone_sword' })] }),
  node('食料とベッド（最初の夜の前・鉄より前）', { kind: 'prep_descent', doneWhen: 'food>=40&have:bed', children: [
    node('村を回る（ベッド全部・干し草・畑・箱）', { kind: 'village', note: '村が見えなければ飛ばす' }),
    node('無ければ動物を4〜6体狩る', { kind: 'food' }), node('かまどで肉を焼く・パンを作る', { kind: 'food', doneWhen: 'food>=40' })] }),
  node('鉄（24〜36）', { kind: 'iron', doneWhen: 'have:iron_ingot>=24|have:iron_chestplate&have:iron_pickaxe&have:shield', caution: ['食料40点・作業台か板4を持ってから下りる'],
    children: [node('鉄を掘る（y=16前後・洞窟）', { kind: 'iron' }),
    node('焼いて鉄のツルハシ・バケツ・盾', { kind: 'iron', doneWhen: 'have:iron_pickaxe&have:bucket&have:shield' }),
    node('鉄の全身の防具', { kind: 'iron_armor', doneWhen: 'have:iron_helmet&have:iron_chestplate&have:iron_leggings&have:iron_boots' })] }),
  node('水入りバケツ', { kind: 'water', doneWhen: 'have:water_bucket' }),
  node('ダイヤ（y=-58）', { kind: 'diamond', doneWhen: 'have:diamond_pickaxe', children: [
    node('ダイヤ3以上を掘る', { kind: 'diamond', doneWhen: 'have:diamond>=3|have:diamond_pickaxe' }),
    node('ダイヤのツルハシ（剣も）', { kind: 'diamond', doneWhen: 'have:diamond_pickaxe' })] }),
  node('黒曜石10とゲート', { kind: 'portal', doneWhen: 'dim:the_nether', children: [
    node('溶岩源に水で黒曜石10', { kind: 'obsidian', doneWhen: 'have:obsidian>=10|dim:the_nether' }),
    node('火打ち金（火打石は砂利）', { kind: 'portal', doneWhen: 'have:flint_and_steel|dim:the_nether' }),
    node('食料100点以上に足す', { kind: 'food', doneWhen: 'food>=100' }), node('ゲートを組んで火をつける', { kind: 'portal', doneWhen: 'dim:the_nether' })] }),
];
/**
 * Run 26 (owner 2026-10-21): she went on to the fortress with no table, slabs, shield or food; each stage past
 * the gate starts with a check.
 * r7 (runs 29–31): the check forbids the fight before it is done (`CHECK_FORBID`, as the first plan is asked to write it).
 * The checks are of the kind `prep_descent` (the preparation before going on: the stage's food and the table); the eyes' are
 * `pearl`, the End's `dragon`.
 */
const BEYOND: readonly PlanSeed[] = [
  node('出発の点検（ネザーの奥へ）', { kind: 'prep_descent', doneWhen: 'food>=100&have:crafting_table&have:shield&have:slab>=12&have:gold_armor', note: '足りない物はゲートのそばで作る',
    forbid: [CHECK_FORBID],
    children: [node('ネザーの幹で作業台（持ち歩く）', { kind: 'other', doneWhen: 'have:crafting_table' }),
      node('深層岩の丸石でハーフブロック12', { kind: 'other', doneWhen: 'have:slab>=12' }),
      node('かまどで鉄を焼き盾', { kind: 'other', doneWhen: 'have:shield' }), node('食料が100点に足りなければ戻って狩る', { kind: 'food', doneWhen: 'food>=100' }),
      node('金の防具を1つ着る（ピグリンが襲わない）', { kind: 'other', doneWhen: 'have:gold_armor' })] }),
  node('ネザー要塞を探す', { kind: 'fortress', note: '帰りのゲート座標を控える。要塞は南北・東西の帯', doneWhen: 'ネザーレンガ（N）が見える' }),
  node('ブレイズロッド7以上', { kind: 'blaze', doneWhen: 'have:blaze_rod>=7', children: [node('スポナーから3〜5マスに隙間つきの待ち場', { kind: 'blaze' }),
    node('accept blaze で14体ほど倒す', { kind: 'blaze' }), node('棒を拾う（ブレイズがいない時）', { kind: 'blaze' })] }),
  node('エンダーパール12前後', { kind: 'pearl', doneWhen: 'have:ender_pearl>=12|have:ender_eye>=12',
    children: [node('歪んだ森のエンダーマン（天井2）', { kind: 'pearl' }), node('金で交換（金塊→延べ棒・砦の遺跡）', { kind: 'pearl' })] }),
  node('エンダーアイ12〜14', { kind: 'pearl', doneWhen: 'have:ender_eye>=12', children: [node('粉と真珠で作る', { kind: 'pearl' }), node('オーバーワールドへ戻る', {
     kind: 'other' })] }),
  node('出発の点検（エンドへ）', { kind: 'prep_descent', doneWhen: 'food>=80&have:bed>=4&have:arrow>=30&have:ender_eye>=12',
    children: [node('ベッドを作る（羊毛3と板3）', { kind: 'bed', doneWhen: 'have:bed>=4' }),
      node('弓と矢（糸・棒・火打石・羽根）', { kind: 'other', doneWhen: 'have:bow&have:arrow>=30' })] }),
  node('ストロングホールド', { kind: 'stronghold', children: [node('2地点で投げて三角測量', { kind: 'stronghold' }), node('交点で地下へ', { kind: 'stronghold' }),
    node('ポータルの部屋で枠に12個', { kind: 'stronghold' })] }),
  node('エンドでドラゴン', { kind: 'dragon', children: [node('クリスタルを弓で壊す', { kind: 'dragon' }), node('止まり木で剣・ベッドの爆発', { kind: 'dragon' }),
    node('奈落に落ちない', { kind: 'dragon' })] }),
];
/**
 * mb-llmc v2 (run 36, the pass mark: the Nether within 30 minutes): before the gate only what the gate needs.
 * The gate's food 100 is
 * the check after she is in (`BEYOND`), the food before it is the 40 of 「食料とベッド」, and the village's beds are one
 * or two, not all (the 4 the
 * End needs are made from wool before it, `出発の点検（エンドへ）`; runs 36 and 37 spent 85–90 s fetching beds more with
 * three in the pack). Run 37: the
 * iron before the Nether is about ten (pickaxe 3, bucket 3, shield 1, flint and steel 1), not the 24–36 with the armour (660 s of
 * digging and smelting).
 */
const DROPPED_BEFORE_GATE = (seed: PlanSeed): boolean => seed.kind === 'food' && seed.doneWhen === 'food>=100';
/**
 * Owner 2026-10-24 (after run 38, whose only armour was iron boots from a chest and who went into the Nether
 * with no golden piece): the iron helmet,
 * chestplate and leggings are made and worn before the diamonds, and the feet's piece is golden boots before the
 * gate (`minecraftLlmcPrepRules.ts`).
 */
const IRON_ARMOUR_WORN = 'have:iron_helmet&have:iron_chestplate&have:iron_leggings';
// The kind `portal`: the golden boots are the piece of the gate's check (`BEFORE_GATE`); the ore on the way down is `other` (it
// stands under the boots, whose stage it takes).
const GOLDEN_BOOTS_NODE = node('金のブーツ（ネザーの前）', { kind: 'portal', doneWhen: 'have:golden_boots', children: [
  node('金鉱石4を掘る（y=-16前後・ダイヤへ下りる途中）', { kind: 'other', doneWhen: 'have:raw_gold>=4|have:gold_ingot>=4|have:golden_boots' }),
  node('焼いて金のブーツを作り履く', { kind: 'portal', doneWhen: 'have:golden_boots' })] });
export function gateFirst(seeds: readonly PlanSeed[]): PlanSeed[] {
  return seeds.flatMap(seed => [{ ...seed, ...gateFirstFields(seed),
    ...seed.children ? { children: gateFirst(seed.children).filter(child => !DROPPED_BEFORE_GATE(child)).map(ironFirst) } : {} },
  // The golden boots come after the diamonds (the gold ore is met on the way down) and before the obsidian and the gate.
  ...seed.kind === 'diamond' && seed.children ? [GOLDEN_BOOTS_NODE] : []]);
}
/**
 * The fields of the seed the gate's side changes: the village's beds (one is enough), the food, and the iron before the diamonds
 * (about 30). The seed is
 * picked by its `kind` and its `doneWhen` (chapter 7), never by the sameness of its title: the village node, the
 * preparation of the
 * food and the bed, and the top iron node (the
 * one with the iron ingots in its condition).
 */
function gateFirstFields(seed: PlanSeed): Partial<PlanSeed> {
  if (seed.kind === 'village') return { title: '村を回る（ベッド1〜2・干し草・畑・箱）' };
  if (seed.kind === 'prep_descent' && seed.doneWhen === 'food>=40&have:bed') return { doneWhen: 'food>=40&have:bed>=1' };
  if (seed.kind === 'iron' && seed.doneWhen === IRON_TOP_DONE) {
    return { title: '鉄（約30・兜・胸・脚まで）', doneWhen: `have:iron_pickaxe&have:bucket&have:shield&${IRON_ARMOUR_WORN}` };
  }
  return {};
}
/** The condition of the seed's top iron node (the kind `iron` with children): the iron before the gate is about
 * thirty with the armour. */
const IRON_TOP_DONE = 'have:iron_ingot>=24|have:iron_chestplate&have:iron_pickaxe&have:shield';
const ironFirst = (seed: PlanSeed): PlanSeed => seed.kind === 'iron' && !seed.doneWhen ? { ...seed, title: '鉄を約30個掘る（y=16前後・洞窟）' }
  : seed.kind === 'iron_armor' ? { ...seed, title: '鉄の兜・胸当て・脚を作って着る', doneWhen: IRON_ARMOUR_WORN } : seed;
/**
 * The fixed first plan of a goal (null: none for this goal). r6 (run 29: a task begun in the Nether fortress
 * held the whole seed; only
 * 「黒曜石10とゲート」 was seen done, and 「村を回る」, with no predicate, was "now" until the strong model's plan came): `dimension`, where the
 * task begins. A dragon's task begun in the Nether starts at the check before going deeper (`BEYOND`), one begun
 * in the End at the dragon.
 */
export function seedPlan(goal: string, dimension: string | null = null): PlanTree | null {
  const kind = planGoal(goal);
  if (!kind) return null;
  const where = dimension?.replace(/^minecraft:/u, '') ?? null;
  if (kind === 'dragon' && where === 'the_nether') return planFromSeeds(BEYOND);
  if (kind === 'dragon' && where === 'the_end') return planFromSeeds(BEYOND.slice(-1));
  const first = gateFirst(TO_NETHER);
  const seeds = kind === 'dragon' ? [...first, ...BEYOND] : [...first, node('ネザーに入る', { kind: 'portal', doneWhen: 'dim:the_nether' })];
  return planFromSeeds(seeds);
}

/**
 * How long the first plan waits for the body's scan when none is there yet (r4; the body scans once its chunks
 * have settled after a
 * spawn: 2 s at least, 15 s at most, then about 30 ms). The plan is asked in the background; the seed plan holds
 * meanwhile. r5 (the
 * body's r5 waits for 8 tenths of the server's view to load, up to 15 s after the spawn, and the head's first
 * decision may come a few
 * seconds before it): 20 s, not 16.
 */
export const SCAN_WAIT = Object.freeze({ ms: 20_000, everyMs: 250 });

const text = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, limit) : '';
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The input: the goal, where and when she is, what she carries, and what the body knows of the land (cut to
 * `inputCharacters`). */
export function firstPlanInput(goal: string, world: Record<string, unknown> | null, options: { scan?: boolean; readiness?: boolean } = {}): string {
  const part = (label: string, value: unknown, limit: number) => {
    const shown = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
    return shown ? [`${label}: ${shown.slice(0, limit)}`] : [];
  };
  // r4: the body's scan of the land it holds (its words and every row), before the rest is cut to the bound.
  const scan = options.scan ? scanForPlan(world?.scan) : null;
  return [`依頼: ${text(goal, 400)}`, ...part('位置', world?.position, 80), ...part('ディメンション', world?.dimension, 40),
    ...part('バイオーム', world?.biome, 60), ...part('時刻', world?.time, 20), ...part('持ち物', world?.inventory, 800),
    ...(options.readiness && world ? [...part('着ている物', world.worn, 200), ...readinessInput(world)] : []),
    ...(scan ? [`走査（読み込み済みの範囲の目印）:\n${scan.slice(0, 2_400)}`] : []),
    ...part('目印', world?.mapLandmarks, 1_500), ...part('地図の要約', world?.mapSummary, 1_500),
    ...part('場所の記憶', world?.rememberedPlaces, 1_000), ...part('通ったバイオーム', world?.biomesSeen, 400)]
    .join('\n').slice(0, FIRST_PLAN.inputCharacters);
}

/**
 * r6: what the place she begins in lacks (`preparationShortage`, the check of the Nether's depth when she is
 * there), and health that does
 * not come back: the code's facts, for the first node.
 */
function readinessInput(world: Record<string, unknown>): string[] {
  const dimension = typeof world.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : null;
  const food = carriedFood(world, {}).points, health = typeof world.health === 'number' ? world.health : null;
  const counts = carriedItemCounts(world, {});
  const shortage = preparationShortage({ dimension, counts, food, nowKinds: null });
  const recovery = recoveryLine(typeof world.food === 'number' ? world.food : null, health, food, counts);
  return [foodPointsWords(food), ...(shortage ? [shortage] : []), ...(recovery ? [recovery] : [])];
}

/** A node's texts from the answer; r4: its forbid and caution too (within the tree's bounds; an answer without
 * them is as before). */
function seedFields(item: Record<string, unknown>): Omit<PlanSeed, 'title' | 'children' | 'id'> {
  const rules = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(line => text(line, PLAN_LIMITS.rule)).filter(Boolean))]
    .slice(0, PLAN_LIMITS.rules);
  const forbid = rules(item.forbid), caution = rules(item.caution);
  // The kind as the model wrote it (`planFromSeeds` takes one outside the list as `other` with the value kept in
// `kindRaw`); none: `other`.
  return { ...(text(item.kind, 64) ? { kind: text(item.kind, 64) } : {}), ...(text(item.where, 120) ? { where: text(item.where, 120) } : {}),
    ...(text(item.doneWhen, 120) ? { doneWhen: text(item.doneWhen, 120) } : {}), ...(text(item.note, 120) ? { note: text(item.note, 120) } : {}),
    ...(forbid.length ? { forbid } : {}), ...(caution.length ? { caution } : {}) };
}
/** The promises of an answer the tree takes in (the tree holds `PLAN_LIMITS.promises`; a first plan has few). */
const ANSWER_PROMISES = 8;
/**
 * The op of one promise of the answer, or null when it cannot be read (chapter 3: the head reads what it can
 * judge). `until.condition` and `instead` are the model's
 * words (`have:crafting_table>=1`): they go through `parseCondition`, and a promise whose condition does not
 * read is left out (not entered half). `until.node` must be a node of
 * the tree.
 */
function promiseOp(row: unknown, tree: PlanTree): PlanOp | null {
  const item = record(row), count = item?.count;
  const name = text(item?.item, 64), use = text(item?.use, PLAN_LIMITS.promiseUse);
  if (!item || !name || !promiseItemFits(name) || !use || typeof count !== 'number' || !Number.isSafeInteger(count)) return null;
  const until = record(item.until), node = text(until?.node, 32);
  if (node && !tree.nodes.some(other => other.id === node)) return null;
  const read = (words: string, label: string): PlanCondition | null => {
    const parsed = parseCondition(words, label);
    return parsed.ok ? parsed.condition : null;
  };
  const untilWords = text(until?.condition, 200), insteadWords = text(item.instead, 200);
  const condition = untilWords ? read(untilWords, 'until') : undefined, instead = insteadWords ? read(insteadWords, 'instead') : undefined;
  if (condition === null || instead === null) return null;
  const promiseUpdate = (): NonNullable<ReturnType<typeof promiseOp>> => ({ op: 'promise', item: name, count, use, ...(node || condition ? {
     until: { ...(node ? { node } : {}), ...(condition ? { condition } : {}) } } : {}),
    ...(instead ? { instead } : {}) });
  return promiseUpdate();
}
/** The tree with the answer's promises in it (a first plan's revision stays 1: it is a plan made whole, not edited). */
function withPromises(tree: PlanTree, rows: unknown, at: string | undefined): PlanTree {
  if (!Array.isArray(rows)) return tree;
  let held = tree;
  for (const row of rows.slice(0, ANSWER_PROMISES)) {
    const op = promiseOp(row, held);
    const made = op ? applyPlanUpdate(held, { ops: [op] }, at ? { at } : {}) : null;
    if (made?.changed) held = made.tree;
  }
  return held === tree ? tree : { ...held, revision: tree.revision };
}
/**
 * The answer as a tree (null when it does not fit: no node, a parent not before its child, past the bounds).
 * Each node's `kind` is the model's (outside the list: `other` with the
 * value kept); `promises` are entered as `plan.update`'s `promise` op does it, at `at`.
 */
export function planFromAnswer(answer: unknown, at?: string): PlanTree | null {
  const rows = Array.isArray(record(answer)?.nodes) ? record(answer)!.nodes as unknown[] : [];
  const seeds = new Map<string, PlanSeed & { children: PlanSeed[] }>(), top: PlanSeed[] = [];
  for (const row of rows.slice(0, 64)) {
    const item = record(row), id = text(item?.id, 32), title = text(item?.title, 60);
    if (!item || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/u.test(id) || !title || seeds.has(id)) continue;
    const seed = { id, title, children: [] as PlanSeed[], ...seedFields(item) };
    const parent = text(item.parent, 32);
    if (parent && !seeds.has(parent)) continue;
    seeds.set(id, seed);
    (parent ? seeds.get(parent)!.children : top).push(seed);
  }
  const tree = top.length ? planFromSeeds(top) : null;
  return tree ? withPromises(tree, record(answer)?.promises, at) : tree;
}

const key = (value: string | undefined) => (value ?? '').replace(/\s+/gu, '').toLowerCase();
/**
 * `next` with the nodes `held` has done marked done in it too (same `kind` and same `doneWhen`, chapter 7: a
 * title says nothing of it). r6 (run 29: the strong model's 「動物を狩り
 * 肉を焼く」, doneWhen food>=100, came in done with 15.6 points of food: the seed's node of the same doneWhen had
 * been closed under a parent
 * seen done): a node whose doneWhen is a predicate is never carried by its words; the frame says whether it
 * holds (`minecraftPlanDone.ts`,
 * at the same read). Only a node whose doneWhen is in free words (and not empty) is carried, by a done node of
 * the same kind with the same words.
 */
export function carryDone(held: PlanTree, next: PlanTree): PlanTree {
  const done = held.nodes.filter(item => item.state === 'done');
  const proof = (item: PlanTree['nodes'][number]) => `${kindOf(item)}|${key(item.doneWhen)}`;
  const proofs = new Set(done.flatMap(item => item.doneWhen ? [proof(item)] : []));
  const carried = (item: PlanTree['nodes'][number]) => !!item.doneWhen && !parseDoneWhen(item.doneWhen) && proofs.has(proof(item));
  const nodes = next.nodes.map(item => carried(item) ? { ...item, state: 'done' as const } : item);
  // A parent whose children are all done is done (deepest first), as `applyPlanUpdate` keeps it.
  for (const item of orderedPlan(nodes).reverse()) {
    const kids = nodes.filter(child => child.parentId === item.id);
    if (kids.length && kids.every(child => child.state === 'done')) nodes[nodes.findIndex(other => other.id === item.id)] = { ...item, state: 'done' };
  }
  // r9: a node under a done one is not the open one (a done node leaves nothing under it to do, `planTree.ts`).
  const doneAbove = (item: PlanTree['nodes'][number]) => {
    for (let up = nodes.find(other => other.id === item.parentId); up; up = nodes.find(other => other.id === up!.parentId)) {
      if (up.state === 'done') return true;
    }
    return false;
  };
  const open = orderedPlan(nodes).find(item => item.state !== 'done' && !nodes.some(child => child.parentId === item.id && child.state !== 'done')
    && !doneAbove(item));
  return { ...next, revision: held.revision + 1, nodes, current: open?.id ?? null, promises: held.promises.length ? held.promises : next.promises };
}

/** The plans handed to tasks from outside their decisions: a seed at the first read, the strong model's answer when it comes. */
interface Slot { seed: PlanTree | null; answer: PlanTree | null; asked: boolean }
const slots = new Map<string, Slot>();
function slotOf(taskId: string): Slot {
  let slot = slots.get(taskId);
  if (!slot) {
    slot = { seed: null, answer: null, asked: false };
    slots.set(taskId, slot);
    if (slots.size > 32) slots.delete(slots.keys().next().value as string);
  }
  return slot;
}
export const firstPlanInbox: FcaPlanInbox = {
  take(taskId, held) {
    const slot = slots.get(taskId);
    if (!slot) return null;
    if (slot.answer) {
      const answer = slot.answer;
      slot.answer = null;
      slot.seed = null;
      return { tree: held.nodes.length ? carryDone(held, answer) : answer, note: '最初の計画（強いモデル）が届いた。済んだ節は引き継いだ。合わなければ plan.update で直す' };
    }
    if (slot.seed && !held.nodes.length) {
      const seed = slot.seed;
      slot.seed = null;
      return { tree: seed, note: '既定の最初の計画。この世界に合わせた計画が後で届く' };
    }
    return null;
  },
};

/**
 * At a task's first decision with no plan: its seed is put in the inbox and the strong model asked once (in the
 * background; its answer is
 * taken at the next read). `planner` absent: the seed alone. Never throws, never waits.
 */
export function startFirstPlan(parts: { taskId: string; goal: string; held: PlanTree; world: Record<string, unknown> | null;
  planner?: (system: string, input: string, signal: AbortSignal) => Promise<unknown>; log(line: string): void;
  /**
   * r4: the body's world now (`world()`), read again for its scan; with no scan yet, the plan waits for one (`SCAN_WAIT`, in the
   * background) and is asked with r4's words (`FIRST_PLAN_SYSTEM_R4`) and the scan in its input. Absent: as before.
   */
  r4?: { world(): Record<string, unknown> | null; waitMs?: number; everyMs?: number;
    /** r5: the words asked with (`FIRST_PLAN_SYSTEM_R5`, doneWhen as predicates). Absent: r4's. */
    system?: string;
    /** r6: the place's shortage and the recovery fact in the input (`readinessInput`). Absent: not. */
    readiness?: boolean } }): void {
  const slot = slotOf(parts.taskId);
  if (slot.asked || parts.held.revision > 1) return;
  slot.asked = true;
  // r6: the seed begins where she is (a dragon's task begun in the Nether: at the check before going deeper).
  const dimension = typeof parts.world?.dimension === 'string' ? parts.world.dimension : null;
  if (!parts.held.nodes.length) slot.seed = seedPlan(parts.goal, dimension);
  if (!parts.planner) return;
  const planner = parts.planner;
  const abort = new AbortController(), began = Date.now();
  const timer = setTimeout(() => abort.abort(), FIRST_PLAN.giveUpMs);
  timer.unref?.();
  const say = (line: string) => { try { parts.log(line); } catch { /* logging never fails a step */ } };
  say(`Shannon Minecraft first plan asked task=${parts.taskId}`);
  const r4 = parts.r4;
  const ask = r4 ? withScan(r4, parts.world).then(world => {
    say(`Shannon Minecraft first plan scan task=${parts.taskId} scan=${world?.scan ? 'yes' : 'none'} waitedMs=${Date.now() - began}`);
    return planner(r4.system ?? FIRST_PLAN_SYSTEM_R4, firstPlanInput(parts.goal, world, { scan: true, ...(r4.readiness ? { readiness: true } : {}) }),
      abort.signal);
  }) : planner(FIRST_PLAN_SYSTEM, firstPlanInput(parts.goal, parts.world), abort.signal);
  ask.then(answer => {
    const tree = abort.signal.aborted ? null : planFromAnswer(answer, new Date().toISOString());
    if (tree) slot.answer = tree;
    say(("Shannon Minecraft first plan " +
`${tree ? 'planned' : 'missing'}` +
" task=" +
`${parts.taskId}` +
" nodes=" +
`${tree?.nodes.length ?? 0}` +
" ms=" +
`${Date.now() - began}` +
""));
  }, () => say(`Shannon Minecraft first plan failed task=${parts.taskId} ms=${Date.now() - began}`)).finally(() => clearTimeout(timer));
}

/** r4: the world with the body's scan: as it is when it holds one, else read again until one comes or `SCAN_WAIT.ms` passes. */
async function withScan(r4: { world(): Record<string, unknown> | null; waitMs?: number; everyMs?: number },
  first: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  if (first?.scan) return first;
  const until = Date.now() + (r4.waitMs ?? SCAN_WAIT.ms);
  let world = first;
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, r4.everyMs ?? SCAN_WAIT.everyMs));
    try { world = r4.world() ?? world; } catch { /* the frame as it was */ }
    if (world?.scan) return world;
  }
  return world;
}

/** For tests: no task holds a first plan. */
export function forgetFirstPlans(): void { slots.clear(); }
