import { applyPlanUpdate, type PlanKind, type PlanTree, type PlanUpdate } from '@shannon/mind';
import type { BodyObservation } from '../contracts/bodyControlContract.js';
import type { FcaBodyLifecycle } from '../mind/action/fca/fcaPorts.js';
import { failureStops, unattendedFailureStops } from '../mind/action/fca/fcaFailureLadder.js';
import type { FcaStepPorts } from '../mind/action/fca/fcaStepPorts.js';
import { readinessParts, type LlmcBodyParts } from '../surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { strongStageNow } from './minecraftLlmcConfiguration.js';
import { stageTextsForKind } from '../surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { doneFacts, doneStatusWords, parseDoneWhen, predicateHolds } from '../surfaces/minecraft/minecraftPlanDone.js';
import { kindOf } from '../surfaces/minecraft/minecraftPlanFacts.js';
import { isDragonPlan } from '../surfaces/minecraft/minecraftLlmcRoad.js';
import { boundTo } from '../surfaces/minecraft/minecraftLlmcReplan.js';
import { nowLines } from '../surfaces/minecraft/minecraftLlmcReplanBrief.js';
import { createReplanFlow, type ReplanFlow, type Replanner, type ReplanSources } from '../surfaces/minecraft/minecraftLlmcReplanFlow.js';
import type { LlmcQueue } from '../surfaces/minecraft/minecraftLlmcQueueState.js';
import { workingNode } from '../surfaces/minecraft/minecraftLlmcNode.js';
import type { Stall } from '../surfaces/minecraft/minecraftLlmcStalls.js';
import { stallVitals } from '../surfaces/minecraft/minecraftLlmcStallRecord.js';
import { createStallWatch } from '../surfaces/minecraft/minecraftLlmcWatch.js';
import type { createWaitLedger } from '../surfaces/minecraft/minecraftPurposeProgress.js';

/**
 * A request that is not held on a failure still has its stalls looked for, and a stall asks for a new plan (`minecraftLlmcReplan.ts`)
 * instead of waiting for a person. This puts the look (`minecraftLlmcWatch.ts`) and the flow together for one task's step, from the
 * parts `llmcStepParts` already has. The held diagnostic run does not use it.
 */
export interface UnheldParts {
  /** The task is held on a failure: the held run's own look is used and this is not made. */
  held: boolean;
  taskId: string;
  goal: string;
  createdAt: string;
  checkpoint: unknown;
  replanner: Replanner | undefined;
  observe(): BodyObservation | null;
  plan: { tree(): PlanTree; view(): object | null };
  bodyParts: LlmcBodyParts;
  queue: LlmcQueue;
  waits: ReturnType<typeof createWaitLedger>;
  activeClock(): number;
  heldMs(): number;
  validate(before: PlanTree, after: PlanTree): string | null;
  log(line: string): void;
  /** Puts keys into the task's checkpoint at once (the step holding the task only): the count of the asks for a new plan is kept before one is sent. */
  persist?(keys: Record<string, unknown>): boolean;
}

const strings = (value: unknown, limit: number): string[] =>
  (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === 'string').slice(0, limit);

/**
 * A node given as done though its own condition (an observation) does not hold now: the strong model does not close what the frame does not
 * show. With no frame to read, a node with such a condition is not closed either (nothing shows it done).
 */
export function doneClaimProblem(before: PlanTree, after: PlanTree, observation: BodyObservation | null): string | null {
  const facts = doneFacts(observation);
  for (const node of after.nodes) {
    const old = before.nodes.find(item => item.id === node.id);
    const predicate = parseDoneWhen(node.doneWhen);
    if (node.state !== 'done' || old?.state === 'done' || !predicate) continue;
    if (!facts) return `${node.id}: 体の観測が取れていないので、観測の条件（${node.doneWhen}）を持つ節は済みにできない`;
    if (!predicateHolds(predicate, facts)) {
      return `${node.id}: 済む条件（${node.doneWhen}）は今の観測で満たされていない。観測の条件を持つ節は、観測が満たした時にコードが済みにする`;
    }
  }
  return null;
}

function sourcesOf(parts: UnheldParts, results: readonly string[], stall: Stall): ReplanSources | null {
  const tree = parts.plan.tree();
  const frame = parts.observe();
  if (!tree.nodes.length) return null;
  const node = stall.kind === 'node_stalled' ? stall.key : workingNode(parts.taskId, tree.current) ?? tree.current;
  const stalled = tree.nodes.find(item => item.id === node);
  const facts = doneFacts(frame);
  const readiness = readinessParts(parts.bodyParts, parts.plan.view(), frame, parts.taskId);
  const endgame = parts.bodyParts.endgame?.lines(frame, isDragonPlan(tree)).lines ?? [];
  const stops = strings((frame?.state.world as { recentStops?: unknown } | undefined)?.recentStops, 5).map(line => `最近の止まり: ${line}`);
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(parts.createdAt) - parts.heldMs()) / 1000));
  const doneStatus = stalled ? doneStatusWords(stalled.doneWhen, facts, stalled.target) : null;
  return { node: stalled ? stalled.id : null, goal: parts.goal, seconds, tree, doneStatus,
    now: nowLines(frame), facts: [...(readiness.shortage ? [`足りない物: ${readiness.shortage}`] : []), ...(readiness.recovery ?? []), ...endgame, ...stops],
    results: [...results], queue: parts.queue.lines(frame),
    knowledge: stageTextsForKind(stalled ? kindOf(stalled) : 'other', facts?.dimension ?? 'overworld') };
}

