import { OMIT } from './minecraftLlmcLiveEnemies.js';
import { ARROWS_TO_CARRY } from './minecraftEndPrepWords.js';

/**
 * mb-llmc v2 (実走36: 階段掘りで丸石 121・閃緑岩 65・深層岩の丸石 154 を拾い続けて満杯になり、dig が 0/12 で止まる・drop だけの act が 4 回・
 * 形式違反の drop 1 回で約 100 秒): the pack's free slots and what fills it, from the live state's inventory lines alone
 * (`body.pack`). The body's
 * pack is the slots 9–44, 36 stacks; each line of the inventory is one stack (a kind in two stacks is two
 * lines), and 「ほか N件」 stands for N more.
 * Facts only: the dig hand's own `collect: false` (do not walk to and pick up what dropped) is in the act's description.
 */
export const PACK_SLOTS = 36;
/** What a dig of rock, earth or sand gives that is not wanted for itself (the pack's filler). */
const FILLER = new RegExp('^(?:cobblestone|cobbled_deepslate|deepslate|diorite|andesite|granite|tuff|dirt|coarse_dirt|gravel|sand|'
  + 'netherrack|basalt|blackstone|calcite|dripstone_block)$', 'u');
/**
 * The clutter that is dropped before the filler (run59 leg 2: free 2 of 36 with fences, stairs, rails, mossy cobblestone, string, saplings and seeds in the
 * pack, and the candidates named were the cobblestone the gate asks for). The string is never clutter (the whole-run audit of 11/4, order 10: one or
 * two of it were named to drop while the bow was not made; a bow takes three, and four make a wool).
 */
const JUNK = new RegExp('(?:_fence|_fence_gate|_stairs|_sapling|_seeds|_terracotta|_door|_banner|_sign|_tulip)$|^(?:rail|powered_rail|detector_rail|activator_rail|mossy_cobblestone'
  + '|mossy_stone_bricks|rotten_flesh|spider_eye|poisonous_potato|terracotta|short_grass|tall_grass|fern|large_fern|dandelion|poppy|blue_orchid|allium'
  + '|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony)$', 'u');
/** 2026-11-13 (run 9: the clutter of the pack was about 12 slots): a few of these are clutter only while they are few or while a better one is held. */
const FEW = /^(?:gold_nugget|emerald)$/u;
const FEW_BELOW = 9;
const TOOL_KIND = /^(wooden|stone|golden)_(pickaxe|axe|shovel|hoe|sword)$/u;
/** A tool with this many uses left or fewer is nearly spent. */
const WORN_LEFT = 3;
const TOOL = /_(?:pickaxe|axe|shovel|hoe|sword)$/u;
/** The stacks per filler kind are shown when the filler alone fills this many slots. */
const FILLER_SLOTS = 3;
const STACK = /^([a-z_0-9]+)×(\d+)/u;
/**
 * Run 46 (the pack said 6 free of 36; the body had none): the body writes ONE LINE A KIND
 * ("cobbled_deepslate×230" is four slots),
 * so a line is not a slot. The free slots are the body's
 * own number (`world.freeSlots`, the same count as its pickup's: the slots 9 to 44 that are empty); only when
 * the frame has none are
 * they estimated, a line by the stacks its count fills.
 */
const ONE_SLOT = new RegExp([
  "(?:_pickaxe|_axe|_shovel|_hoe|_sword|_helmet|_chestplate|_leggings|_boots|_bed|_boat|_minecart)$|^(?:bow|",
  "crossbow|shield|trident|fishing_rod|shears|flint_and_steel|elytra|saddle|minecart|potion|splash_potion|",
  "lingering_potion|water_bucket|lava_bucket|milk_bucket|powder_snow_bucket|cod_bucket|salmon_bucket|",
  "pufferfish_bucket|tropical_fish_bucket|axolotl_bucket|tadpole_bucket|mushroom_stew|rabbit_stew|",
  "beetroot_soup|suspicious_stew|cake|written_book|writable_book|enchanted_book)$",
].join(''), 'u');
const SIXTEEN = /(?:_sign|_hanging_sign|_banner)$|^(?:ender_pearl|snowball|egg|bucket|honey_bottle|armor_stand|painting)$/u;
/** The slots a stack of this many of an item fills (64 a slot unless the item stacks less). */
export function slotsOf(name: string, count: number): number {
  const size = ONE_SLOT.test(name) ? 1 : SIXTEEN.test(name) ? 16 : 64;
  return Math.max(1, Math.ceil(count / size));
}

