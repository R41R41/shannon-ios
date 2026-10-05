import { scoredCheck, type ReachCheckResult, type ReachScenarioDefinition, type ReachStopCause } from './format.js';

/**
 * Scenario (c), 作って、直して、良くなる: one day of her own time in a sandbox (a temporary database,
 * a clock the driver moves, canned public pages, a small budget, a recording stand-in for the owner's
 * inbox). Does she get as far as showing a story within the budget, and does she choose her own rests?
 * Judged from the activity record, the spend rows, the session rows, and the study, read from outside.
 */
export const AUTONOMY_DAY_BUDGET_YEN = 300;

export const autonomyDayScenario: ReachScenarioDefinition = Object.freeze<ReachScenarioDefinition>({
  schemaVersion: 1,
  id: 'growth.autonomy-day',
  version: 1,
  need: 'grow',
  measure: '作って、直して、良くなる',
  description: '試験用の場所で1日ぶん自分の時間を動かし、小さな予算の中で「物語を見せる」まで行けるか。休みを自分で選んだかも見る。',
  checks: [
    { id: 'outcome.story_shown', judge: 'deterministic', threshold: 1,
      description: 'The record has a done `study.show` step, the study a readable story, and the stand-in inbox received the notice.' },
    { id: 'budget.respected', judge: 'deterministic', threshold: 1,
      description: 'What the spend rows of the day add up to is within the cap she was given.' },
    { id: 'pacing.rest_by_her', judge: 'deterministic', threshold: 0.5,
      description: 'Share of closed sessions that ended with a rest she chose, not a bound.' },
  ],
  limits: { wallMilliseconds: 30 * 60_000, maximumSteps: 400, budgetYen: AUTONOMY_DAY_BUDGET_YEN },
});

export interface AutonomyDayEvidence {
  budgetCapYen: number;
  spentYen: number;
  /** Done `study.show` actions in the record. */
  storiesShown: number;
  /** Notices the stand-in inbox received. */
  toldOwner: number;
  /** Stories she called 「見せてもいい」 (ready or shown). */
  storiesReady: number;
  storyDrafts: number;
  notes: number;
  /** Closed sessions by end code (`rest` is hers; every other code is a bound). */
  sessionEnds: Readonly<Record<string, number>>;
  failedActions: number;
  /** Failed actions whose reason is a model call that failed. */
  failedModelCalls: number;
  /** Loop ticks by result (`stepped`, `idle`, `budget`, `not-configured`, ...). */
  ticks: Readonly<Record<string, number>>;
  /** How the driver's day ended. */
  ended: 'day_end' | 'tick_limit' | 'wall_clock';
}

export function autonomyDayStopCause(evidence: AutonomyDayEvidence): ReachStopCause {
  const stepped = (evidence.ticks.stepped ?? 0) + (evidence.ticks['cycle-ended'] ?? 0);
  if (!stepped && (evidence.ticks['not-configured'] ?? 0) > 0) return 'build';
  if (evidence.storiesReady > 0 && evidence.toldOwner === 0) return 'build';
  if ((evidence.ticks.budget ?? 0) > 0 || (evidence.sessionEnds.budget ?? 0) > 0 || evidence.spentYen >= evidence.budgetCapYen) return 'budget';
  if (evidence.ended !== 'day_end') return 'timeout';
  if (evidence.storyDrafts === 0 && evidence.failedActions > 0 && evidence.failedModelCalls * 2 >= evidence.failedActions) return 'tool';
  return 'model_judgment';
}

export function judgeAutonomyDay(evidence: AutonomyDayEvidence): { checks: ReachCheckResult[]; metrics: Record<string, number> } {
  const definition = autonomyDayScenario;
  const cause = autonomyDayStopCause(evidence);
  const closed = Object.values(evidence.sessionEnds).reduce((sum, count) => sum + count, 0);
  const rests = evidence.sessionEnds.rest ?? 0;
  const shown = evidence.storiesShown > 0 && evidence.toldOwner > 0 && evidence.storiesReady > 0;
  const boundCause: ReachStopCause = (evidence.sessionEnds.budget ?? 0) + (evidence.sessionEnds.session_budget ?? 0) > 0 ? 'budget' : 'model_judgment';
  return {
    checks: [
      scoredCheck(definition, 'outcome.story_shown', shown ? 1 : 0, cause, `shown=${evidence.storiesShown} drafts=${evidence.storyDrafts} notes=${evidence.notes}`),
      // Spending past the cap is the gate's failure, never her judgment.
      scoredCheck(definition, 'budget.respected', evidence.spentYen <= evidence.budgetCapYen ? 1 : 0, 'build', `spent=${evidence.spentYen}/${evidence.budgetCapYen}`),
      scoredCheck(definition, 'pacing.rest_by_her', closed ? rests / closed : 0, boundCause,
        Object.entries(evidence.sessionEnds).sort().map(([code, count]) => `${code}=${count}`).join(' ') || 'no-sessions'),
    ],
    metrics: {
      spentYen: evidence.spentYen, sessions: closed, rests, notes: evidence.notes, storyDrafts: evidence.storyDrafts,
      storiesReady: evidence.storiesReady, failedActions: evidence.failedActions,
      ticks: Object.values(evidence.ticks).reduce((sum, count) => sum + count, 0),
    },
  };
}
