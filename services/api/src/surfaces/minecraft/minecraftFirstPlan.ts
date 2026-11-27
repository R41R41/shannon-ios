import { targetConditionProblem } from './minecraftPlanRequirements.js';
export { FIRST_PLAN, CHECK_FORBID, CHECK_FORBID_NOW } from './minecraftFirstPlanPrompts.js';
import { FIRST_PLAN,CHECK_FORBID_NOW } from './minecraftFirstPlanPrompts.js';
import { FIRST_PLAN_SYSTEM,FIRST_PLAN_SYSTEM_R4 } from './minecraftFirstPlanPrompts.js';
import { applyPlanUpdate,orderedPlan,planFromSeeds,PLAN_LIMITS,promiseItemFits,type PlanCondition,type PlanOp,type PlanSeed,
  type PlanNode,type PlanTree } from '@shannon/mind';
import type { FcaPlanInbox } from '../../mind/action/fca/fcaPlanTools.js';
import { scanForPlan } from './minecraftLlmcProbe.js';
import { carriedItemCounts } from './minecraftItems.js';
import { carriedFood, stacks } from './minecraftLlmcLive.js';
import { eyeLedgerFact, frameFoundWords } from './minecraftEyeLedger.js';
import { framesKnownOf } from './minecraftSeenMarks.js';
import { eyeBasisOf, EYES_AT_DEPARTURE, FRAME_EYES } from './minecraftEyeSpare.js';
import { preparationShortage,recoveryLine } from './minecraftLlmcReadiness.js';
import { parseCondition } from '../../contracts/minecraftActCondition.js';
import { parseDoneWhen } from './minecraftPlanDone.js';
import { kindOf } from './minecraftPlanFacts.js';
import { foodPointsWords } from './minecraftFoodWords.js';
import { ARCHERY_ON_THE_WAY, ARROWS_TO_CARRY } from './minecraftEndPrepWords.js';
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
const WOOD_PICKAXE_OR_BETTER = 'have:wooden_pickaxe|have:stone_pickaxe|have:iron_pickaxe|have:diamond_pickaxe';
const STONE_TOOLS_OR_BETTER = 'have:stone_pickaxe&have:stone_axe&have:stone_sword|have:iron_pickaxe|have:diamond_pickaxe';
/** The condition of the seed's top iron node (the kind `iron` with children; its last child has the same words, so the children are told apart): the pickaxe (an iron one, or the
 * diamond one that comes after it), sword, shield and bucket (the armour is its own top node, after the water). */
