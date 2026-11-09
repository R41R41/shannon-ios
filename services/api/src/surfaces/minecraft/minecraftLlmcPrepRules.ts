/**
 * mb-llmc v2 (owner 2026-10-24, after run 38: 「鉄装備を足しか作らない。金装備をしてからネザーに行っていない。最善は足だけ金ブーツ。その他レギンス、
 * チェストプレート、ヘルメットは鉄にしてからダイヤ採掘やネザーに行くべき」; Notion 09-1c 6-2: the gate's, the fortress's and the End's rules in one place, from
 * which the first plan's words, the stage knowledge and the shortage are made, instead of old numbers corrected at the end).
 *
 * One table of what each stage of the way needs before it begins. Its words (`prepWords`) go to the first plan and the stage
 * knowledge; its needs go to
 * `preparationShortage` (`minecraftLlmcReadiness.ts`); the seed plan's nodes name the same items (`minecraftFirstPlan.ts`).
 * - before the diamonds: an iron pickaxe, a bucket, a shield, and the iron helmet, chestplate and leggings, worn
 * (the diamonds are
 * at y=-58, among lava and
 *   the deep dark's mobs);
 * - before the gate: the same, the golden boots (the feet's piece in gold: a piglin does not attack one who wears a golden piece,
 * and the boots are the
 *   cheapest, 4 ingots, and lose the least protection), a sword, blocks to stand on and the first stretch's food;
 * - before the Nether's depth and the End: as they were (the check after she is in, and the End's beds, bow and eyes).
 */
import { BED_ITEM } from './minecraftItems.js';
/**
 * `goal`: wanted when it can be had, not required (the golden boots, when 4 gold is found). `weight`: what one stack of a matching item is worth in the count
 * (a diamond pickaxe stands for three iron ones).
 */
/** `materials`: what the pack holds toward a missing or short need, said beside its label (the bow's string, the arrows' feathers). */
export interface PrepNeed { label: string; count: number; pattern: RegExp; slots?: boolean; worn?: boolean; goal?: boolean; weight?: (name: string) => number;
  materials?: (counts: ReadonlyMap<string, number>) => string }
/** `risk`: what going on without the required needs costs, said beside the lack (a stage that has one says its lack as a required part and a goal part). */
export interface PrepStage { title: string; food: number; needs: readonly PrepNeed[]; risk?: string }

/** Blocks to stand on and to wall with (the knowledge's 足場のブロック 64). */
export const BLOCKS = new RegExp('^(?:cobblestone|cobbled_deepslate|netherrack|blackstone|stone|deepslate|dirt|andesite|diorite|granite|tuff'
  + '|basalt|end_stone|nether_bricks)$', 'u');
/** The three pieces in iron or better (the feet are the golden boots'). */
export const UPPER_ARMOUR = /^(?:iron|diamond|netherite)_(?:helmet|chestplate|leggings)$/u;
export const GOLDEN_BOOTS = /^golden_boots$/u;

const PICKAXE: PrepNeed = { label: '鉄以上のツルハシ', count: 1, pattern: /^(?:iron|diamond|netherite)_pickaxe$/u };
/**
 * The bucket before the diamonds is a full one (the section audit of 11/5: run61 passed this check with an empty bucket, looked for water below for
 * 6 minutes at 2,345 s and died on the way up; it had walked past a known spring with the empty bucket).
 */
