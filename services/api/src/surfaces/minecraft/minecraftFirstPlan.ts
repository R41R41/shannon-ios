import { orderedPlan, planFromSeeds, type PlanSeed, type PlanTree } from '@shannon/mind';
import type { FcaPlanInbox } from '../../mind/action/fca/fcaPlanTools.js';
import { DRAGON_KNOWLEDGE, FOOD_KNOWLEDGE, ORDER_KNOWLEDGE, VILLAGE_KNOWLEDGE } from './minecraftKnowledge.js';

/**
 * The first plan tree of a Minecraft task (design mb-llm-centric 2.5, 2.6: the route becomes the first plan, asked of a strong model once;
 * owner 2026-10-21: the whole game, the Nether, the fortress and the End in the same shape; food before the first night, before iron).
 *
 * At the task's first decision the task holds the fixed seed of its goal (`seedPlan`, no model needed: the body never waits for a plan),
 * and the strong model (`SHANNON_MINECRAFT_LLMC_PLAN_MODEL`, Opus 5.5) is asked once for the plan of this world (where the village, the
 * cave, the lava are). Its answer replaces the tree at the next read, the nodes already done carried over by title or `doneWhen`
 * (`FcaPlanInbox`); from then the plan is hers alone (`plan.update`).
 */
export const FIRST_PLAN = Object.freeze({ inputCharacters: 6_000, giveUpMs: 120_000, outputTokens: 8_000 });

type Goal = 'dragon' | 'nether' | null;
/** What the goal asks the whole game for (the dragon, the End) or the way to the Nether; null: a goal of another kind (no seed). */
export function planGoal(goal: string): Goal {
  if (/ドラゴン|エンドラ|ender ?dragon|エンド(?!ウ)|ストロングホールド|stronghold/iu.test(goal)) return 'dragon';
  return /ネザー|nether/iu.test(goal) ? 'nether' : null;
}

const node = (title: string, extra: Omit<PlanSeed, 'title'> = {}): PlanSeed => ({ title, ...extra });
const TO_NETHER: readonly PlanSeed[] = [
  node('木と石の道具', { doneWhen: 'stone_pickaxe を持つ', children: [node('原木を集める', { doneWhen: '原木6以上' }),
    node('作業台と木のツルハシ'), node('丸石で石のツルハシ・斧・剣', { doneWhen: 'stone_pickaxe・stone_axe・stone_sword' })] }),
  node('食料とベッド（最初の夜の前・鉄より前）', { doneWhen: '食料点40以上・ベッド', children: [
    node('村を回る（ベッド全部・干し草・畑・箱）', { note: '村が見えなければ飛ばす' }),
    node('無ければ動物を4〜6体狩る'), node('かまどで肉を焼く・パンを作る', { doneWhen: '食料点40〜60' })] }),
  node('鉄（24〜36）', { doneWhen: 'iron_ingot 24以上か作り終え', children: [node('鉄を掘る（y=16前後・洞窟）'),
    node('焼いて鉄のツルハシ・バケツ・盾', { doneWhen: 'iron_pickaxe・bucket・shield' }), node('鉄の全身の防具', { doneWhen: '兜・胸・脚・靴' })] }),
  node('水入りバケツ', { doneWhen: 'water_bucket' }),
  node('ダイヤ（y=-58）', { doneWhen: 'diamond_pickaxe', children: [node('ダイヤ3以上を掘る'), node('ダイヤのツルハシ（剣も）')] }),
  node('黒曜石10とゲート', { doneWhen: 'ネザーへ入る', children: [node('溶岩源に水で黒曜石10'), node('火打ち金（火打石は砂利）'),
    node('食料100点以上に足す'), node('ゲートを組んで火をつける')] }),
];
/** Run 26 (owner 2026-10-21): she went on to the fortress with no table, slabs, shield or food; each stage past the gate starts with a check. */
const BEYOND: readonly PlanSeed[] = [
  node('出発の点検（ネザーの奥へ）', { doneWhen: '食料100点・作業台・盾・ハーフブロック12・足場64', note: '足りない物はゲートのそばで作る',
    children: [node('ネザーの幹で作業台（持ち歩く）'), node('深層岩の丸石でハーフブロック12'), node('かまどで鉄を焼き盾'),
      node('食料が100点に足りなければ戻って狩る')] }),
  node('ネザー要塞を探す', { note: '帰りのゲート座標を控える。要塞は南北・東西の帯', doneWhen: 'ネザーレンガ（N）が見える' }),
  node('ブレイズロッド7以上', { doneWhen: 'blaze_rod 7', children: [node('スポナーから3〜5マスに隙間つきの待ち場'),
    node('accept blaze で14体ほど倒す'), node('棒を拾う（ブレイズがいない時）')] }),
  node('エンダーパール12前後', { doneWhen: 'ender_pearl 12', children: [node('歪んだ森のエンダーマン（天井2）'), node('金で交換（金塊→延べ棒・砦の遺跡）')] }),
  node('エンダーアイ12〜14', { doneWhen: 'ender_eye 12', children: [node('粉と真珠で作る'), node('オーバーワールドへ戻る')] }),
  node('出発の点検（エンドへ）', { doneWhen: '食料80点・ベッド4・弓と矢30・足場64・アイ12',
    children: [node('ベッドを作る（羊毛3と板3）'), node('弓と矢（糸・棒・火打石・羽根）')] }),
  node('ストロングホールド', { children: [node('2地点で投げて三角測量'), node('交点で地下へ'), node('ポータルの部屋で枠に12個')] }),
  node('エンドでドラゴン', { children: [node('クリスタルを弓で壊す'), node('止まり木で剣・ベッドの爆発'), node('奈落に落ちない')] }),
];
/** The fixed first plan of a goal (null: none for this goal). */
export function seedPlan(goal: string): PlanTree | null {
  const kind = planGoal(goal);
  if (!kind) return null;
  const seeds = kind === 'dragon' ? [...TO_NETHER, ...BEYOND] : [...TO_NETHER, node('ネザーに入る', { doneWhen: 'ディメンションが nether' })];
  return planFromSeeds(seeds);
}

