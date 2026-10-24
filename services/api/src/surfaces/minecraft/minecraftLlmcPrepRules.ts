/**
 * SHANNON_MINECRAFT_LLMC_V2 (owner 2026-10-24, after run 38: 「鉄装備を足しか作らない。金装備をしてからネザーに行っていない。最善は足だけ金ブーツ。その他レギンス、
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
 * The rules as the first plan and the stage knowledge say them (one text, so the plan and the decision read the same numbers). Knowledge, not an order.
 */
export const PREP_RULES_WORDS = [
  `- ダイヤを掘りに下りる前: 鉄のツルハシ・バケツ・盾・鉄の兜・胸当て・脚（着る）。鉄はネザーまでに約 ${IRON_BEFORE_NETHER}`
    + '（ツルハシ 3・バケツ 3・盾 1・兜 5・胸 8・脚 7・火打ち金 1・剣 2）。作ったらすぐ equip で着る（持っているだけでは守らない）。',
  `- 靴は鉄でなく金のブーツ（金の延べ棒 ${GOLD_FOR_BOOTS}）。金の防具を 1 つ着ているとピグリンが襲わない。金鉱石は y=-16 前後に多く、ダイヤへ下りる途中の壁で見つかる`
    + '（生の金をかまどで焼く。村の箱や廃坑の箱にもある）。鉄のブーツを持っていても、ネザーの前に金のブーツに履き替える。',
  '- ゲート（ネザーに入る）の前: 上の 4 つの防具・盾・剣・鉄以上のツルハシ・水入りバケツ・黒曜石 10・火打ち金・足場のブロック 64・食料 40 点ほど。',
  '- ネザーに入った後、要塞（奥）へ行く前: 作業台・ハーフブロック 12・食料 100 点（足りない食料は帰りのゲートから戻って狩る）。',
  '- ベッドは村で見つけた 1〜2 つでよい（余分に取りに行かない。ベッドの節の doneWhen は have:bed>=1）。エンドの前に羊毛 3＋板 3 で 4〜6 に増やす。',
].join('\n');
