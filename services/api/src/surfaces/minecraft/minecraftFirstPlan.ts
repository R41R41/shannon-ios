import { orderedPlan, planFromSeeds, PLAN_LIMITS, type PlanSeed, type PlanTree } from '@shannon/mind';
import type { FcaPlanInbox } from '../../mind/action/fca/fcaPlanTools.js';
import {
  DRAGON_KNOWLEDGE, DRAGON_KNOWLEDGE_R7, FOOD_KNOWLEDGE, NETHER_ENTRY_KNOWLEDGE, ORDER_KNOWLEDGE, VILLAGE_KNOWLEDGE,
} from './minecraftKnowledge.js';
import { scanForPlan } from './minecraftLlmcProbe.js';
import { carriedItemCounts } from './minecraftItems.js';
import { carriedFood } from './minecraftLlmcLive.js';
import { preparationShortage, recoveryLine } from './minecraftLlmcReadiness.js';
import { parseDoneWhen } from './minecraftPlanDone.js';

/**
 * The first plan tree of a Minecraft task (design mb-llm-centric 2.5, 2.6: the route becomes the first plan, asked of a strong model once;
 * owner 2026-10-21: the whole game, the Nether, the fortress and the End in the same shape; food before the first night, before iron).
 *
 * At the task's first decision the task holds the fixed seed of its goal (`seedPlan`, no model needed: the body never waits for a plan),
 * and the strong model (`SHANNON_MINECRAFT_LLMC_PLAN_MODEL`, Opus 5.5) is asked once for the plan of this world (where the village, the
 * cave, the lava are). Its answer replaces the tree at the next read, the nodes already done carried over by title or `doneWhen`
 * (`FcaPlanInbox`); from then the plan is hers alone (`plan.update`).
 */
/**
 * Run 27 (2026-10-22): the first plan took 46 s and 5,221 output tokens for 54 nodes, each with a long where, doneWhen and note. The
 * answer is now asked shorter (40 nodes, short fields, no note) at low effort: about half the tokens and the time. The 4.96 s the API's
 * event loop was blocked just before it came back was not this answer (its parse is well under a millisecond) but the body recall's
 * first pool (odyTaskRecall.ts, poolMs 3,076), now built over several turns of the loop.
 */
export const FIRST_PLAN = Object.freeze({ inputCharacters: 6_000, giveUpMs: 120_000, outputTokens: 6_000, nodes: 40 });

type Goal = 'dragon' | 'nether' | null;
/** What the goal asks the whole game for (the dragon, the End) or the way to the Nether; null: a goal of another kind (no seed). */
export function planGoal(goal: string): Goal {
  if (/ドラゴン|エンドラ|ender ?dragon|エンド(?!ウ)|ストロングホールド|stronghold/iu.test(goal)) return 'dragon';
  return /ネザー|nether/iu.test(goal) ? 'nether' : null;
}

