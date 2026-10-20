import { itemWords } from '@shannon/mind';
import { BED_ITEM, COOKED_FOOD, EDIBLE_FOOD, countMatching, type ItemCounts } from './minecraftItems.js';
import { ARMOR_PIECES } from './minecraftStage.js';

/**
 * Her Minecraft body's present in her own words (session dc-live): the game's names, what a running tool is doing, the time of day, and
 * what she carries that is worth saying. Closed tables only; a value the table does not know is left out or said plainly, never copied
 * from the world as a sentence.
 */
const MOBS: Readonly<Record<string, string>> = Object.freeze({
  zombie: 'ゾンビ', skeleton: 'スケルトン', creeper: 'クリーパー', spider: 'クモ', cave_spider: '洞窟グモ', enderman: 'エンダーマン', witch: 'ウィッチ',
  blaze: 'ブレイズ', ghast: 'ガスト', piglin: 'ピグリン', piglin_brute: 'ピグリンブルート', hoglin: 'ホグリン', wither_skeleton: 'ウィザースケルトン',
  magma_cube: 'マグマキューブ', slime: 'スライム', drowned: 'ドラウンド', phantom: 'ファントム', pillager: 'ピリジャー', vindicator: 'ヴィンディケーター',
  ender_dragon: 'エンダードラゴン', husk: 'ハスク', stray: 'ストレイ', silverfish: 'シルバーフィッシュ', zombified_piglin: 'ゾンビピグリン',
});
export const mobWords = (name: string): string => MOBS[name] ?? 'モンスター';

const BLOCKS: Readonly<Record<string, string>> = Object.freeze({
  iron_ore: '鉄鉱石', deepslate_iron_ore: '鉄鉱石', coal_ore: '石炭', diamond_ore: 'ダイヤ', deepslate_diamond_ore: 'ダイヤ', stone: '石', cobblestone: '丸石',
  gravel: '砂利', obsidian: '黒曜石', sand: '砂', dirt: '土', gold_ore: '金鉱石', copper_ore: '銅鉱石',
});
function blockWords(name: unknown): string {
  const id = typeof name === 'string' ? name : '';
  return BLOCKS[id] ?? (/_log$/u.test(id) ? '原木' : /_ore$/u.test(id) ? '鉱石' : 'ブロック');
}

type Call = { name: string; input: unknown } | null;
const arg = (call: NonNullable<Call>, key: string): unknown =>
  (call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>)[key] : undefined);

const DOING: Readonly<Record<string, (call: NonNullable<Call>) => string>> = Object.freeze({
  'mc.mine-block': call => `${blockWords(arg(call, 'blockName'))}を掘っている`,
  'mc.stair-mine': () => '階段状に深く掘り下がっている',
  'mc.move-to': () => '目的の場所へ移動している',
  'mc.craft-one': call => `${itemWords(String(arg(call, 'itemName') ?? ''))}を作っている`,
  'mc.start-smelting': () => 'かまどで焼いている',
  'mc.withdraw-from-furnace': () => 'かまどから取り出している',
  'mc.attack-continuously': call => `${mobWords(String(arg(call, 'entityName') ?? ''))}を相手に戦っている`,
  'mc.explore-for-structure': () => '何かないか探しながら歩いている',
  'mc.find-blocks': () => '周りを見回して探している',
  'mc.wait-time': () => '少し待っている',
  'mc.sleep-in-bed': () => 'ベッドで寝ている',
  'mc.build-structure': () => '何かを建てている',
  'mc.build-around-self': () => '身を守る囲いを作っている',
  'mc.dig-shelter': () => '穴を掘って身を隠している',
  'mc.use-item-on-block': () => '道具を使って作業している',
  'mc.leave-water': () => '水から上がろうとしている',
  'mc.flee-from': () => '敵から逃げている',
  'mc.eat': () => 'ごはんを食べている',
});
/** What a body command is doing, from the skill the body names in its progress events (the commands a procedure runs are not her own calls). */
const SKILLS: Readonly<Record<string, string>> = Object.freeze({
  'mine-block': '掘っている', 'stair-mine': '階段状に掘り下がっている', 'move-to': '歩いて移動している', 'explore-for-structure': '歩いて探している',
  'attack-continuously': '戦っている', 'wait-time': '少し待っている', 'craft-one': '何かを作っている', 'start-smelting': 'かまどで焼いている',
  'withdraw-from-furnace': 'かまどから取り出している', 'build-structure': '何かを建てている', 'build-around-self': '身を守る囲いを作っている',
  'dig-shelter': '穴を掘って身を隠している', 'use-item-on-block': '道具を使って作業している', 'sleep-in-bed': 'ベッドで寝ている',
});
export const skillDoing = (skill: string): string => SKILLS[skill] ?? '';

