import type { ActHandLine } from '../../contracts/minecraftActContract.js';

/**
 * The work the stall look must not call a stall (the coordinator's list for 11/4, item 1, run59: the node stood "without progress" while the
 * body was killing blazes, killing endermen, building the gate, lighting it and putting eyes in the frame; none of these shows in the pack):
 * a hand of one of these kinds that ended `done` in an act's result is progress, and the node's window starts again from it.
 * The furnace's wait and the night's wait have their own deadline (`observedWait`), not an event.
 */
export type ProgressEvent = 'kill' | 'frame' | 'ignition' | 'eye';

/** The mobs whose death is the aim of a node (a blaze for the rods, an enderman for the pearls). */
const KILLS = /(?:^|:)(?:blaze|enderman)$|^#\d+$/u;

export type ProgressHand = { do?: unknown; target?: unknown; item?: unknown; at?: unknown } | null | undefined;

/** The event one result line is, with the hand it belongs to (the lines count from 1 in the order the hands were sent), or null. */
function eventOf(hand: ProgressHand, line: ActHandLine): ProgressEvent | null {
  if (line.end === 'not_run' || line.end === 'unknown' || line.goal !== 'done') return null;
  const target = typeof hand?.target === 'string' ? hand.target : '';
  if (line.do === 'fight' && line.code === 'target_killed') return KILLS.test(target) || /blaze|enderman/u.test(line.line) ? 'kill' : null;
  if (line.do === 'attack' && line.status === 'done') return KILLS.test(target) || /blaze|enderman/u.test(line.line) ? 'kill' : null;
  if (line.do === 'obsidian') return 'frame';
  if (line.do === 'portal') return 'ignition';
  return line.do === 'use' && hand?.item === 'ender_eye' && hand.at !== undefined ? 'eye' : null;
}

/**
 * The events of an act's lines. A hand that did not run, or did not end done, earns nothing; a fight or an attack counts when the body saw the
 * opponent die (`target_killed`) or, for an attack, when it ran until the opponent was dead and ended done.
 */
export function progressEvents(hands: ReadonlyArray<ProgressHand>, lines: readonly ActHandLine[]): ProgressEvent[] {
  return lines.flatMap(line => eventOf(hands[line.i - 1], line) ?? []);
}