const IRON_TOP_DONE = 'have:iron_pickaxe&have:iron_sword&have:shield&have:bucket|have:diamond_pickaxe&have:iron_sword&have:shield&have:bucket';
const TO_NETHER: readonly PlanSeed[] = [
  // The section audit of 11/5 (runs 60 and 61 both went back up for wood and died there): the wood of the whole run at once after the stone axe, as
  // the last child; the parent waits for it (a child is closed when its parent is done).
  node('木と石の道具', { kind: 'stone_tools',  // no doneWhen: done when its children are, the last the run's wood (e1111h2: an iron-pickaxe branch closed p1.4 at log 3/16)
    children: [
    node('原木を集める', { kind: 'wood', doneWhen: 'have:log>=8|have:planks>=24', note: '作業台・木のツルハシ・斧と石の道具の棒の分（ツルハシ 1 つで済みにしない）' }),
    // Run 8 (11/27): the pack held a diamond pickaxe, an iron sword and a stone axe, yet 「作業台と木のツルハシ」 and the stone tools stayed open (the list stopped at iron, and
    // the stone pickaxe and sword were never made). `have:pickaxe` is no way out: `carried` counts every id ending in `_pickaxe`, so a wooden or golden one would pass it and a
    // new world's iron stage would be skipped. The conditions list the tiers that come after: a tier above the node's own means the node's work is behind her.
    node('作業台と木のツルハシ', { kind: 'wood', doneWhen: WOOD_PICKAXE_OR_BETTER }),
    node('丸石で石のツルハシ・斧・剣', { kind: 'stone_tools', doneWhen: STONE_TOOLS_OR_BETTER,
      note: '丸石 11（ツルハシ 3・斧 3・剣 2・予備のツルハシ 3）。炉 8・足場は別' }),
    // 11/11 run 7: the amount was the least (16) while many trees stood near; the node says the least and the safe amount, and `stock:wood` reads the logs near.
    node('原木を通しの分（最低12・安心24）', { kind: 'wood', doneWhen: 'stock:wood',
      note: '石の斧の後に一度に（板・棒・盾・ベッドの板・箱の分）。近くに多ければ安心の量まで。後で木のために地上へ戻らない' })] }),
  // Run 9 (11/13): the village's beds are taken in one round (a card's beds up to 8, one cell each); top level, so the food node's closing does not close it.
  node('村を回る（ベッド全部・干し草・畑・箱）', { kind: 'village', doneWhen: 'have:bed>=8',
    note: '札のベッドを 8 まで 1 周で取り切る（1 個 1 マス。9 個目以上は取らない）・干し草は全部',
    caution: ['村が見えなければ飛ばす。羊を見かけたら羊毛も取る（同じ色 3＋板 3 で 1 個）',
      '通りがかりに昼のクモ（剣で倒すと糸。弓に 3）・砂利（火打石）・ニワトリ（羽）を見たら寄って取る（探し回らない）'] }),
  node('食料とベッド（最初の夜の前・鉄より前）', { kind: 'prep_descent', doneWhen: 'stock:food&have:bed',
    note: '食料は最低40・安心100点（干し草3個）。ベッドが一番（寝れば夜を飛ばせる）: 走査の羊の行で同じ色 3 体を探す。夜にベッドが無ければ、地面に 2 段の穴を掘って塞ぎ、その底から鉄の節へ下りる（外で待たない。朝に戻って続ける）', children: [
    node('無ければ（石の剣か斧を持って）動物を4〜6体狩る', { kind: 'food' }), node('かまどで肉を焼く・パンを作る', { kind: 'food', doneWhen: 'stock:food' })] }),
  node('鉄（24〜36）', { kind: 'iron', doneWhen: IRON_TOP_DONE,
    caution: ['食料40点・作業台か板4を持ってから下りる（夜にベッドが無ければ、満腹度14・体力16以上で先に下りてよい）',
      '降りる前に石のツルハシを 2 本と石炭 4（鉄 24 と肉を焼く分。見えている最寄りの石炭を先に mine。原木・板は燃やさない）',
      '生の鉄 4 以上は smelt furnaces=3 で並べて焼く。take は残り 15 秒以内だけ体が待つ。それより長ければ掘る手を先に積む',
      '炉は掘り場の 6m 以内に置く。離れたら furnace に dig=stone,dirt maxDig=N を付ける（体が掘って寄る）'],
    children: [node('最初の鉄3を焼いて鉄のツルハシ（棒・台を確認）', { kind: 'iron', doneWhen: 'have:iron_pickaxe|have:diamond_pickaxe' }),
    // The whole-run audit of 11/4, order 1: the sword and the shield the moment the iron is smelted (run60 met the night with no sword); the boots are
    // the golden ones (the gate's table), so the armour is the three iron pieces. Run 8 (11/13): the gate asks one shield; the spare and its iron
    // and planks are aims (the blazes' stage makes a shield where it stands from iron 1 and planks 6).
    node('残りの鉄をまとめて採り焼く・剣・盾・バケツ', { kind: 'iron', doneWhen: IRON_TOP_DONE, caution: ['盾1はゲートの必須。予備の盾と作り直しの鉄2・板16は目標（ブレイズの湧き場で盾が壊れた時にその場で作り直せる）'] })] }),
  // Run 9 (11/13): the water before the armour (the bucket is made, and the water is drawn while the furnace smelts).
  node('水入りバケツ（バケツを作ったらすぐ、炉が焼いている間に）', { kind: 'water', doneWhen: 'have:water_bucket',
    note: '目から 12m 以内の届く水源ならその場で use bucket。遠い地表の水へは、近くに汲める水が無い時だけ（同じ池で 2 回失敗したら地表へ）' }),
  node('鉄の兜・胸当てを作って着る', { kind: 'iron_armor', doneWhen: 'have:iron_helmet&have:iron_chestplate' }),
  node('ダイヤ（y=-58）', { kind: 'diamond', doneWhen: 'have:diamond_pickaxe',
    caution: ['必須（盾・鉄の兜胸当てを着る・鉄のツルハシ・水入りバケツ・食料40点）が欠けたら下りない', '死ねば鉄装備を失う。体力12未満か、ツルハシの残り耐久が残りの掘る回数（ダイヤ 3＋道。1 段 2〜3 回）に足りなければ補う',
      '火打石が無ければ、下りや横掘りで見た砂利を掘って持つ（1個10%）。地表へ戻らない。ゲートは溶岩の脇（地下）で組んでよい'], children: [
    node('ダイヤ3以上を掘る', { kind: 'diamond', doneWhen: 'have:diamond>=3|have:diamond_pickaxe' }),
    node('ダイヤのツルハシ（剣も）', { kind: 'diamond', doneWhen: 'have:diamond_pickaxe' })] }),
  // 「|have:ender_eye>=10」 (end1108d S9, 11/8): 12 eyes less the one or two just thrown and not yet picked up still close the stages that make them.
  // Run 8 (11/13): the gate was lit at y=-19 and she gathered spares beside it for minutes; the gate's required are the owner's five and food 40, and
  // a lit gate is entered at once. The obsidian's node closes when a lit portal is in view (the frame's 10 leave the pack and the node opened again).
  // Run 10 (11/14, the owner): she died in the Nether with 7 rods and came back far off, and the pack lay there for its 5 minutes. Before going in,
  // a bed of the 8 is set down in front of the lit gate and used (by day it sets the point without a sleep) and left standing: she comes back
  // there, 4 s from the Nether. So the gate is lit with noEnter (the light's node closes on the lit portal) and the entering is its own node.
  node('黒曜石10とゲート', { kind: 'portal', doneWhen: 'dim:the_nether|have:ender_eye>=10', caution: ['必須（盾1・鉄の剣・鉄の兜胸当てを着る・ツルハシ（ダイヤ1か鉄3）・足場32・食料40点）が欠けたら入らない',
    '点いたらゲートの前にベッドを置いて use し、すぐ入る（目標のために地上へ戻らない）'], children: [
    node('溶岩源で黒曜石10（ゲートの分）', { kind: 'obsidian', doneWhen: 'have:obsidian>=10|see:nether_portal|dim:the_nether|have:ender_eye>=10', note: 'ゲートの 10 だけ取る。10 に届いたら掘りをやめてゲートへ（竜戦の分 12 は出発の点検で別に取る）' }),
    node('火打ち金（火打石は砂利）', { kind: 'portal', doneWhen: 'have:flint_and_steel|dim:the_nether|have:ender_eye>=10',
      note: '火打石は下りや横掘りで見た砂利を掘って持つ（1個10%）。火打石のために地表へ戻らない。鉄のある高さで先に作る' }),
    node('ゲートを組んで火をつける（noEnter）', { kind: 'portal', doneWhen: 'see:nether_portal|dim:the_nether|have:ender_eye>=10',
      caution: ['火をつける前に必須を確かめる: 盾1・鉄の剣・鉄の兜胸当てを着る・ツルハシ・足場32・食料40点',
        'portal は noEnter で点ける（入る前にゲートの前のベッドの節がある）'] }),
    node('ゲートの前にベッドを置いて use（寝ない・壊さない）', { kind: 'portal', doneWhen: 'see:gate_spawn|dim:the_nether|have:ender_eye>=10',
      note: 'ネザーで死んでもゲートの前で復活し、すぐ戻って落とし物（約5分で消える）を拾える。昼も use でリスポーン地点になる。集めた8個の1個を使う',
      caution: ['現世側の枠の2〜4m前の床に bed を place→use。掘らずに残す（帰りに掘って8に戻す）', 'ベッドが無ければ skip と理由で閉じて入る'] }),
    node('ゲートに入る（p のマスへ walk）', { kind: 'portal', doneWhen: 'dim:the_nether|have:ender_eye>=10',
      caution: ['ベッドは寝る用2を残し、ゲートの横の箱に預けて入る（1個1マス。帰りに同じゲートで取る）'] })] }),
];
/**
 * Run 26 (owner 2026-10-21): she went on to the fortress with no table, slabs, shield or food; each stage past
 * the gate starts with a check.
 * r7 (runs 29–31): the check forbids the fight before it is done (`CHECK_FORBID`, as the first plan is asked to write it).
 * The checks are of the kind `prep_descent` (the preparation before going on: the stage's food and the table); the eyes' are
 * `pearl`, the End's `dragon`.
 */