const BUCKET: PrepNeed = { label: '水入りバケツ（空なら水源の隣で use して汲む）', count: 1, pattern: /^water_bucket$/u };
const SHIELD: PrepNeed = { label: '盾', count: 1, pattern: /^shield$/u };
// end1108h12 S7 (11/8): among six blazes the shield broke in 5 minutes (about 120 raises) at 5 kills and 2 rods, and the head waited out of
// sight with no shield for the next 7 (「盾が無く湧き場へ入れない」). The spare (iron 1, already in IRON_USES) goes in before the gate; the hold
// puts it on the arm the moment the first breaks.
const SHIELDS_FOR_NETHER: PrepNeed = { label: '盾（予備を含め 2）', count: 2, pattern: /^shield$/u };
// end1108h18 S7 (11/8): with the sword alone (no arrow spent) both shields broke within 10 minutes at 8 kills and 3 rods, and the blaze hands were
// held for the 14 minutes left (「盾 0/1」, no iron or planks carried). Seven rods take about 14 kills, about four shields: two more are carried
// as their materials (iron 2, in IRON_USES, and planks), made where the last one breaks.
const SHIELD_IRON: PrepNeed = { label: '盾の作り直しの鉄（2）', count: 2, pattern: /^iron_ingot$/u };
const SHIELD_PLANKS: PrepNeed = { label: '板（盾の作り直し 2 枚分と作業台、16）', count: 16, pattern: /_planks$/u };
const ARMOUR: PrepNeed = { label: '鉄の兜・胸当て・脚', count: 3, pattern: UPPER_ARMOUR, slots: true, worn: true };
// The coordinator, 2026-11-02 (run59 leg 1 went on to the diamonds and the gate with no shield and no armour): the golden boots are a goal,
// the rest of the gate's list is required.
// A goal of the table; the gate's hand is held while no golden piece is worn (`goldAtPortalHold`), and the stage words say so (the section audit
// of 11/5: the plan read it as a goal and the gate as required).
const BOOTS: PrepNeed = { label: '金のブーツ（金 4 がそろう時）', count: 1, pattern: GOLDEN_BOOTS, worn: true, goal: true };
/** The obsidian taken at the first lava (the section audit of 11/5): the gate's 10 and the End fight's 12 at once, not a second trip after the Nether. */
export const OBSIDIAN_AT_FIRST_LAVA = 22;
/** The Nether's rock wears a pickaxe out (an iron one is 250 uses: S2's lab, one broke): three iron ones, or one diamond one (which counts for three). */
const TRIP_PICKAXE: PrepNeed = { label: 'ツルハシ（ダイヤ 1 か鉄 3）', count: 3, pattern: PICKAXE.pattern, weight: name => /^(?:diamond|netherite)_/u.test(name) ? 3 : 1 };
/**
 * The coordinator, 2026-11-03 (run59 leg 2's plan, 7.1 A): one diamond pickaxe of 1,249 uses is used up on the way to the portal and back in the
 * Nether's rock (1,200 to 1,600 digs); the spares are the stone pickaxes (three cobblestone and two sticks each, the body uses the cheaper tool
 * first): two besides the one in use.
 */
const SPARE_PICKAXES: PrepNeed = { label: '石以上のツルハシ（予備 2 本を含め 3 本）', count: 3, pattern: /^(?:stone|iron|diamond|netherite)_pickaxe$/u };
// Required since 2026-11-04 (the coordinator, the whole-run audit: run60 and run61 met the night with a stone sword or none after the iron was
// smelted; a stone sword passed this gate and put the night's warning out): the iron sword, two iron, is made with the armour before the gate.
const SWORD: PrepNeed = { label: '鉄の剣', count: 1, pattern: /^(?:iron|diamond|netherite)_sword$/u };
const FOOTING: PrepNeed = { label: '足場のブロック', count: 64, pattern: BLOCKS };
const has = (counts: ReadonlyMap<string, number>, name: string): number => (counts.get(name) ?? 0) + (counts.get(`minecraft:${name}`) ?? 0);
/**
 * The bow and the arrows the End's crystals take (the whole-run audit of 11/4, order 10: the shortage counted plain arrows only, the body shoots spectral
 * ones too, and the materials were not said): a crossbow is a bow here, a spectral arrow an arrow; a lack says the materials carried (the string is
 * kept in the pack, `minecraftLlmcPack.ts`, and the first plan asks the materials on the way, `PLAN_PREP_WORDS`).
 */
export const BOW: PrepNeed = { label: '弓', count: 1, pattern: /^(?:bow|crossbow)$/u,
  materials: counts => `材料 糸 ${has(counts, 'string')}/3・棒 ${has(counts, 'stick')}/3` };
export const ARROWS: PrepNeed = { label: '矢', count: 30, pattern: /^(?:arrow|spectral_arrow)$/u,
  materials: counts => `光の矢も数える。材料 羽根 ${has(counts, 'feather')}・火打石 ${has(counts, 'flint')}・棒 ${has(counts, 'stick')}（1 ずつで 4 本）` };

/**
 * Run59 leg 2 (2026-11-02 23:34): a need that looked impossible to make (the body's make said missing oak_log) was put off and the portal hand was
 * sent; the next move is to gather.
 */
