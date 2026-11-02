import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { doneFacts } from './minecraftConditions.js';
import { recipeOf } from './minecraftLlmcRecipes.js';

/**
 * The crafting table's place and reach (the coordinator's list for 11/4, item 4: the third of the top failures, `no_table` 6): a `make` or a
 * `craft` of something that is made on a table, sent while the body's scan of the utilities shows no table within the reach of the hand (4.5 m), is
 * said beside the act as a fact (the act goes as it is; the body's own stop says the same after the hand has run). Said once an act, for the
 * first such hand, and only when every hand before it leaves her where she is (no move, no place of a table): then the scan is of the place the
 * hand is run in.
 */
export const TABLE_REACH_METERS = 4.5;
/** Made without a table (the 2×2 grid of the inventory). */
const NO_TABLE = /^(?:planks|stick|crafting_table|torch|blaze_powder|ender_eye|[a-z_]+_planks|bamboo_planks)$/u;
const MOVES = new Set(['go', 'walk', 'vertical', 'pillarUp', 'jump', 'portal', 'fight', 'attack', 'pickup', 'dig', 'mine']);
const objectOf = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' ? value as Record<string, unknown> : null;

/** Whether a hand makes something that needs a table. */
function needsTable(hand: Record<string, unknown>): boolean {
  if (hand.do !== 'make' && hand.do !== 'craft') return false;
  const item = typeof hand.item === 'string' ? hand.item.replace(/^minecraft:/u, '') : '';
  return item !== '' && !NO_TABLE.test(item) && recipeOf(item) !== null;
}

/** The note for the first hand that needs a table when none is within reach, or null. */
export function tableNote(input: unknown, frame: BodyObservation | null): string | null {
  const hands = objectOf(input)?.hands;
  const scan = doneFacts(frame)?.utilities;
  if (!Array.isArray(hands) || !scan?.scanned) return null;
  for (const [index, raw] of hands.entries()) {
    const hand = objectOf(raw);
    if (!hand) return null;
    if (needsTable(hand)) {
      const nearest = scan.found.filter(item => item.block === 'crafting_table').map(item => item.distance).sort((a, b) => a - b)[0];
      if (nearest !== undefined && nearest <= TABLE_REACH_METERS) return null;
      const where = nearest === undefined ? `半径 ${scan.radius} m 内に作業台が見えない` : `一番近い作業台は ${Math.round(nearest * 10) / 10} m 先`;
      return `手 ${index + 1} ${String(hand.do)} ${String(hand.item)}: ${where}（作る手が届くのは ${TABLE_REACH_METERS} m 以内）。`
        + '先に go で作業台へ寄るか、持ち物の板 4 で作業台を place してから作る';
    }
    if (MOVES.has(String(hand.do)) || (hand.do === 'place' && hand.block === 'crafting_table')) return null;
  }
  return null;
}
