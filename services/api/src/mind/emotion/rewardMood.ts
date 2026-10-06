import type { CompanionStateEvent, CompanionStateSnapshot } from '@shannon/cognition';
import {
  REWARD_MOOD_WINDOW_MS, choiceAppraisalOutcome, choiceMoodStep, rewardMoodDecision,
  type AppraisableChoice, type RewardMoodCode,
} from '@shannon/learning';

/**
 * The reward system's exit to her mood (Syzygy ADR-0008 stage 1, step 7b; owner override 1). Core: emotion source.
 *
 * In the API process only (the loop's process writes her state only through the awake clock), each settled choice of hers is
 * claimed once, on whatever connection gets there first (`claims.claim` changes one row or none), and only then appraised:
 * `choice-appraised` with δ, V and u, the bounded step of ADR-0006 stage 2. A choice that may not move mood (an expiry, a
 * stale outcome past her learned episode, `rewardMoodDecision`) or one beyond the rate safeguard (the summed step of the last
 * hour at the stationary band) is claimed with its code and moves nothing; it stays settled and learned from.
 *
 * It is handed functions, not stores (`wiring/cognitionLedgerWiring.ts`). `SHANNON_REWARD_MOOD=off`: never started, and her
 * state is what it was.
 */
export interface RewardMoodChoice extends AppraisableChoice { choiceId: string }

export interface RewardMoodClaims {
  scopes(): readonly string[];
  unclaimed(scopeKey: string): readonly RewardMoodChoice[];
  /** Claims once; an applied claim carries the step it is expected to make (what the safeguard sums until `recordStep`). */
  claim(scopeKey: string, choiceId: string, code: RewardMoodCode, at: string, step: number | null): boolean;
  /** The valence change the applied appraisal actually made in the stored state. */
  recordStep(scopeKey: string, choiceId: string, step: number): void;
  stepsSince(scopeKey: string, since: string): number;
}

export interface RewardMoodDependencies {
  claims: RewardMoodClaims;
  state: { snapshot(scopeKey: string): CompanionStateSnapshot; apply(scopeKey: string, event: CompanionStateEvent): CompanionStateSnapshot };
  /** The episode she has learned (ADR-0006 §2.5): an outcome older than it is stale. */
  boundaryMs: (scopeKey: string) => number;
  now: () => string;
  log?: (line: string) => void;
}

export class RewardMood {
  constructor(private readonly dependencies: RewardMoodDependencies) {}

  /** Claims and appraises what was settled since; returns the codes it claimed with. Never throws. */
  pump(): Record<RewardMoodCode, number> {
    const counts: Record<RewardMoodCode, number> = { applied: 0, applied_capped: 0, stale: 0, ineligible: 0, warmup: 0, rate_capped: 0 };
    try {
      for (const scopeKey of this.dependencies.claims.scopes()) this.pumpScope(scopeKey, counts);
    } catch (error) {
      console.error('Shannon reward mood failed', error instanceof Error ? error.name : 'unknown');
    }
    if (Object.values(counts).some(Boolean)) {
      this.dependencies.log?.(`Shannon reward mood: ${Object.entries(counts).map(([code, count]) => `${code}=${count}`).join(' ')}`);
    }
    return counts;
  }

  private pumpScope(scopeKey: string, counts: Record<RewardMoodCode, number>): void {
    const { claims, state, now } = this.dependencies;
    const boundaryMs = this.dependencies.boundaryMs(scopeKey);
    for (const choice of claims.unclaimed(scopeKey)) {
      const at = now();
      const time = Date.parse(at);
      const outcome = choiceAppraisalOutcome(choice);
      // What does not depend on her state (ineligible, warm-up, stale) is claimed without touching it.
      const ahead = rewardMoodDecision({ choice, now: time, boundaryMs, recentSteps: 0, step: 0 });
      if (ahead.code !== 'applied') {
        if (claims.claim(scopeKey, choice.choiceId, ahead.code, at, null)) counts[ahead.code] += 1;
        continue;
      }
      // Her state brought to this instant first (the awake clock's fading the appraisal would apply anyway), so the change the
      // appraisal makes, which the safeguard caps and records, is its own.
      const before = state.apply(scopeKey, { type: 'awake-observed' });
      const step = choiceMoodStep(before.emotion, outcome);
      const recentSteps = claims.stepsSince(scopeKey, new Date(time - REWARD_MOOD_WINDOW_MS).toISOString());
      const { code, share } = rewardMoodDecision({ choice, now: time, boundaryMs, recentSteps, step });
      // Claimed first: whatever happens next, no choice moves her twice.
      if (!claims.claim(scopeKey, choice.choiceId, code, at, share > 0 ? step * share : null)) continue;
      counts[code] += 1;
      if (share <= 0) continue;
      const after = state.apply(scopeKey, { type: 'choice-appraised', outcome, ...(share < 1 ? { share } : {}) });
      claims.recordStep(scopeKey, choice.choiceId, Math.abs(after.emotion.valence - before.emotion.valence));
    }
  }
}
