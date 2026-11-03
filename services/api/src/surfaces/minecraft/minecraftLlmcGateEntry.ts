import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { readLayers } from './minecraftLlmcPreflightMap.js';

/**
 * The other way into the Nether (the coordinator's list for 11/4, item 1, the hole of 56a6f5b): not the `portal` hand but a `go` or a `walk`
 * whose end is a cell of a lit portal (`p` of the map's legend), which changes the dimension as the portal hand's entering does. The deadly gate
 * (`gateHold`, `minecraftLlmcReadiness.ts`) holds it as it holds the portal hand. Only the cells the map shows as a portal count, and only an
 * end the hand names (a `go`'s `to` or any of its `goals`, a `walk`'s last point); a hand whose end is not given leaves the act as it is.
 */
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
type Cell = { x: number; y: number; z: number };
const cellOf = (value: unknown): Cell | null => {
  const at = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  return at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } : null;
};

/** The cells a hand ends at (the ends the hand itself names). */
function endsOf(hand: Record<string, unknown>): unknown[] {
  if (hand.do === 'go') return [hand.to, ...(Array.isArray(hand.goals) ? hand.goals : [])];
  if (hand.do === 'walk') return [Array.isArray(hand.path) && hand.path.length ? hand.path.at(-1) : hand.to];
  return [];
}

/** The first hand (0-based) of the act that ends in a lit portal cell of the map (`p`: the Nether's; `e`: the End's), or -1. */
export function portalCellHand(input: unknown, frame: BodyObservation | null, symbol: 'p' | 'e' = 'p'): number {
  const hands = (input as { hands?: unknown } | null)?.hands;
  const world = frame?.state.world as { localMap?: unknown; position?: unknown } | undefined;
  const feet = cellOf(world?.position), layers = typeof world?.localMap === 'string' ? readLayers(world.localMap) : null;
  if (!Array.isArray(hands) || !feet || !layers) return -1;
  const portal = (cell: Cell): boolean => [0, 1].some(dy => layers.layers.get(cell.y + dy)?.get(`${cell.x},${cell.z}`) === symbol);
  return hands.findIndex(raw => {
    const hand = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    if (!hand || (hand.do === 'walk' && finite(hand.range) && hand.range >= 1)) return false;
    return endsOf(hand).some(end => {
      const cell = cellOf(end);
      return cell !== null && portal(hand.rel === true ? { x: feet.x + cell.x, y: feet.y + cell.y, z: feet.z + cell.z } : cell);
    });
  });
}
