import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { LocalVoiceDecisionGateway, JevVoiceDecisionGateway, VOICE_SKILLS } from '../src/voiceDecision.js';
import type { VoiceDecisionInput } from '../src/voiceDecision.js';
import type { ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { InMemoryOrganizeStore } from '../src/organize.js';
import { transcriptNeedsInterpretation } from '../src/voiceTranscriptContext.js';

const at = '2026-09-28T12:00:00.000Z';
const input: VoiceDecisionInput = { scopeKey: 'owner', transcript: '写真整理をタスクにして',
  participantMode: 'owner', requestedLocation: false, hasFreshLocation: false };
afterEach(() => vi.unstubAllEnvs());

function harness(score: number | undefined, silent = false) {
  const decisions: VoiceDecisionInput[] = [];
  const requests: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  const store = new InMemoryOrganizeStore();
  const gateway = new LocalVoiceDecisionGateway();
  const model = { mode: 'openai' as const, model: 'test',
    generate: async (request: ShannonChatModelRequest) => {
      requests.push(request);
      return { mode: 'openai' as const, model: 'test', reply: '確認してください。',
        taskProposal: { title: '危険な推測', goal: '推測したタスクを開始' } };
    },
    generateVoice: async (request: ShannonVoiceModelRequest) => {
      requests.push(request);
      return { mode: 'openai' as const, model: 'test', reply: '確認してください。',
        taskProposal: { title: '危険な推測', goal: '推測したタスクを開始' } };
    },
  };
  const api = createLocalApiKernel(() => at, { chatModel: model, organizeStore: store,
    voiceDecision: { mode: 'jev', model: 'test', decide: async value => {
      decisions.push(value);
      const decision = await gateway.decide(value);
      return { ...decision, transcriptReliabilityProbability: score,
        ...(silent ? { shouldRespond: false, conversationClass: 'no_response' as const } : {}) };
    } },
  });
  const turn = (source: 'speech' | 'typed' = 'speech', participantMode = 'owner') => api.dispatch({
    method: 'POST', path: '/v1/voice/live/delegations', body: {
      scopeKey: 'owner', threadId: 'thread', transcript: input.transcript, participantMode,
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false,
        userUtterance: { id: 'u1', text: input.transcript, source,
        rawText: '写真せいりをタスクにして' } },
    },
  });
  return { api, turn, decisions, requests, store };
}

describe('contextual ASR reliability and authority', () => {
  it('sends bounded same-thread history to the classifier and original ASR to the answer model', async () => {
    const h = harness(0.5);
    await h.api.dispatch({ method: 'POST', path: '/v1/chat',
      body: { scopeKey: 'owner', threadId: 'thread', message: 'エーテルのノートの話をしている' } });
    h.requests.length = 0;
    const result = await h.turn();
    expect(result.status).toBe(200);
    expect(h.decisions[0]?.context?.some(item => item.content.includes('エーテル'))).toBe(true);
    expect(h.decisions[0]?.rawTranscript).toContain('写真せいり');
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.systemPrompt).toContain('[Contextual transcript interpretation required]');
    expect(h.requests[0]?.systemPrompt).toContain('写真せいり');
    expect(h.requests[0]?.systemPrompt).toContain('Output was interrupted, NOT their input');
    expect(h.store.list('owner', 'thread')).toEqual([]);
    expect(result.body).not.toHaveProperty('receipt');
    expect(result.body).not.toHaveProperty('uiBlocks');
  });

  it.each([0.2, undefined])('never authorizes a speech command at low or missing confidence (%s)', async score => {
    const h = harness(score);
    await h.turn();
    expect(h.requests).toHaveLength(1);
    expect(h.store.list('owner', 'thread')).toEqual([]);
  });

  it('does not silence unclear audio just because the fast classifier selected no-response', async () => {
    const h = harness(0.1, true);
    const result = await h.turn();
    expect(h.requests).toHaveLength(1);
    expect(result.body).toMatchObject({ voicePlan: { shouldRespond: true } });
  });

  it('preserves explicit typed commands and high-confidence literal speech commands', async () => {
    for (const [score, source] of [[0.2, 'typed'], [0.95, 'speech']] as const) {
      const h = harness(score);
      const result = await h.turn(source);
      expect(h.requests).toHaveLength(0);
      expect(h.store.list('owner', 'thread')).toHaveLength(1);
      expect(result.body).toHaveProperty('receipt');
    }
  });

  it('never passes owner context to guest classification', async () => {
    const h = harness(0.1);
    await h.api.dispatch({ method: 'POST', path: '/v1/chat',
      body: { scopeKey: 'owner', threadId: 'thread', message: '秘密の合言葉はミズクラゲ' } });
    h.requests.length = 0;
    await h.turn('speech', 'guest');
    expect(h.decisions[0]?.context).toEqual([]);
    expect(h.requests[0]?.history).toEqual([]);
    expect(h.requests[0]?.systemPrompt).not.toContain('ミズクラゲ');
    expect(h.store.list('owner', 'thread')).toEqual([]);
  });

  it('honors a configurable threshold with a safe invalid-config default', async () => {
    const decision = { ...await new LocalVoiceDecisionGateway().decide(input), transcriptReliabilityProbability: 0.84 };
    const speech = { id: 's', text: input.transcript, source: 'speech' as const };
    expect(transcriptNeedsInterpretation(decision, speech)).toBe(true);
    vi.stubEnv('SHANNON_VOICE_TRANSCRIPT_RELIABILITY_THRESHOLD', '0.8');
    expect(transcriptNeedsInterpretation(decision, speech)).toBe(false);
    vi.stubEnv('SHANNON_VOICE_TRANSCRIPT_RELIABILITY_THRESHOLD', 'invalid');
    expect(transcriptNeedsInterpretation(decision, speech)).toBe(true);
  });

  it('uses a Jev Noul score together with context, not invented acoustic confidence', async () => {
    let payload: Record<string, any> = {};
    const fetcher = async (_url: unknown, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ answers: {
        ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: 0 }])),
        reply_required: { type: 'noul', noul: 1 }, solution_wanted: { type: 'noul', noul: 0 },
        transcript_reliable: { type: 'noul', noul: 0.42 },
        conversation_class: { type: 'choice', choice: 'direct' },
        affect: { type: 'choice', choice: 'neutral' }, affect_intensity: { type: 'choice', choice: 'subtle' },
        delivery: { type: 'choice', choice: 'conversational' }, latency_class: { type: 'choice', choice: 'under_3s' },
      } }));
    };
    const decision = await new JevVoiceDecisionGateway({ apiKey: 'test-only', fetcher: fetcher as typeof fetch })
      .decide({ ...input, rawTranscript: 'エートル', context: [{ role: 'user', content: 'Aetherについて話そう' }] });
    expect(decision.transcriptReliabilityProbability).toBe(0.42);
    expect(payload.questions.transcript_reliable.type).toBe('noul');
    expect(JSON.stringify(payload.state)).toContain('Aetherについて話そう');
    expect(JSON.stringify(payload.state)).toContain('エートル');
  });
});
