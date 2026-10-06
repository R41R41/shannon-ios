import { autonomyDayKey, yenFromUsd, type AutonomyBudgetStatus } from '../../inhibition/autonomyBudget.js';
import { ownerLocalTime } from './autonomyLoopCalls.js';
import { sessionMarked } from './autonomyLoopProvenance.js';
import { restSummary, type SessionFacts, type TypicalCost } from './autonomyLoopSessionPrompts.js';
import { AUTONOMY_REST_REASON_MAXIMUM_CHARACTERS, sessionElapsedMilliseconds, type AutonomySession, type SessionEndCode } from './store/autonomyLoopSessions.js';
import type { AutonomyLoopCycle, AutonomyPlannedStep } from './store/autonomyLoopState.js';
import type { PreparedStep, StepDependencies } from './autonomyLoopSteps.js';
import { AUTONOMY_ROOM_LOOK_MODEL, autonomyModelCostUsd, type AutonomyModelPurpose } from './autonomyModels.js';
import { resolveAutonomyModel } from './autonomyTextModel.js';

/**
 * She paces her own day (owner decision 2026-10-02, Syzygy ADR-0003). Core.
 *
 * A session is a cycle that is not ended by a step count of six but by her own `rest`, or by one of the
 * bounds here: what one session may spend, how long it may run, how many steps it may take, how many
 * sessions a day may have, and the shortest rest between two. Each step is still one gated, journalled,
 * recorded step; this file decides only when a session may begin, when it must end, and when the next may
 * begin. The day's budget stays the gate's: nothing here allows a paid step.
 *
 * With `SHANNON_AUTONOMY_PACING=cycles` no function here is reached and the loop is what it was.
 */
export const REST_TOOL = 'study.rest';
/** The rest after a second idle session in a row, at least: about ten idle sessions fit in a day. */
export const IDLE_AGAIN_REST_MILLISECONDS = 150 * 60_000;
const DAY_MILLISECONDS = 24 * 60 * 60_000;

/** The session a cycle is, or null: under `cycles`, for a show cycle, and for a cycle begun before sessions were switched on. */
export function sessionOf(dependencies: Pick<StepDependencies, 'store' | 'loop'>, cycle: Pick<AutonomyLoopCycle, 'id' | 'kind'>): AutonomySession | null {
  if (dependencies.loop.pacing !== 'sessions' || cycle.kind !== 'activity') return null;
  return dependencies.store.loop.sessions.get(cycle.id);
}

/** Begins a session when one is due: the time she chose has come, the day has room, he is not talking, and the budget is not used up. */
export function startSessionIfDue(dependencies: StepDependencies, scopeKey: string, at: string): AutonomyLoopCycle | 'idle' | 'owner-active' | 'budget' {
  const { store, service, config, loop, showing } = dependencies;
  const dayKey = autonomyDayKey(at, config);
  const next = store.loop.nextCycleAt(scopeKey);
  if (next && Date.parse(at) < Date.parse(next)) return 'idle';
  // The shortest rest holds whatever the schedule says.
  const last = store.loop.sessions.latestClosed(scopeKey);
  if (last?.endedAt && Date.parse(at) - Date.parse(last.endedAt) < loop.sessionMinimumRestMilliseconds) return 'idle';
  if (store.loop.sessions.startedOn(scopeKey, dayKey) >= loop.sessionsPerDay) return 'idle';
  if (ownerTalking(dependencies, scopeKey, at)) return 'owner-active';
  const budget = service.overview(scopeKey).budget;
  if (budget.exhausted || store.loop.budgetBlocked(scopeKey, dayKey, budget.capYen)) return 'budget';
  return store.transaction(() => {
    const cycle = store.loop.startCycle(scopeKey, dayKey, 'activity', [], at);
    store.loop.sessions.open(cycle);
    return cycle;
  });
}

/** The owner wrote or spoke within the quiet window: her own activity stands back. */
export function ownerTalking(dependencies: Pick<StepDependencies, 'loop' | 'showing'>, scopeKey: string, at: string): boolean {
  const { loop, showing } = dependencies;
  return loop.ownerActiveMilliseconds > 0
    && showing.ownerActiveSince(scopeKey, new Date(Date.parse(at) - loop.ownerActiveMilliseconds).toISOString());
}

