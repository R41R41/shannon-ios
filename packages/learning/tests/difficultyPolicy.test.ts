import { describe, expect, it } from 'vitest';
import {
  SONNET_FIRST_TOKEN_ESTIMATE_MS, VOICE_SONNET_MARGIN_MS, competenceMean, conversationGrowth, decideTier, escalatedTier, moodEligible, nextTurnServe, tierOutcome,
  type DifficultyAnswers, type DifficultyContext,
} from '../src/index.js';

const answers = (extra: Partial<DifficultyAnswers> = {}): DifficultyAnswers => ({ taskKind: 'lookup', needsStrongModel: 0.1, needsVerification: 0.1, multiStep: 0.1, ...extra });
const text = (extra: Partial<DifficultyContext> = {}): DifficultyContext => ({ surface: 'text', answers: answers(), lunaCompetence: null, sonnetAvailable: false, ...extra });

describe('the difficulty policy (ADR-0008 stage 2, step 4)', () => {
  it('starts with luna, and stays on luna when Jev could not answer', () => {
    expect(decideTier(text())).toMatchObject({ tier: 'luna', served: 'luna', reason: 'plain', escalateOnTrouble: false, verify: false });
    expect(decideTier(text({ answers: null }))).toMatchObject({ tier: 'luna', served: 'luna', reason: 'no_answers', rethinks: 0 });
    expect(decideTier(text({ answers: answers({ taskKind: 'chat', needsStrongModel: 0.05, multiStep: 0.05 }) }))).toMatchObject({ tier: 'jev_only', served: 'luna', reason: 'small_talk' });
  });

  it('asks for Sonnet at p ≥ 0.65 or when luna is learned to be weak at the kind, and serves it as luna_plus without the key and the switch', () => {
    expect(decideTier(text({ answers: answers({ needsStrongModel: 0.7 }) }))).toMatchObject({ tier: 'sonnet', served: 'luna_plus', mappedDown: 'unavailable', reason: 'strong' });
    expect(decideTier(text({ answers: answers({ needsStrongModel: 0.7 }), sonnetAvailable: true }))).toMatchObject({ tier: 'sonnet', served: 'sonnet', mappedDown: 'none' });
    // Learned weakness needs five outcomes and a mean below 0.6.
    expect(decideTier(text({ lunaCompetence: { successes: 1, failures: 4 } }))).toMatchObject({ tier: 'sonnet', reason: 'luna_weak' });
    expect(decideTier(text({ lunaCompetence: { successes: 1, failures: 3 } }))).toMatchObject({ tier: 'luna' });
    expect(decideTier(text({ lunaCompetence: { successes: 5, failures: 2 } }))).toMatchObject({ tier: 'luna' });
  });

  it('escalates the middle once on trouble, and gives a multi-step turn luna_plus', () => {
    expect(decideTier(text({ answers: answers({ needsStrongModel: 0.5 }) }))).toMatchObject({ tier: 'luna', reason: 'middle', escalateOnTrouble: true });
    expect(decideTier(text({ answers: answers({ multiStep: 0.8 }) }))).toMatchObject({ tier: 'luna_plus', served: 'luna_plus', reason: 'multi_step', rethinks: 1 });
    expect(escalatedTier('luna', false)).toBe('luna_plus');
    expect(escalatedTier('luna', true)).toBe('sonnet');
    expect(escalatedTier('luna_plus', true)).toBeNull();
    expect(escalatedTier('sonnet', true)).toBeNull();
  });

  it('serves Sonnet on voice only when the turn\'s time can absorb its first token, else luna', () => {
    const voice = (remainingMs: number, sonnetFirstTokenMs: number | null = null) => decideTier({ ...text({ answers: answers({ needsStrongModel: 0.9 }), sonnetAvailable: true }), surface: 'voice', voice: { remainingMs, sonnetFirstTokenMs } });
    expect(voice(SONNET_FIRST_TOKEN_ESTIMATE_MS + VOICE_SONNET_MARGIN_MS)).toMatchObject({ served: 'sonnet' });
    expect(voice(SONNET_FIRST_TOKEN_ESTIMATE_MS + VOICE_SONNET_MARGIN_MS - 1)).toMatchObject({ served: 'luna', mappedDown: 'voice_time' });
    // The measured latency (step 5's hook) wins over the estimate.
    expect(voice(10_000, 5_000)).toMatchObject({ served: 'luna', mappedDown: 'voice_time' });
    // Without the key, voice is luna_plus like text (inert in steps 1–4).
    expect(decideTier({ ...text({ answers: answers({ needsStrongModel: 0.9 }) }), surface: 'voice', voice: { remainingMs: 1, sonnetFirstTokenMs: null } })).toMatchObject({ served: 'luna_plus', mappedDown: 'unavailable' });
  });

  it('turns closed outcome signals into G, S and a competence outcome, and an expired turn never moves mood', () => {
    expect(conversationGrowth([true, true, false])).toBeCloseTo(2 / 3);
    expect(conversationGrowth([])).toBe(0);
    expect([nextTurnServe(0.1), nextTurnServe(0.5), nextTurnServe(0.9)]).toEqual([1, 0.5, 0]);
    expect(tierOutcome(1, 1)).toBe(1);
    expect(tierOutcome(1, 0)).toBe(0);
    expect(tierOutcome(1 / 3, null)).toBe(0);
    expect(competenceMean({ successes: 3, failures: 1 })).toEqual({ mean: 4 / 6, n: 4 });
    expect(competenceMean(null)).toEqual({ mean: 0.5, n: 0 });
    expect(moodEligible({ status: 'settled', settleCode: 'turn_expired', delta: 0.2 })).toBe(false);
    expect(moodEligible({ status: 'settled', settleCode: 'next_turn', delta: 0.2 })).toBe(true);
  });
});
