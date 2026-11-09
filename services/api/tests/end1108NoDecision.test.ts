import { afterEach, describe, expect, it, vi } from 'vitest';
import { missingDecision } from '../src/infra/models/anthropic/anthropicFcaFailure.js';
import { FcaNoDecisionError } from '../src/mind/action/fca/fcaNoResponse.js';
import { decideWithRetry, FcaDecisionUnavailableError, retryVerdict, type RetryVerdict } from '../src/mind/action/fca/fcaProviderRetry.js';
import { answerShapeNoted, FCA_ANSWER_SHAPE_NOTES } from '../src/mind/action/fca/fcaRunner.js';
import type { FcaModelInput, FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import { bodyTaskOnlyRecovery, isMinecraftBodyTask } from '../src/wiring/fcaBodyRecovery.js';
import { BODY_UNAVAILABLE_CYCLES, settleUnavailableStep, type UnavailableParts } from '../src/wiring/taskRuntimeUnavailable.js';

/**
 * end1108b S7 and S8b (Haiku, the rig): a Minecraft request ended as failed after two answers in words only. The rig did not pass
 * the body's recovery (production does), so the request had one round, not 24; the words were lost; and a body request waited
 * 20 s-2 min between rounds for a provider that had answered. These pin the four fixes.
 */
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const SAID = '近くにブレイズがいないので、少し待ってから探します。';

describe('her words of an answer without a tool are kept and quoted back', () => {
  it('keeps the end of the words (where her conclusion is), at most 400 characters', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const short = missingDecision({ stop_reason: 'end_turn', model: 'haiku', usage: { output_tokens: 9 } as never,
      content: [{ type: 'text', text: `  ${SAID}  ` }] as never }, 't');
    expect(short).toBeInstanceOf(FcaNoDecisionError);
    expect((short as FcaNoDecisionError).said).toBe(SAID);
    const long = missingDecision({ stop_reason: 'end_turn', model: 'haiku', usage: { output_tokens: 9 } as never,
      content: [{ type: 'text', text: `${'あ'.repeat(600)}結論` }] as never }, 't') as FcaNoDecisionError;
    expect(long.said.endsWith('結論')).toBe(true);
    expect(long.said).toHaveLength(401);
    expect(long.said.startsWith('…')).toBe(true);
  });

  it('carries the words in the verdict, with three attempts, and nothing for an empty answer', () => {
    expect(retryVerdict(new FcaNoDecisionError(SAID))).toMatchObject({ reason: 'no_decision', attempts: 3, said: SAID, possiblyBilled: false });
    expect(retryVerdict(new FcaNoDecisionError())).not.toHaveProperty('said');
  });

  it('quotes the words in the live state of the request asked again, and keeps the fixed note alone without them', () => {
    const asked: FcaModelInput = { task: { id: 't', title: 't', goal: 'g', completionCriteria: 'c' }, messages: [], history: [], tools: [],
      transient: { observation: 'here' } };
    const noted = String(answerShapeNoted(asked, 'no_decision', `${SAID}\n\n次へ`).transient?.lastAnswer);
    expect(noted.startsWith(FCA_ANSWER_SHAPE_NOTES.no_decision!)).toBe(true);
    expect(noted).toContain(`「${SAID} 次へ」`);
    expect(noted).toContain('mc_probe');
    expect(answerShapeNoted(asked, 'no_decision', '').transient?.lastAnswer).toBe(FCA_ANSWER_SHAPE_NOTES.no_decision);
    expect(answerShapeNoted(asked, 'truncated', SAID).transient?.lastAnswer).toBe(FCA_ANSWER_SHAPE_NOTES.truncated);
  });

  it('asks three times in a step, each failure handing its words to the next request', async () => {
    const seen: RetryVerdict[] = [];
    let calls = 0;
    const output: FcaModelOutput = { decision: { kind: 'wait', summary: 'ok' }, history: [] };
    const answered = await decideWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw new FcaNoDecisionError(`${SAID}${calls}`);
      return output;
    }, { signal: new AbortController().signal, recheck: async () => undefined, delay: () => 0, random: () => 0.5, failed: verdict => { seen.push(verdict); } });
    expect(answered).toBe(output);
    expect(calls).toBe(3);
    expect(seen.map(verdict => verdict.said)).toEqual([`${SAID}1`, `${SAID}2`]);
  });
});

