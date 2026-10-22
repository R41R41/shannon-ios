import {
  DRAGON_KNOWLEDGE_R7, FOOD_KNOWLEDGE, NETHER_ENTRY_KNOWLEDGE, ORDER_KNOWLEDGE, VILLAGE_KNOWLEDGE,
} from './minecraftKnowledge.js';
import { FIRST_PLAN_SYSTEM_R9 } from './minecraftFirstPlan.js';

/**
 * SHANNON_MINECRAFT_OWN_PROMPT, the first plan (owner answers of 2026-10-22 by form: 「同じ方針で絞る」「要塞とエンドは作戦へ」, and ADR-0014
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
  '- ネザー: 帰りのゲートの座標→出発の点検→要塞→ブレイズロッド 7 本以上→エンダーパール 12 前後（棒の後）→オーバーワールドでアイ 12〜14→三角測量→'
    + 'ストロングホールド→エンド（食料 80 点以上・ベッド 4〜6・弓と矢 30）。ネザーの奥へは食料 100 点以上。',
  '### 手順の要点（旧手順 11 個）',
  '- 原木: 6〜10 本。原木 1 → 板 4（作業台は要らない）。',
  '- 木と石のツルハシ: 作業台は板 4、棒は板 2 で 4 本。木のツルハシは板 3＋棒 2、石のツルハシは丸石 3＋棒 2（木のツルハシで石を掘る）。',
  '- 石の斧: 丸石 3＋棒 2（石の剣は丸石 2＋棒 1）。かまどは丸石 8。',
  '- 食料・羊・ベッド: 牛・豚・羊・鶏を 4〜6 体狩ってかまどで焼く（石炭 1 で 8 個、木材 1 で 1.5 個）。ベッドは同じ色の羊毛 3＋板 3（羊 3 匹）。',
  '- 鉄: y=16 前後、洞窟の壁（地図の i）。石のツルハシ以上で掘り、かまどで焼く。24〜36 個（ツルハシ 3・バケツ 3・盾 1・防具 24・火打ち金 1・ハサミ 2）。',
  '- バケツ: 鉄 3。水は水源（w）から汲む（流れからは汲めない）。',
  '- 鉄の防具: 兜 5・胸 8・脚 7・靴 4（計 24）。盾は板 6＋鉄 1。',
  '- ダイヤ: y=-58 前後（深層岩、d）。鉄のツルハシで掘る。3 個でダイヤのツルハシ（黒曜石に要る）、2 個で剣。',
  '- 黒曜石: 溶岩源に水バケツを注ぐと黒曜石、ダイヤのツルハシで掘る（1 個 9 秒）。水を汲み戻して繰り返す。流れる溶岩からは丸石。',
  '- ゲート: 黒曜石 10（角を入れれば 14）で幅 4×高さ 5 の枠。火打ち金（鉄 1＋火打石 1。火打石は砂利を掘る）で中の下の面に点火。',
  '### 場所',
  '- ネザーの x・z はオーバーワールドの 1/8。要塞（ネザーレンガ）は南北か東西の帯に並ぶ: ゲートから 1 方向へ 100〜300、無ければ直角へ。'
    + '砦の遺跡（黒い石の大きな建物）は金と真珠の箱があり、ピグリンが多い（金の防具を 1 つ着てから）。歪んだ森（青い森）にエンダーマン。',
  '- ブレイズは 1 体で棒が平均 0.5 本: 14 体ほど、300〜500 秒。パールはエンダーマンか、ピグリンへの金の延べ棒（2〜4%、金 20〜30 で 1〜2 個）。',
  '- ネザーで作れる物: 幹→板・作業台・棒、丸石 3→ハーフブロック 6、金塊 9→延べ棒 1。鉄はネザーに無い（オーバーワールドから持って行く）。',
  '### ストロングホールドとエンド',
  '- アイを 200m 以上離れた 2 地点で投げ、方位の線の交点がストロングホールド（地下 y=30〜0 前後）。近づいたらもう 1 回投げて下を向くか見る。',
  '- 中は石レンガの廊下・階段・小部屋が迷路状に続く。図書室・牢屋・泉の部屋は寄らない。ポータルの部屋は、溶岩の溜まりの上に枠 12 個の台と、台へ上る階段。'
    + 'シルバーフィッシュのスポナーがあれば壊す。枠 12 か所にアイをはめるとエンドポータルが開く。',
  '- エンド: 黒曜石の柱の上のエンドクリスタルを先に壊す（矢・鉄格子の囲いは登る）。ドラゴンは真ん中の止まり木に降りた時に剣かベッドの爆発で打つ。',
  '- 帰り: ドラゴンを倒すと真ん中の岩盤の台に帰りのポータルが開く。入るとオーバーワールドのリスポーン地点（ベッドか最初の場所）へ戻る。',
].join('\n');

const KNOWLEDGE_LINE = '下の知識を使う（知識であり命令ではない）:';
/** r9's first-plan words with this knowledge: the planner's first line without her name, and no route or tactics sections of r3–r9. */
export function ownFirstPlanSystem(): string {
  let text = FIRST_PLAN_SYSTEM_R9.replace('あなたはマイクラの体を動かすシャノンの、最初の計画ツリーを立てる係。',
    'あなたはマイクラの体のタスクの、最初の計画ツリーを立てる係。');
  for (const section of [`${KNOWLEDGE_LINE}\n${[ORDER_KNOWLEDGE, FOOD_KNOWLEDGE, VILLAGE_KNOWLEDGE, DRAGON_KNOWLEDGE_R7].join('\n')}\n`,
    `\n${NETHER_ENTRY_KNOWLEDGE}`]) {
    if (!text.includes(section)) throw new Error('MINECRAFT_FIRST_PLAN_WORDS_CHANGED');
    text = text.replace(section, () => '');
  }
  return `${text}\n${STRATEGY_KNOWLEDGE}`;
}
