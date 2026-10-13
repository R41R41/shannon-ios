import { randomUUID } from 'node:crypto';
import type { ShannonPursuit } from '@shannon/cognition';
import {
  DELIBERATION_LIMITS, checkedDeliberationAnswer, deliberationMaterial, valueRank, type DeliberationAnswer, type DeliberationCandidate,
  type DeliberationGoal, type DeliberationMaterial, type MoodLabel, type RecentOutcome,
} from '@shannon/mind';
import { dayBand } from '../../../contracts/cognitionLedgerContract.js';
import { autonomyDayKey } from '../../inhibition/inhibitionPorts.js';
import type {
  AutonomyLoopCycle, AutonomyPlannedStep, DeliberationOutcome, DeliberationRecord, DeliberationTrigger, ExecutivePort, PreparedStep, StepDependencies,
  StepResult,
} from '../ownTime/ownTimePorts.js';
import { callAvailable, callModel, paidCall, reachOutsRemaining, roomLookAvailable } from '../ownTime/loopStepPorts.js';
import { capabilityCatalog } from './capabilityCatalog.js';
import { executivePrompt } from './executivePrompt.js';

/**
 * The Executive (Syzygy ADR-0009 stage 2, E5; plan §1). Behind `SHANNON_EXECUTIVE` it alone decides her own time: when a trigger
 * fires (her chosen time came, a goal's review is due, an own task ended, the owner reacted to her work) and no gate holds (quiet
 * hours, the owner talking, the day's budget), it starts a cycle whose thought is one deliberation. The model chooses one
 * capability from the candidates (or another dispatchable one) with a one-line reason; the code records it and dispatches it:
 * a procedure of the old loop as the cycle's one step, or an own-time FCA task. Nothing else runs on its own.
 *
 * The deliberation is a paid step of the loop, so the loop's reservation, gate and settlement apply (E3). Its material holds her
 * own ledger, numbers and closed values only: no word of the owner's.
 */
export interface ExecutiveParts {
  /** V of a capability in a context (`<band>.<presence>`), or null without data. */
  value?(scopeKey: string, capability: string, context: string): { mean: number; sd: number; n: number } | null;
  interests?(scopeKey: string): readonly { id: string; weight: number }[];
  mood?(scopeKey: string): MoodLabel | null;
  /** Own-time FCA tasks (E4); absent, research is not offered. */
  tasks?: ExecutiveTasks | null;
  /** The choice ledger (`sourceKind: 'deliberation'`); absent, nothing is recorded there. */
  choices?: ExecutiveChoices | null;
  log?(line: string): void;
}

export interface ExecutiveTasks {
  /** Admits one own-time FCA task; its id. Throws when it is not admitted. */
  create(scopeKey: string, spec: { capability: string; title: string; goal: string; requestId: string }): string;
  status(scopeKey: string, taskId: string): Exclude<DeliberationOutcome, 'pending' | 'none'> | null;
}

export interface ExecutiveChoices {
  choose(scopeKey: string, choice: { capability: string; context: string; deliberationId: string }, at: string): string | null;
  report(scopeKey: string, choiceId: string, success: 0 | 1, at: string): void;
}

const MINIMUM_GAP_MS = DELIBERATION_LIMITS.minimumNextMinutes * 60_000;
/** Awake, she thinks at least every three hours (the canary's bound); her chosen time is held inside it. */
const MAXIMUM_NEXT_MINUTES = 180;
const OUTPUT_TOKENS = 700;
const GOAL_CAPABILITIES = ['create.story', 'create.note', 'research.read'] as const;
/** The capabilities this stage can dispatch; the rest of the catalog waits for its executor (reported, never pretended). */
export const DISPATCHABLE = new Set([
  'create.story', 'create.note', 'research.read', 'notify.text', 'notify.call', 'notify.none', 'show.piece', 'look.room', 'rest',
]);

