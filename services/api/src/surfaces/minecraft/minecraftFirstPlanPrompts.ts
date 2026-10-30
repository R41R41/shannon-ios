import { PLAN_KINDS } from '@shannon/mind';
import {
  DRAGON_KNOWLEDGE,
  DRAGON_KNOWLEDGE_R7,
  FOOD_KNOWLEDGE,
  NETHER_ENTRY_KNOWLEDGE,
  ORDER_KNOWLEDGE,
  VILLAGE_KNOWLEDGE,
} from './minecraftKnowledge.js';

/**
 * The first plan tree of a Minecraft task (design mb-llm-centric 2.5, 2.6: the route becomes the first plan,
 * asked of a strong model once;
 * owner 2026-10-21: the whole game, the Nether, the fortress and the End in the same shape; food before the
 * first night, before iron).
 *
 * At the task's first decision the task holds the fixed seed of its goal (`seedPlan`, no model needed: the body
 * never waits for a plan),
 * and the strong model (`SHANNON_MINECRAFT_LLMC_PLAN_MODEL`, Opus 5.5) is asked once for the plan of this world
 * (where the village, the
 * cave, the lava are). Its answer replaces the tree at the next read, the nodes already done carried over by title or `doneWhen`
 * (`FcaPlanInbox`); from then the plan is hers alone (`plan.update`).
 */
/**
 * Run 27 (2026-10-22): the first plan took 46 s and 5,221 output tokens for 54 nodes, each with a long where,
 * doneWhen and note. The
 * answer is now asked shorter (40 nodes, short fields, no note) at low effort: about half the tokens and the
 * time. The 4.96 s the API's
 * event loop was blocked just before it came back was not this answer (its parse is well under a millisecond)
 * but the body recall's
 * first pool (odyTaskRecall.ts, poolMs 3,076), now built over several turns of the loop.
 */
export const FIRST_PLAN = Object.freeze({ inputCharacters: 6_000, giveUpMs: 120_000, outputTokens: 6_000, nodes: 40 });

/** r7: the check's forbid (the seed's, and the words the first plan is asked to write: `FIRST_PLAN_SYSTEM_R7`). */
export const CHECK_FORBID = '点検（作業台・ハーフブロック・盾・食料 100・金の防具）が済むまで、湧き場の前で戦わない。受けた時は離れて塞ぐ';

/**
 * r4 (mb-llmc r4; arch-check 6: run 26 went on to the fortress with no table while a Nether stem stood 4 m away; run 27's
 * 160 m held no tree at all and the plan had to choose which way to look): the body's scan of the land goes into
 * the input, and a node may
 * carry what not to do and what to mind there (`forbid`, `caution`; arch-check 23: of a supervisor's words, these held longest).
 */
export const rulesField = { type: 'array', items: { type: 'string' } };

/** A promise of the answer (chapter 3): `until` and `instead` are texts the head reads (`parseCondition`); one it
 * cannot read leaves the promise out. */
export const promiseField = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['item', 'count', 'use'],
    properties: {
      item: { type: 'string' },
      count: { type: 'integer' },
      use: { type: 'string' },
      instead: { type: 'string' },
      until: { type: 'object', additionalProperties: false, properties: { node: { type: 'string' }, condition: { type: 'string' } } },
    },
  },
};

/** The strong model's answer: the nodes flat, each naming its parent (`""` at the top), in order. */
export const FIRST_PLAN_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['nodes'],
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'parent', 'title', 'where', 'doneWhen'],
        properties: {
          id: { type: 'string' },
          parent: { type: 'string' },
          title: { type: 'string' },
          where: { type: 'string' },
          doneWhen: { type: 'string' },
        },
      },
    },
  },
});

/**
 * The continue contract (chapter 7, 3): each node has a `kind` the head's code reads (the check of a stage, the
 * knowledge of a stage, the gate back, the near creatures a plan needs…), and the
 * plan may hold `promises` (what to keep, for what). The model writes them; the code reads no title for them.
 */
export const KIND_WORDS =
  '- 各節に kind を付ける（頭のコードは題の言葉でなくこれで判断する。名前のとおりの仕事に付け、どれでもなければ other）: ' +
  'prep_descent は下りる前・出発前の準備（食料と作業台）、pearl はパールとアイ、portal はゲート、chest は箱を開ける節。';