/** A wooden tool when a stone or better one of its kind is held, a stone sword when an iron one is (the weaker one is clutter, not the last tool). */
function spareTool(name: string, held: ReadonlySet<string>): boolean {
  const tool = TOOL_KIND.exec(name);
  if (!tool) return false;
  const better = tool[1] === 'wooden' ? ['stone', 'golden', 'iron', 'diamond', 'netherite'] : tool[1] === 'stone' && tool[2] === 'sword' ? ['iron', 'diamond', 'netherite'] : [];
  return better.some(kind => held.has(`${kind}_${tool[2]}`));
}

/** True while the flint the arrows lack is more than the flint carried (`ARROWS_TO_CARRY`, 4 arrows a flint); a bow with enough arrows lacks none. */
function arrowFlintShort(lines: readonly string[]): boolean {
  const have = (pattern: RegExp): number => lines.reduce((sum, line) => { const stack = STACK.exec(line); return stack && pattern.test(stack[1]!) ? sum + Number(stack[2]) : sum; }, 0);
  const arrows = have(/^(?:arrow|spectral_arrow)$/u), bow = have(/^(?:bow|crossbow)$/u);
  return (bow > 0 && arrows >= ARROWS_TO_CARRY) ? false : Math.ceil(Math.max(0, ARROWS_TO_CARRY - arrows) / 4) > have(/^flint$/u);
}
/**
 * What of the bow's materials she carries, held back from a tidy (11/27: a tidy threw the flint away): item and the count the bow and 12 arrows take, never more than carried. The pack's
 * words say why; said only while the bow's node is the plan's now, or a bow, arrows, feather or string is carried (stick and flint alone are carried for other work).
 */
export const ARCHERY_ITEMS: ReadonlyArray<readonly [string, number]> = [['flint', 3], ['feather', 3], ['string', 3], ['stick', 3], ['bow', 1], ['arrow', ARROWS_TO_CARRY]];
export function archeryHeld(carried: ReadonlyMap<string, number>, nowDoneWhen?: string): Map<string, number> {
  const out = new Map<string, number>();
  const signal = /have:(?:bow|arrow)/u.test(nowDoneWhen ?? '') || ['bow', 'arrow', 'feather', 'string'].some(name => (carried.get(name) ?? 0) > 0);
  if (!signal) return out;
  for (const [item, need] of ARCHERY_ITEMS) {
    const have = carried.get(item) ?? 0;
    if (have > 0) out.set(item, Math.min(have, need));
  }
  return out;
}
const ARCHERY_KEEP_WORDS = '弓矢の材料（flint・feather・string・stick・bow・arrow）は捨てない（理由: 作り直すにはクモ・ニワトリ・砂利を探し直すことになり、拾った物は空きが無いと荷に入らない）。'
  + '火打石が矢の分に満たない間は gravel も捨てない（掘ると 10% で火打石）。空きは dirt・leaves など山のある物から先に作る';
