import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { countedJevFetch, emptyJevProbe, jevRequestSize, withJevProbe } from '../src/infra/models/jev/jevClient.js';
import { jevUsageRow, jevUsdPerCall } from '../src/infra/models/jev/jevUsage.js';
import { LockWaitMeter } from '../src/infra/sqlite/lockWaits.js';
import { checkedTrace, type DecisionTraceDraft } from '../src/contracts/decisionTraceContract.js';
import { DecisionTraces, decisionTracesEnabled, traceSymbol } from '../src/mind/inhibition/decisionTraces.js';
import { configuredDecisionTraces, configuredVoiceDecision } from '../src/wiring/cognitionLedgerWiring.js';
import { TracedVoiceDecisionGateway } from '../src/mind/inhibition/tracedVoiceDecision.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { JevVoiceDecisionGateway, LocalVoiceDecisionGateway, OpenAIVoiceDecisionGateway, VOICE_SKILLS, type VoiceDecisionInput } from '../src/mind/selectors/voiceDecision.js';

/**
 * Decision traces and Jev's call count (Syzygy ADR-0008 stage 1, `docs/cognition-ledger-contract.md`): one content-free row per
 * decision, the fallback chain as it ran, Jev's calls as a row of the usage summary with its cost unknown until a price is set,
 * and the transcription cap's lane untouched.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-decision-traces-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); });

const AT = '2026-10-07T03:00:00.000Z';
const TRANSCRIPT = '近くの喫茶店ひみつの合言葉を教えて';
const input: VoiceDecisionInput = {
  scopeKey: 'owner', transcript: TRANSCRIPT, participantMode: 'owner', requestedLocation: false, hasFreshLocation: false,
  context: [{ role: 'user', content: 'さっきの秘密の話' }],
};

function jevAnswers(): Record<string, unknown> {
  return {
    ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: 0.1 }])),
    reply_required: { type: 'noul', noul: 0.9 }, solution_wanted: { type: 'noul', noul: 0.7 },
    conversation_class: { type: 'choice', choice: 'direct' }, affect: { type: 'choice', choice: 'bright' },
    affect_intensity: { type: 'choice', choice: 'moderate' }, delivery: { type: 'choice', choice: 'quick' },
    latency_class: { type: 'choice', choice: 'under_3s' }, waiting_scenario: { type: 'choice', choice: 'general' },
    waiting_variant: { type: 'choice', choice: 'steady' }, waiting_affect: { type: 'choice', choice: 'bright' },
    waiting_intensity: { type: 'choice', choice: 'subtle' }, waiting_delivery: { type: 'choice', choice: 'quick' },
  };
}
const jevOk = (async () => new Response(JSON.stringify({ answers: jevAnswers() }))) as typeof fetch;
const openAIOk = (async () => new Response(JSON.stringify({ output_text: JSON.stringify({
  replyRequiredProbability: 0.9, solutionWantedProbability: 0.2, conversationClass: 'direct', latencyClass: 'under_3s', affect: 'playful',
  affectIntensity: 0.4, delivery: 'conversational', skillScores: Object.fromEntries(VOICE_SKILLS.map(skill => [skill, 0.1])),
}) }))) as typeof fetch;

function collect(): { write: (scopeKey: string, draft: DecisionTraceDraft) => void; drafts: DecisionTraceDraft[] } {
  const drafts: DecisionTraceDraft[] = [];
  return { drafts, write: (_scopeKey, draft) => { drafts.push(checkedTrace(draft)); } };
}

function jevGateway(jevFetch: typeof fetch, fallback: 'openai' | 'local' = 'openai') {
  return new JevVoiceDecisionGateway({
    apiKey: 'jev-test', fetcher: countedJevFetch(jevFetch),
    ...(fallback === 'openai' ? { fallbackGateway: new OpenAIVoiceDecisionGateway({ apiKey: 'openai-test', fetcher: openAIOk }) } : {}),
  });
}

describe('the traced voice gateway', () => {
  it('returns the decision of the configured gateway untouched and traces it without a word of the turn', async () => {
    const { write, drafts } = collect();
    const plain = await jevGateway(jevOk).decide(input);
    const traced = new TracedVoiceDecisionGateway(jevGateway(jevOk), write, { usdPerJevCall: null, now: () => AT });
    expect(traced.mode).toBe('jev');
    expect(traced.model).toBe('jev-latest');
    const decision = await traced.decide(input);
    expect({ ...decision, elapsedMilliseconds: 0 }).toEqual({ ...plain, elapsedMilliseconds: 0 });
    expect(drafts).toHaveLength(1);
    const trace = drafts[0]!;
    expect(trace).toMatchObject({ surface: 'voice', decision: 'voice_route', decider: 'jev', model: 'jev-latest', outcome: 'ok', fallbackDecider: null, costUsd: null, relatedId: null, at: AT });
    expect(trace.questions).toBeGreaterThan(10);
    expect(trace.contextChars).toBeGreaterThan(TRANSCRIPT.length);
    expect(trace.answers).toMatchObject({ respond: plain.shouldRespond, class: plain.conversationClass, affect: plain.affect, delivery: plain.delivery, latency: plain.latencyClass, skills: [...plain.selectedSkills] });
    expect(JSON.stringify(trace)).not.toMatch(/喫茶|秘密|合言葉/u);
  });

  it('records the fallback chain: Jev timed out, failed, or answered unusably, and who decided instead', async () => {
    const timeout = (async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }) as typeof fetch;
    const failure = (async () => { throw new Error('connection reset'); }) as typeof fetch;
    const unusable = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    const cases = [[timeout, 'openai', 'timeout', 'openai'], [failure, 'openai', 'error', 'openai'], [unusable, 'openai', 'fallback', 'openai'], [timeout, 'local', 'timeout', 'local']] as const;
    for (const [jevFetch, fallback, outcome, decider] of cases) {
      const { write, drafts } = collect();
      const decision = await new TracedVoiceDecisionGateway(jevGateway(jevFetch, fallback), write, { usdPerJevCall: 0.0004, now: () => AT }).decide(input);
      expect(decision.source).toBe(decider === 'local' ? 'fallback' : 'openai');
      expect(drafts[0]).toMatchObject({ decider: 'jev', outcome, fallbackDecider: decider, costUsd: 0.0004 });
    }
  });

  it('traces a gateway without Jev as its own decider, at no Jev cost', async () => {
    const { write, drafts } = collect();
    await new TracedVoiceDecisionGateway(new LocalVoiceDecisionGateway(), write, { usdPerJevCall: 0.001, now: () => AT }).decide(input);
    await new TracedVoiceDecisionGateway(new OpenAIVoiceDecisionGateway({ apiKey: 'openai-test', fetcher: openAIOk }), write, { usdPerJevCall: null, now: () => AT }).decide(input);
    expect(drafts.map(trace => [trace.decider, trace.outcome, trace.fallbackDecider, trace.costUsd, trace.questions])).toEqual([
      ['local', 'ok', null, 0, null], ['openai', 'ok', null, 0, null],
    ]);
  });

  it('is configured with a counting Jev fetch only while traces are on, and is the plain gateway otherwise', async () => {
    const environment = { TYPESAFE_API_KEY: 'jev-test' };
    expect(configuredVoiceDecision(environment, undefined, null)).toBeInstanceOf(JevVoiceDecisionGateway);
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => { calls.push(String(url)); return jevOk(url, init); }) as typeof fetch);
    const { write, drafts } = collect();
    const gateway = configuredVoiceDecision({ ...environment, SHANNON_JEV_USD_PER_CALL: '0.002' }, undefined, write);
    expect(gateway).toBeInstanceOf(TracedVoiceDecisionGateway);
    await gateway.decide(input);
    expect(calls).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ decider: 'jev', outcome: 'ok', costUsd: 0.002 });
  });
});

describe('the Jev client count', () => {
  it('counts only inside a probe and reads the request body only to count', async () => {
    const probe = emptyJevProbe();
    const fetcher = countedJevFetch(jevOk, (() => { let t = 0; return () => (t += 5); })());
    await fetcher('https://jev.invalid', { method: 'POST', body: JSON.stringify({ state: { utterance: 'あ' }, questions: { a: {}, b: {} } }) });
    expect(probe.calls).toBe(0);
    await withJevProbe(probe, () => fetcher('https://jev.invalid', { method: 'POST', body: JSON.stringify({ state: { utterance: 'あ' }, questions: { a: {}, b: {} } }) }));
    expect(probe).toEqual({ calls: 1, outcome: 'ok', status: 200, questions: 2, stateChars: JSON.stringify({ utterance: 'あ' }).length, latencyMs: 5 });
    expect(jevRequestSize('not json')).toEqual({ questions: null, stateChars: null });
  });

  it('reads the price only from SHANNON_JEV_USD_PER_CALL, and leaves it unknown otherwise', () => {
    expect(jevUsdPerCall({})).toBeNull();
    expect(jevUsdPerCall({ SHANNON_JEV_USD_PER_CALL: '' })).toBeNull();
    expect(jevUsdPerCall({ SHANNON_JEV_USD_PER_CALL: '-1' })).toBeNull();
    expect(jevUsdPerCall({ SHANNON_JEV_USD_PER_CALL: 'abc' })).toBeNull();
    expect(jevUsdPerCall({ SHANNON_JEV_USD_PER_CALL: '0.0005' })).toBe(0.0005);
    expect(jevUsageRow(null)).toBeNull();
    expect(jevUsageRow({ calls: 0, knownCostUsd: 0, unpriced: 0 })).toBeNull();
    expect(jevUsageRow({ calls: 3, knownCostUsd: 0.001, unpriced: 1 })).toEqual({
      lane: 'jev', calls: 3, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0.001, costUnknown: true,
    });
  });
});

function trace(overrides: Partial<DecisionTraceDraft> = {}): DecisionTraceDraft {
  return {
    surface: 'voice', decision: 'voice_route', decider: 'jev', model: 'jev-latest', questions: 20, contextChars: 400, latencyMs: 180,
    outcome: 'ok', fallbackDecider: null, answers: { class: 'direct' }, costUsd: null, relatedId: null, at: AT, ...overrides,
  };
}

describe('the trace table and the usage summary', () => {
  it('adds a jev row from the traces, with its cost unknown until a price is set, and leaves the transcription cap untouched', () => {
    const path = join(directory, 'usage.sqlite');
    const store = new SQLiteShannonStore({ path, now: () => AT, decisionTraces: true, cognitionDefer: task => task() });
    store.recordLlmUsage({ scopeKey: 'owner', lane: 'voice', model: 'gpt-transcribe', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0.01, occurredAt: AT });
    const before = store.llmUsageSummary('owner', '2026-10');
    const capBefore = store.voiceLlmCostUsdForDay('owner', '2026-10-07');
    const write = store.decisionTraces()!.writer;
    write('owner', trace());
    write('owner', trace({ outcome: 'timeout', fallbackDecider: 'openai' }));
    write('owner', trace({ decider: 'openai', model: 'gpt-5.6-luna', costUsd: 0 }));
    write('owner', trace({ surface: 'autonomy', decision: 'autonomy_think', decider: 'model', model: 'gpt-5.6-luna', costUsd: 0.003 }));
    write('other', trace());
    const rows = store.llmUsageSummary('owner', '2026-10');
    expect(rows.slice(0, -1)).toEqual(before);
    expect(rows.at(-1)).toEqual({ lane: 'jev', calls: 2, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, costUnknown: true });
    write('owner', trace({ at: '2026-10-07T04:00:00.000Z', costUsd: 0.0005 }));
    expect(store.llmUsageSummary('owner', '2026-10').at(-1)).toMatchObject({ calls: 3, estimatedCostUsd: 0.0005, costUnknown: true });
    expect(store.voiceLlmCostUsdForDay('owner', '2026-10-07')).toBe(capBefore);
    const database = new DatabaseSync(path);
    expect(database.prepare("SELECT COUNT(*) AS n FROM llm_usage_events WHERE lane NOT IN ('voice')").get()).toEqual({ n: 0 });
    database.close();
    store.close();
  });

  it('creates nothing and changes no summary with the switch off', () => {
    expect(decisionTracesEnabled({ SHANNON_DECISION_TRACES: 'off' })).toBe(false);
    expect(decisionTracesEnabled({ SHANNON_ADR8_STAGE1: 'off' })).toBe(false);
    expect(decisionTracesEnabled({})).toBe(true);
    expect(configuredDecisionTraces({ SHANNON_DECISION_TRACES: 'off' }, join(directory, 'never.sqlite'))).toBeNull();
    const path = join(directory, 'off.sqlite');
    const store = new SQLiteShannonStore({ path, now: () => AT, decisionTraces: false });
    expect(store.decisionTraces()).toBeNull();
    const database = new DatabaseSync(path);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'shannon_decision_traces'").get()).toBeUndefined();
    database.close();
    store.close();
  });

  it('refuses words, keeps 30 days, and lets the loop\'s connection write only once the API created the table', () => {
    expect(() => checkedTrace(trace({ model: 'ひみつ' }))).toThrow('DECISION_TRACE_SYMBOL');
    expect(() => checkedTrace(trace({ answers: { said: 'ねえ聞いて' } }))).toThrow('DECISION_TRACE_ANSWER');
    expect(() => checkedTrace(trace({ answers: { list: ['ok', 'two words'] } }))).toThrow('DECISION_TRACE_ANSWER');
    expect(() => checkedTrace(trace({ relatedId: 'not an id' }))).toThrow('DECISION_TRACE_IDENTIFIER');
    expect(() => checkedTrace(trace({ decider: 'someone' as never }))).toThrow('DECISION_TRACE_VOCABULARY');
    expect(traceSymbol('openai/gpt 5')).toBe('openai_gpt_5');
    const path = join(directory, 'loop.sqlite');
    const loop = configuredDecisionTraces({}, path)!;
    loop.traces.record('owner', trace());
    const api = new SQLiteShannonStore({ path, now: () => '2026-11-20T00:00:00.000Z', decisionTraces: true, cognitionDefer: task => task() });
    const traces = api.decisionTraces()!;
    expect(traces.store.list('owner')).toEqual([]);
    traces.record('owner', trace());
    expect(traces.store.list('owner').map(row => row.at)).toEqual([AT]);
    // The first write of a new owner day prunes what is older than 30 days before it.
    traces.record('owner', trace({ at: '2026-11-19T00:00:00.000Z' }));
    expect(traces.store.list('owner').map(row => row.at)).toEqual(['2026-11-19T00:00:00.000Z']);
    api.close();
    // So does every open of an API store.
    const later = new SQLiteShannonStore({ path, now: () => '2026-12-25T00:00:00.000Z', decisionTraces: true });
    expect(later.decisionTraces()!.store.list('owner')).toEqual([]);
    later.close();
    loop.close();
  });

  it('measures the waits for the write lock and logs one line a day', () => {
    const lines: string[] = [];
    const meter = new LockWaitMeter('test', line => lines.push(line));
    for (let index = 1; index <= 100; index += 1) meter.record(index, '2026-10-07');
    expect(meter.summary()).toEqual({ writes: 100, p95: 95, p99: 99, maximum: 100 });
    meter.record(1, '2026-10-08');
    expect(lines).toEqual(['Shannon test lock waits: day=2026-10-07 writes=100 p95=95.0ms p99=99.0ms max=100.0ms']);
    const path = join(directory, 'waits.sqlite');
    const database = new DatabaseSync(path);
    const traces = new DecisionTraces({ database, createsSchema: true, defer: task => task(), now: () => AT });
    traces.record('owner', trace());
    expect(traces.lockWaits().writes).toBe(1);
    database.close();
  });
});