export function createExecutive(parts: ExecutiveParts): ExecutivePort {
  const triggers = new Map<string, DeliberationTrigger>();
  /** When this process last started a deliberation: a failed one (no record) still keeps the gap. */
  const started = new Map<string, number>();
  return {
    startIfDue(dependencies, scopeKey, at) {
      settleOpen(dependencies, parts, scopeKey, at);
      const held = gate(dependencies, scopeKey, at);
      if (held) return held;
      if (Date.parse(at) - (started.get(scopeKey) ?? -Infinity) < MINIMUM_GAP_MS) return 'idle';
      const trigger = triggerOf(dependencies, scopeKey, at);
      if (!trigger) return 'idle';
      const { store, config } = dependencies;
      const cycle = store.transaction(() => {
        // Until the deliberation sets her next time, the gap holds: a failed one is not retried at once.
        store.loop.setNextCycleAt(scopeKey, new Date(Date.parse(at) + MINIMUM_GAP_MS).toISOString());
        return store.loop.startCycle(scopeKey, autonomyDayKey(at, config), 'activity', [], at);
      });
      triggers.set(cycle.id, trigger);
      started.set(scopeKey, Date.parse(at));
      return cycle;
    },
    prepare(dependencies, cycle, step, at) {
      if (step.again) return null;
      const trigger = triggers.get(cycle.id) ?? 'interval';
      triggers.delete(cycle.id);
      return prepareDeliberation(dependencies, parts, cycle, trigger, at);
    },
  };
}

/** Quiet hours, the owner talking, or the day's budget: no deliberation (plan §1). Pause is the loop's own gate. */
function gate(dependencies: StepDependencies, scopeKey: string, at: string): 'idle' | 'owner-active' | 'budget' | null {
  const { store, service, loop, showing, config } = dependencies;
  if (showing.mayMessageNow(scopeKey, at) === 'quiet-hours') return 'idle';
  const since = new Date(Date.parse(at) - loop.ownerActiveMilliseconds).toISOString();
  if (loop.ownerActiveMilliseconds > 0 && showing.ownerActiveSince(scopeKey, since)) return 'owner-active';
  const budget = service.overview(scopeKey).budget;
  if (budget.exhausted || store.loop.budgetBlocked(scopeKey, autonomyDayKey(at, config), budget.capYen)) return 'budget';
  return null;
}

/** Why she would think now, or null. Never within 20 minutes of the last deliberation, never inside a rest she chose. */
export function triggerOf(dependencies: Pick<StepDependencies, 'store'>, scopeKey: string, at: string): DeliberationTrigger | null {
  const { store } = dependencies;
  const last = store.deliberations.last(scopeKey);
  if (!last) return 'first';
  const now = Date.parse(at);
  if (now - Date.parse(last.at) < MINIMUM_GAP_MS) return null;
  const next = Date.parse(store.loop.nextCycleAt(scopeKey) ?? last.nextThinkAt);
  if (last.capability === 'rest' && now < next) return null;
  if (now >= next) return 'interval';
  const reviewDue = [...store.pursuits.goals.columns(scopeKey).values()]
    .some(goal => goal.reviewAt !== null && goal.reviewAt > last.at && goal.reviewAt <= at && goal.closedReason !== 'legacy');
  if (reviewDue) return 'review';
  if (store.deliberations.closedSince(scopeKey, last.at)) return 'task_ended';
  const reactions = store.deliberations.ownerReactionsSince(scopeKey, last.at);
  return Object.values(reactions).some(count => count > 0) ? 'attention' : null;
}

interface Offer {
  material: DeliberationMaterial;
  goals: readonly ShannonPursuit[];
  readyPieceIds: readonly string[];
  context: string;
}