/** Stacks used (the lines, and the omitted ones), the filler kinds with their totals, from the inventory lines. */
export function packFacts(lines: readonly string[]): { used: number; filler: Array<[string, number]>; junk: Array<[string, number]>; worn: Array<[string, number]> } {
  let used = 0;
  const tools: Array<[string, number]> = [];
  const filler = new Map<string, number>(), junk = new Map<string, number>();
  // The section audit of 11/5: gravel is the flint's source (10% a block), kept until the flint and steel is made. 11/27 (the bow and arrows are made on the way): and while the flint
  // the arrows still lack is short (4 arrows to a flint), gravel is not a spare either.
  const flintMade = lines.some(line => /^flint_and_steel×/u.test(line)) && !arrowFlintShort(lines);
  const held = new Set(lines.flatMap(line => STACK.exec(line)?.[1] ?? []));
  for (const line of lines) {
    const omitted = OMIT.exec(line) ?? /^ほか(\d+)件は略$/u.exec(line);
    if (omitted) {
      used += Number(omitted[1]);
      continue;
    }
    const stack = STACK.exec(line);
    used += stack ? slotsOf(stack[1]!, Number(stack[2])) : 1;
    if (stack && FILLER.test(stack[1]!) && (stack[1] !== 'gravel' || flintMade)) {
      filler.set(stack[1]!, (filler.get(stack[1]!) ?? 0) + Number(stack[2]));
    }
    const left = /\(耐久(\d+)\/\d+\)$/u.exec(line);
    if (stack && left && TOOL.test(stack[1]!)) tools.push([stack[1]!, Number(left[1])]);
    if (stack && (JUNK.test(stack[1]!) || (FEW.test(stack[1]!) && Number(stack[2]) < FEW_BELOW) || spareTool(stack[1]!, held))) {
      junk.set(stack[1]!, (junk.get(stack[1]!) ?? 0) + Number(stack[2]));
    }
  }
  // A tool with at most WORN_LEFT uses left while another of its kind has more: it is not the last one, so it can go (run 8: the pack filled with half-used pickaxes).
  const worn = tools.filter(([name, left]) => left <= WORN_LEFT && tools.some(([other, more]) => other.replace(/^[a-z]+_/u, '') === name.replace(/^[a-z]+_/u, '') && more > WORN_LEFT));
  return { used, filler: [...filler].sort((a, b) => b[1] - a[1]), junk: [...junk].sort((a, b) => b[1] - a[1]), worn };
}

/** The body's free slots in a frame (`world.freeSlots`: its own count, the same as its pickup's), or null when it
 * has none or it is
 * not a count of the pack. */
export function reportedFree(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= PACK_SLOTS ? Math.floor(value) : null;
}
/** The beds carried (each stack `x_bed×n`). */
export function bedsIn(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + Number(/^[a-z_]*_bed×(\d+)/u.exec(line)?.[1] ?? 0), 0);
}
/** What a full pack costs, said as a fact in the first words of the pack's lines (run 46: 36 of 36 with tuff 65,
 * cobbled deepslate
 * 230 and cobblestone 147, no drop was made; a go stopped full, and the obsidian hand ended "cannot pick up the drop"). */
/**
 * run 8 (11/27): nine drops, none of them freed room (near water the body threw sideways under 3 m and the thrown stack was picked up again, dirt 0 -> 22), tidy never used, and the
 * same iron stopped four times on a full pack. Said beside the free count while it is under 10: why 10, what fills a slot, and which way of freeing room holds.
 */
export const digRoomWords = (free: number): string => 'mine と拾う dig の前に空きを 10 以上にする（掘る岩の種類ごとに 1 マス埋まる: 丸石・深層岩・土・安山岩など。理由: 満杯だと拾う手が止まる）。go・vertical で掘り進む手は満杯でも止まらないので、その前に drop を足さなくてよい（掘った石は足元に落ちるだけ）。'
  + `drop は水が近い所や 3 m 以内では投げた物を拾い直すので、体が「拾い直された」と返したら続けず、${free <= FULL_SOON ? 'tidy にするか、' : ''}3 m 以上離れてから drop する`;
export const FULL_COST = 'go・vertical は止まらない（掘った石は足元に落ちるだけ。canPlace 用の石は残す）。これ以上拾えない（黒曜石も）ので mine・pickup・make・かまどの取り出しは止まる';
/**
 * What of the filler can be dropped: each kind less what the plan's promises hold back of it (`held`), the most carried kind also
 * less one stack kept for pillars and bridges. The kinds
 * are in the order of `packFacts` (the most carried first); a kind with nothing to spare is left out.
 */