const MAKE_IT = '作れない・材料が無いと見えた時は、後回しにして先へ進まず、材料を取りに行く（作る手の行の missing: … を読み、別の材料の形を試す）';

export const BEFORE_DIAMONDS: PrepStage = { title: 'ダイヤを掘る前', food: 40, needs: [PICKAXE, BUCKET, SHIELD, ARMOUR],
  risk: 'ダイヤの層（y=-58）は溶岩と深い所の敵の中。死ねば鉄の道具と防具を失い、取りに戻れないことが多い。' + MAKE_IT };
export const BEFORE_GATE: PrepStage = { title: 'ネザーに入る前', food: 40, needs: [TRIP_PICKAXE, SPARE_PICKAXES, SHIELDS_FOR_NETHER, SHIELD_IRON, SHIELD_PLANKS, SWORD, ARMOUR, FOOTING, BOOTS],
  risk: 'ブレイズの火の玉・ガスト・ウィザースケルトンの傷が重なる。死ねばダイヤのツルハシと黒曜石を失い、ネザーで落とした物は取りに戻れないことが多い。' + MAKE_IT };

/** Owner 2026-11-04 (「ベッドと黒曜石を持っていく」): the dragon is killed with beds; 10 is the aim, 8 the least the End's gate lets in. */
export const END_BEDS = 8;
/** The obsidian the End fight takes (a bed's shield and its base), counted apart from the portal's ten: 12 is the aim, 8 the least. */
export const END_OBSIDIAN = 8;
const BEDS: PrepNeed = { label: 'ベッド（目標 10）', count: END_BEDS, pattern: BED_ITEM };
export const FIGHT_OBSIDIAN_LABEL = '黒曜石（エンドの戦い用・目標 12。ポータルの 10 とは別）';
const FIGHT_OBSIDIAN: PrepNeed = { label: FIGHT_OBSIDIAN_LABEL, count: END_OBSIDIAN, pattern: /^obsidian$/u };
const WATER_BUCKET: PrepNeed = { label: '水入りバケツ', count: 1, pattern: /^water_bucket$/u };
/** What a pillar, a bridge or a cover is made of in the End: the footing's blocks and obsidian. */
const STACKABLE: PrepNeed = { label: '積める物（丸石・黒曜石など）', count: 64, pattern: new RegExp(`${BLOCKS.source}|^obsidian$`, 'u') };
/**
 * The coordinator, 2026-11-03 (the 11/4 list, item 2: the deadly gates in `gateHold`'s form): the hand that walks into the End's portal is held
 * while the blocks to stand and cover on, the water bucket, the beds or the food are missing. What is missing is said; how to gather it is the
 * decision's.
 */
// 11/5 End audit: beds are the main plan; bow, 30 arrows and an iron-or-better sword support the fallback.
// Keep them goals so missing fallback equipment cannot deadlock a bed-equipped entry (the sword was required before the Nether).
export const END_WEAPONS: readonly PrepNeed[] = [BOW, ARROWS, { ...SWORD, label: '鉄以上の剣' }]
  .map(need => ({ ...need, goal: true }));
/**
 * thru-1110 (11/9, meta: e04c went into the End with 4 cooked beef, 83 points, and ate to 0 in the fight): the beds' way gathers 330 food points
 * (16 cooked beef, 20.8 each) within the gathering's ten minutes; the fallback and a return go in with 80, so food never holds the walk in for ever.
 */
export const END_MIN_FOOD = 80;
export const BEFORE_END: PrepStage = { title: 'エンドに入る前', food: 330,
  needs: [STACKABLE, WATER_BUCKET, BEDS, FIGHT_OBSIDIAN, ...END_WEAPONS],
  risk: 'エンドは虚空の島で、戻る道は開いたポータルだけ。積める物・水バケツ・ベッド・食料が無いと、虚空に落ちるか竜に押されて死に、ここまでの装備と時間を失う。' + MAKE_IT };

// 11/5 checked audit: recovering an End death must not require eight new beds and obsidian before reaching the dropped kit.
// Keep the existing food minimum; 20 blocks cover the arrival platform and the existing bridge, without rebuilding a full fight kit.
/**
 * The fallback's own entry (the pre-deploy review of 11/5, item 8: with 6 beds and no village or sheep left, the crystals-and-sword way could not pass
 * the gate, and the gathering had no end): the blocks, the water and the food as for the beds' way, and the bow, 30 arrows and an iron sword
 * required. The gate lets it in once the beds' gathering has had its time (`minecraftEndGather.ts`).
 */
