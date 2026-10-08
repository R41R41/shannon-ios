import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { stationaryBand } from '@shannon/cognition';
import type { DifficultyAnswers } from '@shannon/learning';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { OpenAIResponsesChatModel, type ShannonChatModel, type ShannonChatModelRequest, type ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { CONVERSATION_TOOL_CALLS, functionCallsOf, withToolRounds, type ShannonModelToolSession } from '../src/infra/models/chatModelTools.js';
import { chatTurnRequestBody } from '../src/infra/models/chatModelTurn.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../src/mind/action/respond/turnDeadline.js';
import { finishTurn, talkId, tierRequest, turnDoing } from '../src/mind/action/respond/turnRouting.js';
import { TALK_NEXT_TURN_MINUTES } from '../src/mind/learning/rewardSettlement.js';
import { SQLiteTierOutcomes } from '../src/mind/selectors/store/sqliteTierOutcomes.js';
import { TierCompetence } from '../src/mind/selectors/tierCompetence.js';
import { WRITE_CLAIM_CORRECTION, verifiedReply, verifyWriteClaims, writeClaims } from '../src/mind/selectors/turnVerifier.js';
import type { TurnChooser } from '../src/mind/selectors/turnChoices.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import { startRewardMood } from '../src/wiring/cognitionLedgerWiring.js';
import { configuredTurnRouting, recordTurn } from '../src/wiring/turnRoutingWiring.js';

/** Syzygy ADR-0008 stage 2, step 4: difficulty, tiers, the verifier, and her conversation choices in reward (owner answer I-3). */
const directory = mkdtempSync(join(tmpdir(), 'shannon-turn-routing-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const START = Date.parse('2026-10-07T03:00:00.000Z');
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
let files = 0;

describe('the turn verifier', () => {
  it('finds a claim of a write of hers, not a question, a denial or a word about something else', () => {
    expect(writeClaims('書斎にメモを保存しました。')).toHaveLength(1);
    expect(writeClaims('物語の続きを書いておきました！')).toHaveLength(1);
    expect(writeClaims('Aetherに提案を送りました。')).toHaveLength(1);
    for (const reply of ['メモを保存しましょうか？', 'まだメモは保存していません。', '昨日は映画を見ました。', 'ファイルを読みました。', 'メモを書きましたか？', '保存できませんでした。']) {
      expect(writeClaims(reply), reply).toEqual([]);
    }
  });

  it('flags a claim with no write that worked in the turn, and adds one fixed line in her voice', () => {
    expect(verifyWriteClaims('メモを保存しました。', [])).toBe('claim_without_write');
    expect(verifyWriteClaims('メモを保存しました。', [{ name: 'study.create', effect: 'write', ok: false }])).toBe('claim_without_write');
    expect(verifyWriteClaims('メモを保存しました。', [{ name: 'study.list', effect: 'read', ok: true }])).toBe('claim_without_write');
    expect(verifyWriteClaims('メモを保存しました。', [{ name: 'study.create', effect: 'write', ok: true }])).toBe('ok');
    expect(verifyWriteClaims('こんにちは。', [])).toBe('ok');
    expect(verifiedReply('メモを保存しました。', 'claim_without_write')).toBe(`メモを保存しました。\n${WRITE_CLAIM_CORRECTION}`);
    expect(verifiedReply('はい。', 'ok')).toBe('はい。');
    expect(WRITE_CLAIM_CORRECTION).toMatch(/ライ氏/u);
  });
});

describe('the tiers in the model adapter', () => {
  const base = { scopeKey: 'owner', systemPrompt: '[テスト]', history: [], message: 'x' };
  it('sends luna_plus as luna thinking one step longer, and plain luna as it was', () => {
    expect(chatTurnRequestBody('gpt-5.6-luna', base, undefined).reasoning).toEqual({ effort: 'none' });
    expect(chatTurnRequestBody('gpt-5.6-luna', { ...base, tier: 'luna_plus' }, undefined).reasoning).toEqual({ effort: 'low' });
    expect(JSON.stringify(chatTurnRequestBody('gpt-5.6-luna', { ...base, ...tierRequest(null) }, undefined))).toBe(JSON.stringify(chatTurnRequestBody('gpt-5.6-luna', base, undefined)));
  });

  it('escalates once at a round boundary after a tool failed, and never once her words have started', async () => {
    const failing: ShannonModelToolSession = {
      definitions: [shannonTool('study.list')!], maximumCalls: CONVERSATION_TOOL_CALLS, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
      async call() { return JSON.stringify({ ok: false, text: 'だめ', failure: 'unavailable', retryable: true }); },
    };
    const run = async (allowed: boolean) => {
      const sent: Array<Record<string, unknown>> = [];
      let escalations = 0;
      let round = 0;
      await withToolRounds({ input: [], reasoning: { effort: 'none' } }, failing, async body => {
        sent.push(body);
        round += 1;
        return round <= 2 ? { output: [{ type: 'function_call', call_id: `c${round}`, name: 'study_list', arguments: '{}' }] } : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }] };
      }, {
        isAnswer: envelope => !functionCallsOf(envelope).length, outOfTime: () => 'out',
        escalate: { allowed: () => allowed, body: body => ({ ...body, reasoning: { effort: 'low' } }), onEscalated: () => { escalations += 1; } },
      });
      return { efforts: sent.map(body => (body.reasoning as { effort: string }).effort), escalations };
    };
    expect(await run(true)).toEqual({ efforts: ['none', 'low', 'low'], escalations: 1 });
    expect(await run(false)).toEqual({ efforts: ['none', 'none', 'none'], escalations: 0 });
  });

  it('reports an escalated turn, and never escalates a turn that is already luna_plus', async () => {
    let round = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      round += 1;
      return new Response(JSON.stringify(round === 1 ? { output: [{ type: 'function_call', call_id: 'c1', name: 'study_list', arguments: '{}' }] }
        : { output_text: JSON.stringify({ reply: 'はい。', threadSummary: null, threadTitle: null, taskDecision: { disposition: 'none', reason: 'x' }, taskProposal: null, intentPlan: null, artifacts: null }) }));
    }) as unknown as typeof fetch;
    const tools: ShannonModelToolSession = { definitions: [shannonTool('study.list')!], maximumCalls: 6, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
      async call() { return JSON.stringify({ ok: false, text: 'だめ', failure: 'failed', retryable: true }); } };
    const model = new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher });
    const result = await model.generate({ ...base, tools, escalation: true });
    expect(result.escalated).toBe(true);
    expect(bodies.map(body => (body.reasoning as { effort: string }).effort)).toEqual(['none', 'low']);
    round = 0; bodies.length = 0;
    const plus = await model.generate({ ...base, tools, tier: 'luna_plus', escalation: true });
    expect(plus.escalated).toBeUndefined();
    expect(bodies.map(body => (body.reasoning as { effort: string }).effort)).toEqual(['low', 'low']);
  });
});

class RecordingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly all: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  constructor(private readonly reply = 'はい。') {}
  async generate(request: ShannonChatModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: this.reply }; }
  async generateVoice(request: ShannonVoiceModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: this.reply }; }
}

function world(environment: Record<string, string> = {}) {
  const clock = { at: at(0) };
  const path = join(directory, `routing-${files += 1}.sqlite`);
  const store = new SQLiteShannonStore({ path, now: () => clock.at, predictionLedger: true, choiceLedger: true, cognitionDefer: task => task(), predictionShadowDefer: task => task() });
  const database = new DatabaseSync(path);
  const routing = configuredTurnRouting(environment, { databasePath: null, database, choices: store.choiceLedger(), defer: task => task() })!;
  const outcomes = new SQLiteTierOutcomes(database, { createSchema: false });
  return { clock, store, database, routing: routing.routing, outcomes, close: () => { store.close(); database.close(); } };
}

const answers = (strong: number, retry: number | null = null, taskKind: DifficultyAnswers['taskKind'] = 'write'): TurnChooser => ({
  difficulty: true,
  choose: async () => ({ menu: null, difficulty: { taskKind, needsStrongModel: strong, needsVerification: 0.1, multiStep: 0.1 }, retry }),
});

describe('a routed conversation turn', () => {
  it('serves Sonnet as luna_plus without the key, corrects a claim without a write, and learns the tier and its outcome', async () => {
    const w = world();
    const model = new RecordingModel('書斎にメモを保存しました。');
    const autonomy = createInMemoryAutonomyService(() => w.clock.at);
    let chooser = answers(0.95);
    const api = createLocalApiKernel(() => w.clock.at, { chatModel: model, autonomy, turnChooser: { difficulty: true, choose: request => chooser.choose(request) }, turnRouting: w.routing });
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: '書斎にメモを書いて' } });
    const request = model.all.at(-1) as ShannonChatModelRequest;
    expect(request.tier).toBe('luna_plus');
    expect(request.escalation).toBeUndefined();
    expect((response.body as { reply: string }).reply).toBe(`書斎にメモを保存しました。\n${WRITE_CLAIM_CORRECTION}`);
    const tierChoice = w.store.choiceLedger()!.rows('owner').find(row => row.choice.startsWith('tier.'))!;
    expect(tierChoice).toMatchObject({ choice: 'tier.luna_plus', surface: 'text', sourceKind: 'turn', status: 'pending', subjectKind: 'talk', subjectId: talkId('thread'), context: 'afternoon.alone' });
    // Asked to write, and only said she did (ADR-0008 §14): described, not done, so the turn earns no growth.
    expect(tierChoice.success).toBe(0);
    expect(w.outcomes.all('owner')).toMatchObject([{ tier: 'luna_plus', taskKind: 'write', outcome: null, doing: 'described_not_done', growth: 0 }]);
    // His next turn retries: S = 0 settles her last turn; the competence table learns a failure.
    w.clock.at = at(2);
    chooser = answers(0.1, 0.9);
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: 'ちゃんと保存して' } });
    const settled = w.store.choiceLedger()!.rows('owner').find(row => row.choiceId === tierChoice.choiceId)!;
    expect(settled).toMatchObject({ status: 'settled', settleCode: 'next_turn', serve: 0, world: 0, growth: 0 });
    expect(w.outcomes.all('owner')[0]).toMatchObject({ outcome: 0, settleCode: 'next_turn' });
    expect(w.routing.competence('owner', 'luna_plus', 'write')).toEqual({ successes: 0, failures: 1 });
    w.close();
  });

  it('asks luna to escalate once in the middle, and keeps plain luna\'s request as it was', async () => {
    const w = world();
    const model = new RecordingModel();
    const api = createLocalApiKernel(() => w.clock.at, { chatModel: model, autonomy: createInMemoryAutonomyService(() => w.clock.at), turnChooser: answers(0.5), turnRouting: w.routing });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: 'これ考えて' } });
    expect(model.all.at(-1)).toMatchObject({ escalation: true });
    expect((model.all.at(-1) as ShannonChatModelRequest).tier).toBeUndefined();
    w.close();
  });

  it('settles her last turn from G alone when Jev is not sure he retried (ADR-0008 §14), never moving her mood', async () => {
    const w = world();
    const model = new RecordingModel('うん、少し考えてみるね。');
    let chooser = answers(0.95, null, 'analysis');
    const api = createLocalApiKernel(() => w.clock.at, { chatModel: model, autonomy: createInMemoryAutonomyService(() => w.clock.at),
      turnChooser: { difficulty: true, choose: request => chooser.choose(request) }, turnRouting: w.routing });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: '量子もつれについて考えて' } });
    const tierChoice = w.store.choiceLedger()!.rows('owner').find(row => row.choice.startsWith('tier.'))!;
    w.clock.at = at(2);
    chooser = answers(0.1, 0.6, 'analysis');
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: 'うーん' } });
    expect(w.store.choiceLedger()!.rows('owner').find(row => row.choiceId === tierChoice.choiceId)).toMatchObject({ status: 'settled', settleCode: 'next_turn_unsure', serve: 0.5 });
    // From G alone (1: in time, nothing flagged) the competence table learns a success, as an expired turn would.
    expect(w.outcomes.all('owner')[0]).toMatchObject({ outcome: 1, settleCode: 'next_turn' });
    w.close();
  });

  it('tells doing from describing (ADR-0008 §14): a request to change something is done only by an acts result that worked', () => {
    const create = { name: 'study.create', ok: true };
    const list = { name: 'study.list', ok: true };
    expect(turnDoing('write', 'メモを置いたよ。', [list, create], true)).toBe('done');
    expect(turnDoing('write', 'こう書くといいよ：……', [list], true)).toBe('described_not_done');
    expect(turnDoing('write', 'こう書くといいよ：……', [{ name: 'study.create', ok: false }], true)).toBe('described_not_done');
    expect(turnDoing('action', 'わかった、やってみる。', [], true)).toBe('described_not_done');
    // A claim of doing without an acts result is described, whatever the kind; a turn that could not act and did not claim is neither.
    expect(turnDoing('chat', '書斎にメモを保存しました。', [list], false)).toBe('described_not_done');
    expect(turnDoing('write', 'いまは書けないんだ。', [], false)).toBeNull();
    expect(turnDoing('lookup', '予定は三つあるよ。', [list], true)).toBeNull();
    expect(turnDoing(null, 'はい。', [create], true)).toBeNull();
  });

  it('gives every choice of a described-not-done turn no growth, and keeps the outcome on the tier\'s row', () => {
    const w = world();
    const ledger = w.store.choiceLedger()!;
    const competence = new TierCompetence({ database: w.database, createsSchema: false, defer: task => task() });
    recordTurn(ledger, competence, 'owner', { talk: 'thread', surface: 'text', presence: 'alone', tier: { served: 'luna', kind: 'write' },
      tools: [{ name: 'study.list', ok: true }], inDeadline: true, verified: true, doing: 'described_not_done' }, at(0));
    expect(ledger.rows('owner').map(row => [row.choice, row.success]).sort()).toEqual([['tier.luna', 0], ['tool.study.list', 0]]);
    expect(w.outcomes.all('owner')).toMatchObject([{ doing: 'described_not_done', growth: 0 }]);
    recordTurn(ledger, competence, 'owner', { talk: 'thread-2', surface: 'text', presence: 'alone', tier: { served: 'luna', kind: 'write' },
      tools: [{ name: 'study.create', ok: true }], inDeadline: true, verified: true, doing: 'done' }, at(1));
    expect(ledger.rows('owner').filter(row => row.subjectId === 'thread-2').map(row => [row.choice, row.success]).sort()).toEqual([['tier.luna', 1], ['tool.study.create', 1]]);
    expect(w.outcomes.all('owner')[1]).toMatchObject({ doing: 'done', growth: 1 });
    w.close();
  });

  it('learns a Sonnet turn that luna answered as luna\'s (review M5)', async () => {
    const w = world();
    const decision = { tier: 'sonnet', served: 'sonnet', reason: 'strong', mappedDown: 'none', rethinks: 0, verify: false, escalateOnTrouble: false, kind: 'analysis' } as const;
    const finish = (answeredBy: string, threadId: string, servedTier?: 'luna' | 'sonnet') => finishTurn(w.routing, { scopeKey: 'owner', surface: 'text', threadId, presence: 'alone', reply: 'はい。', outOfTime: false,
      escalated: false, decision, tools: undefined, remainingMs: 30_000, at: at(0), answeredBy, servedTier });
    await finish('openai', 'fell-back');
    await finish('anthropic', 'sonnet');
    await finish('anthropic', 'haiku-fell-back', 'luna');
    expect(w.outcomes.all('owner').map(row => [row.talkId, row.tier]).sort()).toEqual([['fell-back', 'luna'], ['haiku-fell-back', 'luna'], ['sonnet', 'sonnet']]);
    w.close();
  });

  it('never learns a call a rule stopped as a choice of hers, nor counts it against the turn (ADR-0008 §14)', () => {
    const w = world();
    const ledger = w.store.choiceLedger()!;
    recordTurn(ledger, null, 'owner', { talk: 'thread', surface: 'text', presence: 'others', tier: { served: 'luna', kind: 'lookup' },
      tools: [{ name: 'study.create', ok: false, withheld: true }, { name: 'study.list', ok: true }], inDeadline: true, verified: null }, at(0));
    expect(ledger.rows('owner').map(row => [row.choice, row.success]).sort()).toEqual([['tier.luna', 1], ['tool.study.list', 1]]);
    w.close();
  });

  it('settles a conversation choice whose next turn never came as turn_expired, which never moves her mood', () => {
    const w = world();
    recordTurn(w.store.choiceLedger(), null, 'owner', { talk: 'thread', surface: 'voice', presence: 'alone', tier: null, tools: [{ name: 'study.list', ok: true }], inDeadline: true, verified: null }, at(0));
    w.store.choiceLedger()!.settleLater('owner', at(TALK_NEXT_TURN_MINUTES - 1));
    expect(w.store.choiceLedger()!.rows('owner')[0]!.status).toBe('pending');
    w.store.choiceLedger()!.settleLater('owner', at(TALK_NEXT_TURN_MINUTES));
    expect(w.store.choiceLedger()!.rows('owner')[0]).toMatchObject({ status: 'settled', settleCode: 'turn_expired', serve: 0.5, growth: 1, choice: 'tool.study.list', surface: 'voice' });
    w.close();
  });

  it('folds conversation choices into the value table with the switch, and stage 1\'s data-only calls never', () => {
    const w = world();
    const ledger = w.store.choiceLedger()!;
    // Stage 1's record of a conversation tool call: data only, no Talk.
    ledger.recordSettled('owner', { surface: 'text', choice: 'tool.study.read', context: 'afternoon.alone', sourceKind: 'tool_call', sourceId: 'old-1' }, 1, at(0));
    for (let index = 0; index < 4; index += 1) {
      recordTurn(ledger, null, 'owner', { talk: 'thread', surface: 'text', presence: 'alone', tier: null, tools: [{ name: 'study.list', ok: true }], inDeadline: true, verified: true }, at(index));
      ledger.settleTalk('owner', 'thread', 1, at(index));
    }
    w.store.valueVersions()!.nightly('owner', at(10));
    const cells = w.store.valueVersions()!.activeCells('owner');
    expect(cells.some(cell => cell.choice === 'tool.study.list' && cell.n === 4)).toBe(true);
    expect(cells.some(cell => cell.choice === 'tool.study.read')).toBe(false);
    w.close();
  });
});