export function dropCandidates(filler: ReadonlyArray<[string, number]>, held: (item: string) => number = () => 0, keepStack: number = KEEP_STACK): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  let kept = false;
  for (const [name, n] of filler) {
    const spare = Math.max(0, n - held(name) - (!kept ? keepStack : 0));
    if (n - held(name) > 0) kept = true;
    if (spare > 0) out.push([name, spare]);
  }
  return out;
}
/** The candidates in words: 「cobbled_deepslate×166（3 マス）・cobblestone×147（3 マス）」, four at most; empty when there are none. */
export const dropWords = (drops: ReadonlyArray<readonly [string, number]>): string => drops.slice(0, 4).map(([name,
   n]) => `${name}×${n}（${Math.ceil(n / 64)} マス）`).join('・');
/** Free slots at or under this, the pack says what to drop before it is full. */
export const FULL_SOON = 3;
/**
 * Blocks of the filler kind kept for pillars and bridges (the first kind, the most carried): 128, not one stack (the coordinator, 2026-11-03: the gate asks for
 * 128 cobblestone to bridge on, and a pack emptied to 64 by the words was refilled by digging).
 */
const KEEP_STACK = 128;
/** With one free slot or none the pillar stack kept is one stack (2026-11-13, run 9: 128 kept is two slots a full pack cannot spare). */
const KEEP_STACK_TIGHT = 64;
const keepStackFor = (free: number): number => free <= 1 ? KEEP_STACK_TIGHT : KEEP_STACK;
/** What can be dropped, in words: the clutter first, then the filler beyond what is kept (`dropCandidates`). */
export function dropAdvice(packed: { filler: ReadonlyArray<[string, number]>; junk: ReadonlyArray<[string, number]>; worn?: ReadonlyArray<[string, number]> },
  held: (item: string) => number = () => 0, keepStack: number = KEEP_STACK): string {
  const junk = packed.junk.slice(0, 6).map(([name, n]) => `${name}×${n}`).join('・');
  const worn = (packed.worn ?? []).slice(0, 3).map(([name, left]) => `${name}(残り ${left})`).join('・');
  return [junk ? `雑物 ${junk}` : '', dropWords(dropCandidates(packed.filler, held, keepStack)), worn ? `使い切りかけの道具（同じ種類の別の物がある）${worn}` : ''].filter(Boolean).join('・');
}
/**
 * Run 43 (the 36 slots filled with about 270 cobblestone and cobbled deepslate: bread could not be made, about
 * 60 s at +2,343 to +2,402, and a go
 * stopped full at +2,427; the pack's line said the free slots only after they were 0): at 3 free slots or fewer,
 * what to drop, before it is full.
 */
function fullSoon(free: number, filler: ReadonlyArray<[string, number]>, junk: Array<[string, number]> = [], tidy: TidyContext = {}): string | null {
  if (free > FULL_SOON) return null;
  const keepStack = keepStackFor(free), held = tidy.held ?? (() => 0);
  const say = tidySay(tidy.keepWords, tidy.blocks, tidy.archery);
  if (free === 0) {
    // Full now: said as what is so and what it costs, not as what will happen (run 46). tidy goes before drop (2026-11-13).
    const spare = dropAdvice({ filler, junk }, held, keepStack);
    return spare ? `満杯: ${FULL_COST}。${say}。drop で空けられる物: ${spare}（${filler[0]?.[0] ?? '丸石'} ${keepStack} は柱と橋用に数えていない）`
      : `満杯: ${FULL_COST}。${say}`;
  }
  const drops = dropCandidates(filler, held, keepStack);
  const kinds = drops.slice(0, 4).map(([name, n]) => `${name}×${n}（${Math.ceil(n / 64)} マス）`).join('・');
  const keep = filler.length ? `${filler[0]![0]} ${keepStack} は柱と橋に残す` : '';
  const clutter = junk.length ? `雑物 ${junk.slice(0, 6).map(([name, n]) => `${name}×${n}`).join('・')}・` : '';
  return `空きが ${free} マス。満杯になると make・pickup・dig の物が入らず止まる（実走 43 はパンを作れず約 60 秒、go も満杯で止まった）。`
    + (kinds || clutter ? `捨てる物の候補: ${clutter}${kinds}。${keep}。drop で捨てる` : '要らない物を drop で捨てる') + `。${say}`;
}
/**
 * 2026-11-13 (run 9: 20 acts to clear a full pack, the drops mostly missing the pit): at 3 free slots or fewer, the hand that makes the room. `keepWords`: what the
 * plan's current and next nodes need, as `物:数,…` (nothing: no example).
 */