/** The candidates the code offers now, and the bounded material (plan §1). */
export function offer(dependencies: StepDependencies, parts: ExecutiveParts, scopeKey: string, at: string): Offer {
  const { store, service, showing } = dependencies;
  let presence = 'unknown';
  try { presence = dependencies.reachOuts?.audience(scopeKey, at) ? 'others' : 'alone'; } catch { presence = 'unknown'; }
  const context = `${dayBand(at)}.${presence}`;
  const columns = store.pursuits.goals.columns(scopeKey);
  const goals = store.pursuits.list(scopeKey, at).filter(item => item.origin !== 'seed' && item.status === 'active');
  const deliberationGoals: DeliberationGoal[] = goals.map(goal => ({
    id: goal.id, progress: columns.get(goal.id)?.progress ?? 0, predicate: columns.get(goal.id)?.predicate ?? null,
    reviewAt: columns.get(goal.id)?.reviewAt ?? null, interestId: columns.get(goal.id)?.interestId ?? null,
  }));
  const readyPieceIds = store.study.list(scopeKey).filter(piece => piece.kind === 'story' && piece.status === 'ready').map(piece => piece.id);
  const candidate = (capability: string, goalId?: string): DeliberationCandidate => ({
    capability, ...(goalId ? { goalId } : {}), value: safe(() => parts.value?.(scopeKey, capability, context) ?? null, null),
    recent: store.deliberations.outcomes(scopeKey, capability, 3).map(recentOf),
  });
  const ordered = [...deliberationGoals].sort((left, right) => (left.reviewAt ?? '9').localeCompare(right.reviewAt ?? '9') || left.progress - right.progress);
  const unnoted = safe(() => store.loop.unnotedReadings(scopeKey).length, 0) > 0;
  const usable = (capability: string) => (capability !== 'research.read' || Boolean(parts.tasks)) && (capability !== 'create.note' || unnoted);
  const onGoals = ordered.slice(0, DELIBERATION_LIMITS.goals)
    .flatMap(goal => GOAL_CAPABILITIES.filter(usable).map(capability => candidate(capability, goal.id)));
  const free = [
    ...(safe(() => reachOutsRemaining(dependencies, scopeKey, at), 0) > 0 ? [candidate('notify.text')] : []),
    ...(safe(() => callAvailable(dependencies, scopeKey, at), false) ? [candidate('notify.call')] : []),
    ...(readyPieceIds.length && showing.mayMessageNow(scopeKey, at) === 'ok' ? [candidate('show.piece')] : []),
    ...(safe(() => roomLookAvailable(dependencies, scopeKey, at), false) ? [candidate('look.room')] : []),
    candidate('rest'), candidate('notify.none'),
  ];
  // The goal-free ones are always offered: the goal candidates give way to them inside the twelve.
  const room = Math.max(0, DELIBERATION_LIMITS.candidates - free.length);
  const budget = service.overview(scopeKey).budget;
  const material = deliberationMaterial({
    at, candidates: [...onGoals.slice(0, room), ...free], goals: ordered, interests: safe(() => parts.interests?.(scopeKey) ?? [], []),
    ownerReactions7d: store.deliberations.ownerReactionsSince(scopeKey, new Date(Date.parse(at) - 7 * 86_400_000).toISOString()),
    dayBand: dayBand(at), presence, budgetLeftYen: budget.remainingYen, freeSlots: 1, mood: safe(() => parts.mood?.(scopeKey) ?? 'calm', 'calm'),
  });
  return { material, goals, readyPieceIds, context };
}

function prepareDeliberation(
  dependencies: StepDependencies, parts: ExecutiveParts, cycle: AutonomyLoopCycle, trigger: DeliberationTrigger, at: string,
): PreparedStep | null {
  const scopeKey = cycle.scopeKey;
  const offered = offer(dependencies, parts, scopeKey, at);
  const ranked = valueRank(offered.material.candidates);
  const prompt = executivePrompt(offered.material, ranked, offered.goals, dependencies.withheldFacts?.(scopeKey, at) ?? null);
  const call = paidCall(dependencies, scopeKey, 'planning', prompt, OUTPUT_TOKENS, dependencies.planningModel?.(scopeKey));
  if (!call) return null;
  return {
    request: {
      domain: 'thinking', tool: 'executive.deliberate', paid: { model: call.model, estimatedCostYen: call.estimatedCostYen },
      summary: '次に何をするかを一つ選びます。',
    },
    purpose: 'planning', estimate: call.estimate,
    async perform(adapters, _at, signal): Promise<StepResult> {
      const called = await callModel(adapters, call, signal);
      const known = new Set([...DISPATCHABLE].filter(name => name !== 'research.read' || parts.tasks));
      const goalIds = new Set(offered.goals.map(goal => goal.id));
      const answer = called.reply ? checkedDeliberationAnswer(called.reply, known, offered.material.candidates, goalIds) : null;
      if (!answer) {
        const code = !called.reply ? called.failure ? 'model_failed' : 'unparsable' : 'unknown_choice';
        return { outcome: 'failed', ...(called.usage ? { usage: called.usage } : {}), reasonCode: code, summary: '次に何をするか考えましたが、一つに決まりませんでした。' };
      }
      return dispatched(dependencies, parts, { cycle, trigger, at, offered, ranked, answer, usage: called.usage });
    },
  };
}

interface Decided {
  cycle: AutonomyLoopCycle;
  trigger: DeliberationTrigger;
  at: string;
  offered: Offer;
  ranked: ReturnType<typeof valueRank>;
  answer: DeliberationAnswer;
  usage: StepResult['usage'];
}