/** The problem a plan made from another (a new plan of the strong model) would have, by the plan's own checks and the observation's. */
export const adoptProblem = (parts: Pick<UnheldParts, 'validate' | 'observe'>, before: PlanTree, after: PlanTree): string | null =>
  parts.validate(before, after) ?? doneClaimProblem(before, after, parts.observe());

export interface Unheld {
  watch: ReturnType<typeof createStallWatch>;
  flow: ReplanFlow;
  /** The plan's current node now (what a decision's start reads to tell that the body got out of a stalled node). */
  current(): string | null;
  /** The strong model's stage of the plan now (`end`, `dragon`), or null. */
  stage(): PlanKind | null;
  /** R3-1 (3): the step is to close (a stall, a stronger stage): the reserve is taken off and the step ends when its decided items have run. */
  close(reason: string): void;
  checkpoint(): Record<string, unknown>;
}

/** The look and the flow of one task's step, wired to its queue (the look's `raise` is the flow's `note`). Null for a task held on a failure. */
export function unheldReplan(parts: UnheldParts): Unheld | null {
  if (parts.held) return null;
  const results: string[] = [];
  parts.queue.onRan((_item, result) => {
    results.push(result.text.replace(/\s+/gu, ' ').slice(0, 320));
    if (results.length > 4) results.shift();
  });
  const saved = parts.checkpoint as { minecraftReplans?: unknown; minecraftReplanPending?: unknown;
    minecraftActiveWait?: { node: string; until: number } } | null;
  const flow = createReplanFlow({ taskId: parts.taskId, saved: saved?.minecraftReplans, savedPending: saved?.minecraftReplanPending, replanner: parts.replanner,
    clock: parts.activeClock, log: parts.log, vitals: () => stallVitals(parts.observe()), sources: stall => sourcesOf(parts, results, stall),
    bind: update => boundTo(parts.plan.tree(), update),
    ...(parts.persist ? { persist: parts.persist } : {}),
    check: (update: PlanUpdate) => {
      const before = parts.plan.tree();
      const made = applyPlanUpdate(before, update, { at: new Date().toISOString() });
      if (made.problem) return made.problem;
      return made.changed ? adoptProblem(parts, before, made.tree) : '変化なし';
    } });
  const watch = createStallWatch({ taskId: parts.taskId, observe: parts.observe, tree: parts.plan.tree, running: () => parts.queue.runningInput?.() ?? null,
    activeClock: parts.activeClock, waits: parts.waits, ...(saved?.minecraftActiveWait ? { savedWait: saved.minecraftActiveWait } : {}),
    raise: stall => { flow.note(stall);
      parts.queue.closeStep?.('stall'); }, log: parts.log });
  parts.queue.onRan(watch.noteQueueResult);
  const current = (): string | null => workingNode(parts.taskId, parts.plan.tree().current) ?? parts.plan.tree().current ?? null;
  const stage = (): PlanKind | null => strongStageNow({ fcaPlanTree: parts.plan.tree() }, doneFacts(parts.observe())?.dimension ?? null);
  const close = (reason: string): void => parts.queue.closeStep?.(reason);
  return { watch, flow, current, stage, close, checkpoint: () => ({ ...flow.checkpoint(), minecraftActiveWait: watch.activeWait() }) };
}

/** The lifecycle of an unheld task: the look at each result and before each decision, and the plan made again at a decision's start. */
type ReplanLook = Pick<Unheld, 'watch' | 'flow' | 'current'> & Partial<Pick<Unheld, 'stage' | 'close'>>;
export function withReplan(lifecycle: FcaBodyLifecycle, unheld: ReplanLook | null): FcaBodyLifecycle {
  if (!unheld) return lifecycle;
  // The step's model was chosen from the stage it began in: a stronger stage than that closes the step, and the next begins with the strong model.
  const began = unheld.stage?.() ?? null;
  const before = lifecycle.beforeDecision?.bind(lifecycle);
  const noted = lifecycle.noteResult?.bind(lifecycle);
  return Object.assign(lifecycle, {
    async beforeDecision(signal: AbortSignal) {
      await before?.(signal);
      unheld.watch.look();
      unheld.flow.escaped(unheld.current());
      const stage = unheld.stage?.() ?? null;
      if (stage && stage !== began) unheld.close?.('stage');
      await unheld.flow.run(signal);
    },
    noteResult(...args: Parameters<NonNullable<FcaBodyLifecycle['noteResult']>>) {
      noted?.(...args);
      unheld.watch.look();
    },
  });
}

/** The run of failures (by when it began) each task has asked a new plan for, across its steps (a step is made anew, a run of failures is not). */
const failureAsked = new Map<string, number>();

/**
 * The stop of failed steps in a row for a request nobody is watching: where the ladder's stop would have come (`failureStops`), the strong
 * model is asked for a new plan (once for each run of failures), and the stop is the much longer one (`unattendedFailureStops`). None for a
 * request held on a failure: its own look holds it, and the ladder stays as it was.
 */
export function unattendedFailureStop(taskId: string, unheld: Pick<Unheld, 'flow'> | null, node: () => string): FcaStepPorts['failureStop'] | undefined {
  if (!unheld) return undefined;
  return input => {
    if (input.since !== null && failureAsked.get(taskId) !== input.since && failureStops(input)) {
      failureAsked.set(taskId, input.since);
      if (failureAsked.size > 64) failureAsked.delete(failureAsked.keys().next().value as string);
      unheld.flow.note({ kind: 'node_stalled', key: node(), why: `失敗した歩が続けて ${input.failures} 回（${Math.round((input.now - input.since) / 1000)} 秒、動きなし）` });
    }
    return unattendedFailureStops(input);
  };
}
