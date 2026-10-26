/**
 * mb-llmc v2 (mb-llmc-cand 9, run 37: the request named `minecraft.observe`, `minecraft.reflex`, `find-blocks`, `find-structure` and
 * `view top`, tools its menu does not have, in the task note, the stages' knowledge and a history summary): the tools the mode offers, and what names
 * one it does not. The tools are `mc.act`, `mc.probe`, `mc.view`, `plan.update` (the provider's names: `mc_act` …) and the two controls.
 */
export const V2_TOOL_NAMES: readonly string[] = Object.freeze(['mc.act', 'mc.probe', 'mc.view', 'plan.update', 'fca_complete']);

/** Words that name a tool other than the six: the old body tools (`mc.mine-block`, `mc.find-*`), `minecraft.*`, the finders, the catalog's and the memory's. */
const FOREIGN = new RegExp([
  String.raw`minecraft\.[a-z][\w-]*`,
  String.raw`\bmc\.(?!(?:act|probe|view)(?![\w-]))[a-z][\w-]*`,
  String.raw`\bmc_(?!(?:act|probe|view)(?![\w-]))[a-z][\w-]*`,
  String.raw`\bfind-[a-z][\w-]*`,
  String.raw`\bview top\b`,
  String.raw`\bobserve(?![a-z])`,
  String.raw`\b(?:tool_open|fca_context|memory\.search|memory_search|skill\.read|goal\.[a-z]+|task\.[a-z]+)\b`,
].join('|'), 'giu');

/** The names in a text that are not of the six tools (each once, in the order they come); empty when it names none. */
export function foreignToolNames(text: string): string[] {
  return [...new Set([...text.matchAll(FOREIGN)].map(match => match[0]))];
}

/**
 * The narrow list for a history summary's items (an item of a summary is the model's own sentence: only a real tool name is touched): the tools of the
 * old body (`mc.find-blocks`, `mc.move-to`, hyphenated; never `mc.acting`), `minecraft.observe` and `minecraft.reflex` (never `Minecraft.net`), the
 * finders, `observe` as a call, and the task and goal tools by their names.
 */
const SCRUB_NAMES = new RegExp([
  String.raw`\bminecraft\.(?:observe|reflex)\b`,
  String.raw`\bmc\.(?!(?:act|probe|view)\b)[a-z]+(?:-[a-z]+)+\b`,
  String.raw`\bmc_(?!(?:act|probe|view)\b)[a-z]+(?:_[a-z]+)+\b`,
  String.raw`\bfind-(?:blocks?|structures?|biomes?|entit(?:y|ies))\b`,
  String.raw`\bobserve(?:\(\))?(?=\s*(?:で|を|に|から|ツール|tool|\())`,
  String.raw`\b(?:tool_open|fca_context|memory\.search|memory_search|skill\.read)\b`,
  String.raw`\btask\.(?:replan|send|get|list|create|update|cancel|spawn|wait|status)\b`,
  String.raw`\bgoal\.(?:set_conditions|verify|set|get)\b`,
].join('|'), 'gu');

/** The neutral words put where a tool name the mode does not offer stood. */
export const SCRUBBED_NAME = '（道具名略）';

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/**
 * An item that tells to use the tool, in an explicit form (「…で確認」「…で調べ」「…を使う」「…を呼ぶ」「use …」, or a line that starts with 次 or → and
 * names the tool as what to use): there is nothing left of it without the tool. A fact (「find-blocks で (10,64,3) に鉄があった」) is not one.
 */
function instructs(item: string, names: readonly string[]): boolean {
  const next = /^\s*(?:次|→|next)\s*[:：]?/iu.test(item);
  return names.some(name => {
    const tool = escaped(name);
    if (new RegExp(`${tool}\\s*(?:で\\s*(?:確認|調べ|探)|を\\s*(?:使|呼|実行)|に聞|から読|ツール)|\\b(?:use|call|run)\\s+${tool}`, 'iu').test(item)) return true;
    return next && new RegExp(`${tool}\\s*(?:で|を|に|から|して)`, 'u').test(item);
  });
}

/**
 * The summary items made fit for the mode: an item that names no tool outside the six stays as it is; one that only mentions such a name (a
 * fact: 「find-blocks が (1,2,3) を指した」) keeps its words with the name replaced by `SCRUBBED_NAME`; one that tells to use it is dropped.
 */
export function scrubForeignToolItems(items: readonly string[]): { kept: string[]; neutralized: number; dropped: number } {
  const kept: string[] = [];
  let neutralized = 0, dropped = 0;
  for (const item of items) {
    const names = [...new Set([...item.matchAll(SCRUB_NAMES)].map(match => match[0]))];
    if (!names.length) kept.push(item);
    else if (instructs(item, names)) dropped += 1;
    else {
      kept.push(item.replace(SCRUB_NAMES, SCRUBBED_NAME));
      neutralized += 1;
    }
  }
  return { kept, neutralized, dropped };
}
