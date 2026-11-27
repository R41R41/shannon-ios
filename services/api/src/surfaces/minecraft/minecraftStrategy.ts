import { CURRENT_PLAN_STRUCTURE } from './minecraftCurrentPlanPrompt.js';
import { PLAN_PREP_WORDS, PREP_DESCENT_LINES, PREP_RULES_WORDS } from './minecraftLlmcPrepRules.js';
import { FOOD_ACQUISITION_KNOWLEDGE } from './minecraftFoodAcquisition.js';
import { SINGLE_REQUEST_PLAN_WORDS } from './minecraftRequestKnowledge.js';
import { planGoal } from './minecraftFirstPlan.js';

function endKnowledge(bucketCaution: string): string {
  return [
  '### ストロングホールドとエンド',
  '- 最初の 3 つの要塞は原点から 1,280〜2,816m の輪の上。アイは 2 か所（1 投目の線の横へ 24〜32m 動いた所。線の先へ進んで投げても同じ線）から投げ、方位の線の交点が要塞（地下 y=10〜40 前後）。'
    + '交点と誤差は頭が計算して live に出す。アイが真下へ沈む所は要塞の入口（階段）で、枠の部屋の真上とは限らない。交点・入口に着いたら、見えている枠・通路の観測（mc_probe kind=frames）で枠の部屋を探し、観測した枠を推測より優先する。',
  '- 中は石レンガの廊下・階段・小部屋が迷路状に続く。図書室・牢屋・泉の部屋は寄らない。ポータルの部屋は、溶岩の溜まりの上に枠 12 個の台と、台へ上る階段。'
    + 'シルバーフィッシュのスポナーがあれば壊す。枠 12 か所にアイをはめるとエンドポータルが開く。',
  '- 部屋に入る前、近くでベッドを使ってリスポーン地点にしておく（昼でも設定できる）と、エンドで死んでも要塞の近くで復活して早く戻れる。このベッドは置いたまま入るので、戦い用の 8 とは別の 1 個（合計 9）。',
  '- エンド: 入る前に丸石か黒曜石を 3 個以上（橋の分で 64 以上）持つ。着く足場の火の玉は足元に積んで避ける。'
    + '虚空は橋で渡る → 結晶を全部壊した後、本命はベッドで倒す（止まり木に座った竜の頭へ、1 回の座りの間にベッドを続けて使う。黒曜石を盾と台にする）。'
    + '竜の前に結晶を檻つきも全部壊す（1 本でも残ると竜は毎秒 2 回復し、本数に比例しない。ベッド 1 座りの傷は最大 121 で、次の座りまでに戻る）。',
  '- 結晶の壊し方: 檻なしは弓で 13〜64m から 1 発、弓が無ければ低い柱を登って殴る。檻つきは柱を登り、結晶と同じ高さから格子ごしにそのまま殴り（格子は掘らない）、降りる。結晶が 0 本になってから竜を倒す（ベッドか窪みの剣）。',
  bucketCaution,
  '- 帰り: ドラゴンを倒すと真ん中の岩盤の台に帰りのポータルが開く。入るとオーバーワールドのリスポーン地点（ベッドか最初の場所）へ戻る。',
  ].join('\n');
}

/**
 * the own prompt, the first plan (owner answers of 2026-10-22 by form: 「同じ方針で絞る」「要塞とエンドは作戦へ」, and ADR-0014
 * §7-3: the key points of the 11 old procedures go to the strategy, not to the decision). The first plan (Opus) reads this strategic
 * knowledge instead of the route and tactics sections r3–r9 gave it (`ORDER_KNOWLEDGE`, `FOOD_KNOWLEDGE`, `VILLAGE_KNOWLEDGE`,
 * `DRAGON_KNOWLEDGE_R7`, `NETHER_ENTRY_KNOWLEDGE`): the order, the materials, the procedures' key points, where the places are and how
 * the stronghold and the way home from the End look. How to fight, cross, dig and look is the decision's (`minecraftKnowledgeCore.ts`).
 * Food points and the departure lists stay the code's (`minecraftLlmcLive.ts`, `minecraftLlmcReadiness.ts`). Knowledge, not an order.
 */