/** The bound that ends this session before another step, or null while it may go on. */
export function sessionBound(dependencies: Pick<StepDependencies, 'store' | 'loop'>, cycle: AutonomyLoopCycle, session: AutonomySession, at: string): Exclude<SessionEndCode, 'rest'> | null {
  const { store, loop } = dependencies;
  if (cycle.stepsTaken >= loop.maximumStepsPerSession) return 'session_steps';
  if (sessionElapsedMilliseconds(session, at) >= loop.sessionMaximumMilliseconds) return 'session_time';
  return store.loop.sessions.spentYen(cycle.id) >= loop.sessionMaximumYen ? 'session_budget' : null;
}

/** Whether a paid step of the estimated size still fits in what this session may spend. */
export function fitsSession(dependencies: Pick<StepDependencies, 'store' | 'loop'>, cycle: AutonomyLoopCycle, estimatedCostYen: number): boolean {
  if (!Number.isFinite(estimatedCostYen) || estimatedCostYen < 0) return false;
  return dependencies.store.loop.sessions.spentYen(cycle.id) + estimatedCostYen <= dependencies.loop.sessionMaximumYen;
}

/** The rest she takes: what she asked for held inside the bounds, or the default. */
export function restMilliseconds(loop: StepDependencies['loop'], minutes?: number, idle: boolean | 'again' = false): number {
  // A session in which nothing was done is followed by a short rest, not the long default; a second one in a row by a long
  // rest whatever the default is set to, so idle sessions, which are not counted, stay few in a day.
  if (idle === 'again') return Math.min(loop.sessionMaximumRestMilliseconds, Math.max(loop.sessionDefaultRestMilliseconds, IDLE_AGAIN_REST_MILLISECONDS));
  if (idle) return Math.min(loop.sessionNoPlanRestMilliseconds, loop.sessionDefaultRestMilliseconds);
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return loop.sessionDefaultRestMilliseconds;
  return Math.min(loop.sessionMaximumRestMilliseconds, Math.max(loop.sessionMinimumRestMilliseconds, Math.round(minutes) * 60_000));
}

/** Whether a session did nothing but think: no step of hers was carried out, so a `no_plan` end is followed by the short rest. */
export function nothingDone(dependencies: Pick<StepDependencies, 'store'>, cycle: Pick<AutonomyLoopCycle, 'id'>): boolean {
  return dependencies.store.loop.steps(cycle.id).every(step => step.step.kind === 'think' || step.step.kind === 'rest');
}

/**
 * Whether one more thought may follow thoughts that led to no step: the thoughts in a row stay inside the re-think limit,
 * and after `stepsTaken` steps the session has room for that thought and one step of it. A thought the gate refused (a
 * pause that landed in between) was never had and is not counted.
 */
export function mayRetryThought(dependencies: Pick<StepDependencies, 'store' | 'loop'>, cycle: Pick<AutonomyLoopCycle, 'id'>, stepsTaken: number): boolean {
  const { store, loop } = dependencies;
  const taken = store.loop.steps(cycle.id);
  let row = 0;
  for (let index = taken.length - 1; index >= 0 && taken[index]!.step.kind === 'think'; index -= 1) if (taken[index]!.status !== 'refused') row += 1;
  return row <= loop.maximumRethinksPerCycle && loop.maximumStepsPerSession - stepsTaken >= 2;
}

/** Whether the session that closed last did nothing but think: a cause that persists is then not met every half hour. */
export function idleBefore(dependencies: Pick<StepDependencies, 'store'>, scopeKey: string): boolean {
  return dependencies.store.loop.sessions.latestClosed(scopeKey)?.endCode === 'idle';
}

/** Ends the session and its cycle and sets when the next may begin, together. */
export function closeSession(
  dependencies: Pick<StepDependencies, 'store'>, cycle: Pick<AutonomyLoopCycle, 'id' | 'scopeKey'>,
  code: SessionEndCode, at: string, resumeAt: string, reason?: string,
): void {
  const { store } = dependencies;
  store.transaction(() => {
    store.loop.sessions.close(cycle.id, { at, code, resumeAt, ...(reason ? { reason } : {}) });
    store.loop.setNextCycleAt(cycle.scopeKey, resumeAt);
    store.loop.endCycle(cycle.id, code, at);
  });
}