const node = (title: string, extra: Omit<PlanSeed, 'title'> = {}): PlanSeed => ({ title, ...extra });
/** r7: the check's forbid (the seed's, and the words the first plan is asked to write: `FIRST_PLAN_SYSTEM_R7`). */
export const CHECK_FORBID = '点検（作業台・ハーフブロック・盾・食料 100・金の防具）が済むまで、湧き場の前で戦わない。受けた時は離れて塞ぐ';
/** r5: each `doneWhen` that an observation can show is written as one (`minecraftPlanDone.ts`): the head marks the node done when it holds. */
const TO_NETHER: readonly PlanSeed[] = [
  node('木と石の道具', { doneWhen: 'have:stone_pickaxe|have:iron_pickaxe|have:diamond_pickaxe', children: [
    node('原木を集める', { doneWhen: 'have:log>=8|have:planks>=24', note: '作業台・木のツルハシ・斧と石の道具の棒の分（ツルハシ 1 つで済みにしない）' }),
    node('作業台と木のツルハシ', { doneWhen: 'have:wooden_pickaxe|have:stone_pickaxe|have:iron_pickaxe' }),
    node('丸石で石のツルハシ・斧・剣', { doneWhen: 'have:stone_pickaxe&have:stone_axe&have:stone_sword' })] }),
  node('食料とベッド（最初の夜の前・鉄より前）', { doneWhen: 'food>=40&have:bed', children: [
    node('村を回る（ベッド全部・干し草・畑・箱）', { note: '村が見えなければ飛ばす' }),
    node('無ければ動物を4〜6体狩る'), node('かまどで肉を焼く・パンを作る', { doneWhen: 'food>=40' })] }),
  node('鉄（24〜36）', { doneWhen: 'have:iron_ingot>=24|have:iron_chestplate&have:iron_pickaxe&have:shield', caution: ['食料40点・作業台か板4を持ってから下りる'],
    children: [node('鉄を掘る（y=16前後・洞窟）'),
    node('焼いて鉄のツルハシ・バケツ・盾', { doneWhen: 'have:iron_pickaxe&have:bucket&have:shield' }),
    node('鉄の全身の防具', { doneWhen: 'have:iron_helmet&have:iron_chestplate&have:iron_leggings&have:iron_boots' })] }),
  node('水入りバケツ', { doneWhen: 'have:water_bucket' }),
  node('ダイヤ（y=-58）', { doneWhen: 'have:diamond_pickaxe', children: [node('ダイヤ3以上を掘る', { doneWhen: 'have:diamond>=3|have:diamond_pickaxe' }),
    node('ダイヤのツルハシ（剣も）', { doneWhen: 'have:diamond_pickaxe' })] }),
  node('黒曜石10とゲート', { doneWhen: 'dim:the_nether', children: [node('溶岩源に水で黒曜石10', { doneWhen: 'have:obsidian>=10|dim:the_nether' }),
    node('火打ち金（火打石は砂利）', { doneWhen: 'have:flint_and_steel|dim:the_nether' }),
    node('食料100点以上に足す', { doneWhen: 'food>=100' }), node('ゲートを組んで火をつける', { doneWhen: 'dim:the_nether' })] }),
];
/**
 * Run 26 (owner 2026-10-21): she went on to the fortress with no table, slabs, shield or food; each stage past the gate starts with a check.
 * r7 (runs 29–31): the check forbids the fight before it is done (`CHECK_FORBID`, as the first plan is asked to write it).
 */
const BEYOND: readonly PlanSeed[] = [
  node('出発の点検（ネザーの奥へ）', { doneWhen: 'food>=100&have:crafting_table&have:shield&have:slab>=12&have:gold_armor', note: '足りない物はゲートのそばで作る',
    forbid: [CHECK_FORBID],
    children: [node('ネザーの幹で作業台（持ち歩く）', { doneWhen: 'have:crafting_table' }), node('深層岩の丸石でハーフブロック12', { doneWhen: 'have:slab>=12' }),
      node('かまどで鉄を焼き盾', { doneWhen: 'have:shield' }), node('食料が100点に足りなければ戻って狩る', { doneWhen: 'food>=100' }),
      node('金の防具を1つ着る（ピグリンが襲わない）', { doneWhen: 'have:gold_armor' })] }),
  node('ネザー要塞を探す', { note: '帰りのゲート座標を控える。要塞は南北・東西の帯', doneWhen: 'ネザーレンガ（N）が見える' }),
  node('ブレイズロッド7以上', { doneWhen: 'have:blaze_rod>=7', children: [node('スポナーから3〜5マスに隙間つきの待ち場'),
    node('accept blaze で14体ほど倒す'), node('棒を拾う（ブレイズがいない時）')] }),
  node('エンダーパール12前後', { doneWhen: 'have:ender_pearl>=12|have:ender_eye>=12',
    children: [node('歪んだ森のエンダーマン（天井2）'), node('金で交換（金塊→延べ棒・砦の遺跡）')] }),
  node('エンダーアイ12〜14', { doneWhen: 'have:ender_eye>=12', children: [node('粉と真珠で作る'), node('オーバーワールドへ戻る')] }),
  node('出発の点検（エンドへ）', { doneWhen: 'food>=80&have:bed>=4&have:arrow>=30&have:ender_eye>=12',
    children: [node('ベッドを作る（羊毛3と板3）', { doneWhen: 'have:bed>=4' }), node('弓と矢（糸・棒・火打石・羽根）', { doneWhen: 'have:bow&have:arrow>=30' })] }),
  node('ストロングホールド', { children: [node('2地点で投げて三角測量'), node('交点で地下へ'), node('ポータルの部屋で枠に12個')] }),
  node('エンドでドラゴン', { children: [node('クリスタルを弓で壊す'), node('止まり木で剣・ベッドの爆発'), node('奈落に落ちない')] }),
];
/**
 * mb-llmc v2 (run 36, the pass mark: the Nether within 30 minutes): before the gate only what the gate needs. The gate's food 100 is
 * the check after she is in (`BEYOND`), the food before it is the 40 of 「食料とベッド」, and the village's beds are one or two, not all (the 4 the
 * End needs are made from wool before it, `出発の点検（エンドへ）`; runs 36 and 37 spent 85–90 s fetching beds more with three in the pack). Run 37: the
 * iron before the Nether is about ten (pickaxe 3, bucket 3, shield 1, flint and steel 1), not the 24–36 with the armour (660 s of digging and smelting).
 */
