import { describe, expect, it } from 'vitest';
import { decideTier, jevBand, nextTurnServe, type DifficultyAnswers } from '@shannon/learning';
import { checkedTrace } from '../src/contracts/decisionTraceContract.js';
import {
  JEV_CACHE_MILLISECONDS, JEV_QUESTION_SETS, JevChooser, replayedAnswers, type JevChoiceTrace,
} from '../src/infra/models/jev/jevChoice.js';
import { TracedVoiceDecisionGateway } from '../src/mind/inhibition/tracedVoiceDecision.js';
import { JevTurnChooser, type TurnChoices } from '../src/mind/selectors/turnChoices.js';
import { LocalVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import { configuredVoiceDecision } from '../src/wiring/cognitionLedgerWiring.js';

/**
 * Syzygy ADR-0008 §14 (`docs/skill-and-routing-contract.md`, 「Jev の使い方」): Jev is acted on only inside its confidence band,
 * its question sets are fixed and versioned, the same input is answered from a short cache, and every decision replays from its trace.
 */
const AT = '2026-10-07T03:00:00.000Z';
const MENU = [{ name: 'study.list', summary: '書斎の一覧', group: 'study' }, { name: 'study.create', summary: '書斎に書く', group: 'study' }];

function scriptedClient(answer: (questions: Readonly<Record<string, unknown>>) => Record<string, unknown>) {
  const calls: Array<{ state: unknown; questions: Readonly<Record<string, unknown>> }> = [];
  return {
    calls,
    client: {
      model: 'jev-test',
      ask: async (state: unknown, questions: Readonly<Record<string, unknown>>) => { calls.push({ state, questions }); return { answers: answer(questions) }; },
    },
  };
}

const turnAnswers = (strong: number, retry: number) => (questions: Readonly<Record<string, unknown>>) => ({
  ...(questions.tool ? { tool: { type: 'choice', choice: 'study.create' } } : {}),
  task_kind: { type: 'choice', choice: 'write' }, needs_strong_model: { type: 'noul', noul: strong }, needs_verification: { type: 'noul', noul: 0.4 },
  multi_step: { type: 'noul', noul: 0.05 }, retry_or_correction: { type: 'noul', noul: retry },
});

describe('Jev\'s question sets, cache and replay (ADR-0008 §14)', () => {
  it('records the fixed question sets, their language, digests of the questions and the input, and the raw answers', async () => {
    const traces: JevChoiceTrace[] = [];
    const { client } = scriptedClient(turnAnswers(0.95, 0.5));
    const chooser = new JevTurnChooser(new JevChooser(client, { usdPerCall: 0.001, now: () => AT, trace: (_scope, trace) => { traces.push(trace); } }), { toolMenu: true, difficulty: true });
    await chooser.choose({ scopeKey: 'owner', surface: 'text', words: '書斎にメモを書いて', menu: MENU, previousReply: '書いたよ' });
    const answers = traces[0]!.answers;
    expect(answers).toMatchObject({ qv: [JEV_QUESTION_SETS.toolMenu, JEV_QUESTION_SETS.difficulty, JEV_QUESTION_SETS.retry], ql: 'en', cached: false,
      'a.tool': 'study.create', 'a.task_kind': 'write', 'a.needs_strong_model': 0.95, 'a.retry_or_correction': 0.5 });
    expect(answers.qh).toMatch(/^q[0-9a-f]{16}$/u);
    expect(answers.h).toMatch(/^h[0-9a-f]{16}$/u);
    // Every value is a closed one the decision traces accept, and no word of the turn is in it.
    expect(() => checkedTrace({ ...traces[0]!, decider: 'jev', fallbackDecider: null, relatedId: null })).not.toThrow();
    expect(JSON.stringify(traces[0])).not.toMatch(/書斎|メモ|書いた/u);
  });

  it('replays a decision from its trace alone', async () => {
    const traces: JevChoiceTrace[] = [];
    const { client } = scriptedClient(turnAnswers(0.95, 0.93));
    const live = new JevTurnChooser(new JevChooser(client, { usdPerCall: null, now: () => AT, trace: (_scope, trace) => { traces.push(trace); } }), { toolMenu: true, difficulty: true });
    const request = { scopeKey: 'owner', surface: 'text' as const, words: '書斎にメモを書いて', menu: MENU, previousReply: '書いたよ' };
    const decided = await live.choose(request);
    // A Jev that answers only what the trace recorded gives the same choices, the same tier and the same S.
    const replay = new JevTurnChooser(new JevChooser({ model: 'jev-test', ask: async () => ({ answers: replayedAnswers(traces[0]!.answers) }) }, { usdPerCall: null }), { toolMenu: true, difficulty: true });
    const replayed: TurnChoices = await replay.choose(request);
    expect(replayed).toEqual(decided);
    const tier = (choices: TurnChoices) => decideTier({ surface: 'text', answers: choices.difficulty as DifficultyAnswers, lunaCompetence: null, sonnetAvailable: true });
    expect(tier(replayed)).toEqual(tier(decided));
    expect(tier(decided)).toMatchObject({ tier: 'sonnet', verify: false });
    expect(nextTurnServe(replayed.retry!)).toBe(0);
  });

  it('answers the same input from the cache within its time, at no cost, and asks again after it or for another input', async () => {
    const traces: JevChoiceTrace[] = [];
    let now = 0;
    const { client, calls } = scriptedClient(turnAnswers(0.5, 0.5));
    const jev = new JevChooser(client, { usdPerCall: 0.001, now: () => AT, clock: () => now, trace: (_scope, trace) => { traces.push(trace); } });
    const chooser = new JevTurnChooser(jev, { toolMenu: false, difficulty: true });
    const request = { scopeKey: 'owner', surface: 'text' as const, words: 'これ考えて', menu: [] };
    const first = await chooser.choose(request);
    now = JEV_CACHE_MILLISECONDS - 1;
    expect(await chooser.choose(request)).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(traces[1]).toMatchObject({ outcome: 'ok', costUsd: 0, answers: { cached: true, h: traces[0]!.answers.h } });
    // Another scope, another input, or the time run out: a new call.
    await chooser.choose({ ...request, scopeKey: 'guest' });
    await chooser.choose({ ...request, words: '別のこと' });
    now = 2 * JEV_CACHE_MILLISECONDS;
    await chooser.choose(request);
    expect(calls).toHaveLength(4);
  });

  it('never caches an answer it could not use', async () => {
    let usable = false;
    const { client, calls } = scriptedClient(questions => (usable ? turnAnswers(0.5, 0.5)(questions) : { nothing: true }));
    const chooser = new JevTurnChooser(new JevChooser(client, { usdPerCall: null }), { toolMenu: false, difficulty: true });
    const request = { scopeKey: 'owner', surface: 'text' as const, words: 'これ考えて', menu: [] };
    expect(await chooser.choose(request)).toMatchObject({ difficulty: null });
    usable = true;
    expect(await chooser.choose(request)).toMatchObject({ difficulty: { needsStrongModel: 0.5 } });
    expect(calls).toHaveLength(2);
  });

  it('names the voice router\'s question set only with stage 2 on', async () => {
    const drafts: Array<Record<string, unknown>> = [];
    const input = { scopeKey: 'owner', transcript: 'ただいま', participantMode: 'owner' as const, requestedLocation: false, hasFreshLocation: false };
    await new TracedVoiceDecisionGateway(new LocalVoiceDecisionGateway(), (_scope, draft) => { drafts.push(draft.answers); }, { usdPerJevCall: null, now: () => AT,
      questionSet: { id: JEV_QUESTION_SETS.voiceRoute, language: 'en' } }).decide(input);
    expect(drafts[0]).toMatchObject({ qv: ['voice_route.v1'], ql: 'en' });
    const off: Array<Record<string, unknown>> = [];
    await configuredVoiceDecision({ SHANNON_ADR8_STAGE2: 'off' }, undefined, (_scope, draft) => { off.push(draft.answers); }).decide(input);
    expect(off[0]).not.toHaveProperty('qv');
    const on: Array<Record<string, unknown>> = [];
    await configuredVoiceDecision({}, undefined, (_scope, draft) => { on.push(draft.answers); }).decide(input);
    // With her weather tool (the read tools, on by default) the router also asks about the weather: v2 (2026-10-13 daily evals).
    expect(on[0]).toMatchObject({ qv: ['voice_route.v2'], ql: 'en' });
    const noReads: Array<Record<string, unknown>> = [];
    await configuredVoiceDecision({ SHANNON_READ_TOOLS: 'off' }, undefined, (_scope, draft) => { noReads.push(draft.answers); }).decide(input);
    expect(noReads[0]).toMatchObject({ qv: ['voice_route.v1'], ql: 'en' });
  });

  it('keeps every band decision on one side of 0.9 and 0.1', () => {
    expect([0.1, 0.10001, 0.89999, 0.9].map(jevBand)).toEqual(['no', 'unsure', 'unsure', 'yes']);
  });
});
