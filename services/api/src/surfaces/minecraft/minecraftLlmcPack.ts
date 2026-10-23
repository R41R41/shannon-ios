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
/**
 * `body.pack`: the free slots as a line, and the filler that takes them when it takes three slots or more; run 36 and 37 (85–90 s each): with two beds or more
 * the beds are enough (the End asks four, made from wool before it: `forEnd`). Empty when the inventory is not a list.
 */
export function packLines(lines: readonly string[], options: { forEnd?: boolean } = {}): string[] {
  if (!lines.length) return [];
  const { used, filler } = packFacts(lines);
  const free = Math.max(0, PACK_SLOTS - used);
  const out = [`持ち物の空き ${free} マス（使用 ${Math.min(used, PACK_SLOTS)}/${PACK_SLOTS}。満杯だと dig・pickup が「満杯」で止まる）`];
  const total = filler.reduce((sum, [, n]) => sum + n, 0);
  if (Math.ceil(total / 64) >= FILLER_SLOTS) {
    const kinds = filler.slice(0, 4).map(([name, n]) => `${name}×${n}`).join('・');
    out.push(`掘って拾い続けた石や土 ${total} 個（${kinds}）が約 ${Math.ceil(total / 64)} マスを占める。`
      + 'dig は拾いに歩く (collect 既定 true)。使わない掘りは collect=false');
  }
  const beds = bedsIn(lines);
  if (beds >= 2 && !options.forEnd) out.push(`ベッドは足りている（${beds}）。これ以上取りに行かない（エンドの前に羊毛から 4〜6 に増やす）`);
  return out;
}