const DROPPED_BEFORE_GATE = (seed: PlanSeed): boolean => seed.doneWhen === 'food>=100';
/**
 * Owner 2026-10-24 (after run 38, whose only armour was iron boots from a chest and who went into the Nether with no golden piece): the iron helmet,
 * chestplate and leggings are made and worn before the diamonds, and the feet's piece is golden boots before the gate (`minecraftLlmcPrepRules.ts`).
 */
const IRON_ARMOUR_WORN = 'have:iron_helmet&have:iron_chestplate&have:iron_leggings';
const GOLDEN_BOOTS_NODE = node('金のブーツ（ネザーの前）', { doneWhen: 'have:golden_boots', children: [
  node('金鉱石4を掘る（y=-16前後・ダイヤへ下りる途中）', { doneWhen: 'have:raw_gold>=4|have:gold_ingot>=4|have:golden_boots' }),
  node('焼いて金のブーツを作り履く', { doneWhen: 'have:golden_boots' })] });
export function gateFirst(seeds: readonly PlanSeed[]): PlanSeed[] {
  return seeds.flatMap(seed => [{ ...seed, ...gateFirstFields(seed),
    ...seed.children ? { children: gateFirst(seed.children).filter(child => !DROPPED_BEFORE_GATE(child)).map(ironFirst) } : {} },
  // The golden boots come after the diamonds (the gold ore is met on the way down) and before the obsidian and the gate.
  ...seed.title === 'ダイヤ（y=-58）' ? [GOLDEN_BOOTS_NODE] : []]);
}
/** The fields of the seed the gate's side changes: the village's beds (one is enough), the food, and the iron before the diamonds (about 30). */
function gateFirstFields(seed: PlanSeed): Partial<PlanSeed> {
  if (seed.title === '村を回る（ベッド全部・干し草・畑・箱）') return { title: '村を回る（ベッド1〜2・干し草・畑・箱）' };
  if (seed.doneWhen === 'food>=40&have:bed') return { doneWhen: 'food>=40&have:bed>=1' };
  if (seed.title === '鉄（24〜36）') {
    return { title: '鉄（約30・兜・胸・脚まで）', doneWhen: `have:iron_pickaxe&have:bucket&have:shield&${IRON_ARMOUR_WORN}` };
  }
  return {};
}
const ironFirst = (seed: PlanSeed): PlanSeed => seed.title === '鉄を掘る（y=16前後・洞窟）' ? { ...seed, title: '鉄を約30個掘る（y=16前後・洞窟）' }
  : seed.title === '鉄の全身の防具' ? { ...seed, title: '鉄の兜・胸当て・脚を作って着る', doneWhen: IRON_ARMOUR_WORN } : seed;