/**
 * The step that closes a session: her own `rest`, with the time she chose and her reason, or the one the loop
 * puts in her plan when a bound stopped her. It calls no model and costs nothing; like every step it is asked
 * of the gate and recorded, so her reason and the reason a bound stopped her are both in her record.
 */
export function prepareRest(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep): PreparedStep | null {
  const session = sessionOf(dependencies, cycle);
  if (!session || session.endedAt) return null;
  const { config, loop } = dependencies;
  const forced = step.forced;
  // A marked session's reason, in her words, is not kept (ADR-0007): the rest is.
  const reason = forced || sessionMarked(dependencies, cycle) ? undefined : step.intent?.replace(/\s+/gu, ' ').trim().slice(0, AUTONOMY_REST_REASON_MAXIMUM_CHARACTERS) || undefined;
  // A session that did nothing but think ends as `idle`: a short rest the first time, the long default when the one before was idle too.
  const idle = forced === 'no_plan' && nothingDone(dependencies, cycle);
  const rest = restMilliseconds(loop, forced ? undefined : step.minutes, idle ? (idleBefore(dependencies, cycle.scopeKey) ? 'again' : true) : false);
  return {
    request: { domain: 'thinking', tool: REST_TOOL, summary: forced ? '上限に届いたので、ここで一区切りにします。' : 'ここで一区切りにして、休みます。' },
    async perform(_adapters, performAt) {
      const resumeAt = new Date(Date.parse(performAt) + rest).toISOString();
      return {
        outcome: 'done', reasonCode: forced ?? 'rest',
        summary: restSummary({ ...(forced ? { forced } : {}), resumeClock: clock(resumeAt, config.timeZone), ...(reason ? { reason } : {}) }),
        commit: (_remaining, commitAt) => {
          closeSession(dependencies, cycle, idle ? 'idle' : forced ?? 'rest', commitAt, resumeAt, reason);
          return { plan: [] };
        },
      };
    },
  };
}

/** What a step of each kind is priced at when she has not taken one lately: a usual prompt and reply of that step. */
const TYPICAL_STEPS: readonly { tool: string; label: string; purpose: AutonomyModelPurpose | 'look'; inputTokens: number; outputTokens: number }[] = Object.freeze([
  { tool: 'study.think', label: '考える', purpose: 'planning', inputTokens: 7_000, outputTokens: 500 },
  { tool: 'study.note', label: '読んだもののメモ', purpose: 'research_reading', inputTokens: 5_000, outputTokens: 600 },
  { tool: 'study.draft', label: '物語を書く', purpose: 'prose', inputTokens: 4_000, outputTokens: 2_500 },
  { tool: 'study.revise', label: '物語を直す', purpose: 'prose', inputTokens: 5_500, outputTokens: 2_500 },
  { tool: 'owner.reach_out', label: '話しかける', purpose: 'prose', inputTokens: 3_500, outputTokens: 150 },
  { tool: 'study.look', label: '部屋を見る', purpose: 'look', inputTokens: 2_300, outputTokens: 300 },
]);
const TYPICAL_COST_DAYS = 14;

/**
 * What a step usually costs her: the average of what she was charged in the last two weeks, or the price of a usual call.
 * `offered`: the steps she may plan right now that are not always there (a look, a message of her own).
 */