describe('a chat burst of tool calls (owner answer I-3): the warm-up and the hourly cap hold', () => {
  it('moves her for nothing until a cell has learned from three, and never past the stationary band in an hour', () => {
    const w = world();
    const ledger = w.store.choiceLedger()!;
    const turn = (minute: number, ok: boolean) => {
      recordTurn(ledger, null, 'owner', { talk: 'thread', surface: 'text', presence: 'alone', tier: null, tools: [{ name: 'study.search', ok }], inDeadline: true, verified: null }, at(minute));
      ledger.settleTalk('owner', 'thread', ok ? 1 : 0, at(minute + 0.5));
    };
    // Cold: three settled calls, no version yet: every one is warm-up, her state unchanged.
    for (let index = 0; index < 3; index += 1) turn(index, true);
    w.clock.at = at(4);
    const mood = startRewardMood({}, { choices: ledger, shadow: w.store.predictionShadow(), state: w.store }, () => w.clock.at, { intervalMs: 3_600_000, log: () => undefined });
    const valence = w.store.snapshot('owner').emotion.valence;
    expect(mood.mood!.pump()).toMatchObject({ applied: 0, applied_capped: 0, warmup: 3 });
    expect(w.store.snapshot('owner').emotion.valence).toBe(valence);
    // A version learned from three: a burst of twenty calls in ten minutes moves her at most the stationary band.
    w.store.valueVersions()!.nightly('owner', at(5));
    for (let index = 0; index < 20; index += 1) turn(6 + index / 2, index % 3 !== 0);
    w.clock.at = at(17);
    const counts = mood.mood!.pump();
    expect(counts.applied + counts.applied_capped + counts.rate_capped + counts.warmup + counts.ineligible).toBe(20);
    expect(counts.rate_capped).toBeGreaterThan(0);
    const applied = ledger.rows('owner').filter(row => row.moodCode?.startsWith('applied'));
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.reduce((sum, row) => sum + (row.moodStep ?? 0), 0)).toBeLessThanOrEqual(stationaryBand() + 1e-9);
    mood.stop();
    // Switched off: the same burst claims nothing of a conversation.
    const off = startRewardMood({ SHANNON_CONVERSATION_REWARD: 'off' }, { choices: ledger, shadow: w.store.predictionShadow(), state: w.store }, () => w.clock.at, { intervalMs: 3_600_000, log: () => undefined });
    turn(18, true);
    expect(off.mood!.pump()).toMatchObject({ applied: 0, applied_capped: 0, rate_capped: 0, warmup: 0 });
    off.stop();
    w.close();
  });
});