/**
 * The fixed first plan of a goal (null: none for this goal). r6 (run 29: a task begun in the Nether fortress held the whole seed; only
 * 「黒曜石10とゲート」 was seen done, and 「村を回る」, with no predicate, was "now" until the strong model's plan came): `dimension`, where the
 * task begins. A dragon's task begun in the Nether starts at the check before going deeper (`BEYOND`), one begun in the End at the dragon.
 */
export function seedPlan(goal: string, dimension: string | null = null): PlanTree | null {
  const kind = planGoal(goal);
  if (!kind) return null;
  const where = dimension?.replace(/^minecraft:/u, '') ?? null;
  if (kind === 'dragon' && where === 'the_nether') return planFromSeeds(BEYOND);
  if (kind === 'dragon' && where === 'the_end') return planFromSeeds(BEYOND.slice(-1));
  const first = gateFirst(TO_NETHER);
  const seeds = kind === 'dragon' ? [...first, ...BEYOND] : [...first, node('ネザーに入る', { doneWhen: 'dim:the_nether' })];
  return planFromSeeds(seeds);
}

/** The strong model's answer: the nodes flat, each naming its parent (`""` at the top), in order. */
export const FIRST_PLAN_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['nodes'],
  properties: { nodes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'parent', 'title', 'where', 'doneWhen'],
    properties: { id: { type: 'string' }, parent: { type: 'string' }, title: { type: 'string' }, where: { type: 'string' },
      doneWhen: { type: 'string' } } } } },
});

export const FIRST_PLAN_SYSTEM = [
  'あなたはマイクラの体を動かすシャノンの、最初の計画ツリーを立てる係。依頼（goal）を、済ませる順の節の木にする。',
  `- 節は全部で${FIRST_PLAN.nodes}まで、深さ3まで（親1つに子は6まで）。id は p1, p1.2 のような短い文字。parent は親の id、一番上は ""。並びは済ませる順。`,
  '- title は20字以内で、する事。where はその場所（座標だけ、分からなければ ""）。doneWhen は済んだと分かる観測（持ち物の名前と数、20字以内、無ければ ""）。note は書かない。説明の文は要らない。',
  '- 入力の地図・目印・場所の記憶・通ったバイオームにある物だけを場所に使う。無い物を作り出さない。座標は見立て。',
  '- 食料の節は鉄より前（最初の夜の前）。村が見えていれば、最初に近い節で村を回ってベッド・干し草・畑・箱を取る。',
  '- 最初の「木と石の道具」は、原木の節（作業台・木のツルハシ・斧と石の道具の棒の分: doneWhen は have:log>=8 の形。ツルハシ 1 つで済みにしない）、作業台と木のツルハシ、'
    + '丸石で石のツルハシ・石の斧・石の剣（doneWhen は have:stone_pickaxe&have:stone_axe&have:stone_sword。斧を落とさない）に分ける。',
  '- 鉄を掘りに地下へ下りる前に済ませる物（食料 40 点・石の斧・作業台か板 4 以上・板の余り）は、鉄の節より前の節か、その doneWhen に入れる。',
  '- 依頼がエンドラ討伐なら、ネザー・要塞・ブレイズ・パール・アイ・ストロングホールド・エンドまで全部入れる。ネザーまでなら、ネザーに入るまで。',
  '- 依頼がそれ以外なら、その依頼に要る節だけ。',
  '下の知識を使う（知識であり命令ではない）:',
  ORDER_KNOWLEDGE, FOOD_KNOWLEDGE, VILLAGE_KNOWLEDGE, DRAGON_KNOWLEDGE,
].join('\n');

