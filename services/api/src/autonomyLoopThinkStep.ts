import { autonomyDayKey } from './autonomyBudget.js';
import { callModel, ownerLocalTime, paidCall } from './autonomyLoopCalls.js';
import { roomLookAvailable } from './autonomyLoopLookStep.js';
import { OBSERVATION_RETENTION_DAYS, type ObservedStepKind } from './autonomyLoopObservations.js';
import { agenticLoop, followUpsRemaining, ownerRepliedAt, reachOutChain, thinkingSteps } from './autonomyLoopObserve.js';
import { reachOutMemories, reachOutMemoryExtras, rethinkExtras } from './autonomyLoopObservePrompts.js';
import type { OwnerContextBlock } from './autonomyLoopOwnerContext.js';
import { mayRetryThought, sessionFacts, sessionOf } from './autonomyLoopPacing.js';
import { SESSION_RULES, restAction, sessionFactsSection, unplannedSection } from './autonomyLoopSessionPrompts.js';
import { reasonedPlan, thinkingMaterials, type ReasonedThought } from './autonomyLoopPlan.js';
import { salvagedModelObject, thinkingPrompt, type ThinkingExtras } from './autonomyLoopPrompts.js';
import { phoneThinking, withPhone, type PhoneThinking } from './autonomyLoopPhoneStep.js';
import { reachOutsRemaining } from './autonomyLoopReachOutStep.js';
import { sessionMarked, unmarkedOnly, unmarkedPursuits } from './autonomyLoopProvenance.js';
import type { AutonomyLoopCycle, AutonomyPlannedStep } from './autonomyLoopState.js';
import { offeredOwnTools, toolThinking } from './autonomyLoopToolStep.js';
import type { PreparedStep, StepDependencies } from './autonomyLoopSteps.js';
import { STUDY_LIMITS, STUDY_STATUS_LABEL } from './studyStore.js';

/**
 * The thinking step: one planning-model call that chooses the next steps from her ledger and study.
 *
 * It runs once at the start of a cycle and, while the act → observe → think-again mechanism is on, again
 * when a step's outcome is worth thinking about (`again`): then the prompt also carries what just happened
 * as facts, the plan that was still open, and, after a message of hers that nobody answered, the choices
 * she has. A later cycle's first thinking step is told what followed today's messages. The reply replaces
 * the rest of the plan. With the mechanism off the prompt and the step are what they were.
 *
 * In a session (owner decision 2026-10-02, ADR-0003) it also runs whenever a plan has been carried out, until she
 * rests: the prompt then ends with the facts of the day's budget and of this session, and `rest` says when she
 * comes back. While the owner's context is switched on, the prompt carries one bounded block of it, built by the
 * interface the loop was handed, and what she writes down is checked against what must reach nobody but him.
 */
const OUTPUT_TOKENS = 1_500;
const DAY_MILLISECONDS = 24 * 60 * 60_000;
/** Observations older than this are dropped when a cycle starts thinking. */
const OBSERVATION_RETENTION_MILLISECONDS = OBSERVATION_RETENTION_DAYS * DAY_MILLISECONDS;

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