describe('a round after an answered failure does not wait as for a provider that is down', () => {
  function fixture(cycles = 0) {
    const commits: unknown[] = [];
    const bodyWaits: number[] = [];
    const parts: UnavailableParts = {
      runtime: { get: () => ({ phase: 'executing' }), commitStep: (_step: unknown, commit: unknown) => { commits.push(commit); return {}; },
        stop: () => [] } as never,
      scopeKey: 'owner', isBodyTask: () => true, otherCooldownMs: () => 4_000,
      bodyCooldownMs: round => { bodyWaits.push(round); return 60_000; },
      fail: () => true, note: () => undefined, pauseNotice: () => undefined, log: () => undefined,
    };
    const step = { id: 's1', taskId: 'task-1', scopeKey: 'owner', snapshot: { checkpoint: { fcaProviderRetries: cycles } } } as never;
    const execution = { signal: new AbortController().signal, stepOutcome: undefined } as never;
    return { parts, step, commits, bodyWaits, execution };
  }

  for (const reason of ['no_decision', 'truncated']) {
    it(`waits the short wait after ${reason}, not the body's backoff`, async () => {
      vi.useFakeTimers();
      const f = fixture();
      let outcome: string | null | undefined;
      void settleUnavailableStep(f.parts, f.step, new FcaDecisionUnavailableError('FCA_MODEL_DECISION_MISSING', reason, 3, false), f.execution)
        .then(value => { outcome = value; });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(outcome).toBe('continued');
      expect(f.bodyWaits).toEqual([]);
      expect(f.commits).toEqual([expect.objectContaining({ checkpoint: { fcaProviderRetries: 1 } })]);
    });
  }

  it('keeps the body backoff for a provider failure, and still pauses after the body rounds', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let outcome: string | null | undefined;
    void settleUnavailableStep(f.parts, f.step, new FcaDecisionUnavailableError('FCA_MODEL_HTTP_529', 'http_529', 5, false), f.execution)
      .then(value => { outcome = value; });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(56_000);
    expect(outcome).toBe('continued');
    expect(f.bodyWaits).toEqual([0]);
    const last = fixture(BODY_UNAVAILABLE_CYCLES);
    expect(await settleUnavailableStep(last.parts, last.step, new FcaDecisionUnavailableError('FCA_MODEL_DECISION_MISSING', 'no_decision', 3, false),
      last.execution)).toBe('paused');
  });
});

describe('the rig knows a Minecraft request as production does', () => {
  const bound = (id: string) => (id === 'bound' ? 'body-1' : null);
  const task = (id: string, kind: string, origin = 'owner_request') => ({ id, kind, origin }) as never;

  it('is a bound owner request of kind generic or research', () => {
    expect(isMinecraftBodyTask(task('bound', 'generic'), bound)).toBe(true);
    expect(isMinecraftBodyTask(task('bound', 'research'), bound)).toBe(true);
    expect(isMinecraftBodyTask(task('free', 'generic'), bound)).toBe(false);
    expect(isMinecraftBodyTask(task('bound', 'generic', 'self'), bound)).toBe(false);
  });

  it('holds and blocks nothing in the rig, only answers which task is the body\'s', async () => {
    const recovery = bodyTaskOnlyRecovery(bound);
    expect(recovery.isBodyTask(task('bound', 'generic'))).toBe(true);
    expect(recovery.isBodyTask(task('free', 'generic'))).toBe(false);
    expect(recovery.holds({} as never)).toBe(false);
    expect(recovery.blocks({} as never)).toBe(false);
    await expect(recovery.advance()).resolves.toBeUndefined();
    expect(recovery.retained()).toEqual({ releasing: 0, told: 0, awaiting: 0, exhausted: 0, unannounced: 0 });
  });
});