/**
 * r4 (mb-llmc r4; arch-check 6: run 26 went on to the fortress with no table while a Nether stem stood 4 m away; run 27's
 * 160 m held no tree at all and the plan had to choose which way to look): the body's scan of the land goes into the input, and a node may
 * carry what not to do and what to mind there (`forbid`, `caution`; arch-check 23: of a supervisor's words, these held longest).
 */
const rulesField = { type: 'array', items: { type: 'string' } };
export const FIRST_PLAN_SCHEMA_R4 = Object.freeze({
  type: 'object', additionalProperties: false, required: ['nodes'],
  properties: { nodes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'parent', 'title', 'where', 'doneWhen'],
    properties: { id: { type: 'string' }, parent: { type: 'string' }, title: { type: 'string' }, where: { type: 'string' },
      doneWhen: { type: 'string' }, forbid: rulesField, caution: rulesField } } } },
});
export const FIRST_PLAN_SYSTEM_R4 = [
  FIRST_PLAN_SYSTEM,
  '走査と禁止・注意（r4）:',
  '- 入力の「走査」は、体が読み込み済みの範囲（約 160m）を数えた物。原木・村・水・溶岩・構造物・ネザーの幹・要塞・ポータルの座標を where に使う。'
    + '走査に無い物は 160m の外にある: 探しに出る向き（走査の地形・バイオームから）を節にする。',
  '- 節の forbid（してはいけない事）・caution（気をつける事）は、その節で特に守る事だけ書く（無ければ書かない）。各 2 つまで、30 字以内。'
    + '例: forbid「素手で真下を掘らない」「村の鉄ゴーレムを殴らない」、caution「水の溜まりの上で掘らない」「溶岩の隣を掘らない」。',
  NETHER_ENTRY_KNOWLEDGE,
].join('\n');
/**
 * r5 (run 28: Sonnet never called plan.update and the plan's "now" stayed on its first node; owner 2026-10-22 「止めて直す」): each doneWhen an
 * observation can show is written as a predicate, which the head checks at every decision (`minecraftPlanDone.ts`).
 */
export const FIRST_PLAN_SYSTEM_R5 = [
  FIRST_PLAN_SYSTEM_R4,
  '済みの形（r5）:',
  '- doneWhen は、観測で確かめられる形で書く（頭のコードが毎判断に確かめて、その節を済みにし、今の節を次へ進める）。'
    + 'have:物 か have:物>=数（持ち物・着ている物。物は id か、log・planks・bed・bucket・slab のような id の末尾）、dim:the_nether か dim:the_end（次元）、'
    + 'at:x,y,z~半径（その近くに立つ）、food>=点（持っている食料点）。& で全部、| でどれか（& が先）。この形は 20 字を超えてよい（120 字まで）。',
  '- 例: "have:stone_pickaxe&have:stone_sword"、"have:log>=6|have:wooden_pickaxe"、"food>=40&have:bed"、'
    + '"have:iron_ingot>=24|have:iron_chestplate"、"dim:the_nether"、'
    + '"at:196,69,237~6"。観測で確かめようのない節（探す・回る・見る）は ""。',
].join('\n');
/**
 * r6 (run 29: begun in a Nether fortress, the plan's 28 nodes put no food before the blazes; Sonnet went to the spawner at 10 s with one
 * mutton and no table, slabs or shield): the plan begins where she is, and what the place's check lacks (the input's 「準備の不足」, the code's
 * fact) is its first node.
 */