function rethinking(dependencies: StepDependencies, cycle: AutonomyLoopCycle, at: string, maximumSteps: number, lookAvailable: boolean, session: boolean): Rethink {
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
  const thinkAfterLook = look && maximumSteps >= 3 && (session || thinkingSteps(dependencies, cycle.id) + 1 < 1 + loop.maximumRethinksPerCycle);
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
  const session = sessionOf(dependencies, cycle);
  // A second thought left in a plan from before the mechanism was switched off is dropped, not run as a first one.
  if (step.again && !agentic && !session) return null;
  const again = step.again === true;
  const overview = service.overview(cycle.scopeKey);
  const readsToday = store.activity.countForDay(cycle.scopeKey, overview.budget.dayKey, 'public_read', 'allowed');
  // In a session one plan is as long as a cycle's was, and never longer than the steps the session has left.
  const maximumSteps = session ? Math.max(0, Math.min(loop.maximumStepsPerCycle - 1, loop.maximumStepsPerSession - cycle.stepsTaken - 1))
    : Math.max(0, loop.maximumStepsPerCycle - cycle.stepsTaken - 1);
  const lookNow = roomLookAvailable(dependencies, cycle.scopeKey, at);
  let rethink = NOTHING;
  let memory: ThinkingExtras | null = null;
  try {
    if (again) rethink = rethinking(dependencies, cycle, at, maximumSteps, lookNow, session !== null);
    else if (agentic) memory = remembered(dependencies, cycle.scopeKey, at);
  } catch { /* she thinks without what happened rather than not at all */ }
  const reachOuts = rethink.spoke ? 0 : reachOutsRemaining(dependencies, cycle.scopeKey, at);
  const materials = thinkingMaterials(store, cycle.scopeKey, {
    at, localTime: ownerLocalTime(at, config.timeZone), remainingYen: overview.budget.remainingYen,
    remainingReads: Math.max(0, config.maximumPublicReadsPerDay - readsToday), maximumSteps,
    readingSeeds: loop.readingSeeds, notionAvailable: dependencies.notion !== undefined,
    // The v1 copy step only while her study is Shannon's (Syzygy ADR-0007 revised: with Aether, stories are never put in the PC folder).
    folderAvailable: !service.studyAether?.covers(cycle.scopeKey) && service.folder.available(cycle.scopeKey, at),
    lookAvailable: lookNow && !rethink.looked, ownNotes: agentic, keep: unmarkedOnly(dependencies, cycle), keepPursuit: unmarkedPursuits(dependencies, cycle),
    reachOut: reachOuts > 0 ? { remaining: reachOuts, upcoming: upcomingLines(dependencies, cycle.scopeKey, at) } : null,
  });
  // The phone: the facts of the moment, and the action while she may use it. Nothing while he has not switched calls on.
  let phone: PhoneThinking | null = null;
  try {
    phone = phoneThinking(dependencies, cycle.scopeKey, at, {
      look: materials.lookAvailable === true, upcoming: Boolean(materials.reachOut) && (materials.upcoming?.length ?? 0) > 0, spoke: rethink.spoke,
    });
  } catch { phone = null; }
  const owned = ownerBlock(dependencies, cycle.scopeKey, at, materials.pursuits.filter(item => item.status === 'active').slice(0, 4).map(item => item.title).join(' '));
  const base = withPhone(rethink.extras ?? memory, phone);
  // The thought before this one led to no step: she is told why, as fixed sentences.
  const unplanned = session && again && step.dropped?.length ? unplannedSection(step.dropped) : null;
  const facts = (thinkReserveYen?: number) => sessionFacts(dependencies, cycle, session!, at, {
    budget: overview.budget, remainingReads: materials.remainingReads,
    openStories: materials.stories.filter(story => story.statusLabel !== STUDY_STATUS_LABEL.shown).length, maximumOpenStories: STUDY_LIMITS.openStories,
    offered: { look: materials.lookAvailable === true, reachOut: Boolean(materials.reachOut) }, ...(thinkReserveYen !== undefined ? { thinkReserveYen } : {}),
  });
  // Without a session and without the owner's context the extras are what they were, and so is the prompt.
  const extrasWith = (reserveYen?: number): ThinkingExtras | null => session || owned ? {
    actions: base?.actions ?? '', examples: base?.examples ?? '', sections: [...(base?.sections ?? []), ...(unplanned ? [unplanned] : [])],
    rules: [...(base?.rules ?? []), ...(session ? SESSION_RULES : [])],
    ...(session ? {
      rest: restAction({ minimumMinutes: Math.round(loop.sessionMinimumRestMilliseconds / 60_000), maximumMinutes: Math.round(loop.sessionMaximumRestMilliseconds / 60_000) }),
      closing: [sessionFactsSection(facts(reserveYen))],
    } : {}),
    ...(owned ? { ownerContext: owned.section } : {}),
  } : base;
  // Her registry tools, and what her last calls returned (`autonomyLoopToolStep.ts`); none while they are switched off.
  const tooling = toolThinking(dependencies, cycle);
  const withTools = (extras: ThinkingExtras | null): ThinkingExtras | null => (tooling ? {
    ...(extras ?? { rules: [] }), actions: `${extras?.actions ?? ''}${tooling.actions}`, examples: `${extras?.examples ?? ''}${tooling.examples}`,
    sections: [...(extras?.sections ?? []), ...tooling.sections], ownTools: true,
  } : extras);
  const priced = (reserveYen?: number) => paidCall(dependencies, cycle.scopeKey, 'planning', thinkingPrompt(materials, withTools(extrasWith(reserveYen))), session ? loop.sessionThinkOutputTokens : OUTPUT_TOKENS);
  // In a session she is told what the gate reserves for a thought: the estimate of this very prompt, priced once without that line.
  const first = priced();
  const estimated = first && session ? priced(first.estimatedCostYen) : first;
  if (!estimated) return null;
  // A planning reply must fit the ceiling: the provider is asked to spend little of it on its own reasoning.
  const call = loop.planReasoning === 'low' ? { ...estimated, reasoning: 'low' as const } : estimated;
  /**
   * In a session a thought that led to no step is not the end: she thinks once more, told why, as long as the thoughts in a
   * row stay inside the re-think limit. After that the plan stays empty and the session rests.
   */
  const thinkAgain = (codes: readonly string[]): AutonomyPlannedStep[] | null => {
    if (!session || !codes.length) return null;
    // This thought is journalled but not yet counted in `cycle`.
    return mayRetryThought(dependencies, cycle, cycle.stepsTaken + 1) ? [{ kind: 'think', again: true, dropped: [...new Set(codes)].slice(0, 8) }] : null;
  };
  const noted = (code: string) => { try { dependencies.log?.(`think ${code}`); } catch { /* the log is optional */ } return code; };
  return {
    request: {
      domain: 'thinking', tool: 'study.think', paid: { model: call.model, estimatedCostYen: call.estimatedCostYen },
      summary: again ? 'さっき起きたことを見て、このあと何をするかを考え直します。' : '次に何をするか、自分の台帳と書斎を見て考えます。',
    },
    purpose: 'planning', estimate: call.estimate,
    async perform(adapters, _at, signal) {
      const called = await callModel(adapters, call, signal);
      const { usage, failure } = called;
      // In a session a reply cut off at the output ceiling still gives the steps that were written out in full.
      const salvaged = session && !called.reply && called.truncated && called.text ? salvagedModelObject(called.text) : null;
      const reply = called.reply ?? salvaged;
      if (!reply) {
        // Why there is no plan, as a closed code: for her record, for the log, and for her next thought.
        const code = called.truncated ? 'truncated' : failure ? 'model_failed' : 'unparsable';
        return {
          outcome: 'failed', usage, reasonCode: noted(code),
          // Under the fixed cycles the two sentences are the ones they were.
          summary: session && called.truncated ? '考えましたが、返事が途中で切れて、次の一歩にまとまりませんでした。' : failure ? '考えようとしましたが、モデルから返事をもらえませんでした。' : '考えましたが、次の一歩にまとまりませんでした。',
          commit: remaining => {
            // A reply she can do better is asked for once more. A provider that did not answer, or that spent the whole ceiling
            // on its own reasoning and wrote nothing, is not asked again at once: no hint of hers can change that.
            const retry = remaining.length || code === 'model_failed' || (code === 'truncated' && !called.text) ? null : thinkAgain([`reply.${code}`]);
            return retry ? { plan: retry } : undefined;
          },
        };
      }
      const thought: ReasonedThought = reasonedPlan(reply, {
        pursuits: materials.pursuits, pieces: store.study.list(cycle.scopeKey), unnotedReadingIds: materials.unnotedReadings.map(item => item.id),
        placeUrls: materials.places.map(place => place.url),
      }, {
        maximumSteps, maximumReads: Math.min(loop.maximumReadsPerCycle, materials.remainingReads), notionAvailable: materials.notionAvailable, folderAvailable: materials.folderAvailable === true, lookAvailable: materials.lookAvailable === true, reachOut: materials.reachOut ? { upcoming: (materials.upcoming?.length ?? 0) > 0 } : null,
        call: phone?.offered ? { upcoming: Boolean(materials.reachOut) && (materials.upcoming?.length ?? 0) > 0 } : null,
        ...(again ? { followUp: rethink.followUp, chainLook: rethink.chainLook, jot: rethink.jot } : {}),
        ...(session ? { session: true } : {}), ...(owned ? { secrets: owned.secrets } : {}),
        ...(tooling ? { tools: offeredOwnTools(dependencies, cycle.scopeKey).map(tool => tool.name) } : {}),
      });
      const words = again ? 'さっき起きたことを見て、考え直しました。' : '次に何をするか考えました。';
      // A thought with no step at all: nothing she named could be done, or she named nothing.
      // A reply that only rests (under the fixed cycles), or whose steps found no room, is neither.
      const unplannable = thought.steps.length > 0 ? null
        : salvaged ? 'truncated' : thought.asked === 0 ? 'empty_plan' : thought.dropped.length ? `all_steps_filtered:${[...new Set(thought.dropped)].join(',')}` : null;
      const code = unplannable ?? (salvaged ? 'truncated' : null);
      return {
        outcome: 'done', usage, ...(code ? { reasonCode: noted(code) } : {}),
        // In a marked session her thought may retell what she read of the owner's: the record keeps that she thought, not the words.
        summary: thought.text && !sessionMarked(dependencies, cycle) ? `${words}「${thought.text}」` : words,
        commit: (_remaining, commitAt) => {
          // What her last calls returned has been in front of her: it is not given again.
          dependencies.toolResults?.clear(cycle.id);
          const retry = unplannable && maximumSteps > 0 ? thinkAgain(salvaged ? ['reply.truncated'] : thought.asked === 0 ? ['reply.empty'] : thought.dropped) : null;
          // A thought that is about to be thought again changes nothing in her ledger: the next one decides.
          for (const change of retry ? [] : thought.pursuits) {
            if (change.op === 'add') service.addPursuit(cycle.scopeKey, { kind: change.kind!, title: change.title!, why: change.why!, origin: 'self' });
            else service.updatePursuit(cycle.scopeKey, change.id!, { ...(change.status ? { status: change.status } : {}), ...(change.why ? { why: change.why } : {}) });
          }
          if ((agentic || session) && !again) store.loop.observations.prune(cycle.scopeKey, new Date(Date.parse(commitAt) - OBSERVATION_RETENTION_MILLISECONDS).toISOString());
          return { plan: retry ?? thought.steps };
        },
      };
    },
  };
}

/** The owner's context for this thought, or null: switched off, not wired, nothing there, or not readable just now. */
function ownerBlock(dependencies: StepDependencies, scopeKey: string, at: string, topic: string): OwnerContextBlock | null {
  if (!dependencies.loop.ownerContext || !dependencies.ownerContext) return null;
  try { return dependencies.ownerContext.forThinking(scopeKey, at, topic); } catch { return null; }
}

function upcomingLines(dependencies: StepDependencies, scopeKey: string, at: string) {
  try { return dependencies.upcoming?.lines(scopeKey, at, 'owner') ?? []; } catch { return []; }
}
