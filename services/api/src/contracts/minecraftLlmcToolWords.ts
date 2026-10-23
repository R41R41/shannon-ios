/**
 * SHANNON_MINECRAFT_LLMC_V2 (mb-llmc-cand 9, run 37: the request named `minecraft.observe`, `minecraft.reflex`, `find-blocks`, `find-structure` and
 * `view top`, tools its menu does not have, in the task note, the stages' knowledge and a history summary): the tools the mode offers, and what names
 * one it does not. The tools are `mc.act`, `mc.probe`, `mc.view`, `plan.update` (the provider's names: `mc_act` …) and the two controls.
 */
export const V2_TOOL_NAMES: readonly string[] = Object.freeze(['mc.act', 'mc.probe', 'mc.view', 'plan.update', 'fca_wait', 'fca_complete']);

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

/** The lines that name no tool outside the six, and how many did (a summary item that does is dropped whole: the rest of its words are the same guess). */
export function withoutForeignToolLines(items: readonly string[]): { kept: string[]; dropped: number } {
  const kept = items.filter(item => foreignToolNames(item).length === 0);
  return { kept, dropped: items.length - kept.length };
}