const BEYOND: readonly PlanSeed[] = [
  // thru-1110 (11/9, the kits of the rig's sections against a through run): the blaze fight eats about 150 food points over the 7 rods (S7's rig
  // gives 24 beef, about 500); run48 reached the spawner with 39.6. The check before going deep asks 200 (about 10 cooked beef), the fight's 150
  // and the way to the fortress, so the gate (60 to go in since G04, 11/10) does not turn the plan to the pearls for food.
  node('出発の点検（ネザーの奥へ）', { kind: 'prep_descent', doneWhen: 'food>=200&have:crafting_table&have:shield', note: '足りない物はゲートのそばで作る',
    forbid: [CHECK_FORBID_NOW],
    children: [node('ネザーの幹で作業台（持ち歩く）', { kind: 'other', doneWhen: 'have:crafting_table' }),
      node('足場のブロック64（橋と囲い）', { kind: 'other', doneWhen: 'have:cobblestone>=64|have:netherrack>=64|have:cobbled_deepslate>=64' }),
      node('かまどで鉄を焼き盾', { kind: 'other', doneWhen: 'have:shield' }), node('食料が200点に足りなければ地上で狩って焼く（焼き肉10ほど）', { kind: 'food', doneWhen: 'food>=200',
        note: 'ブレイズ戦がロッド7本で約150点、道の分を足して200（ゲートを出てすぐの地上で）。群れが見えなければ探さず、この節を prep skipped にして100点で進む' }),
      node('金の防具を1つ着る（ピグリンが襲わない）', { kind: 'other', doneWhen: 'have:gold_armor' })] }),
  node('ネザー要塞を探す', { kind: 'fortress', note: '帰りのゲート座標を控える。432m区画の要塞・砦・未確認を見る。手がかりが無ければ見通しの良い向きを1つ決める',
    // S5's rig of 11/5: with 7 rods in hand the node held and she went to the fortress again; the rods or an eye close it too.
    doneWhen: 'see:fortress|have:blaze_rod>=7|have:ender_eye>=1',
    caution: ['橋の下は溶岩のことがある。足元と両脇を確かめて渡る', '遠い go に canDig[netherrack,basalt,blackstone] canPlace[cobblestone,netherrack]',
      'maxDig 200・maxPlace 100・seconds 100〜120。止まったら行の通りに直して同じ go'] }),
  node('ブレイズロッド7以上', { kind: 'blaze', target: { item: 'blaze_rod', count: 7 }, doneWhen: 'have:blaze_rod>=7|have:ender_eye>=10', note: '粉にするのは7本そろってから',
    caution: ['死ぬと持ち物と時間を失う（死んでも続ける）。体力12未満・盾の耐久2割未満なら戦わず退いて補う'],
    children: [node('mc_probe kind=camp で湧き場の足場を見つけ、go で着く', { kind: 'blaze' }),
    node('8m 内の見えるブレイズへ待たずに attack target=#id（体が追う）、剣で 20 体ほど（矢なし）', { kind: 'blaze' }), node('棒を拾う（ブレイズがいない時）', { kind: 'blaze' })] }),
  // The owner's line of 11/27 (one pearl more): the number to leave with is the frames' 12 plus the spare for the eyes the throws that find the stronghold break (`eyeSpare`), and the pearls
  // are taken up to it whenever they come. The rods stay 7: 7 rods make 14 powder, which is this number.
  node(`エンダーパール${EYES_AT_DEPARTURE}以上`, { kind: 'pearl', target: { item: 'ender_pearl', count: EYES_AT_DEPARTURE }, doneWhen: `have:ender_pearl>=${EYES_AT_DEPARTURE}|have:ender_eye>=${EYES_AT_DEPARTURE}`,
    note: `${EYES_AT_DEPARTURE} で出る（枠 ${FRAME_EYES}＋予備 ${EYES_AT_DEPARTURE - FRAME_EYES}。要塞を探す投げは 5 回に 1 回割れ、割れた 1 個で枠に 1 個足りないと要塞の前でパール待ちになる）。手に入る時は予備の分まで取る`,
    // Run 9 (11/12): after the rods she scanned and searched 0 times, took the way back for the pearls (about 1,100 s, 0 pearls). The search is the first child,
    // done by what the body saw; the rest of the pearl's children stay until the pearls are in.
    children: [node('歪んだ森を探す（走査→見えていない向きへ90mのgo→走査）', { kind: 'nether', doneWhen: 'see:warped_forest',
      note: 'ネザーに居たまま。1 回 約 90 秒。範囲内に無く 90m の go を 6 回重ねても出ない時は、探し続けるか、この節を skip と理由で閉じて最後の手（地上の夜）へ進むかを選ぶ' }),
      node('歪んだ森のエンダーマン（天井2）', { kind: 'pearl' }), node('金の延べ棒をピグリンに投げて交換', { kind: 'pearl' }), node('歪んだ森が見つからない時は、地上の夜の平らな所でエンダーマン（天井2。寝ると夜が飛ぶので寝ない）', { kind: 'pearl' })] }),
  // The coordinator, 11/9 (thru-1110's table): leave the Nether with 12 eyes, not 10 (a frame holds one from the start 1 time in 10, 1.2 on
  // average, so about 11 are needed, and a throw breaks about 1 in 5). A node closed in the Nether stays done while eyes fly; a first plan made
  // in the overworld with 10 or more eyes has these stages taken out (`strongholdFirst`, EYES_FOR_STRONGHOLD), so 10 still keep her from going back.
  node(`エンダーアイ${EYES_AT_DEPARTURE}個`, { kind: 'pearl', target: { item: 'ender_eye', count: EYES_AT_DEPARTURE }, doneWhen: `have:ender_eye>=${EYES_AT_DEPARTURE}`, note: `材料（粉 ${EYES_AT_DEPARTURE}）があれば全部作る。${EYES_AT_DEPARTURE} 個そろってからネザーを出る`,
    children: [node('粉と真珠で作る', { kind: 'pearl' })] }),
  node('オーバーワールドへ戻る', { kind: 'nether', doneWhen: 'dim:overworld', note: `パールとアイがそろってから（アイ${EYES_AT_DEPARTURE}以上）。帰りのゲートから。ポータルの対は live の控え。そろう前に始めるなら、エンダーパールの節を skip と理由で閉じてから（往復で戻る理由は黒曜石・ベッドではない）` }),
  // Run 9 (11/13): the gate's frame (10 obsidian) is taken on the way back, not found again as lava.
  node('帰ったゲートの枠の黒曜石を回収（竜戦用 12 に）', { kind: 'obsidian', doneWhen: 'have:obsidian>=12|dim:the_end',
    note: 'ネザーの用事（ロッド・パール）が済んで戻った後だけ。先に目玉を 1 個投げて向きを知る。ダイヤのツルハシで 1 個約 9 秒、10 個で約 90 秒。足りない 2 は溶岩で' }),
  // thru-1110 (11/9): the arrows are the fallback's, not the beds' way (the End's gate holds no first entry for them when the beds are in), and a
  // through run brings none from the Nether (the blazes are cut with the sword): the check no longer waits for 30 of them.
  node('出発の点検（エンドへ）', { kind: 'prep_descent', doneWhen: 'food>=150&have:bed>=8&have:obsidian>=8&have:ender_eye>=10&have:water_bucket',
    note: '帰ってすぐ目玉を 1 個投げて交点の向きを知る（約 10 秒）。水入りバケツ（水を汲んだ物）を hotbar（最初の 9 スロット）に持つ: 自動救済は対応版で有効な時だけ手・hotbar の水。'
      + '下降は事前に水を置くか vertical',
    children: [node('ベッドを8個にする（預けた箱から・羊毛3と板3）', { kind: 'bed', doneWhen: 'have:bed>=8',
        note: 'ゲートの前のベッドも掘って持つ。羊毛は鋏（鉄2）で刈ると1頭1〜3枚（殺すと1枚）。8に足りない時に。9個目は枠の近くに置くリスポーン用（戦い用の8とは別）' }),
      node('エンドの戦い用の黒曜石を12（最低8・ポータルの分とは別）', { kind: 'obsidian', doneWhen: 'have:obsidian>=12', note: '戻ったゲートの枠から（回収の節）。足りない分は溶岩で' }),
    ] }),
  // 11/27 (the owner): the bow and arrows are made on the way, in a short node before the stronghold, and kept for the fight with the dragon (`ARCHERY_ON_THE_WAY`). It closes at 12 arrows or when
  // what is in sight is taken: the same words as the knowledge (`END_BOW_KNOWLEDGE`), within the node's limits (the note 120 characters, a caution 80).
  node('弓と矢（道中の短い節。矢 12 本で閉じる）', { kind: 'other', doneWhen: `have:bow&have:arrow>=${ARROWS_TO_CARRY}`,
    note: '先に空きを 8 マス作る。見えた分だけ作って次へ進む（30m 内に見えない物は探さない）。矢が 4〜8 本でも持つ価値あり。そろわなくても閉じて要塞へ',
    caution: ['弓＝糸3＋棒3、矢4本＝火打石・棒・羽根 各1（作業台が要る）。骸骨の弓が荷にあれば糸は不要',
      'クモは昼の地表で見える1体を剣で。ニワトリは hunt chicken。砂利は mine gravel（石のシャベルは体が持ち替える）',
      '弓も糸も無い時は羽根・火打石だけを集めに行かない。村など遠い所へは往復しない',
      '作ったら竜との戦いまで撃たない（ブレイズ・骸骨などにも剣で戦う）'] }),
  node('ストロングホールド', { kind: 'stronghold', children: [
    node('食料330点（交点への道すがら）', { kind: 'food', doneWhen: 'food>=330|see:end_portal_frame',
      note: '交点の向きへ歩きながら、見えた牛・豚・羊を go の間に hunt で積む。かまどは持って歩き、夜の囲いでまとめて焼く。地上で止まって集めない（エンドのゲートは食料 80 の予備で入れる）' }),
    node('目玉の交点へ行き、地下の枠の部屋を見つける', { kind: 'stronghold', doneWhen: 'see:end_portal_frame',
      note: '交点・誤差・次の投げ位置は live の目玉の帳簿。',
      caution: ['海の向こうも地上の道で行ける: 海は go waterOk で泳いで渡る（橋・海の下の掘りはしない）。go の to は 200m 前後先。',
        '泳ぎは 2〜2.3 m/s・歩きは約 4 m/s（実測）。',
        'ネザー経由は使わない（帰りのゲートの枠は回収済み）。'] }),
    node('枠にアイをはめてポータルを開く', { kind: 'stronghold', doneWhen: 'see:end_portal' })] }),
  node('エンドに入る', { kind: 'end', doneWhen: 'dim:the_end', note: 'ポータルの e のマスへ walk して約4秒待つ',
    caution: ['丸石か黒曜石を3個以上持って入る（着く足場の火の玉は足元に積んで避ける）', '橋の先端（幅1）に長居せず、玉が来る向きを見て渡る。積める物を残す'] }),
  node('エンドでドラゴン', { kind: 'dragon', note: '討伐は体の記録（boss.verified）で確かめる。節では閉じない',
    caution: ['縁から5マス以上内側で戦う（sneak は押されるのを止めない）', '息の雲・火の玉の線の上で立ち止まらない',
      '結晶は檻つきも全部壊してから竜を倒す（1 本でも毎秒 2 回復し、ベッドの傷が戻る）',
      '竜を打つ前に剣か斧を equip で手に持つ（手が別の物のことがある）'],
    children: [node('結晶を全部壊す（檻つきも）', { kind: 'dragon', doneWhen: 'crystals<=0',
        note: '1 本でも残ると竜は毎秒 2 回復（本数に比例しない）。檻なしは矢か柱、檻つきは柱を登り格子ごしにそのまま殴る（掘らない）',
        caution: ['登る前に積める物3個以上と降りる手（go maxDrop・vertical down）を確かめる', '竜が火の玉を狙う間（phase 1）や近い時は登らず根で待つ'] }),
      node('ベッドで倒す（本命）', { kind: 'dragon',
        note: '結晶 0 本から。ベッド 8 以上・黒曜石 12 を持って入る。ベッドが尽きたら窪みの剣。エンドでは寝ない（爆発）' })] }),
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
// The coordinator, 11/10 6:55 (plan A): the helmet and chestplate; the legs' 7 iron are left out before the Nether.
const IRON_ARMOUR_WORN = 'have:iron_helmet&have:iron_chestplate';
// The kind `portal`: the golden boots are a goal of the gate's check (`BEFORE_GATE`, not required); the ore on the way down is `other` (it
// stands under the boots, whose stage it takes). Review of the run-8 fixes (11/13): with the boots an aim, the node said 「ネザーの前」 and stayed
// open until boots were made, and run 8 gathered gold beside a lit gate; it is an aim when four gold come together, and a lit gate or the
// Nether closes it and its children.
const BOOTS_OR_GATE = 'have:golden_boots|see:nether_portal|dim:the_nether|have:ender_eye>=10';
const GOLDEN_BOOTS_NODE = node('金のブーツ（目標・金 4 がそろう時）', { kind: 'portal', doneWhen: BOOTS_OR_GATE, children: [
  node('金鉱石4を掘る（y=-16前後・ダイヤへ下りる途中）', { kind: 'other', doneWhen: `have:raw_gold>=4|have:gold_ingot>=4|${BOOTS_OR_GATE}` }),
  node('焼いて金のブーツを作り履く', { kind: 'portal', doneWhen: BOOTS_OR_GATE })] });
export function gateFirst(seeds: readonly PlanSeed[]): PlanSeed[] {
  return seeds.flatMap(seed => [{ ...seed, ...gateFirstFields(seed),
    ...seed.children ? { children: gateFirst(seed.children).filter(child => !DROPPED_BEFORE_GATE(child)).map(ironFirst) } : {} },
  // The golden boots come after the diamonds (the gold ore is met on the way down) and before the obsidian and the gate.
  ...seed.kind === 'diamond' && seed.children ? [GOLDEN_BOOTS_NODE] : []]);
}
/**
 * The fields of the seed the gate's side changes: the village's beds (all of them: the End takes 10; the node itself is done at one),
 * the food, and the iron before the diamonds
 * (about 30). The seed is
 * picked by its `kind` and its `doneWhen` (chapter 7), never by the sameness of its title: the village node, the
 * preparation of the
 * food and the bed, and the top iron node (the
 * one with the iron ingots in its condition).
 */
function gateFirstFields(seed: PlanSeed): Partial<PlanSeed> {
  if (seed.kind === 'village') return { title: '村を回る（ベッド全部・干し草・畑・箱）' };
  if (seed.kind === 'prep_descent' && seed.doneWhen === 'stock:food&have:bed') return { doneWhen: 'stock:food&have:bed>=1' };
  if (seed.kind === 'iron' && seed.children && seed.doneWhen === IRON_TOP_DONE) {
    // The pre-deploy review of 11/5 (item 7): the iron sword is the gate's, so the iron node is done with it too (not only with the armour).
    return { title: '鉄（約30・剣・盾・バケツまで）', doneWhen: IRON_TOP_DONE };
  }
  return {};
}
const ironFirst = (seed: PlanSeed): PlanSeed => seed.kind === 'iron' && !seed.doneWhen ? { ...seed, title: '最初の鉄3を焼いて鉄のツルハシ（棒・台を確認）' }
  : seed.kind === 'iron_armor' ? { ...seed, title: '鉄の兜・胸当てを作って着る', doneWhen: IRON_ARMOUR_WORN } : seed;
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
export function firstPlanInput(goal: string, world: Record<string, unknown> | null,
  options: { scan?: boolean; readiness?: boolean; journeyReadiness?: boolean; draft?: string | null; words?: readonly string[]; now?: number } = {}): string {
  const part = (label: string, value: unknown, limit: number) => {
    const shown = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
    return shown ? [`${label}: ${shown.slice(0, limit)}`] : [];
  };
  // r4: the body's scan of the land it holds (its words and every row), before the rest is cut to the bound.
  const scan = options.scan ? scanForPlan(world?.scan) : null;
  return [`依頼: ${text(goal, 400)}`,
    ...(options.words?.length ? [`人の言葉（依頼と、届いた言葉。原文・話者・時刻つき。依頼の一行はこの依頼を書き直した物で、言われた言葉の方が詳しい）:\n${options.words.slice(0, 6).join('\n').slice(0, 1_800)}`] : []),
    ...part('位置', world?.position, 80), ...part('ディメンション', world?.dimension, 40),
    ...part('バイオーム', world?.biome, 60), ...part('時刻', world?.time, 20), ...packInput(world),
    ...(options.readiness && world ? [...part('着ている物', world.worn, 200), ...finishedInput(world),
      ...readinessInput(world, options.journeyReadiness, planGoal(goal) === null, options.now ?? Date.now())] : []),
    ...(options.draft ? [options.draft.slice(0, 3_200)] : []),
    ...(scan ? [`走査（読み込み済みの範囲の目印）:\n${scan.slice(0, 2_400)}`] : []),
    ...part('目印', world?.mapLandmarks, 1_500), ...part('地図の要約', world?.mapSummary, 1_500),
    ...part('場所の記憶', world?.rememberedPlaces, 1_000), ...part('通ったバイオーム', world?.biomesSeen, 400)]
    .join('\n').slice(0, FIRST_PLAN.inputCharacters);
}

/**
 * end1109o02 (11/9, the opening lane, all Haiku): asked to write the whole tree from the rules alone, Haiku's first plan put only
 * 「バケツを作る」「最初の水源で水を汲む」 under 「鉄の道具と防具」, no wood for the run, no iron pickaxe, armour, diamond pickaxe or flint and steel;
 * the bucket took the first 3 iron and the plan went on to the diamonds with a stone pickaxe. The seed (the order made from 60 runs) is now
 * the draft of the first plan from the overworld: the model keeps its nodes, order, kinds and conditions up to the Nether, and adds the
 * places the scan shows (a smaller decision than writing the tree). Null: no seed, or the plan does not begin at the overworld's start.
 */
export const OPENING_DRAFT_WORDS = [
  '下書き（過去の実走から作った、ネザーに入るまでの節。これを元に計画を書く）:',
  '- ネザーに入るまでは、下書きの節・順・kind・doneWhen をそのまま書き、走査にある座標（村・原木・水・溶岩・壊れたポータル）を where に足す。村が走査に無い時だけ村の節を除く（ベッドは羊毛 3＋板 3 で作る）。'
    + '水・溶岩・壊れたポータル・原木など、ほかの物が走査に無い時は、その節を消さず where を空にして探す節にする（どのワールドでも、近くに無い物は探して取る）。',
  '- 理由: 鉄のツルハシ（最初の鉄 3）・鉄の防具・水入りバケツ・ダイヤのツルハシ・黒曜石・火打ち金は、どれが欠けてもネザーで死ぬか取りに戻る。だから節と doneWhen を消さず、順も変えない（鉄のツルハシはバケツより前）。',
  '- ネザーより先の節は今までどおり書く。',
].join('\n');
export function openingDraft(seed: PlanTree | null): string | null {
  if (!seed) return null;
  const order = orderedPlan(seed.nodes), tops = order.filter(item => item.parentId === null);
  // The gate is the node whose first alternative is the Nether (「黒曜石10とゲート」, 「ネザーに入る」). The golden boots' node (11/13) has the
  // Nether only as a later alternative, and the old test on any alternative ended the draft there, before the obsidian and the gate.
  const gate = tops.findIndex(item => /^dim:the_nether(?:$|[&|])/u.test((item.doneWhen ?? '').replace(/\s+/gu, '')));
  if (gate < 0) return null;
  const kept = new Set(tops.slice(0, gate + 1).map(item => item.id));
  const depth = (id: string | null): number => { let d = 0; for (let up = id; up !== null && d < 8; d += 1) up = seed.nodes.find(item => item.id === up)?.parentId ?? null; return d; };
  const top = (id: string): string => { let at = seed.nodes.find(item => item.id === id); while (at?.parentId) at = seed.nodes.find(item => item.id === at!.parentId); return at?.id ?? id; };
  const lines = order.filter(item => kept.has(top(item.id))).map(item =>
    `${'  '.repeat(depth(item.id) - 1)}${item.id} ${item.title} [${kindOf(item)}]${item.doneWhen ? ` doneWhen: ${item.doneWhen}` : ''}`);
  return [OPENING_DRAFT_WORDS, ...lines].join('\n');
}

/**
 * r6: what the place she begins in lacks (`preparationShortage`, the check of the Nether's depth when she is
 * there), and health that does
 * not come back: the code's facts, for the first node.
 */
function readinessInput(world: Record<string, unknown>, journeyReadiness?: boolean, singleRequest = false, now: number = Date.now()): string[] {
  const dimension = typeof world.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : null;
  const food = carriedFood(world, {}).points, health = typeof world.health === 'number' ? world.health : null;
  const counts = carriedItemCounts(world, {});
  const shortage = preparationShortage({ dimension, counts, food, nowKinds: null, world, journeyReadiness });
  const recovery = recoveryLine(typeof world.food === 'number' ? world.food : null, health, food, counts);
  // A request of one thing (`planGoal` is null) is planned from the request alone (`SINGLE_REQUEST_PLAN_WORDS`): the descent's food count and
  // shortage would put a food node first again; the health that does not come back is still a fact of the place.
  if (singleRequest) return recovery ? [recovery] : [];
  const eyes = eyesForStronghold(world);
  const at = record(world.position), feet = at && typeof at.x === 'number' && typeof at.z === 'number' ? { x: at.x, z: at.z } : null;
  // Run 7 (11/27): the lines she threw before this plan (the body keeps them on the world): the point they give, as a guide, is a fact of the first plan too.
  // The frames are known in this world (the map's marks, or the body's record of this world): the plan starts from them, and the lines thrown before say nothing more.
  const known = dimension === 'overworld' ? framesKnownOf(world) : null;
  const thrown = dimension === 'overworld' && !known ? eyeLedgerFact(world.eyeThrows, feet, now) : [];
  const netherEyes = dimension === 'the_nether' ? eyesInHand(world) : null;
  return [...(eyes !== null ? [known ? EYES_WITH_FRAMES(eyes, frameFoundWords(known, feet, eyes)) : EYES_IN_HAND(eyes, eyeBasisOf(world).need)] : netherEyes !== null ? [EYES_IN_NETHER(netherEyes)] : []), ...thrown, foodPointsWords(food), ...(shortage ? [shortage] : []), ...(recovery ? [recovery] : [])];
}

/**
 * Run 8 (11/27): the pack was cut at 800 characters of JSON (the diamond pickaxe was in it, the stone tools and the shield further on were not read), and the plan was written as if
 * the finished things were not held. The whole pack in the live's own form (名前×数（耐久 残り/最大）); if it is too long the stacks with the biggest counts go first (cobblestone,
 * dirt: the things that are many and are not read one by one), and the line says how many kinds were left out.
 */
const PACK_LIMIT = 1_500;
function packInput(world: Record<string, unknown> | null): string[] {
  const inventory = world?.inventory;
  if (typeof inventory === 'string') return inventory ? [`持ち物: ${inventory.slice(0, PACK_LIMIT)}`] : [];
  const rows = stacks(inventory).map(line => ({ line, count: Number(/×(\d+)/u.exec(line)?.[1] ?? 1) }));
  if (!rows.length) return [];
  let left = 0;
  const joined = () => rows.map(row => row.line).join('・');
  while (joined().length > PACK_LIMIT && rows.length > 1) {
    const biggest = rows.reduce((best, row, index) => row.count >= rows[best]!.count ? index : best, 0);
    rows.splice(biggest, 1);
    left += 1;
  }
  return [`持ち物: ${joined()}${left ? `（数の多い ${left} 種は省いた）` : ''}`];
}

/** The finished things she carries or wears (a tool, a weapon, armour, the shield, a bucket, a bow, a bed...), by their ids: a fact, so that no node asks for one again. */
const FINISHED = /^(?:(?:wooden|stone|golden|iron|diamond|netherite)_(?:pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)|turtle_helmet|shield|bucket|water_bucket|lava_bucket|flint_and_steel|bow|crossbow|shears|[a-z]+_bed)$/u;
function finishedInput(world: Record<string, unknown>): string[] {
  const held = stacks(world.inventory).filter(line => FINISHED.test(line.replace(/×.*$/u, '')));
  const worn = typeof world.worn === 'string' ? [...world.worn.matchAll(/[:：]\s*([a-z_]+)(?:\(残り(\d+)\/(\d+)\))?/gu)]
    .filter(found => FINISHED.test(found[1]!)).map(found => `${found[1]}（着ている${found[2] ? `・残り ${found[2]}/${found[3]}` : ''}）`) : [];
  const all = [...held, ...worn];
  return all.length ? [`持っている完成品（事実。同じ物を作り直す節・取り直す節は要らない）: ${all.join('・').slice(0, 700)}`] : [];
}

/**
 * end1108e S9 (11/8): with 12 eyes in the overworld (the pack's 8th row, uncut), Haiku's first plan began again at wood, flint, a gate, the
 * fortress, rods, pearls and 「アイを14個そろえる」: three first plans of three (end1108c, d, e) did so with the rule in the words. The count is
 * said as the input's first fact, and the answer's stages that make eyes are dropped (`strongholdFirst`).
 */
export const EYES_FOR_STRONGHOLD = 10;
/**
 * Run 8 (11/27): the line was an order (「最初の節は…」) beside a shortage list that read as things to do first; Haiku wrote the village's beds, iron, an obsidian node and a bow first and the
 * stronghold fourth, with the eyes in the pack. It is the facts and the reason now, and where the shortage's things go (the order's own words are in the plan's system, `CURRENT_PLAN_STRUCTURE`).
 */
const EYES_PLAN_TAIL =
  'ゲート・ネザー・ブレイズ・パールを集める節は要らない。ベッド・黒曜石・足場の不足は、道中・要塞の近く・村や溶岩を通る時に取れる分だけでよく、そのための節は要塞の節の後ろ・エンドへ入る節の前に置く。' +
  `${ARCHERY_ON_THE_WAY}。弓矢の節は要塞の節の前の短い節（道中の準備）に置く。` +
  '防具の欠け・食料・掘る道具の欠けは要塞の前の短い節（出発の準備）にしてよい（手元か近く 30m 以内の材料で作れる分だけ。遠くへ鉄を掘りに行く節は作らない）。エンドの点検物は要塞の後ろの節（ベッド・黒曜石・足場）。' +
  '節は削らず順だけ後ろへ置く（黒曜石・ベッドの節、枠を埋めてポータルを開く節、12 個目の目の作り方の注意も節に残す）。理由: 枠は 12 個で目は今の数より多く要り、置かれていない時の手立ての節が計画に無いと、要塞に着いた後に次の手が決まらない';
/**
 * The frames are already known in this world (the body remembered a room 155 m away and the first plan still said "two throws give the place"): the place is a fact, the eyes are for the frames,
 * and the first node is the walk there. The same tail as the case without frames: where the preparation goes.
 */
const EYES_WITH_FRAMES = (eyes: number, found: string) => `エンダーアイ ${eyes} 個（オーバーワールド）。${found}。要塞の場所はもう分かっているので、目を投げて場所を出す節は要らない。` + EYES_PLAN_TAIL;
const EYES_IN_HAND = (eyes: number, need: number) => `エンダーアイ ${eyes} 個（オーバーワールド）。2 本投げれば要塞の場所が出る（今すぐできて、足りない物は要らない）。` +
  (eyes >= need ? '' : `枠は最大 12 で、割れる分の予備を足した ${need} 個を持って向かうのが目安（今 ${eyes}/${need}・あと ${need - eyes} 個。要塞を探す投げは 5 回に 1 回割れる。パールが手に入る時は予備の分まで取る。10 個以上あれば、足すためにネザーへ戻らず先に投げる）。`) +
  '投げて落ちたアイは拾う。' + EYES_PLAN_TAIL;
/**
 * Run 7 (11/27): a task begun in the Nether with 13 eyes. With the overworld-only rule in the system, Haiku weighed whether it applied (its thinking filled the 9,000 output tokens in 2 of 4 asks with the
 * new system; with the old system 4 of 4 took 2.8 to 4.2 thousand): the Nether's case is said as a fact of its own, with the same reason.
 */
const EYES_IN_NETHER = (eyes: number) => `エンダーアイ ${eyes} 個（ネザーの中）。要塞の場所は現世へ戻って 2 本投げれば出る（足りない物は要らない）。ロッド・パール・アイを足す節は要らない。` +
  '帰りのゲートで現世へ戻る節が先。ベッド・黒曜石・足場・鉄の不足は、道中・要塞の近く・村や溶岩を通る時に取れる分だけでよく、そのための節は要塞の節の後ろ・エンドへ入る節の前に置く。' +
  `${ARCHERY_ON_THE_WAY}。弓矢の節は要塞の節の前の短い節（道中の準備）に置く`;
/** The eyes she carries, in whatever dimension, when they are enough to look for the stronghold (`EYES_FOR_STRONGHOLD`); null: fewer. */
function eyesInHand(world: Record<string, unknown>): number | null {
  const eyes = carriedItemCounts(world, {}).get('ender_eye') ?? 0;
  return eyes >= EYES_FOR_STRONGHOLD ? eyes : null;
}
/** The eyes she carries in the overworld when they are enough to look for the stronghold (`EYES_FOR_STRONGHOLD`); null: elsewhere or fewer. */
export function eyesForStronghold(world: Record<string, unknown> | null): number | null {
  const dimension = typeof world?.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : null;
  if (!world || dimension !== 'overworld') return null;
  const eyes = carriedItemCounts(world, {}).get('ender_eye') ?? 0;
  return eyes >= EYES_FOR_STRONGHOLD ? eyes : null;
}
const EYE_MAKING_KINDS = new Set(['obsidian', 'lava', 'portal', 'nether', 'fortress', 'blaze', 'pearl']);
const STRONGHOLD_ON = new Set(['stronghold', 'end', 'dragon']);
/**
 * end1108f S9 (11/8): the stages dropped by kind were p3 to p6 and p9, but 「ネザーの準備」 (a stage of its own kind) with its children
 * 「火打ち金を作る」 (flint_and_steel) and 「金のブーツを作る」 (golden_boots), and 「アイを2個足して14へ」 (ender_eye) stayed: she mined and
 * smelted iron for 2 minutes before the throws. A stage whose target is one of these items goes too, and so does a stage all of whose
 * children went.
 */
const EYE_MAKING_ITEMS = /^(flint_and_steel|obsidian|blaze_rod|blaze_powder|ender_pearl|ender_eye|fire_charge|golden_(boots|helmet|chestplate|leggings))$/u;
/**
 * The answer without its stages that make eyes (and their children) when `eyes` are in hand in the overworld; as it is when it has no
 * stronghold, End or dragon stage left to go on with (`say` is told what was dropped).
 */
export function strongholdFirst(answer: unknown, eyes: number | null, say?: (line: string) => void): unknown {
  const rows = Array.isArray(record(answer)?.nodes) ? record(answer)!.nodes as unknown[] : null;
  if (eyes === null || !rows) return answer;
  const dropped = new Set<string>();
  // Run 9 of 11/27: 「黒曜石を5個足す」 (kind obsidian, have:obsidian>=12, for the dragon) and 「枠を12にしてポータルを開く」 (kind portal, see:end_portal) were dropped with the Nether's
  // gate, and with them the step after the stronghold (fitting the eyes, the 12th eye). The End's side is kept by what it is for: the End's portal or the End itself in its condition, or
  // an obsidian node for 12 or more (the dragon's) with no word of the Nether or the gate.
  const endSide = (item: Record<string, unknown>) => /see:end_portal|dim:the_end/u.test(text(item.doneWhen, 200))
    || (text(item.kind, 64) === 'obsidian' && /have:obsidian>=(?:1[2-9]|[2-9]\d)/u.test(text(item.doneWhen, 200)) && !/dim:the_nether|ネザー|ゲート|火打|flint/u.test(`${text(item.title, 80)} ${text(item.doneWhen, 200)}`));
  const makesEyes = (item: Record<string, unknown>) => !endSide(item)
    && (EYE_MAKING_KINDS.has(text(item.kind, 64)) || EYE_MAKING_ITEMS.test(text(record(item.target)?.item, 64).replace(/^minecraft:/u, '')));
  let kept = rows.filter(row => {
    const item = record(row), id = text(item?.id, 32), parent = text(item?.parent, 32);
    if (!item || !(makesEyes(item) || (parent && dropped.has(parent)))) return true;
    dropped.add(id);
    return false;
  });
  // A stage that only held stages now dropped (「ネザーの準備」) goes with them.
  const parentOf = (row: unknown) => text(record(row)?.parent, 32);
  kept = kept.filter(row => {
    const id = text(record(row)?.id, 32);
    const children = rows.filter(other => id && parentOf(other) === id);
    if (!children.length || STRONGHOLD_ON.has(text(record(row)?.kind, 64)) || !children.every(child => dropped.has(text(record(child)?.id, 32)))) return true;
    dropped.add(id);
    return false;
  });
  if (!dropped.size || !kept.some(row => STRONGHOLD_ON.has(text(record(row)?.kind, 64)))) return answer;
  say?.(`Shannon Minecraft first plan stronghold first eyes=${eyes} dropped=${[...dropped].join(',').slice(0, 160)}`);
  return { ...record(answer), nodes: kept };
}

/** A node's texts from the answer; r4: its forbid and caution too (within the tree's bounds; an answer without
 * them is as before). */
function seedFields(item: Record<string, unknown>): Omit<PlanSeed, 'title' | 'children' | 'id'> {
  const rules = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(line => text(line, PLAN_LIMITS.rule)).filter(Boolean))]
    .slice(0, PLAN_LIMITS.rules);
  const forbid = rules(item.forbid), caution = rules(item.caution);
  // The kind as the model wrote it (`planFromSeeds` takes one outside the list as `other` with the value kept in