export const FIRST_PLAN_SYSTEM_R6 = [
  FIRST_PLAN_SYSTEM_R5,
  '今いる所から（r6）:',
  '- 計画は入力の「ディメンション」の今いる所から始める（ネザー・エンドから始まった時に、オーバーワールドの最初の節は書かない）。',
  '- 入力に「準備の不足」があれば、最初の節を「出発の点検」にし、足りない物（食料を含む）をその子の節にする。各子に作り方か取りに行く所（走査の座標）を where に、'
    + '観測の形の doneWhen（have:物>=数・food>=点）を書く。ネザーで食料が足りなければ、真紅の森のホグリンか、帰りのゲートからオーバーワールドへ戻って狩る節にする。',
  '- 戦い（ブレイズ・エンダーマン）と奥への移動の節は、その点検の後に置く。',
].join('\n');
/**
 * r7 (runs 30, 31: Opus's first plan put the check first both times, and its only forbid was 「スポナーを掘らない」 under the blazes; Sonnet
 * and Opus went for the blazes at 10–13 s anyway): the check's node carries 「点検が済むまで湧き場の前で戦わない」 as a forbid (the seed's
 * too, `CHECK_FORBID`), and a move through a fortress is planned in the rock below its corridors. The knowledge's blaze is r7's.
 */
export const FIRST_PLAN_SYSTEM_R7 = [
  FIRST_PLAN_SYSTEM_R6.replace(DRAGON_KNOWLEDGE, () => DRAGON_KNOWLEDGE_R7),
  '点検が済むまで戦わない（r7）:',
  `- 「出発の点検」の節には forbid に「${CHECK_FORBID}」を書く（この 1 行は 80 字まで）。ブレイズの節はその点検の後。`,
  '- 要塞の中・ブレイズの部屋の近くを通る移動の節は、通路を歩かず 1 段下の岩（ネザーラック）にトンネルを掘る道にし、その節の caution に「射線の中で止まらない」と書く。',
].join('\n');
/**
 * r8 (run 32: Opus's plan said 「p1.1 湧き場から岩の中を西へ」 and the move was made in the rock until the rock ended; then a one-wide bridge
 * without walls went over the lava sea, in sight of a fortress corridor, and she died on it): a node that crosses a gap in the Nether is
 * planned in the rock or as a bridge with walls, and says so in its caution.
 */
export const FIRST_PLAN_SYSTEM_R8 = [
  FIRST_PLAN_SYSTEM_R7,
  '空所を渡る節（r8）:',
  '- ネザーの空所（溶岩の海・深い穴・崖）を渡る節は、岩の中のトンネル（空所の縁の 1 段下の岩）か、両脇の足の高さに壁を置いた橋の道にする。'
    + '壁の無い幅 1 の橋は、落差 4 以上・敵のいる構造物（要塞・砦の遺跡）の近くでは使わない。',
  '- そういう節の caution に「橋は両脇に壁を置く」「橋の上で立ち止まらない」を書く（30 字以内）。',
].join('\n');
/**
 * r9 (run 33: p2 `dim:the_nether` was true at the start and its three children, among them 「ブレイズロッド7本」 with 0 rods, were closed with it;
 * p4 `dim:overworld` after the respawn; p1.5 `at:` of the overworld's place while she stood in the Nether): a node is done by its own
 * condition; a place is written with its dimension; the pearls come after the rods; the check holds one piece of golden armour.
 */
export const FIRST_PLAN_SYSTEM_R9 = [
  FIRST_PLAN_SYSTEM_R8,
  '済みの形と順番（r9）:',
  '- at: には次元を付ける: "at:196,69,237~6@overworld"、ネザーなら "@nether"（ネザーの x・z はオーバーワールドの 1/8。付けないと別の次元の同じ数字で済みになる）。',
  '- 子のある節の doneWhen は、子の仕事が済んだ後にだけ真になる持ち物の形（have:blaze_rod>=7 など）にする。dim:・at:（着いた事）は子の無い節に書く。'
    + '親が済んでも子は済みにならない: 子は自分の doneWhen（無ければ計画の更新）で済む。消費して無くなる物（板・棒・原木）は子の doneWhen にしない。'
    + '集める節（原木・丸石）の doneWhen は、集めた物で作った物との | にする（板や道具にすると数が減って戻る）: "have:log>=8|have:wooden_pickaxe"。',
  '- 順番: ブレイズロッド（7 本以上）の節はエンダーパールの節より前。「出発の点検」には金の防具 1 つ（have:gold_armor）も入れる（ネザーのピグリンは金の防具を着ていないと襲う）。',
].join('\n');