/** The answer carried out: a task admitted now (outside the store's transaction), and the record, the step and the goal in its commit. */
function dispatched(dependencies: StepDependencies, parts: ExecutiveParts, decided: Decided): StepResult {
  const { cycle, at, answer, offered } = decided;
  const scopeKey = cycle.scopeKey;
  const id = randomUUID();
  const label = capabilityCatalog().find(item => item.name === answer.capability)?.label ?? answer.capability;
  let taskId: string | null = null;
  let failed = false;
  if (answer.capability === 'research.read') {
    try {
      const intent = answer.args.intent ?? offered.goals.find(goal => goal.id === answer.goalId)?.title ?? '気になっていること';
      taskId = parts.tasks!.create(scopeKey, { capability: answer.capability, title: `調べる: ${intent.slice(0, 60)}`, requestId: id,
        goal: `${intent}\n公開されている情報だけを読んで、わかったことを自分の言葉で短く報告する。持ち主の個人的なことは調べない。` });
    } catch (error) {
      failed = true;
      safe(() => parts.log?.(`executive task refused: ${error instanceof Error ? error.message.slice(0, 60) : 'unknown'}`), undefined);
    }
  }
  const plan = failed ? [] : stepFor(answer, offered, dependencies, scopeKey);
  const chosen = { capability: answer.capability, context: offered.context, deliberationId: id };
  const choiceId = failed ? null : safe(() => parts.choices?.choose(scopeKey, chosen, at) ?? null, null);
  const rank = decided.ranked.find(item => item.capability === answer.capability && item.goalId === answer.goalId)?.rank ?? null;
  const nextThinkAt = new Date(Date.parse(at) + Math.min(MAXIMUM_NEXT_MINUTES, answer.nextThinkMinutes) * 60_000).toISOString();
  return {
    outcome: failed ? 'failed' : 'done', ...(decided.usage ? { usage: decided.usage } : {}), ...(failed ? { reasonCode: 'task_refused' } : {}),
    summary: failed ? `「${label}」を選びましたが、始められませんでした。` : `次は「${label}」を選びました。${answer.reason ? `（${answer.reason}）` : ''}`,
    commit: () => {
      const { store } = dependencies;
      store.deliberations.record({
        id, scopeKey, at, trigger: decided.trigger, capability: answer.capability, goalId: answer.goalId ?? null, reason: answer.reason || null,
        intent: answer.args.intent ?? null, valueRank: rank, topByValue: rank === 1 && decided.ranked.some(item => item.rank === 1),
        offCandidates: answer.outsideCandidates, candidates: decided.ranked.map(item => candidateRow(item, offered.material.candidates)),
        material: materialRow(offered.material), dispatch: taskId ? 'fca' : plan.length ? 'procedure' : 'none', cycleId: plan.length ? cycle.id : null,
        taskId, outcome: failed ? 'failed' : taskId || plan.length ? 'pending' : 'none', nextThinkAt, choiceId,
      });
      applyProposal(dependencies, scopeKey, answer, at);
      store.loop.setNextCycleAt(scopeKey, nextThinkAt);
      return { plan };
    },
  };
}

/** The old loop's step a procedure capability becomes (the loop's own preparation checks it again when it runs). */
export function stepFor(
  answer: DeliberationAnswer, offered: Pick<Offer, 'readyPieceIds'>, dependencies: Pick<StepDependencies, 'store'>, scopeKey: string,
): AutonomyPlannedStep[] {
  const about = answer.args.about ?? 'share';
  switch (answer.capability) {
    case 'create.story': return [storyStep(answer, dependencies, scopeKey)];
    // A note is written about a page she read and has not noted yet (the loop's `note`).
    case 'create.note': return [{ kind: 'note' }];
    case 'notify.text': return [{ kind: 'reach_out', reason: about }];
    case 'notify.call': return [{ kind: 'reach_out', reason: about, call: true }];
    case 'look.room': return [{ kind: 'look' }];
    case 'show.piece': {
      const named = answer.args.pieceId;
      const pieceId = named && offered.readyPieceIds.includes(named) ? named : offered.readyPieceIds[0];
      return pieceId ? [{ kind: 'show', pieceId }] : [];
    }
    default: return [];
  }
}

/** A draft of hers she named is revised; otherwise a new one is drafted for the goal. */
function storyStep(answer: DeliberationAnswer, dependencies: Pick<StepDependencies, 'store'>, scopeKey: string): AutonomyPlannedStep {
  const intent = answer.args.intent ?? '';
  const named = answer.args.pieceId;
  const piece = named ? dependencies.store.study.list(scopeKey).find(item => item.id === named && item.kind === 'story' && item.status === 'draft') : undefined;
  return piece ? { kind: 'revise', pieceId: piece.id, intent } : { kind: 'draft', intent, ...(answer.goalId ? { pursuitId: answer.goalId } : {}) };
}