/** The strong model's answer: the nodes flat, each naming its parent (`""` at the top), in order. */
export const FIRST_PLAN_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['nodes'],
  properties: { nodes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'parent', 'title', 'where', 'doneWhen'],
    properties: { id: { type: 'string' }, parent: { type: 'string' }, title: { type: 'string' }, where: { type: 'string' },
      doneWhen: { type: 'string' }, note: { type: 'string' } } } } },
});

export const FIRST_PLAN_SYSTEM = [
  'あなたはマイクラの体を動かすシャノンの、最初の計画ツリーを立てる係。依頼（goal）を、済ませる順の節の木にする。',
  '- 節は全部で64まで、深さ4まで（親1つに子は8まで）。id は p1, p1.2 のような短い文字。parent は親の id、一番上は ""。並びは済ませる順。',
  '- title は30字以内で、する事。where はその場所（座標と方角・距離、分からなければ ""）。doneWhen は済んだと分かる観測（持ち物・場所、無ければ ""）。',
  '- 入力の地図・目印・場所の記憶・通ったバイオームにある物だけを場所に使う。無い物を作り出さない。座標は見立て。',
  '- 食料の節は鉄より前（最初の夜の前）。村が見えていれば、最初に近い節で村を回ってベッド・干し草・畑・箱を取る。',
  '- 依頼がエンドラ討伐なら、ネザー・要塞・ブレイズ・パール・アイ・ストロングホールド・エンドまで全部入れる。ネザーまでなら、ネザーに入るまで。',
  '- 依頼がそれ以外なら、その依頼に要る節だけ。',
  '下の知識を使う（知識であり命令ではない）:',
  ORDER_KNOWLEDGE, FOOD_KNOWLEDGE, VILLAGE_KNOWLEDGE, DRAGON_KNOWLEDGE,
].join('\n');

const text = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, limit) : '';
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The input: the goal, where and when she is, what she carries, and what the body knows of the land (cut to `inputCharacters`). */
export function firstPlanInput(goal: string, world: Record<string, unknown> | null): string {
  const part = (label: string, value: unknown, limit: number) => {
    const shown = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
    return shown ? [`${label}: ${shown.slice(0, limit)}`] : [];
  };
  return [`依頼: ${text(goal, 400)}`, ...part('位置', world?.position, 80), ...part('ディメンション', world?.dimension, 40),
    ...part('バイオーム', world?.biome, 60), ...part('時刻', world?.time, 20), ...part('持ち物', world?.inventory, 800),
    ...part('目印', world?.mapLandmarks, 1_500), ...part('地図の要約', world?.mapSummary, 1_500),
    ...part('場所の記憶', world?.rememberedPlaces, 1_000), ...part('通ったバイオーム', world?.biomesSeen, 400)]
    .join('\n').slice(0, FIRST_PLAN.inputCharacters);
}