// `kindRaw`); none: `other`.
  return { ...(item.target !== undefined ? { target: item.target as NonNullable<PlanSeed['target']> } : {}),
    ...(text(item.kind, 64) ? { kind: text(item.kind, 64) } : {}), ...(text(item.where, 120) ? { where: text(item.where, 120) } : {}),
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
 * A node whose target its doneWhen does not establish keeps its doneWhen and loses the target (run59 task 1: one such node threw the whole first plan
 * away); `said` is told which node and why.
 */
export function planFromAnswer(answer: unknown, at?: string, said?: (line: string) => void): PlanTree | null {
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
  let tree = top.length ? planFromSeeds(top) : null;
  const loose = (tree?.nodes ?? []).flatMap(node => {
    const problem = targetConditionProblem(node);
    return problem ? [{ id: node.id, problem }] : [];
  });
  for (const { id, problem } of loose) {
    delete seeds.get(id)?.target;
    said?.(`Shannon Minecraft first plan target dropped node=${id} ${problem.slice(0, 160)}`);
  }
  if (loose.length) tree = planFromSeeds(top);
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
interface Slot { seed: PlanTree | null; answer: PlanTree | null; asked: boolean; pending?: boolean; began?: number; settled?: boolean }
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
/** What the inbox says beside the plan it hands over, from the task's step (all optional: the open items of the queue, how far the point the eyes give is). */
export interface FirstPlanWords { running?(): readonly string[]; crossing?(node: PlanNode, nodes: readonly PlanNode[]): string | null }
/**
 * Run 9 of 11/27: the first plan came in with the now on 「p1.1」 while an item of the default plan (q1) was running, and the note said only that the plan came; the decision read 「今の計画は q1 が走っている」
 * and went on with it. The note says the now changed, which node it is (with how far, when it is the walk to the point), and that the items running are the old default plan's (to be replaced when they are not wanted).
 */
export function firstPlanInboxWith(words: FirstPlanWords = {}): FcaPlanInbox {
  return {
    take(taskId, held) {
      const slot = slots.get(taskId);
      if (!slot) return null;
      if (slot.answer) {
        const answer = slot.answer;
        slot.answer = null;
        slot.seed = null;
        const tree = held.nodes.length ? carryDone(held, answer) : answer;
        const now = tree.nodes.find(node => node.id === tree.current);
        const running = (words.running?.() ?? []).slice(0, 4);
        const reach = now ? words.crossing?.(now, tree.nodes) ?? null : null;
        const changed = now ? `。計画が替わった。今の節は [${now.id}] ${now.title.slice(0, 24)}${reach ? `（${reach}）` : ''}` : '';
        const old = running.length ? `。走っている ${running.join('・')} は旧の既定計画の物（要るなら replace で入れ替えてよい）` : '';
        return { tree, note: `最初の計画（強いモデル）が届いた。済んだ節は引き継いだ${changed}${old}。合わなければ plan.update で直す` };
      }
      if (slot.seed && !held.nodes.length) {
        const seed = slot.seed;
        slot.seed = null;
        // Run 9: the default plan's order is the old preparation order (the first item walked 53 s north, away from the stronghold).
        return { tree: seed, note: slot.pending
          ? '既定の最初の計画。この世界に合わせた計画が約 1 分以内に届く。それまでは長い act（歩きが 30 秒を超える物）を出さず、probe・短い手で待つ。'
            + '理由: 既定計画は旧の準備順で、9 回目はこれで要塞と逆の北へ 53 秒歩いた'
          : '既定の最初の計画。この世界に合わせた計画が後で届く' };
      }
      return null;
    },
  };
}
export const firstPlanInbox: FcaPlanInbox = firstPlanInboxWith();

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
    readiness?: boolean; journeyReadiness?: boolean;
    /** What people said to the task so far (`heardLines`), read when the plan is asked (after the scan wait): shown in the input. */
    words?(): readonly string[] } }): void {
  const slot = slotOf(parts.taskId);
  if (slot.asked || parts.held.revision > 1) return;
  slot.asked = true;
  // r6: the seed begins where she is (a dragon's task begun in the Nether: at the check before going deeper).
  const dimension = typeof parts.world?.dimension === 'string' ? parts.world.dimension : null;
  if (!parts.held.nodes.length) slot.seed = seedPlan(parts.goal, dimension);
  if (!parts.planner) return;
  slot.pending = true;
  const planner = parts.planner;
  const abort = new AbortController(), began = Date.now();
  slot.began = began;
  const timer = setTimeout(() => abort.abort(), FIRST_PLAN.giveUpMs);
  timer.unref?.();
  const say = (line: string) => { try { parts.log(line); } catch { /* logging never fails a step */ } };
  say(`Shannon Minecraft first plan asked task=${parts.taskId}`);
  const r4 = parts.r4;
  let asked = parts.world;
  const ask = r4 ? withScan(r4, parts.world).then(world => {
    asked = world;
    say(`Shannon Minecraft first plan scan task=${parts.taskId} scan=${world?.scan ? 'yes' : 'none'} waitedMs=${Date.now() - began}`);
    // end1109o02: from the overworld's start (no eyes for the stronghold) the seed up to the Nether is the draft.
    const startDimension = typeof world?.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : 'overworld';
    const draft = startDimension === 'overworld' && eyesForStronghold(world) === null ? openingDraft(seedPlan(parts.goal, 'overworld')) : null;
    if (draft) say(`Shannon Minecraft first plan draft task=${parts.taskId} characters=${draft.length}`);
    return planner(r4.system ?? FIRST_PLAN_SYSTEM_R4, firstPlanInput(parts.goal, world,
      { scan: true, draft, ...(r4.words ? { words: r4.words() } : {}), ...(r4.readiness ? { readiness: true, journeyReadiness: r4.journeyReadiness } : {}) }),
      abort.signal);
  }) : planner(FIRST_PLAN_SYSTEM, firstPlanInput(parts.goal, parts.world), abort.signal);
  ask.then(answer => {
    const tree = abort.signal.aborted ? null
      : planFromAnswer(strongholdFirst(answer, eyesForStronghold(asked), say), new Date().toISOString(), say);
    if (tree) slot.answer = tree;
    slot.settled = true;
    say(("Shannon Minecraft first plan " +
`${tree ? 'planned' : 'missing'}` +
" task=" +
`${parts.taskId}` +
" nodes=" +
`${tree?.nodes.length ?? 0}` +
" ms=" +
`${Date.now() - began}` +
""));
  }, () => { slot.settled = true; say(`Shannon Minecraft first plan failed task=${parts.taskId} ms=${Date.now() - began}`); }).finally(() => clearTimeout(timer));
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

/** How long the words of the waiting (`firstPlanWaiting`) stand: a plan that has not come by then is read as not coming, and the node's own line is said as it is. */
export const FIRST_PLAN_WAITING_MS = 90_000;
/**
 * The task's first plan is being written (asked, no answer yet, failure or give-up) and has been for less than `FIRST_PLAN_WAITING_MS`; the node the decision reads is then the default plan's, a stand-in.
 * Null when no plan was asked, it came, it failed, or the wait is past the bound (the ordinary words come back).
 */
export function firstPlanWaiting(taskId: string, now: number = Date.now()): { sinceMs: number } | null {
  const slot = slots.get(taskId);
  if (!slot?.pending || slot.settled || slot.began === undefined) return null;
  const sinceMs = now - slot.began;
  return sinceMs >= 0 && sinceMs < FIRST_PLAN_WAITING_MS ? { sinceMs } : null;
}

/** For tests: no task holds a first plan. */
export function forgetFirstPlans(): void { slots.clear(); }
