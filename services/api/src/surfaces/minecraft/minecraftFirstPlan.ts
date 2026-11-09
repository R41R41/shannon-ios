import { targetConditionProblem } from './minecraftPlanRequirements.js';
export { FIRST_PLAN, CHECK_FORBID, CHECK_FORBID_NOW } from './minecraftFirstPlanPrompts.js';
import { FIRST_PLAN,CHECK_FORBID_NOW } from './minecraftFirstPlanPrompts.js';
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
  // The section audit of 11/5 (runs 60 and 61 both went back up for wood and died there): the wood of the whole run at once after the stone axe, as
  // the last child; the parent waits for it (a child is closed when its parent is done).
  node('木と石の道具', { kind: 'stone_tools', doneWhen: 'have:stone_pickaxe&have:log>=16|have:stone_pickaxe&have:planks>=64|have:iron_pickaxe|have:diamond_pickaxe',
    children: [
    node('原木を集める', { kind: 'wood', doneWhen: 'have:log>=8|have:planks>=24', note: '作業台・木のツルハシ・斧と石の道具の棒の分（ツルハシ 1 つで済みにしない）' }),
    node('作業台と木のツルハシ', { kind: 'wood', doneWhen: 'have:wooden_pickaxe|have:stone_pickaxe|have:iron_pickaxe' }),
    node('丸石で石のツルハシ・斧・剣', { kind: 'stone_tools', doneWhen: 'have:stone_pickaxe&have:stone_axe&have:stone_sword' }),
    node('原木を通しの分（計20〜24）', { kind: 'wood', doneWhen: 'have:log>=16|have:planks>=64',
      note: '石の斧の後に一度に（板・棒・盾・ベッドの板・箱の分）。後で木のために地上へ戻らない' })] }),
  node('食料とベッド（最初の夜の前・鉄より前）', { kind: 'prep_descent', doneWhen: 'food>=40&have:bed',
    note: 'ベッドが一番（寝れば夜を飛ばせる）: 走査の羊の行で同じ色 3 体を探す。夜にベッドが無ければ、地面に 2 段の穴を掘って塞ぎ、その底から鉄の節へ下りる（外で待たない。朝に戻って続ける）', children: [
    node('村を回る（ベッド全部・干し草・畑・箱）', { kind: 'village',
    note: '村が見えなければ飛ばす。ベッドは見つけた分を全部（寝る用 1 と、エンドの竜戦に 10 個・最低 8）。この親が済んでも取り切ってから出る。'
      + '羊を見かけたら羊毛も取る（同じ色 3＋板 3 で 1 個）',
    caution: ['通りがかりに糸・火打石（砂利を掘る）・羽（ニワトリ）を見かけたら拾う（エンドの弓と矢 30 の分。取りに戻らない）'] }),
    node('無ければ動物を4〜6体狩る', { kind: 'food' }), node('かまどで肉を焼く・パンを作る', { kind: 'food', doneWhen: 'food>=40' })] }),
  node('鉄（24〜36）', { kind: 'iron', doneWhen: 'have:iron_ingot>=24|have:iron_chestplate&have:iron_pickaxe&have:shield', caution: ['食料40点・作業台か板4を持ってから下りる（夜にベッドが無ければ、満腹度14・体力16以上で先に下りてよい）'],
    children: [node('最初の鉄3を焼いて鉄のツルハシ（棒・台を確認）', { kind: 'iron', doneWhen: 'have:iron_pickaxe' }),
    // The whole-run audit of 11/4, order 1: the sword and the shield the moment the iron is smelted (run60 met the night with no sword); the boots are
    // the golden ones (the gate's table), so the armour is the three iron pieces.
    node('残りの鉄をまとめて採り焼く・剣・盾・バケツ', { kind: 'iron', doneWhen: 'have:iron_pickaxe&have:iron_sword&have:shield&have:bucket' }),
    node('鉄の兜・胸当て', { kind: 'iron_armor', doneWhen: 'have:iron_helmet&have:iron_chestplate' })] }),
  node('水入りバケツ（最初の水源ですぐ汲む）', { kind: 'water', doneWhen: 'have:water_bucket' }),
  node('ダイヤ（y=-58）', { kind: 'diamond', doneWhen: 'have:diamond_pickaxe',
    caution: ['必須（盾・鉄の兜胸当てを着る・鉄のツルハシ・水入りバケツ・食料40点）が欠けたら下りない', '死ねば鉄装備を失う。体力12未満・耐久2割未満なら進まず補う'], children: [
    node('ダイヤ3以上を掘る', { kind: 'diamond', doneWhen: 'have:diamond>=3|have:diamond_pickaxe' }),
    node('ダイヤのツルハシ（剣も）', { kind: 'diamond', doneWhen: 'have:diamond_pickaxe' })] }),
  // 「|have:ender_eye>=10」 (end1108d S9, 11/8): 12 eyes less the one or two just thrown and not yet picked up still close the stages that make them.
  node('黒曜石10とゲート', { kind: 'portal', doneWhen: 'dim:the_nether|have:ender_eye>=10', caution: ['必須（盾・鉄の剣・鉄の兜胸当てを着る・ツルハシと石の予備2本・足場64・食料40点）が欠けたら入らない'], children: [
    node('溶岩源で黒曜石22（ゲート10・竜戦12）', { kind: 'obsidian', doneWhen: 'have:obsidian>=22|dim:the_nether|have:ender_eye>=10', note: '最初の溶岩でまとめて取る（竜戦の分を後で取りに来ない）' }),
    node('火打ち金（火打石は砂利）', { kind: 'portal', doneWhen: 'have:flint_and_steel|dim:the_nether|have:ender_eye>=10' }),
    node('食料100点以上に足す', { kind: 'food', doneWhen: 'food>=100' }), node('ゲートを組んで火をつける', { kind: 'portal', doneWhen: 'dim:the_nether|have:ender_eye>=10',
      caution: ['火をつける前に必須を確かめる: 盾・鉄の剣・鉄の兜胸当てを着る・ツルハシ・足場64・食料40点',
        'ベッドは寝る用2を残し、ゲートの横の箱に預けて入る（1個1マス。帰りに同じゲートで取る）'] })] }),
];
/**
 * Run 26 (owner 2026-10-21): she went on to the fortress with no table, slabs, shield or food; each stage past
 * the gate starts with a check.
 * r7 (runs 29–31): the check forbids the fight before it is done (`CHECK_FORBID`, as the first plan is asked to write it).
 * The checks are of the kind `prep_descent` (the preparation before going on: the stage's food and the table); the eyes' are
 * `pearl`, the End's `dragon`.
 */