/**
 * How long the first plan waits for the body's scan when none is there yet (r4; the body scans once its chunks have settled after a
 * spawn: 2 s at least, 15 s at most, then about 30 ms). The plan is asked in the background; the seed plan holds meanwhile. r5 (the
 * body's r5 waits for 8 tenths of the server's view to load, up to 15 s after the spawn, and the head's first decision may come a few
 * seconds before it): 20 s, not 16.
 */
export const SCAN_WAIT = Object.freeze({ ms: 20_000, everyMs: 250 });

const text = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, limit) : '';
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The input: the goal, where and when she is, what she carries, and what the body knows of the land (cut to `inputCharacters`). */
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
 * r6: what the place she begins in lacks (`preparationShortage`, the check of the Nether's depth when she is there), and health that does
 * not come back: the code's facts, for the first node.
 */
function readinessInput(world: Record<string, unknown>): string[] {
  const dimension = typeof world.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : null;
  const food = carriedFood(world, {}).points, health = typeof world.health === 'number' ? world.health : null;
  const shortage = preparationShortage({ dimension, counts: carriedItemCounts(world, {}), food, nowTitle: null });
  const recovery = recoveryLine(typeof world.food === 'number' ? world.food : null, health, food);
  return [`食料: ${food} 点`, ...(shortage ? [shortage] : []), ...(recovery ? [recovery] : [])];
}

/** A node's texts from the answer; r4: its forbid and caution too (within the tree's bounds; an answer without them is as before). */
function seedFields(item: Record<string, unknown>): Omit<PlanSeed, 'title' | 'children' | 'id'> {
  const rules = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(line => text(line, PLAN_LIMITS.rule)).filter(Boolean))]
    .slice(0, PLAN_LIMITS.rules);
  const forbid = rules(item.forbid), caution = rules(item.caution);
  return { ...(text(item.where, 120) ? { where: text(item.where, 120) } : {}),
    ...(text(item.doneWhen, 120) ? { doneWhen: text(item.doneWhen, 120) } : {}), ...(text(item.note, 120) ? { note: text(item.note, 120) } : {}),
    ...(forbid.length ? { forbid } : {}), ...(caution.length ? { caution } : {}) };
}
/** The answer as a tree (null when it does not fit: no node, a parent not before its child, past the bounds). */
export function planFromAnswer(answer: unknown): PlanTree | null {
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
  return top.length ? planFromSeeds(top) : null;
}

const key = (value: string | undefined) => (value ?? '').replace(/\s+/gu, '').toLowerCase();
/**
 * `next` with the nodes `held` has done marked done in it too (same title, or same `doneWhen`). r6 (run 29: the strong model's 「動物を狩り
 * 肉を焼く」, doneWhen food>=100, came in done with 15.6 points of food: the seed's node of the same doneWhen had been closed under a parent
 * seen done): a node whose doneWhen is a predicate is never carried by its words; the frame says whether it holds (`minecraftPlanDone.ts`,
 * at the same read). Only a node in free words is carried by its title or doneWhen.
 */
export function carryDone(held: PlanTree, next: PlanTree): PlanTree {
  const done = held.nodes.filter(item => item.state === 'done');
  const titles = new Set(done.map(item => key(item.title))), proofs = new Set(done.flatMap(item => item.doneWhen ? [key(item.doneWhen)] : []));
  const carried = (item: PlanTree['nodes'][number]) => !parseDoneWhen(item.doneWhen)
    && (titles.has(key(item.title)) || (item.doneWhen !== undefined && proofs.has(key(item.doneWhen))));
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
    const tree = abort.signal.aborted ? null : planFromAnswer(answer);
    if (tree) slot.answer = tree;
    say(`Shannon Minecraft first plan ${tree ? 'planned' : 'missing'} task=${parts.taskId} nodes=${tree?.nodes.length ?? 0} ms=${Date.now() - began}`);
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
