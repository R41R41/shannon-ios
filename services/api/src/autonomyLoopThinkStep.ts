import { autonomyDayKey } from './autonomyBudget.js';
import { callModel, ownerLocalTime, paidCall } from './autonomyLoopCalls.js';
import { roomLookAvailable } from './autonomyLoopLookStep.js';
import type { ObservedStepKind } from './autonomyLoopObservations.js';
import { agenticLoop, followUpsRemaining, ownerRepliedAt, reachOutChain, thinkingSteps } from './autonomyLoopObserve.js';
import { reachOutMemories, reachOutMemoryExtras, rethinkExtras } from './autonomyLoopObservePrompts.js';
import { planFromThought, thinkingMaterials, type Thought } from './autonomyLoopPlan.js';
import { thinkingPrompt, type ThinkingExtras } from './autonomyLoopPrompts.js';
import { reachOutsRemaining } from './autonomyLoopReachOutStep.js';
import type { AutonomyLoopCycle, AutonomyPlannedStep } from './autonomyLoopState.js';
import type { PreparedStep, StepDependencies } from './autonomyLoopSteps.js';

/**
 * The thinking step: one planning-model call that chooses the next steps from her ledger and study.
 *
 * It runs once at the start of a cycle and, while the act → observe → think-again mechanism is on, again
 * when a step's outcome is worth thinking about (`again`): then the prompt also carries what just happened
 * as facts, the plan that was still open, and, after a message of hers that nobody answered, the choices
 * she has. A later cycle's first thinking step is told what followed today's messages. The reply replaces
 * the rest of the plan. With the mechanism off the prompt and the step are what they were.
 */
const OUTPUT_TOKENS = 1_500;
const DAY_MILLISECONDS = 24 * 60 * 60_000;
/** Observations older than this are dropped when a cycle starts thinking. */
const OBSERVATION_RETENTION_MILLISECONDS = 14 * DAY_MILLISECONDS;

interface Rethink {
  extras: ThinkingExtras | null;
  /** The message a second call would follow, while she may make one. */
  followUp: { originId: string } | null;
  /** A look planned now is one she takes to find out, and she thinks again after it. */
  chainLook: boolean;
  jot: boolean;
  /** No ordinary message of her own in this plan: she already spoke in this cycle. */
  spoke: boolean;
  /** No look in this plan: she already looked after the unanswered message. */
  looked: boolean;
}

const NOTHING: Rethink = Object.freeze({ extras: null, followUp: null, chainLook: false, jot: false, spoke: false, looked: false });

function rethinking(dependencies: StepDependencies, cycle: AutonomyLoopCycle, at: string, maximumSteps: number, lookAvailable: boolean): Rethink {
  const { store, config, loop, reachOuts } = dependencies;
  const happened = store.loop.observations.ofCycle(cycle.id);
  const chain = reachOutChain(happened);
  const repliedSince = chain ? ownerRepliedAt(dependencies, cycle.scopeKey, chain.pending.sentAt) !== null : false;
  const pending = chain && !repliedSince ? chain : null;
  let followed = true;
  try { followed = pending ? reachOuts?.followedUp?.(cycle.scopeKey, pending.pending.id) ?? true : true; } catch { followed = true; }
  const followUp = pending && !followed && maximumSteps >= 1 && followUpsRemaining(dependencies, cycle.scopeKey, at) > 0;
  const look = Boolean(pending) && !pending!.looked && lookAvailable && maximumSteps >= 1;
  // This thinking step, the look, the thinking step after it, and one step she may then take.
  const thinkAfterLook = look && maximumSteps >= 3 && thinkingSteps(dependencies, cycle.id) + 1 < 1 + loop.maximumRethinksPerCycle;
  const planned = cycle.plan.filter(step => step.kind !== 'think').map(step => step.kind as ObservedStepKind);
  return {
    extras: rethinkExtras({
      at, timeZone: config.timeZone, happened, planned, repliedSince,
      pending: pending ? { followUp: Boolean(followUp), look, thinkAfterLook } : null,
    }),
    followUp: followUp ? { originId: pending!.pending.id } : null, chainLook: look, jot: Boolean(pending),
    spoke: happened.some(item => item.step === 'reach_out'), looked: Boolean(chain?.looked),
  };
}

/** What followed today's messages of hers, for the first thinking step of a later cycle. */
function remembered(dependencies: StepDependencies, scopeKey: string, at: string): ThinkingExtras | null {
  const { store, config, showing } = dependencies;
  const today = autonomyDayKey(at, config);
  const memories = reachOutMemories(store.loop.observations.since(scopeKey, new Date(Date.parse(at) - DAY_MILLISECONDS).toISOString()))
    .filter(memory => autonomyDayKey(memory.facts.sentAt, config) === today)
    .map(memory => {
      if (memory.facts.replied) return memory;
      const waitedUntil = new Date(Date.parse(memory.facts.sentAt) + memory.facts.waitedSeconds * 1_000).toISOString();
      let repliedSince = false;
      try { repliedSince = showing.ownerActiveSince(scopeKey, waitedUntil); } catch { repliedSince = false; }
      return { ...memory, repliedSince };
    });
  return reachOutMemoryExtras(memories, config.timeZone);
}

