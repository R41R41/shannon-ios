import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import { itemWords } from './minecraftLlmcReachWords.js';

/**
 * 11/24 (the night of 11/23: 「倒した（N回振って…）」 said nothing of what the kill left, and `eat` of the flesh that fell failed four times with 「持っていない」): the
 * result of an attack that killed names the dropped items lying within `DROPS_METERS` of her, as a fact. Nothing is picked up by the head or the body for it:
 * whether to pick the drop up is the decision's (the line names `pickup`).
 */
export const DROPS_METERS = 8;
const DROPS_SHOWN = 4;
const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The line of the near drops from the newest frame, or null when none lies near. */
export function dropsLine(frame: BodyObservation | null): string | null {
  const entities = rec(frame?.state.world)?.nearbyEntities;
  const drops = (Array.isArray(entities) ? entities : []).flatMap(raw => {
    const entity = rec(raw), distance = entity && typeof entity.distance === 'number' ? entity.distance : null;
    if (!entity || entity.name !== 'item' || entity.droppedByMe === true || distance === null || distance > DROPS_METERS) return [];
    return [{ distance, text: `${itemWords(entity) || 'item'}${entity.id !== undefined ? ` #${String(entity.id)}` : ''} ${distance.toFixed(1)}m` }];
  }).sort((a, b) => a.distance - b.distance).slice(0, DROPS_SHOWN);
  return drops.length ? `落とし物（近く）: ${drops.map(drop => drop.text).join('・')}（拾うなら pickup。自動では拾わない）` : null;
}

/** A result that says it killed (「倒した（」) with the near drops added. */
export function withDrops(result: ToolResult, frame: BodyObservation | null): ToolResult {
  if (!result.text.includes('倒した（')) return result;
  const line = dropsLine(frame);
  return line ? { ...result, text: `${result.text}\n${line}` } : result;
}