export const PROMISE_WORDS =
  '- 取っておく物（作業台の板 4 など）があれば promises に item（物の名前か food）・count・use（用途）を書く。期限は until（node: 節の id、condition: ' +
  'have:crafting_table>=1 の形）、代わりに足りる条件は instead。無ければ空。';

export const FIRST_PLAN_SYSTEM = [
  'あなたはマイクラの体を動かすシャノンの、最初の計画ツリーを立てる係。依頼（goal）を、済ませる順の節の木にする。',
  `- 節は全部で${FIRST_PLAN.nodes}まで、深さ3まで（親1つに子は6まで）。id は p1, p1.2 のような短い文字。parent は親の id、一番上は ""。並びは済ませる順。`,
  '- title は20字以内で、する事。where はその場所（座標だけ、分からなければ ""）。doneWhen は済んだと分かる観測（持ち物の名前と数、20字以内、無ければ ""）。note ' +
    'は書かない。説明の文は要らない。',
  '- 入力の地図・目印・場所の記憶・通ったバイオームにある物だけを場所に使う。無い物を作り出さない。座標は見立て。',
  '- 食料の節は鉄より前（最初の夜の前）。村が見えていれば、最初に近い節で村を回ってベッド・干し草・畑・箱を取る。',
  '- 最初の「木と石の道具」は、原木の節（作業台・木のツルハシ・斧と石の道具の棒の分: doneWhen は have:log>=8 の形。ツルハシ 1 つで済みにしない）、作業台と木のツルハシ、' +
    '丸石で石のツルハシ・石の斧・石の剣（doneWhen は have:stone_pickaxe&have:stone_axe&have:stone_sword。斧を落とさない）に分ける。',
  '- 鉄を掘りに地下へ下りる前に済ませる物（食料 40 点・石の斧・作業台か板 4 以上・板の余り）は、鉄の節より前の節か、その doneWhen に入れる。',
  '- 依頼がエンドラ討伐なら、ネザー・要塞・ブレイズ・パール・アイ・ストロングホールド・エンドまで全部入れる。ネザーまでなら、ネザーに入るまで。',
  '- 依頼がそれ以外なら、その依頼に要る節だけ。',
  KIND_WORDS,
  PROMISE_WORDS,
  '下の知識を使う（知識であり命令ではない）:',
  ORDER_KNOWLEDGE,
  FOOD_KNOWLEDGE,
  VILLAGE_KNOWLEDGE,
  DRAGON_KNOWLEDGE,
].join('\n');

export const FIRST_PLAN_SCHEMA_R4 = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['nodes'],
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'parent', 'title', 'kind', 'where', 'doneWhen'],
        properties: {
          id: { type: 'string' },
          parent: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string', enum: [...PLAN_KINDS] },
          where: { type: 'string' },
          doneWhen: { type: 'string' },
          forbid: rulesField,
          caution: rulesField,
        },
      },
    },
    promises: promiseField,
  },
});

export const FIRST_PLAN_SYSTEM_R4 = [
  FIRST_PLAN_SYSTEM,
  '走査と禁止・注意（r4）:',
  '- 入力の「走査」は、体が読み込み済みの範囲（約 160m）を数えた物。原木・村・水・溶岩・構造物・ネザーの幹・要塞・ポータルの座標を where に使う。' +
    '走査に無い物は 160m の外にある: 探しに出る向き（走査の地形・バイオームから）を節にする。',
  '- 節の forbid（してはいけない事）・caution（気をつける事）は、その節で特に守る事だけ書く（無ければ書かない）。各 2 つまで、30 字以内。' +
    '例: forbid「素手で真下を掘らない」「村の鉄ゴーレムを殴らない」、caution「水の溜まりの上で掘らない」「溶岩の隣を掘らない」。',
  NETHER_ENTRY_KNOWLEDGE,
].join('\n');

/**
 * r5 (run 28: Sonnet never called plan.update and the plan's "now" stayed on its first node; owner 2026-10-22
 * 「止めて直す」): each doneWhen an
 * observation can show is written as a predicate, which the head checks at every decision (`minecraftPlanDone.ts`).
 */
