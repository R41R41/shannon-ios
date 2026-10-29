import { OMIT } from './minecraftLlmcLiveEnemies.js';

/**
 * mb-llmc v2 (実走36: 階段掘りで丸石 121・閃緑岩 65・深層岩の丸石 154 を拾い続けて満杯になり、dig が 0/12 で止まる・drop だけの act が 4 回・
 * 形式違反の drop 1 回で約 100 秒): the pack's free slots and what fills it, from the live state's inventory lines alone (`body.pack`). The body's
 * pack is the slots 9–44, 36 stacks; each line of the inventory is one stack (a kind in two stacks is two lines), and 「ほか N件」 stands for N more.
 * Facts only: the dig hand's own `collect: false` (do not walk to and pick up what dropped) is in the act's description.
 */
export const PACK_SLOTS = 36;
/** What a dig of rock, earth or sand gives that is not wanted for itself (the pack's filler). */
const FILLER = new RegExp('^(?:cobblestone|cobbled_deepslate|deepslate|diorite|andesite|granite|tuff|dirt|coarse_dirt|gravel|sand|'
  + 'netherrack|basalt|blackstone|calcite|dripstone_block)$', 'u');
/** The stacks per filler kind are shown when the filler alone fills this many slots. */
const FILLER_SLOTS = 3;
const STACK = /^([a-z_0-9]+)×(\d+)/u;

/** Stacks used (the lines, and the omitted ones), the filler kinds with their totals, from the inventory lines. */
export function packFacts(lines: readonly string[]): { used: number; filler: Array<[string, number]> } {
  let used = 0;
  const filler = new Map<string, number>();
  for (const line of lines) {
    const omitted = OMIT.exec(line) ?? /^ほか(\d+)件は略$/u.exec(line);
    if (omitted) {
      used += Number(omitted[1]);
      continue;
    }
    used += 1;
    const stack = STACK.exec(line);
    if (stack && FILLER.test(stack[1]!)) {
      filler.set(stack[1]!, (filler.get(stack[1]!) ?? 0) + Number(stack[2]));
    }
  }
  return { used, filler: [...filler].sort((a, b) => b[1] - a[1]) };
}

/** The beds carried (each stack `x_bed×n`). */
export function bedsIn(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + Number(/^[a-z_]*_bed×(\d+)/u.exec(line)?.[1] ?? 0), 0);
}
/** What a full pack costs, said as a fact in the first words of the pack's lines (run 46: 36 of 36 with tuff 65, cobbled deepslate 230 and cobblestone 147, no drop was made; a go stopped full, and the obsidian hand ended "cannot pick up the drop"). */
export const FULL_COST = 'これ以上拾えない（黒曜石・鉱石・落とし物も。dig・pickup・make の物も入らず止まる）';
/**
 * What of the filler can be dropped: each kind less what the plan's promises hold back of it (`held`), the most carried kind also less one stack kept for pillars and bridges. The kinds
 * are in the order of `packFacts` (the most carried first); a kind with nothing to spare is left out.
 */
export function dropCandidates(filler: ReadonlyArray<[string, number]>, held: (item: string) => number = () => 0): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  let kept = false;
  for (const [name, n] of filler) {
    const spare = Math.max(0, n - held(name) - (!kept ? KEEP_STACK : 0));
    if (n - held(name) > 0) kept = true;
    if (spare > 0) out.push([name, spare]);
  }
  return out;
}
/** The candidates in words: 「cobbled_deepslate×166（3 マス）・cobblestone×147（3 マス）」, four at most; empty when there are none. */
export const dropWords = (drops: ReadonlyArray<readonly [string, number]>): string => drops.slice(0, 4).map(([name, n]) => `${name}×${n}（${Math.ceil(n / 64)} マス）`).join('・');
/** Free slots at or under this, the pack says what to drop before it is full. */
export const FULL_SOON = 3;
/** Stacks of a filler kind kept for pillars and bridges (the first kind, the most carried). */
const KEEP_STACK = 64;
/**
 * Run 43 (the 36 slots filled with about 270 cobblestone and cobbled deepslate: bread could not be made, about 60 s at +2,343 to +2,402, and a go
 * stopped full at +2,427; the pack's line said the free slots only after they were 0): at 3 free slots or fewer, what to drop, before it is full.
 */
function fullSoon(free: number, filler: ReadonlyArray<[string, number]>): string | null {
  if (free > FULL_SOON) return null;
  if (free === 0) {
    // Full now: said as what is so and what it costs, not as what will happen (run 46).
    const spare = dropWords(dropCandidates(filler));
    return spare ? `満杯: ${FULL_COST}。drop で空けられる物: ${spare}（${filler[0]![0]} 1 スタックは柱と橋用に数えていない）`
      : `満杯: ${FULL_COST}。空けるのは drop`;
  }
  const drops = filler.map(([name, n], index) => [name, index === 0 ? Math.max(0, n - KEEP_STACK) : n] as const).filter(([, n]) => n > 0);
  const kinds = drops.slice(0, 4).map(([name, n]) => `${name}×${n}（${Math.ceil(n / 64)} マス）`).join('・');
  const keep = filler.length ? `${filler[0]![0]} 1 スタックは柱と橋に残す` : '';
  return `空きが ${free} マス。満杯になると make・pickup・dig の物が入らず止まる（実走 43 はパンを作れず約 60 秒、go も満杯で止まった）。`
    + (kinds ? `捨てる物の候補: ${kinds}。${keep}。drop で捨てる` : '要らない物を drop で捨てる');
}
/**
 * `body.pack`: the free slots as a line, and the filler that takes them when it takes three slots or more; run 36 and 37 (85–90 s each): with two beds or more
 * the beds are enough (the End asks four, made from wool before it: `forEnd`). Empty when the inventory is not a list.
 */
export function packLines(lines: readonly string[], options: { forEnd?: boolean } = {}): string[] {
  if (!lines.length) return [];
  const { used, filler } = packFacts(lines);
  const free = Math.max(0, PACK_SLOTS - used);
  const out = [free === 0 ? `持ち物 満杯 ${Math.min(used, PACK_SLOTS)}/${PACK_SLOTS}（空き 0 マス）`
    : `持ち物の空き ${free} マス（使用 ${Math.min(used, PACK_SLOTS)}/${PACK_SLOTS}。満杯だと dig・pickup が「満杯」で止まる）`];
  const before = fullSoon(free, filler);
  if (before) out.push(before);
  const total = filler.reduce((sum, [, n]) => sum + n, 0);
  if (Math.ceil(total / 64) >= FILLER_SLOTS) {
    const kinds = filler.slice(0, 4).map(([name, n]) => `${name}×${n}`).join('・');
    out.push(`掘って拾い続けた石や土 ${total} 個（${kinds}）が約 ${Math.ceil(total / 64)} マスを占める。`
      + 'dig は拾いに歩く (collect 既定 true): 階段・トンネルで使わない石や土を掘る dig は collect=false。捨てるなら drop（体は 3m 以上先へ水平に投げる。'
      + 'その近くに立ち続ける・歩くと拾い直す）');
  }
  const beds = bedsIn(lines);
  if (beds >= 2 && !options.forEnd) out.push(`ベッドは足りている（${beds}）。これ以上取りに行かない（エンドの前に羊毛から 4〜6 に増やす）`);
  return out;
}