export function typicalCosts(dependencies: StepDependencies, scopeKey: string, at: string, offered: { look: boolean; reachOut: boolean }): (TypicalCost & { tool: string })[] {
  const { store, config, model } = dependencies;
  const measured = store.loop.sessions.typicalCosts(scopeKey, new Date(Date.parse(at) - TYPICAL_COST_DAYS * DAY_MILLISECONDS).toISOString());
  const preferences = store.modelPreferences(scopeKey);
  return TYPICAL_STEPS.flatMap(step => {
    if ((step.tool === 'study.look' && !offered.look) || (step.tool === 'owner.reach_out' && !offered.reachOut)) return [];
    const actual = measured.get(step.tool);
    if (actual && actual.count > 0) return [{ tool: step.tool, label: step.label, yen: actual.yen }];
    const id = step.purpose === 'look' ? (model.canUse(AUTONOMY_ROOM_LOOK_MODEL) ? AUTONOMY_ROOM_LOOK_MODEL : null)
      : resolveAutonomyModel(step.purpose, preferences, candidate => model.canUse(candidate));
    const costUsd = id ? autonomyModelCostUsd(id, step, config.modelPrices) : null;
    return costUsd === null ? [] : [{ tool: step.tool, label: step.label, yen: yenFromUsd(costUsd, config) }];
  });
}

/** The facts of the day and of this session that a thinking step is shown. Every number is the server's. */
export function sessionFacts(
  dependencies: StepDependencies, cycle: AutonomyLoopCycle, session: AutonomySession, at: string,
  input: { budget: AutonomyBudgetStatus; remainingReads: number; openStories: number; maximumOpenStories: number; offered: { look: boolean; reachOut: boolean }; thinkReserveYen?: number },
): SessionFacts {
  const { store, config, loop } = dependencies;
  const spent = store.loop.sessions.spentYen(cycle.id);
  const typical = typicalCosts(dependencies, cycle.scopeKey, at, input.offered);
  const previous = store.loop.sessions.latestClosed(cycle.scopeKey);
  const elapsed = sessionElapsedMilliseconds(session, at);
  return {
    localTime: ownerLocalTime(at, config.timeZone, true),
    capYen: input.budget.capYen, spentYen: input.budget.spentYen, remainingYen: input.budget.remainingYen,
    resetInMinutes: minutesToNextDay(at, config.timeZone),
    session: {
      startedClock: clock(session.startedAt, config.timeZone), steps: cycle.stepsTaken, spentYen: spent,
      // What is left of this session is never more than what is left of the day.
      remainingYen: Math.max(0, Math.min(loop.sessionMaximumYen - spent, input.budget.remainingYen)),
      remainingSteps: Math.max(0, loop.maximumStepsPerSession - cycle.stepsTaken - 1),
      remainingMinutes: Math.max(0, (loop.sessionMaximumMilliseconds - elapsed) / 60_000),
      heldMinutes: session.heldMilliseconds / 60_000,
    },
    // Counted on the day the session began, so a session that runs past midnight is still that day's.
    sessionsToday: store.loop.sessions.startedOn(cycle.scopeKey, session.dayKey), sessionsPerDay: loop.sessionsPerDay,
    typical: typical.map(item => ({ label: item.label, yen: item.yen })),
    ...(typical.find(item => item.tool === 'study.draft') ? { draftYen: typical.find(item => item.tool === 'study.draft')!.yen } : {}),
    remainingReads: input.remainingReads,
    ...(input.thinkReserveYen !== undefined ? { thinkReserveYen: input.thinkReserveYen } : {}),
    ...(input.openStories >= input.maximumOpenStories ? { studyFull: input.openStories } : {}),
    previous: previous?.endedAt && previous.endCode
      // The reason a marked session gave, in her words, is not given to a session that is not marked (ADR-0007, option a).
      ? { endedClock: clock(previous.endedAt, config.timeZone), code: previous.endCode, ...(previous.restReason && reasonShown(store, cycle, previous.cycleId) ? { reason: previous.restReason } : {}) } : null,
  };
}

function reasonShown(store: StepDependencies['store'], cycle: Pick<AutonomyLoopCycle, 'id'>, previousId: string): boolean {
  try { return !store.informed.sessionInformedAt(previousId) || store.informed.sessionInformedAt(cycle.id) !== null; } catch { return false; }
}

export function clock(at: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', { timeZone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  } catch { return at.slice(11, 16); }
}

/** Minutes until the owner-local day changes, which is when the budget starts again. */
export function minutesToNextDay(at: string, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
    const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
    return Math.max(1, 24 * 60 - (value('hour') * 60 + value('minute')));
  } catch { return 24 * 60; }
}