const tidySay = (keepWords?: string, blocks?: TidyContext['blocks'], archery?: boolean): string => `tidy で空ける（捨てる物と焼く原石を体が選ぶ）。要る物は keep=物:数${keepWords ? `（今の節の材料: keep=${keepWords}）` : ''}${blocksWords(blocks)}${archery ? `。${ARCHERY_KEEP_WORDS}` : ''}`;
/**
 * 11/27 (the dirt and cobblestone she had thrown to make room were the scaffold that was short by 63): when the End's check wants blocks to stand on and she carries some, the
 * tidy words say which of the pack count for that and what throwing them costs. Facts only: the count, the kinds, the number short after a full throw; keeping them is `keep=`.
 */
const blocksWords = (blocks?: TidyContext['blocks']): string => blocks && blocks.held.length
  ? `。足場に数える物（${blocks.held.map(([name, n]) => `${name}×${n}`).join('・')}）は今 ${blocks.have} 個。目標は ${blocks.need} 個で、これを捨てると足場用にあと ${blocks.need - Math.max(0, blocks.have - blocks.held.reduce((sum, [, n]) => sum + n, 0))} 個足りなくなる（残すなら keep=${blocks.held.map(([name, n]) => `${name}:${n}`).join(',')}）` : '';
/** What the plan needs and where she stands, for the tidy words (all optional; none given: no extra line is said). */
export interface TidyContext {
  /** What the open promises and the plan's materials hold back of an item. */
  held?: (item: string) => number;
  keepWords?: string;
  /** The bow's materials are carried (`archeryHeld`): the tidy words say they are not thrown, with the reason. */
  archery?: boolean;
  /** The blocks that count for the End's scaffold (`have` of `need`) and the kinds she carries (largest first), while the End's check is the plan's stage. */
  blocks?: { have: number; need: number; held: ReadonlyArray<readonly [string, number]> };
  /** A crafting table or a furnace within reach (remembered within 16 m). */
  near?: { table?: boolean; furnace?: boolean };
}
const countOf = (lines: readonly string[], pattern: RegExp): number => lines.reduce((sum, line) => {
  const stack = STACK.exec(line);
  return stack && pattern.test(stack[1]!) ? sum + Number(stack[2]) : sum;
}, 0);
const HAY_POINTS = 33;
/**
 * At 3 free slots or fewer, two facts that only tidy can use, each said only when it can be done now: hay_block turns into bread (a table is
 * carried, planks to put one down are, or one is near), raw iron or gold is smelted (a furnace is carried or near, or 8 cobblestone make one; fuel is held).
 */
