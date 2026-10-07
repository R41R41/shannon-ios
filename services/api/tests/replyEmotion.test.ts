import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { ownerDay, presentCompanionState, sharedTimeEvent } from '../src/mind/emotion/companionPresence.js';
import { promptOf } from './modelPrompt.js';

const at = '2026-10-02T03:00:00.000Z';
const delegations = '/v1/voice/gemini/cascade/delegations';
const turns = '/v1/voice/gemini/cascade/turns';

class ScriptedModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  readonly voiceRequests: ShannonVoiceModelRequest[] = [];
  reply = 'はい、こう進めるのが良いと思います。';

  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: this.reply };
  }

  async generateVoice(request: ShannonVoiceModelRequest) {
    this.voiceRequests.push(request);
    return { mode: this.mode, model: this.model, reply: this.reply };
  }
}

function kernel(clock: () => string = () => at) {
  const model = new ScriptedModel();
  const stateStore = new InMemoryCompanionStateStore(clock);
  const conversationStore = new InMemoryConversationStore();
  const api = createLocalApiKernel(clock, { chatModel: model, stateStore, conversationStore });
  const chat = async (message: string, reply: string) => {
    model.reply = reply;
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message } });
    return response.body as { messageEmotion: { expression: string; feeling?: string }; state: Record<string, unknown> };
  };
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  return { api, model, stateStore, conversationStore, chat, tick };
}

describe('text chat expression', () => {
  it('comes from her reply and stored feeling, not from the owner\'s words', async () => {
    const { chat } = kernel();
    expect((await chat('次の設計を考えてみて', 'はい、こう進めるのが良いと思います。')).messageEmotion.expression).toBe('calm');
    expect((await chat('今日は悲しい', 'そばにいますよ、ライ氏。')).messageEmotion.expression).toBe('tender');
    expect((await chat('違うよ、間違ってる。なんで？', 'す、すみません、ライ氏！すぐ直します。')).messageEmotion)
      .toMatchObject({ expression: 'concerned', feeling: 'apologetic' });
    expect((await chat('もう直ったの？', 'ふふん、ボクは天才ですから！')).messageEmotion)
      .toMatchObject({ expression: 'determined', feeling: 'proud' });
  });

  it('answers from the captured state and stores the feeling only afterwards', async () => {
    const { chat, stateStore, tick, api, model } = kernel();
    const response = await chat('すごい、さすが', 'えへへ、そんなこと言われると照れます。');
    expect(response.messageEmotion.expression).toBe('bashful');
    // The state returned with the reply already agrees with its face.
    expect(response.state).toMatchObject({ presence: { mood: { expression: 'bashful', fromConversation: true } } });
    // Nothing was written before the response was returned.
    expect(stateStore.snapshot('owner').expressiveEmotion?.primary).toBe('neutral');
    await tick();
    await api.waitForBackground('owner');
    expect(stateStore.snapshot('owner').expressiveEmotion).toMatchObject({ primary: 'bashful', updatedAt: at });
    // The next text turn tells the model the feeling as it stands now.
    await chat('ところで明日の予定は', '明日は午前が空いています。');
    expect(promptOf(model.requests.at(-1))).toContain('いまの会話感情: bashful');
  });

  it('keeps the stored history face equal to the response face', async () => {
    const { chat, api } = kernel();
    await chat('それ違わない？', 'わわっ、ち、違うんです！');
    const conversation = await api.dispatch({
      method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: 'owner' }),
    });
    expect(conversation.body).toMatchObject({
      messages: [{ role: 'user' }, { role: 'assistant', messageEmotion: { expression: 'embarrassed', feeling: 'flustered' } }],
    });
  });
});