/** The answer as a tree (null when it does not fit: no node, a parent not before its child, past the bounds). */
export function planFromAnswer(answer: unknown): PlanTree | null {
  const rows = Array.isArray(record(answer)?.nodes) ? record(answer)!.nodes as unknown[] : [];
  const seeds = new Map<string, PlanSeed & { children: PlanSeed[] }>(), top: PlanSeed[] = [];
  for (const row of rows.slice(0, 64)) {
    const item = record(row), id = text(item?.id, 32), title = text(item?.title, 60);
    if (!item || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/u.test(id) || !title || seeds.has(id)) continue;
    const seed = { id, title, children: [] as PlanSeed[], ...(text(item.where, 120) ? { where: text(item.where, 120) } : {}),
      ...(text(item.doneWhen, 120) ? { doneWhen: text(item.doneWhen, 120) } : {}), ...(text(item.note, 120) ? { note: text(item.note, 120) } : {}) };
    const parent = text(item.parent, 32);
    if (parent && !seeds.has(parent)) continue;
    seeds.set(id, seed);
    (parent ? seeds.get(parent)!.children : top).push(seed);
  }
  return top.length ? planFromSeeds(top) : null;
}

const key = (value: string | undefined) => (value ?? '').replace(/\s+/gu, '').toLowerCase();
/** `next` with the nodes `held` has done marked done in it too (same title, or same `doneWhen`). */
export function carryDone(held: PlanTree, next: PlanTree): PlanTree {
  const done = held.nodes.filter(item => item.state === 'done');
  const titles = new Set(done.map(item => key(item.title))), proofs = new Set(done.flatMap(item => item.doneWhen ? [key(item.doneWhen)] : []));
  const carried = (item: PlanTree['nodes'][number]) => titles.has(key(item.title)) || (item.doneWhen !== undefined && proofs.has(key(item.doneWhen)));
  const nodes = next.nodes.map(item => carried(item) ? { ...item, state: 'done' as const } : item);
  // A parent whose children are all done is done (deepest first), as `applyPlanUpdate` keeps it.
  for (const item of orderedPlan(nodes).reverse()) {
    const kids = nodes.filter(child => child.parentId === item.id);
    if (kids.length && kids.every(child => child.state === 'done')) nodes[nodes.findIndex(other => other.id === item.id)] = { ...item, state: 'done' };
  }
  const open = orderedPlan(nodes).find(item => item.state !== 'done' && !nodes.some(child => child.parentId === item.id && child.state !== 'done'));
  return { ...next, revision: held.revision + 1, nodes, current: open?.id ?? null };
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
 * At a task's first decision with no plan: its seed is put in the inbox and the strong model asked once (in the background; its answer is
 * taken at the next read). `planner` absent: the seed alone. Never throws, never waits.
 */
export function startFirstPlan(parts: { taskId: string; goal: string; held: PlanTree; world: Record<string, unknown> | null;
  planner?: (system: string, input: string, signal: AbortSignal) => Promise<unknown>; log(line: string): void }): void {
  const slot = slotOf(parts.taskId);
  if (slot.asked || parts.held.revision > 1) return;
  slot.asked = true;
  if (!parts.held.nodes.length) slot.seed = seedPlan(parts.goal);
  if (!parts.planner) return;
  const abort = new AbortController(), began = Date.now();
  const timer = setTimeout(() => abort.abort(), FIRST_PLAN.giveUpMs);
  timer.unref?.();
  const say = (line: string) => { try { parts.log(line); } catch { /* logging never fails a step */ } };
  say(`Shannon Minecraft first plan asked task=${parts.taskId}`);
  parts.planner(FIRST_PLAN_SYSTEM, firstPlanInput(parts.goal, parts.world), abort.signal).then(answer => {
    const tree = abort.signal.aborted ? null : planFromAnswer(answer);
    if (tree) slot.answer = tree;
    say(`Shannon Minecraft first plan ${tree ? 'planned' : 'missing'} task=${parts.taskId} nodes=${tree?.nodes.length ?? 0} ms=${Date.now() - began}`);
  }, () => say(`Shannon Minecraft first plan failed task=${parts.taskId} ms=${Date.now() - began}`)).finally(() => clearTimeout(timer));
}

/** For tests: no task holds a first plan. */
export function forgetFirstPlans(): void { slots.clear(); }