const BEYOND: readonly PlanSeed[] = [
  // thru-1110 (11/9, the kits of the rig's sections against a through run): the blaze spawner's gate asks 150 food points with no rods (S7's rig
  // gives 24 beef, about 500); run48 reached the spawner with 39.6. The check before going deep asks 200 (about 10 cooked beef), the gate's 150
  // and the way to the fortress, so the gate does not turn the plan to the pearls for food.
  node('出発の点検（ネザーの奥へ）', { kind: 'prep_descent', doneWhen: 'food>=200&have:crafting_table&have:shield', note: '足りない物はゲートのそばで作る',
    forbid: [CHECK_FORBID_NOW],
    children: [node('ネザーの幹で作業台（持ち歩く）', { kind: 'other', doneWhen: 'have:crafting_table' }),
      node('足場のブロック64（橋と囲い）', { kind: 'other', doneWhen: 'have:cobblestone>=64|have:netherrack>=64|have:cobbled_deepslate>=64' }),
      node('かまどで鉄を焼き盾', { kind: 'other', doneWhen: 'have:shield' }), node('食料が200点に足りなければ地上で狩って焼く（焼き肉10ほど）', { kind: 'food', doneWhen: 'food>=200',
        note: 'ブレイズの湧き場の関所が150点を求める。要塞までの道で減る分を足して200（ゲートを出てすぐの地上で）' }),
      node('金の防具を1つ着る（ピグリンが襲わない）', { kind: 'other', doneWhen: 'have:gold_armor' })] }),
  node('ネザー要塞を探す', { kind: 'fortress', note: '帰りのゲート座標を控える。432m区画の要塞・砦・未確認を見る。手がかりが無ければ南北から',
    // S5's rig of 11/5: with 7 rods in hand the node held and she went to the fortress again; the rods or an eye close it too.
    doneWhen: 'see:fortress|have:blaze_rod>=7|have:ender_eye>=1',
    caution: ['橋の下は溶岩のことがある。足元と両脇を確かめて渡る', '遠い go に canDig[netherrack,basalt,blackstone] canPlace[cobblestone,netherrack]',
      'maxDig 200・maxPlace 100・seconds 100〜120。止まったら行の通りに直して同じ go'] }),
  node('ブレイズロッド7以上', { kind: 'blaze', target: { item: 'blaze_rod', count: 7 }, doneWhen: 'have:blaze_rod>=7|have:ender_eye>=10', note: '粉にするのは7本そろってから',
    caution: ['死ぬと持ち物と時間を失う（死んでも続ける）。体力12未満・盾の耐久2割未満なら戦わず退いて補う'],
    children: [node('mc_probe kind=camp で湧き場の足場を見つけ、go で着く', { kind: 'blaze' }),
    node('8m 内の見えるブレイズへ待たずに attack target=#id（体が追う）、剣で 20 体ほど（矢なし）', { kind: 'blaze' }), node('棒を拾う（ブレイズがいない時）', { kind: 'blaze' })] }),
  node('エンダーパール14以上', { kind: 'pearl', target: { item: 'ender_pearl', count: 14 }, doneWhen: 'have:ender_pearl>=14|have:ender_eye>=12', note: '枠に11〜12・投げの損耗に2〜3',
    children: [node('歪んだ森のエンダーマン（天井2）', { kind: 'pearl' }), node('金の延べ棒をピグリンに投げて交換', { kind: 'pearl' })] }),
  // The coordinator, 11/9 (thru-1110's table): leave the Nether with 12 eyes, not 10 (a frame holds one from the start 1 time in 10, 1.2 on
  // average, so about 11 are needed, and a throw breaks about 1 in 5). A node closed in the Nether stays done while eyes fly; a first plan made
  // in the overworld with 10 or more eyes has these stages taken out (`strongholdFirst`, EYES_FOR_STRONGHOLD), so 10 still keep her from going back.
  node('エンダーアイ14個', { kind: 'pearl', target: { item: 'ender_eye', count: 14 }, doneWhen: 'have:ender_eye>=12', note: '材料があれば14作る。12以上でネザーを出る（枠に最初から入るのは平均1.2個、投げは1回約2割で割れる。投げて落ちたアイは拾う。枠の空きを見て足りない時だけ戻る）',
    children: [node('粉と真珠で作る', { kind: 'pearl' })] }),
  node('オーバーワールドへ戻る', { kind: 'nether', doneWhen: 'dim:overworld', note: '帰りのゲートから。ポータルの対は live の控え' }),
  // thru-1110 (11/9): the arrows are the fallback's, not the beds' way (the End's gate holds no first entry for them when the beds are in), and a
  // through run brings none from the Nether (the blazes are cut with the sword): the check no longer waits for 30 of them.
  node('出発の点検（エンドへ）', { kind: 'prep_descent', doneWhen: 'food>=330&have:bed>=8&have:obsidian>=8&have:ender_eye>=10&have:water_bucket',
    note: '水入りバケツ（水を汲んだ物）を hotbar（最初の 9 スロット）に持つ: 自動救済は対応版で有効な時だけ手・hotbar の水。'
      + '下降は事前に水を置くか vertical（自動救済を当てに跳び降りない）',
    children: [node('ベッドを10個にする（預けた箱から・羊毛3と板3・最低8）', { kind: 'bed', doneWhen: 'have:bed>=10',
        note: '羊毛は鋏（鉄2）で刈ると1頭1〜3枚（殺すと1枚）。村のベッドが8に足りない時に' }),
      node('エンドの戦い用の黒曜石を12（最低8・ポータルの分とは別）', { kind: 'obsidian', doneWhen: 'have:obsidian>=12' }),
      node('食料330点（焼き牛16）にする', { kind: 'food', doneWhen: 'food>=330',
        note: '地上で牛・豚・羊を狩ってかまどで焼く。竜の戦いは20分ほど食べ続ける（焼き牛4では途中で0になった）' }),
      node('弓と矢（手元の材料で作れる分。集めに行かない）', { kind: 'other', doneWhen: 'have:bow&have:arrow>=30',
        note: '糸・棒・火打石・羽根。矢は予備の手の物で、ベッド8がそろえば無くても入れる' })] }),
  node('ストロングホールド', { kind: 'stronghold', children: [
    node('目玉の交点へ行き、地下の枠の部屋を見つける', { kind: 'stronghold', doneWhen: 'see:end_portal_frame',
      note: '交点・誤差・次の投げ位置は live の目玉の帳簿。',
      caution: ['海の向こうも地上の道で行ける: 海は go waterOk で泳いで渡る（約 3 m/s。橋・海の下の掘りはしない）。go の to は 200m 前後先。',
        'ネザー経由なら、アイの交点が出た後にネザーへ入り直し、掘る前にネザー側のゲート座標を控える。',
        '入った側（1 つ目のゲートの向こう側）の枠の黒曜石 10 は、ダイヤのツルハシで回収できる（1 個 9.4 秒、計約 94 秒）。',
        '回収した 10 は (x/8, z/8) の 2 つ目のゲートの分で、竜戦用の 12 を残せる。枠を回収したゲートは帰りには使わない。'] }),
    node('枠にアイをはめてポータルを開く', { kind: 'stronghold', doneWhen: 'see:end_portal' })] }),
  node('エンドに入る', { kind: 'end', doneWhen: 'dim:the_end', note: 'ポータルの e のマスへ walk して約4秒待つ',
    caution: ['丸石か黒曜石を3個以上持って入る（着く足場の火の玉は足元に積んで避ける）', '橋の先端（幅1）に長居せず、玉が来る向きを見て渡る。積める物を残す'] }),
  node('エンドでドラゴン', { kind: 'dragon', note: '討伐は体の記録（boss.verified）で確かめる。節では閉じない',
    caution: ['縁から5マス以上内側で戦う（sneak は押されるのを止めない）', '息の雲・火の玉の線の上で立ち止まらない',
      '檻つきの柱は積める物3個以上を持って登り、長居しない（落下止めは当てにしない）。檻は本命が尽きて竜の体力100超の予備の最後',
      '竜を打つ前に剣か斧を equip で手に持つ（手が別の物のことがある）'],
    children: [node('ベッドで倒す（本命）', { kind: 'dragon',
        note: 'ベッド 10・黒曜石 12 を持って入る。ネザーとエンドでは寝ない（爆発する）。使い方はエンドの知識の通り' }),
      // Unseen crystal bases count as remaining: full clearance must not be a prerequisite for the perched sword fallback.
      node('結晶を弓で壊しつつ止まり木の竜を剣で打つ（予備）', { kind: 'dragon',
        note: '竜の体力50以下なら結晶へ行かず窪みの足場の剣か残りのベッドで届く。',
        caution: ['本命が尽きて竜の体力100超なら檻なしを地面から弓で壊す余地がある', '剣は結晶全破壊を待たず座りごとに使える（檻は最後）'] })] }),
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
// The kind `portal`: the golden boots are the piece of the gate's check (`BEFORE_GATE`); the ore on the way down is `other` (it
// stands under the boots, whose stage it takes).
const GOLDEN_BOOTS_NODE = node('金のブーツ（ネザーの前）', { kind: 'portal', doneWhen: 'have:golden_boots|have:ender_eye>=10', children: [
  node('金鉱石4を掘る（y=-16前後・ダイヤへ下りる途中）', { kind: 'other', doneWhen: 'have:raw_gold>=4|have:gold_ingot>=4|have:golden_boots|have:ender_eye>=10' }),
  node('焼いて金のブーツを作り履く', { kind: 'portal', doneWhen: 'have:golden_boots|have:ender_eye>=10' })] });
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
  if (seed.kind === 'prep_descent' && seed.doneWhen === 'food>=40&have:bed') return { doneWhen: 'food>=40&have:bed>=1' };
  if (seed.kind === 'iron' && seed.doneWhen === IRON_TOP_DONE) {
    // The pre-deploy review of 11/5 (item 7): the iron sword is the gate's, so the iron node is done with it too (not only with the armour).
    return { title: '鉄（約30・剣・兜・胸まで）', doneWhen: `have:iron_pickaxe&have:iron_sword&have:bucket&have:shield&${IRON_ARMOUR_WORN}` };
  }
  return {};
}
/** The condition of the seed's top iron node (the kind `iron` with children): the iron before the gate is about
 * thirty with the armour. */
