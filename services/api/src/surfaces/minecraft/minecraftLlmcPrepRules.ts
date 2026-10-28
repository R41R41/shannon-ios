/**
 * mb-llmc v2 (owner 2026-10-24, after run 38: 「鉄装備を足しか作らない。金装備をしてからネザーに行っていない。最善は足だけ金ブーツ。その他レギンス、
 * チェストプレート、ヘルメットは鉄にしてからダイヤ採掘やネザーに行くべき」; Notion 09-1c 6-2: the gate's, the fortress's and the End's rules in one place, from
 * which the first plan's words, the stage knowledge and the shortage are made, instead of old numbers corrected at the end).
 *
 * One table of what each stage of the way needs before it begins. Its words (`prepWords`) go to the first plan and the stage knowledge; its needs go to
 * `preparationShortage` (`minecraftLlmcReadiness.ts`); the seed plan's nodes name the same items (`minecraftFirstPlan.ts`).
 * - before the diamonds: an iron pickaxe, a bucket, a shield, and the iron helmet, chestplate and leggings, worn (the diamonds are at y=-58, among lava and
 *   the deep dark's mobs);
 * - before the gate: the same, the golden boots (the feet's piece in gold: a piglin does not attack one who wears a golden piece, and the boots are the
 *   cheapest, 4 ingots, and lose the least protection), a sword, blocks to stand on and the first stretch's food;
 * - before the Nether's depth and the End: as they were (the check after she is in, and the End's beds, bow and eyes).
 */
export interface PrepNeed { label: string; count: number; pattern: RegExp; slots?: boolean; worn?: boolean }
export interface PrepStage { title: string; food: number; needs: readonly PrepNeed[] }

/** Blocks to stand on and to wall with (the knowledge's 足場のブロック 64). */
export const BLOCKS = new RegExp('^(?:cobblestone|cobbled_deepslate|netherrack|blackstone|stone|deepslate|dirt|andesite|diorite|granite|tuff'
  + '|basalt|end_stone|nether_bricks)$', 'u');
/** The three pieces in iron or better (the feet are the golden boots'). */
export const UPPER_ARMOUR = /^(?:iron|diamond|netherite)_(?:helmet|chestplate|leggings)$/u;
export const GOLDEN_BOOTS = /^golden_boots$/u;

const PICKAXE: PrepNeed = { label: '鉄以上のツルハシ', count: 1, pattern: /^(?:iron|diamond|netherite)_pickaxe$/u };
const BUCKET: PrepNeed = { label: 'バケツ', count: 1, pattern: /^(?:bucket|water_bucket|lava_bucket)$/u };
const SHIELD: PrepNeed = { label: '盾', count: 1, pattern: /^shield$/u };
const ARMOUR: PrepNeed = { label: '鉄の兜・胸当て・脚', count: 3, pattern: UPPER_ARMOUR, slots: true, worn: true };
const BOOTS: PrepNeed = { label: '金のブーツ', count: 1, pattern: GOLDEN_BOOTS, worn: true };
const SWORD: PrepNeed = { label: '剣', count: 1, pattern: /^(?:stone|iron|diamond|netherite)_sword$/u };
const FOOTING: PrepNeed = { label: '足場のブロック', count: 64, pattern: BLOCKS };

export const BEFORE_DIAMONDS: PrepStage = { title: 'ダイヤを掘る前', food: 40, needs: [PICKAXE, BUCKET, SHIELD, ARMOUR] };
export const BEFORE_GATE: PrepStage = { title: 'ネザーに入る前', food: 40, needs: [PICKAXE, SHIELD, SWORD, ARMOUR, BOOTS, FOOTING] };

/** The iron the way to the Nether takes: pickaxe 3, bucket 3, shield 1, helmet 5, chestplate 8, leggings 7, flint and steel 1, sword 2. */
export const IRON_BEFORE_NETHER = 30;
/** The gold of the golden boots (ingots). */
export const GOLD_FOR_BOOTS = 4;

/**
 * The 500 of this constant came from run 42's one trip back to the surface (540 s, with the go's fault in it): it is not a loss in general, and no sentence
 * says it as one. The instructions say it as a fact of that one example (`PREP_DESCENT_LINES`); the value is kept for the records that read it.
 */
export const PREP_SKIP_SECONDS = 500;
/**
 * GPT's blind review of the prompt (2026-10-28, owner approved): the descent's preparation as a rule for choosing the action, in one place, in the instructions
 * (`V2_ALWAYS`) and for the first plan. What must hold before the descent (必須) apart from what is wanted (目標); that a reason written in a plan update or a why
 * does not skip an unmet requirement; that the food carried is for eating below (the fullness does not stand for it); and that eating below the 40 is not a new
 * shortage. The live state and the results only say the state (`preparationState`); the story of runs 41 and 42 is one reference sentence (`PREP_REFERENCE`).
 */