/**
 * What a running tool is doing, in a few words: the tool and the item or block it names, never its other arguments. A procedure runs
 * many commands under one call of hers: it is told by the step it runs, and by the command the body reports now (`running`).
 */
export function doingWords(call: Call, running = ''): string {
  if (!call) return running;
  if (call.name === 'mc.run-procedure') {
    const step = typeof arg(call, 'milestone') === 'string' ? `「${String(arg(call, 'milestone')).slice(0, 20)}」の手順を進めていて、` : '決めた手順を進めていて、';
    return `${step}${running || 'まとめて動かしている'}`;
  }
  return DOING[call.name]?.(call) ?? (running || 'マイクラの作業を進めている');
}

/** The body's four parts of the day, from the tick (as the body tells it to the companion). */
export function timeWords(tick: number | null): string {
  if (tick === null) return '';
  if (tick < 1_000 || tick >= 23_000) return '明け方';
  if (tick < 12_000) return '昼';
  return tick < 13_800 ? '夕方' : '夜';
}

const LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^diamond$/u, 'ダイヤ'], [/^iron_ingot$/u, '鉄の延べ棒'], [/^raw_iron$/u, '鉄の原鉱'], [/^(?:coal|charcoal)$/u, '石炭'], [/^obsidian$/u, '黒曜石'],
  [/^ender_pearl$/u, 'エンダーパール'], [/^blaze_rod$/u, 'ブレイズロッド'], [/^ender_eye$/u, 'エンダーアイ'], [/^cobblestone$/u, '丸石'],
];
const TIERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^netherite_pickaxe$/u, 'ネザライトのツルハシ'], [/^diamond_pickaxe$/u, 'ダイヤのツルハシ'], [/^iron_pickaxe$/u, '鉄のツルハシ'],
  [/^stone_pickaxe$/u, '石のツルハシ'], [/^wooden_pickaxe$/u, '木のツルハシ'],
];

/** What she carries that is worth saying: the best pickaxe, the armour, the food, a bed, and the few items the way to the dragon runs on. */
export function carriedWords(counts: ItemCounts): string[] {
  const pickaxe = TIERS.find(([pattern]) => countMatching(counts, pattern) > 0)?.[1];
  const pieces = ARMOR_PIECES.filter(piece => countMatching(counts, piece) > 0).length;
  const food = countMatching(counts, EDIBLE_FOOD), cooked = countMatching(counts, COOKED_FOOD);
  const items = LABELS.flatMap(([pattern, label]) => {
    const have = countMatching(counts, pattern);
    return have > 0 ? [`${label}×${have}`] : [];
  });
  return [...(pickaxe ? [pickaxe] : ['ツルハシはまだ無い']), ...(pieces ? [`防具${pieces}/4`] : []),
    food > 0 ? `食べ物${food}個${cooked > 0 ? `（焼いた物${cooked}）` : ''}` : '食べ物は無い', countMatching(counts, BED_ITEM) > 0 ? 'ベッドを持っている' : 'ベッドは持っていない', ...items];
}

/** The map the body keeps, in a few words: the structures with the nearest one's distance, and how many ores, lava pools and cave mouths. */
export function mapWords(map: unknown): string {
  if (typeof map !== 'string' || !map) return '';
  const parts: string[] = [];
  const structures = map.split('\n').find(line => line.startsWith('構造物:'));
  if (structures) {
    for (const part of structures.slice('構造物:'.length).split('／').slice(0, 5)) {
      const name = part.split(':')[0]?.trim(), distance = /(\d+)m/u.exec(part)?.[1];
      if (name) parts.push(distance ? `${name}(${distance}m)` : name);
    }
  }
  const counted = [['ダイヤ', /ダイヤ\s*(\d+)か所/u], ['鉄', /鉱石:.*?鉄\s*(\d+)か所/u], ['溶岩', /溶岩の溜まり\s*(\d+)か所/u], ['洞窟の入口', /洞窟の入口\s*(\d+)か所/u]] as const;
  for (const [label, pattern] of counted) {
    const count = pattern.exec(map)?.[1];
    if (count) parts.push(`${label}${count}か所`);
  }
  return parts.join('・');
}