/** Her proposal about the goal: rest or drop it, or say it is done (a proposal only: E2). */
function applyProposal(dependencies: StepDependencies, scopeKey: string, answer: DeliberationAnswer, at: string): void {
  if (!answer.goalId || !answer.goalProposal || answer.goalProposal === 'continue') return;
  const status = answer.goalProposal === 'rest' ? 'resting' : answer.goalProposal === 'drop' ? 'dropped' : 'done';
  safe(() => dependencies.store.pursuits.update(scopeKey, answer.goalId!, { status }, at), null);
}

/**
 * What came of open deliberations: the dispatched step's journal or the task's status. A closed one reports to the choice
 * ledger and, when it did its work for a goal, gives that goal its evidence and its last work.
 */
export function settleOpen(
  dependencies: Pick<StepDependencies, 'store'>, parts: Pick<ExecutiveParts, 'tasks' | 'choices'>, scopeKey: string, at: string,
): void {
  const { store } = dependencies;
  for (const row of store.deliberations.open(scopeKey)) {
    const outcome = outcomeOf(dependencies, parts, row);
    if (!outcome || outcome === row.outcome) continue;
    store.deliberations.settle(row.id, outcome, at);
    if (outcome === 'running') continue;
    if (row.choiceId) safe(() => parts.choices?.report(scopeKey, row.choiceId!, outcome === 'done' ? 1 : 0, at), undefined);
    if (outcome === 'done' && row.goalId) credit(dependencies, row, at);
  }
}

function outcomeOf(dependencies: Pick<StepDependencies, 'store'>, parts: Pick<ExecutiveParts, 'tasks'>, row: DeliberationRecord): DeliberationOutcome | null {
  const { store } = dependencies;
  if (row.dispatch === 'fca') return row.taskId ? safe(() => parts.tasks?.status(row.scopeKey, row.taskId!) ?? null, null) : 'failed';
  if (!row.cycleId || store.loop.openCycle(row.scopeKey)?.id === row.cycleId) return null;
  const step = store.loop.steps(row.cycleId).filter(item => item.step.kind !== 'think').at(-1);
  if (!step) return 'none';
  if (step.status === 'reported') return 'done';
  return step.status === 'refused' || step.status === 'abandoned' ? 'failed' : 'unknown';
}

function credit(dependencies: Pick<StepDependencies, 'store'>, row: DeliberationRecord, at: string): void {
  const goals = dependencies.store.pursuits.goals;
  safe(() => goals.worked(row.scopeKey, row.goalId!, at), undefined);
  const evidence = row.capability === 'research.read' && row.taskId
    ? [{ kind: 'research_report' as const, ref: row.taskId, at }, { kind: 'task_completed' as const, ref: row.taskId, capability: row.capability, at }]
    : row.capability === 'create.note' ? [{ kind: 'note_written' as const, ref: row.id, at }]
      : [{ kind: 'task_completed' as const, ref: row.id, capability: row.capability, at }];
  safe(() => goals.completeWithEvidence(row.scopeKey, row.goalId!, evidence, at), null);
}

function recentOf(outcome: DeliberationOutcome): RecentOutcome {
  if (outcome === 'done') return 'success';
  return outcome === 'failed' || outcome === 'cancelled' ? 'failure' : 'unknown';
}

function candidateRow(item: ReturnType<typeof valueRank>[number], candidates: readonly DeliberationCandidate[]): Record<string, string | number | null> {
  const value = candidates.find(candidate => candidate.capability === item.capability && candidate.goalId === item.goalId)?.value ?? null;
  return { capability: item.capability, goalId: item.goalId ?? null, rank: item.rank, mean: value?.mean ?? null, n: value?.n ?? null };
}

function materialRow(material: DeliberationMaterial): Record<string, string | number | boolean | null> {
  return {
    dayBand: material.dayBand, presence: material.presence, budgetLeftYen: material.budgetLeftYen, freeSlots: material.freeSlots, mood: material.mood,
    goals: material.goals.length, candidates: material.candidates.length, interests: material.interests.length,
    ownerReactions: Object.values(material.ownerReactions7d).reduce((sum, count) => sum + count, 0),
  };
}

function safe<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}