export const FIRST_PLAN_SYSTEM_R5 = [
  FIRST_PLAN_SYSTEM_R4,
  '済みの形（r5）:',
  '- doneWhen は、観測で確かめられる形で書く（頭のコードが毎判断に確かめて、その節を済みにし、今の節を次へ進める）。' +
    ('have:物 か have:物>=数（持ち物・着ている物。物は id か、log・planks・bed・bucket・slab のような id の末尾）、dim:the_nether か ' +
      'dim:the_end（次元）、') +
    'at:x,y,z~半径（その近くに立つ）、food>=点（持っている食料点）。& で全部、| でどれか（& が先）。この形は 20 字を超えてよい（120 字まで）。',
  '- 例: "have:stone_pickaxe&have:stone_sword"、"have:log>=6|have:wooden_pickaxe"、"food>=40&have:bed"、' +
    '"have:iron_ingot>=24|have:iron_chestplate"、"dim:the_nether"、' +
    '"at:196,69,237~6"。観測で確かめようのない節（探す・回る・見る）は ""。',
].join('\n');

/**
 * r6 (run 29: begun in a Nether fortress, the plan's 28 nodes put no food before the blazes; Sonnet went to the
 * spawner at 10 s with one
 * mutton and no table, slabs or shield): the plan begins where she is, and what the place's check lacks (the
 * input's 「準備の不足」, the code's
 * fact) is its first node.
 */
export const FIRST_PLAN_SYSTEM_R6 = [
  FIRST_PLAN_SYSTEM_R5,
  '今いる所から（r6）:',
  '- 計画は入力の「ディメンション」の今いる所から始める（ネザー・エンドから始まった時に、オーバーワールドの最初の節は書かない）。',
  '- 入力に「準備の不足」があれば、最初の節を「出発の点検」にし、足りない物（食料を含む）をその子の節にする。各子に作り方か取りに行く所（走査の座標）を where に、' +
    '観測の形の doneWhen（have:物>=数・food>=点）を書く。ネザーで食料が足りなければ、真紅の森のホグリンか、帰りのゲートからオーバーワールドへ戻って狩る節にする。',
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
 * without walls went over the lava sea, in sight of a fortress corridor, and she died on it): a node that
 * crosses a gap in the Nether is
 * planned in the rock or as a bridge with walls, and says so in its caution.
 */
export const FIRST_PLAN_SYSTEM_R8 = [
  FIRST_PLAN_SYSTEM_R7,
  '空所を渡る節（r8）:',
  '- ネザーの空所（溶岩の海・深い穴・崖）を渡る節は、岩の中のトンネル（空所の縁の 1 段下の岩）か、両脇の足の高さに壁を置いた橋の道にする。' +
    '壁の無い幅 1 の橋は、落差 4 以上・敵のいる構造物（要塞・砦の遺跡）の近くでは使わない。',
  '- そういう節の caution に「橋は両脇に壁を置く」「橋の上で立ち止まらない」を書く（30 字以内）。',
].join('\n');

/**
 * r9 (run 33: p2 `dim:the_nether` was true at the start and its three children, among them 「ブレイズロッド7本」 with 0
 * rods, were closed with it;
 * p4 `dim:overworld` after the respawn; p1.5 `at:` of the overworld's place while she stood in the Nether): a
 * node is done by its own
 * condition; a place is written with its dimension; the pearls come after the rods; the check holds one piece of golden armour.
 */
export const FIRST_PLAN_SYSTEM_R9 = [
  FIRST_PLAN_SYSTEM_R8,
  '済みの形と順番（r9）:',
  '- at: には次元を付ける: "at:196,69,237~6@overworld"、ネザーなら "@nether"（ネザーの x・z はオーバーワールドの 1/8。付けないと別の次元の同じ数字で済みになる）。',
  '- 子のある節の doneWhen は、子の仕事が済んだ後にだけ真になる持ち物の形（have:blaze_rod>=7 など）にする。dim:・at:（着いた事）は子の無い節に書く。' +
    '親が済んでも子は済みにならない: 子は自分の doneWhen（無ければ計画の更新）で済む。消費して無くなる物（板・棒・原木）は子の doneWhen にしない。' +
    '集める節（原木・丸石）の doneWhen は、集めた物で作った物との | にする（板や道具にすると数が減って戻る）: "have:log>=8|have:wooden_pickaxe"。',
  '- 順番: ブレイズロッド（7 本以上）の節はエンダーパールの節より前。「出発の点検」には金の防具 1 つ（have:gold_armor）も入れる（ネザーのピグリンは金の防具を着ていないと襲う）。',
].join('\n');