export const STRATEGY_KNOWLEDGE = [
  '## 作戦の知識（計画を立てるため。知識であり命令ではない）',
  '### 順番',
  '- オーバーワールド: 木→木のツルハシ→石の道具→食料とベッド（最初の夜の前、鉄より前に 40〜60 点）→鉄→バケツ・盾・鉄の防具→ダイヤ→黒曜石→ゲート→ネザー。'
    + '村が見えていれば最初に回る（ベッド全部・干し草・育った畑・箱）。',
  '- ネザー: 帰りのゲートの座標→出発の点検→要塞→ブレイズロッド 7 本以上→エンダーパール 14（棒と並べてよい）→オーバーワールドでアイ 14（枠 12＋予備）→三角測量→'
    + 'ストロングホールド→エンド（食料 330 点（焼き牛 16）・ベッド 10（最低 8）・黒曜石 12・弓と矢 12（道中で作る）・水入りバケツ）。ネザーの奥へは食料 100 点以上。',
  '### 手順の要点（旧手順 11 個）',
  '- 原木: 序盤は石の斧の後に最低 12・安心 24 本まで一度に取る（通しの板・棒・盾・ベッドの板・箱の分。後で木のために地上へ戻らない）。それ以後は次の工作に不足する分。原木 1 → 板 4（作業台は要らない）。',
  '- 木と石のツルハシ: 作業台は板 4、棒は板 2 で 4 本。木のツルハシは板 3＋棒 2、石のツルハシは丸石 3＋棒 2（木のツルハシで石を掘る）。',
  '- 石の斧: 丸石 3＋棒 2（石の剣は丸石 2＋棒 1）。かまどは丸石 8。',
  '- 食料・羊・ベッド: 牛・豚・羊・鶏を 4〜6 体狩ってかまどで焼く（燃料は石炭: 1 で 8 個。木は道具の分なので燃やさない）。ベッドは同じ色の羊毛 3＋板 3（羊 3 匹）。',
  '- 鉄: y=16 前後、洞窟の壁（地図の i）。石のツルハシ以上で掘り、かまどで焼く。24〜36 個（ツルハシ 3・バケツ 3・盾 1・防具 24・火打ち金 1・ハサミ 2）。',
  '- バケツ: 鉄 3。水は水源（w）から汲む（流れからは汲めない）。',
  '- 鉄の防具: 兜 5・胸 8・脚 7・靴 4（計 24）。盾は板 6＋鉄 1。',
  '- ダイヤ: y=-58 前後（深層岩、d）。鉄のツルハシで掘る。3 個でダイヤのツルハシ（黒曜石に要る）、2 個で剣。',
  '- 黒曜石: 溶岩源に水バケツを注ぐと黒曜石、ダイヤのツルハシで掘る（1 個 9 秒）。水を汲み戻して繰り返す。流れる溶岩からは丸石。',
  '- ゲート: 黒曜石 10（角を入れれば 14）で幅 4×高さ 5 の枠。火打ち金（鉄 1＋火打石 1。火打石は砂利を掘る）で中の下の面に点火。',
  '### 場所',
  '- ネザーの x・z はオーバーワールドの 1/8。ネザーは 432m 四方の区画に分かれ、どの区画にも要塞か砦の遺跡のどちらか 1 つがある（区画の中の置き場は乱数で、帯や決まった向きは無い）。'
    + '要塞（ネザーレンガ）の方角は着いてから決める: world.scan の「ネザーの区画」と見えた構造物を見て、今の区画が要塞ならその方へ、砦なら隣の区画へ。'
    + '隣のどれかは、まだ読めていない向き・見通しの良い向き・溶岩の湖や崖の少ない向きで選び、新しい区画の答えが出るまでその方角を保つ。'
    + '砦の遺跡（黒い石の大きな建物）は金の箱があり（真珠は無い）、ピグリンが多い（金の防具を 1 つ着てから）。歪んだ森（青い森）にエンダーマン。',
  '- ブレイズは 1 体で棒が平均 0.5 本: 20 体を見込む（14 体で 7 本そろうのは約 6 割）、400〜700 秒。'
    + 'パールはエンダーマンか、ピグリンへの金の延べ棒（当たり約 2.1%・2〜4 個、金 15.6 個で平均 1 個。14 個に金 220 個前後、エンダーマンなら約 28 体。どれも平均の期待値）。',
  '- ネザーで作れる物: 幹→板・作業台・棒、丸石 3→ハーフブロック 6、金塊 9→延べ棒 1。鉄はネザーに無い（オーバーワールドから持って行く）。',
  endKnowledge('- 鉄格子の檻つきは、水の入ったバケツ（鉄 3。hotbar に）と積める物 3 個以上を持って登る。下りは積んだ柱を掘り下るか、水バケツで着水する飛び降り（実走で被害 0 だった最大は総落差 25m、ラボは 90m。pack の水バケツは先に equip）。降りる手の費用は、高所に居る間の live の「高所:」の行が並べる。'),
].join('\n');