/**
 * thru-1110 (11/9, the owner: no safety nobody asked for may stop the filmed run): the bow and the 30 arrows are aims of the fallback, not its
 * required: with fewer than 8 beds and no arrows the gate held the walk in for ever, and the run ended at the portal without a try at the dragon.
 * After the gathering's ten minutes the blocks, the water, the food and an iron sword let her in; a bow and arrows are used when carried.
 */
export const BEFORE_END_FALLBACK: PrepStage = { title: 'エンドに入る前（予備の手）', food: END_MIN_FOOD,
  needs: [STACKABLE, WATER_BUCKET, { ...SWORD, label: '鉄以上の剣' }, { ...BOW, goal: true }, { ...ARROWS, goal: true }], risk: BEFORE_END.risk };
export const RETURN_TO_END: PrepStage = { title: 'エンドへ戻る前', food: END_MIN_FOOD,
  needs: [{ ...STACKABLE, count: 20 }, ...END_WEAPONS, { ...WATER_BUCKET, goal: true }],
  risk: 'エンドへ戻る時も、積める物と食料が無いと足場の火の玉や回復不足で死ぬ。落とした装備が残っているかは未確認。' };

/**
 * The coordinator, 2026-11-02 (the owner: dragon within three hours, an hour and a half at best; a death after the iron gear puts the time in doubt, so a
 * death is out): from the iron gear on, not dying stands above being fast. Knowledge of the stages, in the numbers the live state shows (the health, the food
 * points, the wear of a piece in the pack's line).
 */
export const SAFETY_FIRST = '- 死なないことを速さより上に置く（鉄の装備を手に入れた後は特に。死ぬと装備と時間を失い、この通しは死んだらアウト）。'
  + '体力 12 未満・食料 40 点未満・防具か盾かツルハシの耐久が残り 2 割未満（持ち物の行の耐久）のまま、深い所・ネザー・戦いへ進まない: 食べる・回復を待つ・作り直す・退くを先にする。'
  + '溶岩の縁・落下の上・火の玉の線では、足元と両脇を確かめて 1 マスずつ。'
  // S2's blaze lab of 11/5 (raid3: health 6.1 and fullness 17 for about 1.5 minutes of sorties, health never came back): the head chooses the meal.
  + '戦いの合間は、体力 18 未満なら見えない所で満腹 18 以上まで食べ、体力 18 以上まで待ってから出る（満腹 18 未満では体力は自然に戻らない。live の recovery の行）。';

/**
 * The iron the way to the Nether takes, by its use (the whole-run audit of 11/4, order 11: the 30 had no shears, no spare sword and no spare shield,
 * and the old path's 「鉄は33まで」 cut the digging short of them): the sum is the budget, and the words say the uses.
 */
export const IRON_USES: ReadonlyArray<readonly [string, number]> = Object.freeze([['ツルハシ', 3], ['バケツ', 3], ['盾', 1], ['兜', 5], ['胸', 8],
  ['脚', 7], ['火打ち金', 1], ['剣', 2], ['ハサミ', 2], ['予備の剣', 2], ['予備の盾', 1], ['盾の作り直し', 2]] as const);
export const IRON_BEFORE_NETHER = IRON_USES.reduce((sum, [, count]) => sum + count, 0);
/**
 * The owner's ruler to the Nether (the 3-hour plan of 11/3: 47 minutes, the preparation included): one number for the road's milestone, the stage
 * knowledge and the old route's planner (the whole-run audit of 11/4, order 12: they said 47 and 30 minutes).
 */
export const NETHER_BY_SECONDS = 2_820;
/** The gold of the golden boots (ingots). */
export const GOLD_FOR_BOOTS = 4;
/** A golden piece of armour (one worn keeps the piglins calm). */
export const GOLD_ARMOUR = /^golden_(?:helmet|chestplate|leggings|boots)$/u;

/**
 * The 500 of this constant came from run 42's one trip back to the surface (540 s, with the go's fault in it):
 * it is not a loss in
 * general, and no sentence
 * says it as one. The instructions say it as a fact of that one example (`PREP_DESCENT_LINES`); the value is
 * kept for the records that read it.
 */