const IRON_TOP_DONE = 'have:iron_ingot>=24|have:iron_chestplate&have:iron_pickaxe&have:shield';
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
  options: { scan?: boolean; readiness?: boolean; journeyReadiness?: boolean; draft?: string | null } = {}): string {
  const part = (label: string, value: unknown, limit: number) => {
    const shown = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
    return shown ? [`${label}: ${shown.slice(0, limit)}`] : [];
  };
  // r4: the body's scan of the land it holds (its words and every row), before the rest is cut to the bound.
  const scan = options.scan ? scanForPlan(world?.scan) : null;
  return [`依頼: ${text(goal, 400)}`, ...part('位置', world?.position, 80), ...part('ディメンション', world?.dimension, 40),
    ...part('バイオーム', world?.biome, 60), ...part('時刻', world?.time, 20), ...part('持ち物', world?.inventory, 800),
    ...(options.readiness && world ? [...part('着ている物', world.worn, 200), ...readinessInput(world, options.journeyReadiness)] : []),
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
  const gate = tops.findIndex(item => /(?:^|[&|])dim:the_nether(?:$|[&|])/u.test(item.doneWhen ?? ''));
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
function readinessInput(world: Record<string, unknown>, journeyReadiness?: boolean): string[] {
  const dimension = typeof world.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : null;
  const food = carriedFood(world, {}).points, health = typeof world.health === 'number' ? world.health : null;
  const counts = carriedItemCounts(world, {});
  const shortage = preparationShortage({ dimension, counts, food, nowKinds: null, world, journeyReadiness });
  const recovery = recoveryLine(typeof world.food === 'number' ? world.food : null, health, food, counts);
  const eyes = eyesForStronghold(world);
  return [...(eyes !== null ? [EYES_IN_HAND(eyes)] : []), foodPointsWords(food), ...(shortage ? [shortage] : []), ...(recovery ? [recovery] : [])];
}

/**
 * end1108e S9 (11/8): with 12 eyes in the overworld (the pack's 8th row, uncut), Haiku's first plan began again at wood, flint, a gate, the
 * fortress, rods, pearls and 「アイを14個そろえる」: three first plans of three (end1108c, d, e) did so with the rule in the words. The count is
 * said as the input's first fact, and the answer's stages that make eyes are dropped (`strongholdFirst`).
 */
export const EYES_FOR_STRONGHOLD = 10;
const EYES_IN_HAND = (eyes: number) => `エンダーアイ ${eyes} 個（オーバーワールド）: ゲート・ネザー・ブレイズ・パール・アイを作る節は要らない。` +
  '最初の節はストロングホールドを探す節（2 か所から投げて交点を出す）。投げて落ちたアイは拾う';
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
  const makesEyes = (item: Record<string, unknown>) =>
    EYE_MAKING_KINDS.has(text(item.kind, 64)) || EYE_MAKING_ITEMS.test(text(record(item.target)?.item, 64).replace(/^minecraft:/u, ''));
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
    readiness?: boolean; journeyReadiness?: boolean } }): void {
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
  let asked = parts.world;
  const ask = r4 ? withScan(r4, parts.world).then(world => {
    asked = world;
    say(`Shannon Minecraft first plan scan task=${parts.taskId} scan=${world?.scan ? 'yes' : 'none'} waitedMs=${Date.now() - began}`);
    // end1109o02: from the overworld's start (no eyes for the stronghold) the seed up to the Nether is the draft.
    const startDimension = typeof world?.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : 'overworld';
    const draft = startDimension === 'overworld' && eyesForStronghold(world) === null ? openingDraft(seedPlan(parts.goal, 'overworld')) : null;
    if (draft) say(`Shannon Minecraft first plan draft task=${parts.taskId} characters=${draft.length}`);
    return planner(r4.system ?? FIRST_PLAN_SYSTEM_R4, firstPlanInput(parts.goal, world,
      { scan: true, draft, ...(r4.readiness ? { readiness: true, journeyReadiness: r4.journeyReadiness } : {}) }),
      abort.signal);
  }) : planner(FIRST_PLAN_SYSTEM, firstPlanInput(parts.goal, parts.world), abort.signal);
  ask.then(answer => {
    const tree = abort.signal.aborted ? null
      : planFromAnswer(strongholdFirst(answer, eyesForStronghold(asked), say), new Date().toISOString(), say);
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