/**
 * mb-llmc v2 (Notion 09-1c 2-2 P1: the plan read 「ベッド全部・鉄 24〜36」 first and its corrections at the end; owner 2026-10-24: the iron
 * helmet, chestplate and leggings before the diamonds, golden boots before the gate): the same knowledge with one set of numbers, those of
 * `minecraftLlmcPrepRules.ts`, and no section that a later one overrides.
 */
export const STRATEGY_KNOWLEDGE_V2 = [
  '## 作戦の知識（計画を立てるため。知識であり命令ではない）',
  '### 順番',
  '- オーバーワールド: 木→木のツルハシ→石の道具→食料とベッド（最初の夜の前、鉄より前に 40〜60 点）→鉄→ツルハシ・バケツ・盾・鉄の兜・胸当て→ダイヤ→'
    + '金のブーツ→黒曜石→ゲート→ネザー。村が見えていれば最初に回る（ベッド全部・干し草・育った畑・箱）。',
  '- ネザー: 帰りのゲートの座標→出発の点検→要塞→ブレイズロッド 7 本以上→エンダーパール 14（棒と並べてよい）→オーバーワールドでアイ 14（枠 12＋予備）→三角測量→'
    + 'ストロングホールド→エンド（食料 330 点（焼き牛 16）・ベッド 10（最低 8）・黒曜石 12・弓と矢 12（道中で作る）・水入りバケツ）。',
  '### 段ごとの準備（この数がすべて。後の訂正は無い）',
  ...PREP_DESCENT_LINES,
  PREP_RULES_WORDS,
  '- エンダーアイを 10 個以上持って現世にいる場合の鉄: ネザーへ行かないので「ネザーまでに約 30」は要らない。要るのは今の道具・防具に足りない分だけ（入力の「持っている完成品」を引く）で、要塞の後ろ・エンドへ入る節の前でよい。',
  '### 手順の要点',
  FOOD_ACQUISITION_KNOWLEDGE,
  '- 原木: 序盤は石の斧の後に最低 12・安心 24 本まで一度に取る（後で木のために地上へ戻らない）。それ以後は次の工作に不足する分。原木 1 → 板 4（作業台は要らない）。崖の上など届かない木は選ばない（足の高さから幹に届く木か、走査の近い原木）。',
  '- 木と石のツルハシ: 作業台は板 4、棒は板 2 で 4 本。木のツルハシは板 3＋棒 2、石のツルハシは丸石 3＋棒 2（木のツルハシで石を掘る）。',
  '- 石の斧: 丸石 3＋棒 2（石の剣は丸石 2＋棒 1）。かまどは丸石 8。',
  '- 食料: 村の干し草（1 個でパン 3＝約 33 点）・育った畑・箱が先。無ければ石の剣か斧を作ってから牛・豚・羊・鶏を 4〜6 体狩って焼く（燃料は石炭: 1 で 8 個。木は道具の分なので燃やさない）。',
  '- 鉄: y=16 前後、洞窟の壁（地図の i）。石のツルハシ以上で掘り、かまどで焼く（焼ける間は別の仕事）。鉄の防具は兜 5・胸 8・脚 7。盾は板 6＋鉄 1。',
  '- ダイヤ: y=-58 前後（深層岩、d）。鉄のツルハシで掘る。3 個でダイヤのツルハシ（黒曜石に要る）、2 個で剣。',
  '- 黒曜石: 溶岩源に水バケツを注ぐと黒曜石、ダイヤのツルハシで掘る（1 個約 9 秒）。10 個には源が 10 以上ある溶岩の溜まりへ行く（単独の源は 1 個にしかならない）。',
  '- ゲート: 黒曜石 10（角を入れれば 14）で幅 4×高さ 5 の枠。火打ち金（鉄 1＋火打石 1。火打石は砂利を掘る）で中の下の面に点火。',
  '### 場所',
  '- ネザーの x・z はオーバーワールドの 1/8。ネザーは 432m 四方の区画に分かれ、どの区画にも要塞か砦の遺跡のどちらか 1 つがある（区画の中の置き場は乱数で、帯や決まった向きは無い）。'
    + '要塞（ネザーレンガ）の方角は着いてから決める: world.scan の「ネザーの区画」と見えた構造物を見て、今の区画が要塞ならその方へ、砦なら隣の区画へ。'
    + '隣のどれかは、まだ読めていない向き・見通しの良い向き・溶岩の湖や崖の少ない向きで選び、新しい区画の答えが出るまでその方角を保つ。'
    + '砦の遺跡（黒い石の大きな建物）は金の箱があり（真珠は無い）、ピグリンが多い。歪んだ森（青い森）にエンダーマン。',
  '- ブレイズは 1 体で棒が平均 0.5 本: 20 体を見込む（14 体で 7 本そろうのは約 6 割）、400〜700 秒。'
    + 'パールはエンダーマンか、ピグリンへの金の延べ棒（当たり約 2.1%・2〜4 個、金 15.6 個で平均 1 個。14 個に金 220 個前後、エンダーマンなら約 28 体。どれも平均の期待値）。',
  '- ネザーで作れる物: 幹→板・作業台・棒、丸石 3→ハーフブロック 6、金塊 9→延べ棒 1。鉄はネザーに無い（オーバーワールドから持って行く）。',
  endKnowledge('- 鉄格子の檻つきは、水の入ったバケツ（鉄 3。hotbar に）と積める物 3 個以上を持って登る。'
    + '体の落下止めは、エンドで手か hotbar の水バケツと真下の固い床がある時に水で着水する（実走で被害 0 だった最大は総落差 25m、ラボは 90m。pack の水バケツは先に equip。虚空・横の押し・敵・火の玉や息の雲の最中は未確認）。'
    + '下りは vertical で掘るか、go に maxDrop を付けた飛び降りか（費用は live の「高所:」の行）。外れれば 20 ブロックで被害 17、それ以上は死ぬ。'),
].join('\n');

