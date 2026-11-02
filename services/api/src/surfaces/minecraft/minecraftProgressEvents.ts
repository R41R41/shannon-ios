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

type Hand = { do?: unknown; target?: unknown; item?: unknown; at?: unknown } | null | undefined;

/** The hand a result line belongs to: the lines count from 1 in the order the hands were sent. */
const handOf = (hands: ReadonlyArray<Hand>, line: ActHandLine): Hand => hands[line.i - 1];

/**
 * The events of an act's lines. A hand that did not run, or did not end done, earns nothing; a fight or an attack counts when the body saw the
 * opponent die (`target_killed`) or, for an attack, when it ran until the opponent was dead and ended done.
 */
export function progressEvents(hands: ReadonlyArray<Hand>, lines: readonly ActHandLine[]): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  for (const line of lines) {
    if (line.end === 'not_run' || line.end === 'unknown' || line.goal !== 'done') continue;
    const hand = handOf(hands, line);
    const target = typeof hand?.target === 'string' ? hand.target : '';
    if ((line.do === 'fight' && line.code === 'target_killed') || (line.do === 'attack' && line.status === 'done')) {
      if (KILLS.test(target) || /blaze|enderman/u.test(line.line)) events.push('kill');
    } else if (line.do === 'obsidian') events.push('frame');
    else if (line.do === 'portal') events.push('ignition');
    else if (line.do === 'use' && hand?.item === 'ender_eye' && hand.at !== undefined) events.push('eye');
  }
  return events;
}