export function tidyExtras(lines: readonly string[], free: number, tidy: TidyContext = {}): string[] {
  if (free > FULL_SOON) return [];
  const out: string[] = [];
  const hay = countOf(lines, /^hay_block$/u);
  if (hay > 0 && (tidy.near?.table || countOf(lines, /^crafting_table$/u) > 0 || countOf(lines, /_planks$/u) >= 4)) {
    out.push(`hay_block×${hay} は tidy で食料のパンになる（約 ${hay * HAY_POINTS} 点）`);
  }
  const raw = [['raw_iron', countOf(lines, /^raw_iron$/u)], ['raw_gold', countOf(lines, /^raw_gold$/u)]].filter(([, n]) => (n as number) > 0);
  const fuel = countOf(lines, /^(?:coal|charcoal)$/u) > 0 || countOf(lines, /_(?:log|stem)$/u) > 0;
  const stove = tidy.near?.furnace || countOf(lines, /^furnace$/u) > 0 || countOf(lines, /^(?:cobblestone|cobbled_deepslate)$/u) >= 8;
  if (raw.length && fuel && stove) out.push(`原石 ${raw.map(([name, n]) => `${name}×${n}`).join('・')} は tidy で焼ける`);
  return out;
}
/**
 * `body.pack`: the free slots as a line, and the filler that takes them when it takes three slots or more; run
 * 36 and 37 (85–90 s each going back to a village): with two beds or more the line says what the beds are for and what each way costs (not in the
 * End's own check: `forEnd`). Empty when the inventory is not a list.
 */
export function packLines(lines: readonly string[], options: { forEnd?: boolean; free?: number } & TidyContext = {}): string[] {
  if (!lines.length) return [];
  const { used: counted, filler, junk } = packFacts(lines);
  // The body's own number when the frame has it (Math.floor, 0 to 36); else the lines' stacks.
  const reported = typeof options.free === 'number' && Number.isFinite(options.free) && options.free >= 0 &&
     options.free <= PACK_SLOTS ? Math.floor(options.free) : null;
  const used = reported === null ? counted : PACK_SLOTS - reported;
  const free = Math.max(0, PACK_SLOTS - used);
  const out = [free === 0 ? `持ち物は満杯（${PACK_SLOTS} マスのうち使用 ${Math.min(used, PACK_SLOTS)}、空き 0）`
    : `持ち物は ${PACK_SLOTS} マスのうち使用 ${Math.min(used, PACK_SLOTS)}、空き ${free}（満杯だと dig・pickup が「満杯」で止まる）`];
  const before = fullSoon(free, filler, junk, options);
  if (before) out.push(before);
  out.push(...tidyExtras(lines, free, options));
  const total = filler.reduce((sum, [, n]) => sum + n, 0);
  if (Math.ceil(total / 64) >= FILLER_SLOTS) {
    const kinds = filler.slice(0, 4).map(([name, n]) => `${name}×${n}`).join('・');
    out.push(`掘って拾い続けた石や土 ${total} 個（${kinds}）が約 ${Math.ceil(total / 64)} マスを占める。`
      + 'dig は拾いに歩く (collect 既定 true): 階段・トンネルで使わない石や土を掘る dig は collect=false。捨てるなら drop（体は 3m 以上先へ水平に投げる。'
      + 'その近くに立ち続ける・歩くと拾い直す）'
      // run62 (11/5): 81 drop hands of 90 to 120 cobblestone each, the pack full four times on the way down.
      + (dropCandidates(filler, options.held, keepStackFor(free)).length ? `。下りる前に、余り（${dropWords(dropCandidates(filler, options.held, keepStackFor(free)))}）を 1 つの act の drop で一度に捨てる`
        + `（${filler[0]![0]} ${keepStackFor(free)} は柱と橋に残す）` : ''));
  }
  const beds = bedsIn(lines);
  // The whole-run audit of 11/4 (chapter 1: 「村へ取りに戻らない」 stood against taking every bed of a village): the facts of both ways, no rule.
  if (beds >= 2 && !options.forEnd) {
    out.push(`ベッドは ${beds} 個（エンドの竜戦に 10・最低 8）。通る村のベッドは全部取れる。ベッドのためだけに村へ戻った往復は 1 回 85〜90 秒だった（実走 36・37）。`
      + '羊毛からも作れる（同じ色 3＋板 3。ハサミなら羊 1 頭で 1〜3）');
  }
  if (free < 10) out.push(digRoomWords(free));
  return out;
}