const WHOLE_GAME_PLAN_LINES: readonly string[] = ['- エンドラ討伐の後半は', '- 準備の不足は、', '- 順番（エンダーアイを 10 個以上', '- 要塞へ向かう節の書き方'];

/** The active template is assembled directly; no historical exact-string replacements. */
export function ownFirstPlanSystem(): string {
  return [CURRENT_PLAN_STRUCTURE, PLAN_PREP_WORDS, STRATEGY_KNOWLEDGE_V2].join('\n');
}

/**
 * The first plan's words for a request that is one thing to make or fetch (`planGoal` is null: not the dragon, not the Nether): the same structure,
 * and in place of the whole-game route and the descent's preparation the words of a request (`minecraftRequestKnowledge.ts`).
 */
export function singleRequestFirstPlanSystem(): string {
  // Two lines of the structure speak of the whole game and point at a preparation policy this text does not carry (「下の方針」, the village's
  // hay and beds, the dragon's second half): left in, they contradict the request's own words that no food or night node comes first.
  const structure = CURRENT_PLAN_STRUCTURE.split('\n').filter(line => !WHOLE_GAME_PLAN_LINES.some(start => line.startsWith(start)));
  return [structure.join('\n'), SINGLE_REQUEST_PLAN_WORDS].join('\n');
}

/** The first plan's words for a goal: the whole game's for the dragon and the Nether, the request's for any other. */
export function firstPlanSystemFor(goal: string): string {
  return planGoal(goal) === null ? singleRequestFirstPlanSystem() : ownFirstPlanSystem();
}
