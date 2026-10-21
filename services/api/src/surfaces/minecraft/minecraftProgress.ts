import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { FcaExternalTools } from '../../mind/action/fca/fcaPorts.js';
import type { ToolResult } from '../../mind/tools/shannonTools.js';
import { carriedItemCounts } from './minecraftItems.js';
import { milestonesShown } from './minecraftMilestoneLog.js';

/**
 * A failed call of the body that still made something is not a failed step (mb-r23, Minecraft run 23: `use-item-on-block` made six and
 * then three obsidian and was told failed because it did not make ten; `run-procedure` reached the diamond pickaxe and was told failed
 * because its last move failed twice; five such "failures" stopped the task with 9 of 10 obsidian). The body returns only `completed`
 * or `failed` (`MinecraftControlReceipt.outcome`), so the head reads the progress itself, from the frame before the call and the frame
 * after it: something carried that she did not carry (not the rock and the mob drops she throws away), a milestone newly shown, or a
 * move of `MOVED_BLOCKS` or more. The result keeps its text and its `ok: false`; only the failure count of the run (`fcaFailureLadder.ts`)
 * sees `progressed`.
 */
export const MOVED_BLOCKS = 16;
/** Rock, soil and the drops of a fight: carried more of them is no progress (they are what the pack is cleared of). */
const WASTE = new RegExp('^(?:cobblestone|cobbled_deepslate|blackstone|stone|deepslate|dirt|coarse_dirt|rooted_dirt|grass_block|gravel|sand|red_sand|'
  + 'sandstone|andesite|diorite|granite|tuff|calcite|netherrack|clay|mud|dripstone_block|pointed_dripstone|smooth_basalt|basalt|snowball|'
  + 'rotten_flesh|bone|string|spider_eye|gunpowder|arrow|stick|seeds|wheat_seeds)$', 'u');

type Place = { x: number; y: number; z: number };
export interface ProgressMark { counts: ReadonlyMap<string, number>; shown: ReadonlySet<string>; at: Place | null; sequence: number | null }

export function progressMark(observation: BodyObservation | null): ProgressMark | null {
  if (!observation) return null;
  const world = (observation.state.world && typeof observation.state.world === 'object' ? observation.state.world : {}) as Record<string, unknown>;
  const counts = carriedItemCounts(world, observation.facts);
  const dimension = typeof world.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : null;
  const position = world.position && typeof world.position === 'object' ? world.position as Record<string, unknown> : null;
  const at = position && [position.x, position.y, position.z].every(value => typeof value === 'number' && Number.isFinite(value))
    ? { x: position.x as number, y: position.y as number, z: position.z as number } : null;
  return { counts, shown: new Set(milestonesShown(counts, dimension)), at, sequence: typeof observation.sequence === 'number' ? observation.sequence : null };
}

/** What the call made, in a few words, or null when nothing moved: items carried that were not, a milestone, a move. */
export function madeProgress(before: ProgressMark | null, after: ProgressMark | null): string | null {
  if (!before || !after) return null;
  const gained = [...after.counts].flatMap(([name, count]) => {
    const more = count - (before.counts.get(name) ?? 0);
    return more > 0 && !WASTE.test(name) ? [`${name}+${more}`] : [];
  });
  const milestones = [...after.shown].filter(name => !before.shown.has(name));
  if (gained.length || milestones.length) return [...gained.slice(0, 4), ...milestones.map(name => `節目 ${name}`)].join('、');
  if (before.at && after.at && Math.hypot(after.at.x - before.at.x, after.at.y - before.at.y, after.at.z - before.at.z) >= MOVED_BLOCKS) {
    return `${Math.round(Math.hypot(after.at.x - before.at.x, after.at.y - before.at.y, after.at.z - before.at.z))}m 動いた`;
  }
  return null;
}

/** How long a failed call waits for a frame the body sent after it (its beat), before the pack is read. */
const FRESH_FRAME_MS = 800;

/** The result with a line of what it made before its retry hint (which stays the text's last part). */
function told(result: ToolResult, why: string): ToolResult {
  const line = `進み（失敗には数えない）: ${why}`;
  const at = result.text.lastIndexOf('［再試行の目安');
  const text = at < 0 ? `${result.text}\n${line}` : `${result.text.slice(0, at)}\n${line}\n${result.text.slice(at)}`;
  return { ...result, text, progressed: true };
}

/**
 * The body's tools with the progress of a failed call read after it. Outermost of the executor's wrappers, so a procedure's whole run
 * is one call here. A read, a call that worked and a call the body's own reflex cut off pass as they are.
 */
export function withMinecraftProgress(tools: FcaExternalTools,
  parts: { observe(): BodyObservation | null; sleep?(milliseconds: number): Promise<void> }): FcaExternalTools {
  const sleep = parts.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const writes = (name: string) => name.startsWith('mc.') && tools.definitions.find(definition => definition.name === name)?.effect === 'write';
  return { ...tools, async execute(call) {
    if (!writes(call.name)) return tools.execute(call);
    const before = progressMark(parts.observe());
    const result = await tools.execute(call);
    if (result.ok || result.bodyReflex || !before) return result;
    // A frame sent after the call ended: the pack the next move would read, not one a beat behind.
    const ended = parts.observe()?.sequence ?? null, until = Date.now() + FRESH_FRAME_MS;
    while (ended !== null && (parts.observe()?.sequence ?? ended) <= ended && Date.now() < until) await sleep(50);
    const why = madeProgress(before, progressMark(parts.observe()));
    return why ? told(result, why) : result;
  } };
}
