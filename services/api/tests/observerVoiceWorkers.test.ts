import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { streamSpeech } from '../src/surfaces/voice/serverGeminiSpeechRoute.js';
import { createLiveVoiceStreamRoute } from '../src/surfaces/voice/serverLiveVoiceStreamRoute.js';
import { WAITING_CUE_DELAY_MILLISECONDS } from '../src/surfaces/voice/voiceWaitingCue.js';
import type { LiveVoiceStreamObserver } from '../src/surfaces/voice/apiLiveVoice.js';
import { ShannonBackgroundWorker } from '../src/mind/sleep/backgroundWorker.js';
import { LocalRuleSleepMemoryAnalyzer } from '../src/mind/sleep/sleepConsolidation.js';
import { memoryWorld, MEMORY_AT } from './support/memoryWorld.js';

describe('observed voice and background work', () => {
  it('observes the actual visible reply and plan without changing the model request or exposing prompts', async () => {
    const events: ObserverDraft[] = [];
    const requests: unknown[] = [];
    const model = { mode: 'openai' as const, model: 'fixture-voice', generate: async (input: unknown) => {
      requests.push(input); return { mode: 'openai' as const, model: 'fixture-voice', reply: 'ボクも嬉しいです。' };
    } };
    const request = { method: 'POST' as const, path: '/v1/voice/live/delegations', body: {
      scopeKey: 'owner', transcript: 'シャノン、おはよう', deviceContext: {
        timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false,
        userUtterance: { id: '85a3dc10-10a3-423a-8149-81a5617505a5', source: 'speech', text: 'シャノン、おはよう' },
      },
    } };
    const baseline = await createLocalApiKernel(() => MEMORY_AT, { chatModel: model }).dispatch(request);
    const restore = installObserverSink(event => events.push(event));
    try {
      const observed = await createLocalApiKernel(() => MEMORY_AT, { chatModel: model }).dispatch(request);
      expect(observed.status).toBe(baseline.status);
      expect(observed.body).toMatchObject({ reply: 'ボクも嬉しいです。' });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(events.some(event => event.node === 'plan' && event.kind === 'span.completed')).toBe(true);
      expect(events.find(event => event.node === 'sentences' && event.kind === 'span.completed')?.output)
        .toMatchObject({ reply: 'ボクも嬉しいです。', model: 'fixture-voice' });
      expect(events.every(event => event.runId === request.body.deviceContext.userUtterance.id)).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(/\[Voice route\]|\[User knowledge\]|systemPrompt/u);
    } finally { restore(); }
  });

  it('suppresses guest voice even inside an existing owner run, and sink failures do not fail a turn', async () => {
    const events: ObserverDraft[] = [];
    const api = createLocalApiKernel(() => MEMORY_AT);
    const restore = installObserverSink(event => events.push(event));
    try {
      await withObserverRun({ scopeKey: 'owner', surface: 'http' }, () => api.dispatch({
        method: 'POST', path: '/v1/voice/live/delegations',
        body: { scopeKey: 'owner', participantMode: 'guest', transcript: 'シャノン、おはよう' },
      }));
      expect(events.filter(event => event.node !== 'turn')).toEqual([]);
    } finally { restore(); }
    const broken = installObserverSink(() => { throw new Error('observer-only'); });
    try {
      expect((await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations',
        body: { scopeKey: 'owner', transcript: 'シャノン、おはよう' } })).status).toBe(200);
    } finally { broken(); }
  });

  it('counts actually written PCM and the exact provider model without keeping bytes or the private voice ID', async () => {
    const events: ObserverDraft[] = [];
    const restore = installObserverSink(event => events.push(event));
    const request = new EventEmitter() as IncomingMessage;
    let writes = 0;
    const response = Object.assign(new EventEmitter(), {
      writeHead() {}, write() { writes++; return true; }, end() {},
    }) as unknown as ServerResponse;
    try {
      await withObserverRun({ scopeKey: 'owner', surface: 'tts' }, () => streamSpeech(request, response, {
        stream: async () => ({ contentType: 'audio/l16', sampleRate: 24_000, channels: 1, bitsPerSample: 16,
          model: 'eleven_fixture_exact', voice: 'private-voice-id', outputUsdPerTenSeconds: 0,
          chunks: (async function* () { yield new Uint8Array([1, 2, 3, 4]); yield new Uint8Array([5, 6]); })() }),
      }, { scopeKey: 'owner', text: 'おはようございます。' }, 'eleven'));
      expect(writes).toBe(2);
      expect(events.find(event => event.node === 'tts' && event.kind === 'span.completed')?.output).toMatchObject({
        provider: 'eleven', model: 'eleven_fixture_exact', byteCount: 6, sampleCount: 3, cancelled: false,
      });
      expect(JSON.stringify(events)).not.toMatch(/private-voice-id|1,2,3,4/u);
    } finally { restore(); }
  });

  it('observes exact written sentences including waiting text, without recording discarded partial deltas', async () => {
    const events: ObserverDraft[] = [];
    const restore = installObserverSink(event => events.push(event));
    const runId = '85a3dc10-10a3-423a-8149-81a5617505a5';
    const request = Readable.from([JSON.stringify({ transcript: 'シャノン、確認して',
      deviceContext: { userUtterance: { id: runId } } })]) as IncomingMessage;
    request.method = 'POST';
    let wire = '';
    const response = Object.assign(new EventEmitter(), {
      headersSent: false, writeHead() { this.headersSent = true; return this; },
      write(value: string) { wire += value; return true; }, end() {},
    }) as unknown as ServerResponse;
    const kernel = { streamLiveVoiceDelegation: async (_request: unknown, observer: LiveVoiceStreamObserver) => {
      await observer.onPlan({ waitingPhrase: '確認しますね。', shouldRespond: true });
      await new Promise(resolve => setTimeout(resolve, WAITING_CUE_DELAY_MILLISECONDS + 50)); // The waiting line follows a silence.
      await observer.onTextDelta('答え');
      await observer.onTextDelta('です。PRIVATE_DISCARDED_TAIL');
      return { status: 200, body: { threadId: 'thread', reply: '答えです。', truncated: true } };
    } };
    try {
      await createLiveVoiceStreamRoute(kernel as never, () => true)(request, response, { scopeKey: 'owner', deviceId: 'fixture' } as never);
      const sent = wire.trim().split('\n').map(line => JSON.parse(line) as { type: string; text?: string })
        .filter(event => event.type === 'segment').map(event => event.text);
      const observed = events.filter(event => event.node === 'sentences' && event.kind === 'span.started')
        .map(event => (event.input as { text: string }).text);
      expect(observed).toEqual(sent);
      expect(observed).toEqual(['確認しますね。', '答えです。']);
      expect(events.every(event => event.runId === runId)).toBe(true);
      expect(JSON.stringify(events)).not.toContain('PRIVATE_DISCARDED_TAIL');
    } finally { restore(); }
  });

  it('opens a real run per memory row and keeps private fact payloads out', async () => {
    const world = memoryWorld();
    const events: ObserverDraft[] = [];
    const restore = installObserverSink(event => events.push(event));
    try {
      world.ports.proposals.propose({ opId: 'fixture:fact', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:f1',
        payload: { fact: { id: 'f1', statement: 'PRIVATE_FACT_SENTINEL', confidence: 0.9, observedAt: MEMORY_AT, evidence: 'PRIVATE_EVIDENCE' }, source: 'conversation' } });
      expect(await world.writer().runOnce()).toBe('worked');
      expect(events.filter(event => event.kind === 'run.started')).toHaveLength(1);
      expect(events.find(event => event.node === 'memory' && event.kind === 'span.completed')?.output).toEqual({ final: true });
      expect(JSON.stringify(events)).not.toMatch(/PRIVATE_FACT|PRIVATE_EVIDENCE/u);
      expect(world.rows()[0]?.status).toBe('applied');
    } finally { restore(); world.close(); }
  });

  it('observes a claimed background job without exposing its user message or creating another analyzer call', async () => {
    const world = memoryWorld();
    const events: ObserverDraft[] = [];
    const thread = world.store.createThread('owner', 'fixture');
    const turn = world.store.appendTurn('owner', thread, 'PRIVATE_TURN_SENTINEL', 'うん。', MEMORY_AT);
    world.store.enqueueTurnRefinement('owner', turn.id, turn.userMessage, MEMORY_AT);
    const restore = installObserverSink(event => events.push(event));
    try {
      const worker = new ShannonBackgroundWorker(world.store, world.store, world.store, new LocalRuleSleepMemoryAnalyzer(),
        { now: () => new Date(MEMORY_AT) });
      expect(await worker.runOnce()).toBe('processed');
      expect(events.filter(event => event.kind === 'run.started')).toHaveLength(1);
      expect(events.find(event => event.node === 'memory' && event.kind === 'span.completed')?.output).toEqual({ processed: true });
      expect(JSON.stringify(events)).not.toContain('PRIVATE_TURN_SENTINEL');
    } finally { restore(); world.close(); }
  });
});