describe('voice: the Eye and the stored face follow the emotion the voice acts with', () => {
  it('returns the face with every owner voice plan and stores the reconciled one', async () => {
    const { api, model, conversationStore, stateStore } = kernel();
    model.reply = 'ふふん、ボクにかかれば簡単です！';
    const delegated = await api.dispatch({ method: 'POST', path: delegations,
      body: { scopeKey: 'owner', threadId: 'thread', transcript: 'もうできたの？' } });
    const plan = (delegated.body as { voicePlan: Record<string, any> }).voicePlan;
    expect(plan.emotion.primary).toBe('smug');
    expect(plan).toMatchObject({ expression: 'determined', feeling: 'proud', affect: 'smug' });
    expect(stateStore.snapshot('owner').expressiveEmotion?.primary).toBe('smug');

    const stored = await api.dispatch({ method: 'POST', path: turns, body: {
      scopeKey: 'owner', threadId: 'thread', userTranscript: 'もうできたの？', shannonTranscript: model.reply,
      emotion: { primary: plan.emotion.primary, intensity: plan.emotion.intensity },
    } });
    expect(stored.status).toBe(201);
    expect((stored.body as { messageEmotion: unknown }).messageEmotion)
      .toMatchObject({ expression: plan.expression, feeling: plan.feeling });
    expect(conversationStore.conversationHistory('owner', 'thread').at(-1)?.messageEmotion)
      .toMatchObject({ expression: 'determined', feeling: 'proud' });
  });

  it('accepts a turn from a client that sends no emotion and rejects an unknown kind quietly', async () => {
    const { api } = kernel();
    const legacy = await api.dispatch({ method: 'POST', path: turns, body: {
      scopeKey: 'owner', userTranscript: 'かわいいね', shannonTranscript: 'えへへ、照れます。',
    } });
    expect((legacy.body as { messageEmotion: { expression: string } }).messageEmotion.expression).toBe('bashful');
    const unknown = await api.dispatch({ method: 'POST', path: turns, body: {
      scopeKey: 'owner', userTranscript: 'やあ', shannonTranscript: 'はい。', emotion: { primary: 'made-up', intensity: 9 },
    } });
    expect(unknown.status).toBe(201);
    expect((unknown.body as { messageEmotion: { expression: string } }).messageEmotion.expression).toBe('calm');
  });

  it('gives 友人も一緒 a face for the Eye and stores nothing', async () => {
    const { api, model, conversationStore, stateStore } = kernel();
    const before = stateStore.snapshot('owner');
    model.reply = 'えへへ、そんなこと言われると照れます。';
    const response = await api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript: 'シャノン、声が可愛いね', participantMode: 'guest',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: 'g1', text: 'シャノン、声が可愛いね', source: 'speech', rawText: 'シャノン、声が可愛いね',
          callContext: { turns: [], introductionStart: true } } },
    } });
    const plan = (response.body as { voicePlan: Record<string, any> }).voicePlan;
    expect(plan.expression).toBe('bashful');
    expect(plan.emotion.target).toBe('現在の話者');
    expect(stateStore.snapshot('owner')).toBe(before);
    expect(conversationStore.conversationHistory('owner', 'thread')).toEqual([]);
    expect(conversationStore.experienceCandidates('owner')).toEqual([]);
  });
});

describe('state shown to the owner', () => {
  it('moves closeness with recorded owner days and explains it', async () => {
    let now = '2026-10-01T03:00:00.000Z';
    const { api, chat, stateStore } = kernel(() => now);
    await chat('おはよう', 'おはようございます、ライ氏。');
    await api.waitForBackground('owner');
    now = '2026-10-02T03:00:00.000Z';
    await chat('今日もよろしく', 'はい、よろしくお願いします。');
    await api.waitForBackground('owner');
    expect(stateStore.snapshot('owner')).toMatchObject({
      sharedDays: ['2026-10-01', '2026-10-02'], temperament: { closeness: 0.18, initiative: 0.25 },
    });
    const state = await api.dispatch({ method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner' }) });
    expect(state.body).toMatchObject({
      temperament: { closeness: 0.18 },
      presence: { mood: { expression: 'calm', fromConversation: false },
        temperamentReasons: { closeness: 'この30日で2日話した', curiosity: '育っている関心はまだない' } },
    });
  });

  it('shows an absence without waiting for the next turn, and never stores it on read', () => {
    const store = new InMemoryCompanionStateStore(() => at);
    const stored = store.apply('owner', sharedTimeEvent(
      Array.from({ length: 10 }, (_, index) => ({ observedAt: `2026-09-${String(20 + index).padStart(2, '0')}T03:00:00.000Z` })),
      '2026-09-29T03:00:00.000Z',
    ));
    expect(stored.temperament.closeness).toBe(0.32);
    const later = presentCompanionState(stored, '2026-10-25T03:00:00.000Z');
    expect(later.temperament.closeness).toBe(0.22);
    expect(later.presence.temperamentReasons.closeness).toBe('この30日で4日話した');
    expect(store.snapshot('owner')).toBe(stored);
  });

  it('uses the owner-local day and ignores turns outside the window', () => {
    expect(ownerDay('2026-10-01T15:30:00.000Z', 'Asia/Tokyo')).toBe('2026-10-02');
    expect(ownerDay('2026-10-01T15:30:00.000Z', 'America/Los_Angeles')).toBe('2026-10-01');
    expect(ownerDay('2026-10-01T15:30:00.000Z', 'Not/AZone')).toBe('2026-10-02');
    expect(sharedTimeEvent([
      { observedAt: '2026-08-01T03:00:00.000Z' }, { observedAt: '2026-10-01T03:00:00.000Z' },
    ], at)).toEqual({ type: 'shared-time-observed', days: ['2026-10-01', '2026-10-02'], today: '2026-10-02' });
  });
});