export function prepareThinking(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, at: string): PreparedStep | null {
  const { store, service, config, loop } = dependencies;
  const agentic = agenticLoop(dependencies);
  const again = agentic && step.again === true;
  const overview = service.overview(cycle.scopeKey);
  const readsToday = store.activity.countForDay(cycle.scopeKey, overview.budget.dayKey, 'public_read', 'allowed');
  const maximumSteps = Math.max(0, loop.maximumStepsPerCycle - cycle.stepsTaken - 1);
  const lookNow = roomLookAvailable(dependencies, cycle.scopeKey, at);
  let rethink = NOTHING;
  let memory: ThinkingExtras | null = null;
  try {
    if (again) rethink = rethinking(dependencies, cycle, at, maximumSteps, lookNow);
    else if (agentic) memory = remembered(dependencies, cycle.scopeKey, at);
  } catch { /* she thinks without what happened rather than not at all */ }
  const reachOuts = rethink.spoke ? 0 : reachOutsRemaining(dependencies, cycle.scopeKey, at);
  const materials = thinkingMaterials(store, cycle.scopeKey, {
    at, localTime: ownerLocalTime(at, config.timeZone), remainingYen: overview.budget.remainingYen,
    remainingReads: Math.max(0, config.maximumPublicReadsPerDay - readsToday), maximumSteps,
    readingSeeds: loop.readingSeeds, notionAvailable: dependencies.notion !== undefined,
    folderAvailable: service.folder.available(cycle.scopeKey, at),
    lookAvailable: lookNow && !rethink.looked,
    reachOut: reachOuts > 0 ? { remaining: reachOuts, upcoming: upcomingLines(dependencies, cycle.scopeKey, at) } : null,
  });
  const call = paidCall(dependencies, cycle.scopeKey, 'planning', thinkingPrompt(materials, rethink.extras ?? memory), OUTPUT_TOKENS);
  if (!call) return null;
  return {
    request: {
      domain: 'thinking', tool: 'study.think', paid: { model: call.model, estimatedCostYen: call.estimatedCostYen },
      summary: again ? 'さっき起きたことを見て、このあと何をするかを考え直します。' : '次に何をするか、自分の台帳と書斎を見て考えます。',
    },
    purpose: 'planning', estimate: call.estimate,
    async perform(adapters, _at, signal) {
      const { reply, usage, failure } = await callModel(adapters, call, signal);
      if (!reply) return { outcome: 'failed', summary: failure ? '考えようとしましたが、モデルから返事をもらえませんでした。' : '考えましたが、次の一歩にまとまりませんでした。', usage };
      const thought: Thought = planFromThought(reply, {
        pursuits: materials.pursuits, pieces: store.study.list(cycle.scopeKey), unnotedReadingIds: materials.unnotedReadings.map(item => item.id),
        placeUrls: materials.places.map(place => place.url),
      }, {
        maximumSteps, maximumReads: Math.min(loop.maximumReadsPerCycle, materials.remainingReads), notionAvailable: materials.notionAvailable, folderAvailable: materials.folderAvailable === true, lookAvailable: materials.lookAvailable === true, reachOut: materials.reachOut ? { upcoming: (materials.upcoming?.length ?? 0) > 0 } : null,
        ...(again ? { followUp: rethink.followUp, chainLook: rethink.chainLook, jot: rethink.jot } : {}),
      });
      const words = again ? 'さっき起きたことを見て、考え直しました。' : '次に何をするか考えました。';
      return {
        outcome: 'done', usage,
        summary: thought.text ? `${words}「${thought.text}」` : words,
        commit: (_remaining, commitAt) => {
          for (const change of thought.pursuits) {
            if (change.op === 'add') service.addPursuit(cycle.scopeKey, { kind: change.kind!, title: change.title!, why: change.why!, origin: 'self' });
            else service.updatePursuit(cycle.scopeKey, change.id!, { ...(change.status ? { status: change.status } : {}), ...(change.why ? { why: change.why } : {}) });
          }
          if (agentic && !again) store.loop.observations.prune(cycle.scopeKey, new Date(Date.parse(commitAt) - OBSERVATION_RETENTION_MILLISECONDS).toISOString());
          return { plan: thought.steps };
        },
      };
    },
  };
}

function upcomingLines(dependencies: StepDependencies, scopeKey: string, at: string) {
  try { return dependencies.upcoming?.lines(scopeKey, at, 'owner') ?? []; } catch { return []; }
}