export const PREP_DESCENT_LINES: readonly string[] = [
  '- 必須（未達の間は、下りる act も鉄の採掘もしない。補う手を先に出す）: 食料の点 40 以上（foodPoints.total。満腹 fullness では数えない）・石のツルハシと石の斧・作業台 1 つか板 4 以上（持つ）。',
  '- 目標: 食料 40〜60 点・板 8 ほどと棒の余り（ツルハシの作り直し分）。',
  '- 未達の必須は、reason や why に書いても省けない（計画の順は変えてよい）。下りる手の why には、確かめた今の数と補い方を書く（満たした時だけ「（食料 41.2/40・作業台 有・板 6）」）。',
  '- 理由: 持ち込む食料は地下で食べて体力を戻す分で、満腹では代わりにならない。地下には食べ物も木も見つかりにくく、足りなくなると地上へ戻る必要がある（実走 42 の 1 回の例、移動の不具合込みで 540 秒）。死ぬこともある。',
  '- 下りた後に食べて 40 点を切るのは未達ではない。未達のまま下りていたら、奥へ進む前に補う（近くで補えるか調べ、無ければ上で）。「もう地下にいる」は続ける理由にならない。',
];
export const PREP_DESCENT_RULE: string = ['## 準備の決まり（鉄を掘りに地下へ下りる前）', ...PREP_DESCENT_LINES].join('\n');
/** An earlier run's measure, as a reference (not this run's time). */
export const PREP_REFERENCE = '- 参考（以前の実走の記録。今回の所要時間ではない）: 実走 42 は地上へ戻るのに 540 秒かかり（移動の不具合込みの 1 回の例）、実走 41 は作業台が無いまま 372 秒止まって上りの途中で死んだ。';
/**
 * The knowledge of the stages as the first plan and the stage knowledge say it (one text, so the plan and the decision read the same numbers): materials and
 * procedures; the descent's rule is `PREP_DESCENT_RULE`. Knowledge, not an order.
 */
export const PREP_RULES_WORDS = [
  `- ダイヤを掘りに下りる前: 鉄のツルハシ・バケツ・盾・鉄の兜・胸当て・脚（着る）。鉄はネザーまでに約 ${IRON_BEFORE_NETHER}`
    + '（ツルハシ 3・バケツ 3・盾 1・兜 5・胸 8・脚 7・火打ち金 1・剣 2）。作ったらすぐ equip で着る（持っているだけでは守らない）。',
  `- 靴は鉄でなく金のブーツ（金の延べ棒 ${GOLD_FOR_BOOTS}）。金の防具を 1 つ着ているとピグリンが襲わない。金鉱石は y=-16 前後に多く、ダイヤへ下りる途中の壁で見つかる`
    + '（生の金をかまどで焼く。村の箱や廃坑の箱にもある）。鉄のブーツを持っていても、ネザーの前に金のブーツに履き替える。',
  '- ゲート（ネザーに入る）の前: 上の 4 つの防具・盾・剣・鉄以上のツルハシ・水入りバケツ・黒曜石 10・火打ち金・足場のブロック 64・食料 40 点ほど。',
  '- ネザーに入った後、要塞（奥）へ行く前: 作業台・ハーフブロック 12・食料 100 点（足りない食料は帰りのゲートから戻って狩る）。',
  '- ベッドは村の家で 1〜2 つ（ベッドの節の doneWhen は have:bed>=1）。村も羊も見つからない世界では、地下の構造物のベッドへ下りず、ベッドの節は後回しにして鉄へ進む（plan_update に書く）。'
    + '羊は見かけたら羊毛 3 を取り、エンドの前に板 3 と作って 4〜6 にする。',
  PREP_REFERENCE,
].join('\n');

/**
 * Run 41 (the plan had p1.3 「食料」 at the bed's coordinates and p4 「鉄を掘る」 with no caution for the descent; the preparation was passed over): what the first plan is
 * asked to write of the preparation. A request to the planner, not a rule of the code.
 */
export const PLAN_PREP_WORDS = [
  '地下へ下りる前の準備を節に書く:',
  '- 地下へ下りる節（鉄・ダイヤを掘る節）の caution に、その前に済ませる準備を書く（30 字以内。例「食料40点・作業台か板4を持ってから下りる」）。',
  '- 食料の節の where は、食料のある所（箱・畑・干し草の座標）にする。ベッドの座標にしない。見当たらなければ ""。',
  '- 準備の節の doneWhen は観測の形で書く: 例 "food>=40&have:crafting_table|food>=40&have:planks>=4"。',
].join('\n');
