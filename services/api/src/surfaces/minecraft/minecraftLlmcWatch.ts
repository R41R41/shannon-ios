import type { PlanNode, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActInput } from '../../contracts/minecraftActContract.js';
import { doneFacts } from './minecraftConditions.js';
import { workingNode } from './minecraftLlmcNode.js';
import { meterParts, reachedMilestoneNames } from './minecraftLlmcRoad.js';
import type { RanListener } from './minecraftLlmcQueueState.js';
import {
  deathCounterOf,
  externalWorkMilestones,
  noteDeath,
  noteProgress,
  noteRan,
  type Stall,
} from './minecraftLlmcStalls.js';
import { endFightEvidence, explorationEvidence, observedWait, purposeEvidence, travelEvidence, type createWaitLedger } from './minecraftPurposeProgress.js';

/**
 * The head's own look for a task that stands still, for a request that is NOT held on a failure (the held diagnostic run has its own,
 * `minecraftLlmcWiring.ts`, and stays as it is). The same purpose-wise progress as the held run's (`minecraftLlmcStalls.ts`,
 * `minecraftPurposeProgress.ts`): a node's evidence is what its purpose needs, a wait is a night or a furnace with a deadline, a
 * move is a goal the body accepted. A stall found goes to `raise`, which asks for a new plan (`minecraftLlmcReplan.ts`); nothing here
 * stops the body or the task.
 */
export interface WatchDeps {
  taskId: string;
  observe(): BodyObservation | null;
  tree(): PlanTree;
  /** The input the body is running now, or null. */
  running(): ActInput | null;
  /** The task's running clock in ms (the wall clock less the time it was held). */
  activeClock(): number;
  waits: ReturnType<typeof createWaitLedger>;
  /** The wait the task's checkpoint held (`minecraftActiveWait`). */
  savedWait?: { node: string; until: number };
  raise(stall: Stall): void;
  log(line: string): void;
}

/** The node and the nodes above it (three at most): what a child works for is what its parent asks for. */
function chainOf(tree: PlanTree, node: PlanNode | undefined): PlanNode[] {
  const out: PlanNode[] = [];
  for (let at = node; at && out.length < 3; at = tree.nodes.find(item => item.id === at!.parentId)) out.push(at);
  return out;
}

export function createStallWatch(deps: WatchDeps) {
  let activeWait = deps.savedWait;
  let waitUntil: number | undefined;
  const refreshWait = (current: string | null, frame: BodyObservation | null, running: ActInput | null): void => {
    deps.waits.observeDay(frame);
    if (running?.hands.length && running.hands.every(hand => hand.do === 'wait')) {
      const until = deps.waits.until(current ?? '', observedWait(running.done, frame), deps.activeClock());
      if (current && until !== undefined) activeWait = { node: current, until };
    } else if (running) {
      activeWait = undefined;
    }
    waitUntil = activeWait?.node === current ? activeWait.until : undefined;
  };
  const look = (): boolean => {
    try {
      const frame = deps.observe();
      const tree = deps.tree();
      const current = workingNode(deps.taskId, tree.current) ?? tree.current;
      const node = tree.nodes.find(item => item.id === current);
      const counts = doneFacts(frame)?.counts;
      const running = deps.running();
      refreshWait(current, frame, running);
      // A child's progress is its parent's too: the rods of 「ブレイズロッド7」 count for the waiting at the spawner under it.
      const purpose = { ...Object.assign({}, ...chainOf(tree, node).map(item => purposeEvidence(item, frame))), ...travelEvidence(running, frame),
        ...explorationEvidence(node, running, frame), ...endFightEvidence(frame) };
      const progress = { node: current, state: node?.state ?? null, milestone: meterParts(tree, frame, 0)?.next ?? null,
        reached: reachedMilestoneNames(tree, frame) ?? [],
        externalWork: externalWorkMilestones(frame),
        purpose,
        waitUntil, inventory: counts ? Object.fromEntries(counts) : {}, items: counts ? [...counts.values()].reduce((sum, count) => sum + count, 0) : 0 };
      const stall = noteDeath(deps.taskId, deathCounterOf(frame)) ?? noteProgress(deps.taskId, progress, deps.activeClock());
      if (stall) deps.raise(stall);
      return stall !== null;
    } catch (error) {
      deps.log(`Shannon Minecraft stall look failed task=${deps.taskId} ${String(error)}`);
      return false;
    }
  };
  const noteQueueResult: RanListener = (item, _result, receipt) => {
    try {
      const input = item.call.input as { hands?: unknown; done?: unknown } | null;
      const tree = deps.tree();
      const current = workingNode(deps.taskId, tree.current) ?? tree.current;
      const hands = Array.isArray(input?.hands) ? input.hands : [];
      const waiting = hands.length > 0 && hands.every(hand => hand?.do === 'wait');
      waitUntil = waiting ? deps.waits.until(current ?? '', observedWait(input?.done, deps.observe()), deps.activeClock()) : undefined;
      activeWait = current && waitUntil !== undefined ? { node: current, until: waitUntil } : undefined;
      const command = receipt?.id ? { command: receipt.id } : {};
      const stall = noteRan(deps.taskId, { hands, result: receipt?.result, waitUntil, activeMs: deps.activeClock(), ...command });
      if (stall) deps.raise(stall);
      else look();
    } catch (error) {
      deps.log(`Shannon Minecraft stall ran failed task=${deps.taskId} ${String(error)}`);
    }
  };
  return { look, noteQueueResult, activeWait: (): { node: string; until: number } | undefined => activeWait };
}
