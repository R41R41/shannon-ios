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

/**
 * Her latest death was in the Nether and the body still says its drops can be picked up (`world.lastDeath`: 「N分前 the_nether (x,y,z) … →拾いに戻れる」;
 * the body ages them only while she is within 160 m in that dimension, so they wait while she is in the overworld). The review of 11/10 (G01):
 * both entry gates (`gateHold` and the golden piece's) held her bare at her own portal until the whole kit was made again, while the knowledge
 * leaves fetching or remaking to the decision. A death in lava is left out (what falls into lava burns: nothing to fetch), and a death that
 * dropped nothing (the body says so in place of 「拾いに戻れる」), so a return that died bare does not open the gates again.
 */
export function fetchingNetherDrops(world: Record<string, unknown>): boolean {
  const said = typeof world.lastDeath === 'string' ? world.lastDeath : '';
  if (!/^\d+\s*分前 (?:minecraft:)?the_nether /u.test(said) || !said.includes('拾いに戻れる')) return false;
  const last = (Array.isArray(world.deaths) ? world.deaths : []).at(-1) as { cause?: unknown } | null | undefined;
  return !/lava|溶岩/iu.test(`${/「([^」]*)」/u.exec(said)?.[1] ?? ''} ${typeof last?.cause === 'string' ? last.cause : ''}`);
}
/** Said after the last death's line in the overworld while `fetchingNetherDrops` holds: the gates' own lines are not there to say what entering bare costs. */
export const FETCH_ENTRY_WORDS = '落とし物が残る間は、取りに戻れるように、ネザーへ入る手は準備の必須・金の防具が欠けていても止まらない'
  + '（金の防具なしではピグリンが襲う。取りに戻るか作り直すかは比べて決める）';