export const PREP_SKIP_SECONDS = 500;
/**
 * GPT's blind review of the prompt (2026-10-28, owner approved): the descent's preparation as a rule for
 * choosing the action, in one
 * place, in the instructions
 * (`V2_ALWAYS`) and for the first plan. What must hold before the descent (必須) apart from what is wanted (目標);
 * that a reason written
 * in a plan update or a why
 * does not skip an unmet requirement; that the food carried is for eating below (the fullness does not stand for it); and that
 * eating below the 40 is not a new
 * shortage. The live state and the results only say the state (`preparationState`); the story of runs 41 and 42 is one reference
 * sentence (`PREP_REFERENCE`).
 */
export const PREP_DESCENT_LINES: readonly string[] = [
  ("- 必須（未達の間は下りない・鉄を掘らない。省くなら prep に skipped と理由を書く。省いた節は達成に数えない）: 食料の点 40 以上（foodPoints.total。満腹 fullness " +
"では数えない）・石のツルハシと石の斧・作業台 1 つか板 4 以上（持つ）。"),
  '- 目標: 食料 40〜60 点・原木 20〜24 本分（板なら 80 前後。通しの分）。',
  '- 下りる手の why には、確かめた今の数と補い方を書く（満たした時だけ「（食料 41.2/40・作業台 有・板 6）」）。',
  ("- 理由: 持ち込む食料は地下で食べて体力を戻す分で、満腹では代わりにならない。地下には食べ物も木も見つかりにくく、足りなくなると地上へ戻る必要がある（実走 42 の 1 回の例、移動の不具合込みで 540 " +
"秒）。死ぬこともある。"),
  '- 下りた後に食べて 40 点を切るのは未達ではない。未達のまま下りていたら、奥へ進む前に補う（近くで補えるか調べ、無ければ上で）。「もう地下にいる」は続ける理由にならない。',
];
export const PREP_DESCENT_RULE: string = ['## 準備の決まり（鉄を掘りに地下へ下りる前）', ...PREP_DESCENT_LINES].join('\n');
/** An earlier run's measure, as a reference (not this run's time). */
export const PREP_REFERENCE = '- 参考（以前の実走の記録。今回の所要時間ではない）: 実走 42 は地上へ戻るのに 540 秒かかり（移動の不具合込みの 1 回の例）、実走 41 は作業台が無いまま 372 秒止まって上りの途中で死んだ。';
/**
 * The knowledge of the stages as the first plan and the stage knowledge say it (one text, so the plan and the
 * decision read the same
 * numbers): materials and
 * procedures; the descent's rule is `PREP_DESCENT_RULE`. Knowledge, not an order.
 */
