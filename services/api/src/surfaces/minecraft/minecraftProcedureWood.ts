import type { ProcedureMemory } from '@shannon/mind';
import type { MinecraftWorkItem } from './minecraftFillers.js';
import { block, cellKey, type Cell, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { ANY_LOG_NAMES, LOGS, doing, stuck, type McMove } from './minecraftProcedureMoves.js';
import type { MapVisits } from './minecraftProcedureMap.js';
import { treeEntries } from './minecraftMapRead.js';
import { CARDINALS, WOOD_WALK, biomesOf, woodAdvice, type Cardinal } from './minecraftWoodAdvice.js';

/**
 * When there is no log in reach (mb-r24, Minecraft run 24, first world: 128 m of desert and sea; `mine-block` for logs failed in 0 s twice
 * and the decisions went to look for a village for 419 s, with a shipwreck 149 m away that is made of oak): the wood is looked for in the
 * order the places promise it. (1) A tree the body's map lists. (2) A structure made of wood (a shipwreck, a mineshaft, a village's
 * houses), once a task. (3) The way trees grow, by `explore-for-structure` for a tree, a heading at a time, each stopping at the first
 * log it reads (the body lists `tree` among its targets since mb-r24). (4) The planner, with the reasons.
 */
const DIG: MinecraftWorkItem = { tool: 'mc.mine-block', input: { blockName: ANY_LOG_NAMES, count: 6, searchRadius: 48 }, why: '着いた所の原木を掘る',
  expectMs: 48_000, key: 'wood:dig' };
/** How far one search for a tree goes (blocks). */
const EXPLORE_REACH = 160;
const CARDINAL_OF: Readonly<Record<string, Cardinal>> = { '北': 'north', '南': 'south', '東': 'east', '西': 'west' };
const SEA = /ocean|river|beach/u;

/** Whether a move is a dig for logs. */
const logDig = (move: McMove) => move.kind === 'do' && move.item.tool === 'mc.mine-block'
  && String((move.item.input as { blockName?: unknown }).blockName ?? '').split(',').every(name => LOGS.test(name.trim()));

/** The headings to search: the way trees grow first, a sea or a river to one side last. */
function headings(facts: MinecraftProcedureFacts): Cardinal[] {
  const grows = woodAdvice({ mapSummary: facts.map, biomesSeen: facts.biomes }).grows?.heading ?? null;
  const sea = biomesOf(facts.biomes).filter(item => SEA.test(item.name) && item.direction).map(item => CARDINAL_OF[item.direction![0]!]).filter(Boolean);
  const rest = CARDINALS.filter(heading => heading !== grows).sort((a, b) => Number(sea.includes(a)) - Number(sea.includes(b)));
  return grows ? [grows, ...rest] : rest;
}

/** The next place to look for wood, or the planner with the reasons. */
export function woodSearch(facts: MinecraftProcedureFacts, memory: ProcedureMemory, visits: MapVisits): McMove {
  const fresh = (cell: Cell) => !visits.visited.has(`wood:${cellKey(block(cell))}`) && memory.failed(`wood:walk:${cellKey(block(cell))}`) === 0;
  const sources = [...treeEntries(facts.map).map(item => ({ ...item, name: '木' })), ...woodAdvice({ mapSummary: facts.map, biomesSeen: facts.biomes }).sources]
    .filter(item => item.distance <= WOOD_WALK && fresh(item.at));
  const source = sources[0];
  if (source) {
    const at = block(source.at);
    return doing({ tool: 'mc.move-to', input: { ...at, goalType: 'near', range: 8 }, why: `木材の出どころ（${source.name} ${source.distance}m）へ行く`,
      expectMs: 90_000, resumable: true, key: `wood:walk:${cellKey(at)}`, then: () => {
        visits.visited.add(`wood:${cellKey(at)}`);
        return DIG;
      } });
  }
  // An older body does not know the target `tree` (invalid_input): the headings are not tried.
  const unsupported = CARDINALS.some(heading => memory.lastFailure(`wood:explore:${heading}`) === 'invalid_input');
  const searched = (item: Cardinal) => memory.failed(`wood:explore:${item}`) + memory.succeeded(`wood:explore:${item}`) > 0;
  const heading = unsupported ? undefined : headings(facts).find(item => !searched(item));
  if (heading) {
    const input = { structureType: 'tree', direction: heading, maxDistance: EXPLORE_REACH };
    return doing({ tool: 'mc.explore-for-structure', input, why: `木を探して${heading}へ進む`, expectMs: 120_000, key: `wood:explore:${heading}`, then: () => DIG });
  }
  return stuck('128m 以内に原木が無く、木の出どころの構造物も地図に無い。木の生えるバイオームの方角を決めるか、別の場所からやり直す');
}

/**
 * A step's move, but the wood search in place of a dig for logs that found none (`target_not_found`): the logs the body cannot see in
 * 48 m are looked for by the places above, not dug for again.
 */
export function wooded(planned: McMove, facts: MinecraftProcedureFacts, memory: ProcedureMemory, visits: MapVisits): McMove {
  return planned.kind === 'do' && logDig(planned) && memory.lastFailure(planned.key) === 'target_not_found' ? woodSearch(facts, memory, visits) : planned;
}