export const PREP_RULES_WORDS = [
  `- ダイヤを掘りに下りる前の必須（そろうまで下りない。理由を書いても省けない）: 鉄のツルハシ・水入りバケツ・盾・鉄の兜・胸当て・脚（着る）・食料 40 点。鉄はネザーまでに約 ${IRON_BEFORE_NETHER}`
    + `（${IRON_USES.map(([use, count]) => `${use} ${count}`).join('・')}）` + ("。火打ち金は鉄のある高さで先に作る。黒曜石の後で鉄と火打石を探すために上り直さずに済む。作った防具はすぐ equip " +
"で着る（持つだけでは守らない）。"),
  `- 靴は鉄でなく金のブーツ（金の延べ棒 ${GOLD_FOR_BOOTS}）。金の防具を 1 つ着ているとピグリンが襲わない。金鉱石は y=-16 前後に多く、ダイヤへ下りる途中の壁で見つかる`
    + '（生の金をかまどで焼く。村の箱・廃坑の箱・荒廃したポータル（走査の「壊れたポータル」）の箱にもある）。鉄のブーツを持っていても、ネザーの前に金のブーツに履き替える。',
  '- ゲート（ネザーに入る）の前の必須（そろうまで入らない。理由を書いても省けない）: 盾 2（予備 1。火の玉で 5 分で壊れた）と作り直しの材料（鉄 2・板 16。ブレイズの湧き場で 10 分に 2 枚壊れた。壊れたらその場で作る）・鉄の剣・鉄の兜と胸当てと脚（着る）・ツルハシ（ダイヤ 1 か鉄 3）'
    + '・石以上のツルハシの予備 2 本（主の他に。丸石 3・棒 2 で 1 本、体は安い方の道具から使う）・足場のブロック 64（丸石 128 あると橋で尽きない）・食料 40 点。'
    + '鉄のツルハシは 1 本が耐久 250 で、ネザーの岩を掘り続けると壊れて止まった（鉄はネザーに無い）。'
    + '目標: 金のブーツ（金 4 がそろう時。金の防具を 1 つも着ていないと、ネザーへ入る手は止まる）'
    + `・水入りバケツ・黒曜石 ${OBSIDIAN_AT_FIRST_LAVA}（ゲート 10＋竜戦 12。最初の溶岩でまとめて）・火打ち金・`
    + '食料 250 点前後（干し草 1 個でパン 3）。必須が欠けたまま入ると、ブレイズ・ガスト・ウィザースケルトンの傷が重なり、死ねばダイヤのツルハシと黒曜石を失う。'
    + 'ネザーへ入る手（portal。enter でない時を除く）は、必須が未達の間は体へ送られず、足りない物と費用が返る。'
    + '必須が作れない・材料が無いと見えた時は、後回しにして先へ進まない。材料を取りに行く（盾なら木と鉄 1。作る手が失敗したら行の理由（missing: …）を読み、別の材料の形を試す）。',
  '- ネザーに入った後、要塞（奥）へ行く前: 作業台・食料 100 点（足りない食料は帰りのゲートから戻って狩る）。',
  '- ベッドは用途が 2 つ: 寝る用 1 個（最初の夜の前。doneWhen have:bed>=1）と、竜戦用 10 個（最低 8。target bed×10）。村の家で見つけた分は全部取る'
    + '（竜戦用の節は寝る用の親の子にしない: 親が済むと開いた子は閉じられる）。村も羊も見つからない世界では、地下の構造物のベッドへ下りず、竜戦用はエンドの点検の前に羊毛から作る。'
    + '羊は見かけたら羊毛を取る（同じ色 3＋板 3 で 1 個。殺すと羊毛 1、ハサミなら 1〜3）。ベッドは重ならず 1 個 1 マス（10 個で 10 マス）。'
    + 'ネザーへ入る前に、ゲートの横に箱を置いて寝る用の 1〜2 個を残して預け（羊毛・弓の材料・予備の食料・戦いに要らない物も。死ぬとネザーでは取りに行けない）、帰りに同じゲートから出て取る（ネザーでロッドとパールの入る所を残す）。',
  PREP_REFERENCE,
].join('\n');

/**
 * Run 41 (the plan had p1.3 「食料」 at the bed's coordinates and p4 「鉄を掘る」 with no caution for the descent; the
 * preparation was passed over): what the first plan is
 * asked to write of the preparation. A request to the planner, not a rule of the code.
 */
export const PLAN_PREP_WORDS = [
  '地下へ下りる前の準備を節に書く:',
  '- 地下へ下りる節（鉄・ダイヤを掘る節）の caution に、その前に済ませる準備を書く（30 字以内。例「食料40点・作業台か板4を持ってから下りる」）。',
  '- 食料の節の where は、食料のある所（箱・畑・干し草の座標）にする。ベッドの座標にしない。見当たらなければ ""。',
  '- 準備の節の doneWhen は観測の形で書く: 例 "food>=40&have:crafting_table|food>=40&have:planks>=4"。',
  '- 村の節（ベッド全部・干し草・箱）は、食料とベッド（寝る用）の親の子にせず、一番上の節にする（親が済むと開いた子は閉じられる）。'
    + '竜戦用のベッドは target bed×10 の節にする。',
  '- 木は序盤だけ通しの分を一度に: 石の斧ができたら原木を合計 20〜24 本まで取る節を書く（doneWhen は作った分を引いて板も数える: have:log>=16|have:planks>=64）。'
    + '後で木のために地上へ戻らない。',
  '- バケツを作ったら、最初の水源ですぐ汲む節を鉄の節の次に書く（doneWhen have:water_bucket）。',
  '- 弓と矢（クリスタルとエンダーマンに要る）の材料は序盤の道中で集める。食料か鉄の節の caution に「糸3・羽根・火打石を拾う」と書く（後の節に回さない）。',
  '- エンダーマン 1 体は鉄の剣で約 7 打撃かかり、そのたびに剣の耐久（250）が減る: パール狩りの前に、予備の鉄の剣をもう 1 本作る（鉄の節の caution に書く）。',
].join('\n');
