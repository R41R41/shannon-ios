import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore, SHANNON_EMOTION_KINDS, createShannonMessageEmotion, type ReplyEmotion, type ShannonExpressiveEmotion } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/infra/http/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { chatSentenceStreamLines } from '../src/surfaces/text/chatSentenceStream.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { parseMessageMetadata } from '../src/infra/sqlite/sqliteStoreCodecs.js';
import { storedVoiceFace } from '../src/mind/emotion/voiceEmotionPlan.js';

// Owner decision 2026-10-05: `messageEmotion` (and the owner's voice plan) carry the reply's own feeling as an optional
// `kind`, so an app can show a finer icon. It is additive: the face is unchanged and an older client ignores the field.

const at = '2026-10-05T03:00:00.000Z';
const delegations = '/v1/voice/gemini/cascade/delegations';
const turns = '/v1/voice/gemini/cascade/turns';
const PROUD = 'ふふん、ボクは天才ですから！';
const PLAIN = 'はい、こう進めるのが良いと思います。';

class ScriptedModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  reply = PLAIN;
  async generate(_request: ShannonChatModelRequest) { return { mode: this.mode, model: this.model, reply: this.reply }; }
  async generateVoice(_request: ShannonVoiceModelRequest) { return { mode: this.mode, model: this.model, reply: this.reply }; }
}

type Emotion = { expression: string; feeling?: string; kind?: string };

function kernel() {
  const model = new ScriptedModel();
  const api = createLocalApiKernel(() => at, { chatModel: model, stateStore: new InMemoryCompanionStateStore(() => at), conversationStore: new InMemoryConversationStore() });
  const chat = async (message: string, reply: string, extra: Record<string, unknown> = {}) => {
    model.reply = reply;
    return (await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message, ...extra } })).body as { messageEmotion: Emotion };
  };
  const history = async () => ((await api.dispatch({ method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: 'owner', threadId: 'thread' }) }))
    .body as { messages: Array<{ role: string; messageEmotion?: Emotion }> }).messages.filter(message => message.role === 'assistant');
  return { api, model, chat, history };
}

describe('text: messageEmotion.kind', () => {
  it('is the feeling that decided the face, is stored, and comes back from GET /v1/conversation', async () => {
    const { chat, history } = kernel();
    expect((await chat('もうできたの？', PROUD)).messageEmotion).toMatchObject({ expression: 'determined', feeling: 'proud', kind: 'smug' });
    const [stored] = await history();
    expect(stored.messageEmotion).toMatchObject({ expression: 'determined', feeling: 'proud', kind: 'smug' });
  });

  it('is absent when the face comes from the quiet mood, so the face alone is what it always was', async () => {
    const { chat, history } = kernel();
    const emotion = (await chat('次の設計を考えてみて', PLAIN)).messageEmotion;
    expect(emotion.expression).toBe('calm');
    expect(emotion).not.toHaveProperty('kind');
    expect((await history())[0].messageEmotion).not.toHaveProperty('kind');
  });

  it('is in the NDJSON done.response, exactly as in the JSON response', async () => {
    const { api, model } = kernel();
    model.reply = PROUD;
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', deviceId: 'iphone',
      body: { scopeKey: 'owner', message: 'もうできたの？', stream: 'sentences' }, chatSentences: { write: () => undefined } });
    const lines = chatSentenceStreamLines(response);
    const done = lines.find(line => line.type === 'done') as { response: { messageEmotion: Emotion } } | undefined;
    expect(done?.response.messageEmotion).toMatchObject({ expression: 'determined', feeling: 'proud', kind: 'smug' });
    expect(done?.response.messageEmotion).toEqual((response.body as { messageEmotion: Emotion }).messageEmotion);
    expect(lines.filter(line => line.type === 'sentence').every(line => !('kind' in line))).toBe(true);
  });

  it('is never sent while other people can see the reply: the face is, and the owner reads the kind in his history', async () => {
    const { api, model, chat, history } = kernel();
    const emotion = (await chat('もうできたの？', PROUD, { audience: 'others' })).messageEmotion;
    expect(emotion).toMatchObject({ expression: 'determined', feeling: 'proud' });
    expect(emotion).not.toHaveProperty('kind');
    model.reply = PROUD;
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', deviceId: 'iphone',
      body: { scopeKey: 'owner', threadId: 'thread', message: 'もうできたの？', stream: 'sentences', audience: 'others' }, chatSentences: { write: () => undefined } });
    const done = chatSentenceStreamLines(response).find(line => line.type === 'done') as { response: { messageEmotion: Emotion } } | undefined;
    expect(done?.response.messageEmotion).toMatchObject({ expression: 'determined', feeling: 'proud' });
    expect(done?.response.messageEmotion).not.toHaveProperty('kind');
    // Stored with the message: only the owner reads GET /v1/conversation.
    expect((await history()).map(message => message.messageEmotion?.kind)).toEqual(['smug', 'smug']);
  });
});

describe('voice: the plan and the stored turn', () => {
  it('gives the owner\'s plan the kind beside the face and stores the voiced kind', async () => {
    const { api, model, history } = kernel();
    model.reply = 'ふふん、ボクにかかれば簡単です！';
    const plan = ((await api.dispatch({ method: 'POST', path: delegations, body: { scopeKey: 'owner', threadId: 'thread', transcript: 'もうできたの？' } }))
      .body as { voicePlan: Record<string, any> }).voicePlan;
    expect(plan).toMatchObject({ expression: 'determined', feeling: 'proud', kind: 'smug', emotion: { primary: 'smug' } });
    const stored = await api.dispatch({ method: 'POST', path: turns, body: {
      scopeKey: 'owner', threadId: 'thread', userTranscript: 'もうできたの？', shannonTranscript: model.reply,
      emotion: { primary: plan.emotion.primary, intensity: plan.emotion.intensity } } });
    expect((stored.body as { messageEmotion: Emotion }).messageEmotion).toMatchObject({ expression: 'determined', kind: 'smug' });
    expect((await history()).at(-1)?.messageEmotion).toMatchObject({ kind: 'smug' });
  });

  it('sends no kind on a /turns response with a companion present, and stores it for the owner\'s history', async () => {
    const { api, history } = kernel();
    const stored = await api.dispatch({ method: 'POST', path: turns, body: {
      scopeKey: 'owner', threadId: 'thread', userTranscript: 'もうできたの？', shannonTranscript: 'ふふん、ボクにかかれば簡単です！',
      emotion: { primary: 'smug', intensity: 0.7 }, companionPresent: true } });
    const emotion = (stored.body as { messageEmotion: Emotion }).messageEmotion;
    expect(emotion).toMatchObject({ expression: 'determined', feeling: 'proud' });
    expect(emotion).not.toHaveProperty('kind');
    expect((await history()).at(-1)?.messageEmotion).toMatchObject({ kind: 'smug' });
  });

  it('keeps the owner\'s plan to the face with a companion present, on every streamed line', async () => {
    const { api, model } = kernel();
    model.reply = 'ふふん、ボクにかかれば簡単です！';
    const plans: Array<Record<string, unknown>> = [];
    const response = await api.streamLiveVoiceDelegation({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript: 'もうできたの？',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, companionPresent: true } } },
    { onPlan: async plan => { plans.push(plan); }, onTextDelta: async () => undefined });
    const completed = (response.body as { companionPresent?: boolean; voicePlan: Record<string, unknown> });
    expect(completed.companionPresent).toBe(true);
    expect(plans.length).toBeGreaterThan(0);
    // The face comes from her feeling (alone, this plan would carry `kind: 'smug'`).
    expect(completed.voicePlan).toMatchObject({ expression: 'determined', feeling: 'proud', emotion: { primary: 'smug' } });
    for (const plan of [...plans, completed.voicePlan]) {
      expect(plan).not.toHaveProperty('kind');
    }
  });

  it('keeps a 友人も一緒 guest call to the face alone', async () => {
    const { api, model } = kernel();
    model.reply = 'えへへ、そんなこと言われると照れます。';
    const response = await api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript: 'シャノン、声が可愛いね', participantMode: 'guest',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: 'g1', text: 'シャノン、声が可愛いね', source: 'speech', rawText: 'シャノン、声が可愛いね',
          callContext: { turns: [], introductionStart: true } } } } });
    const plan = (response.body as { voicePlan: Record<string, unknown> }).voicePlan;
    expect(plan.expression).toBe('bashful');
    expect(plan).not.toHaveProperty('kind');
  });

  it('names the voiced kind when the stored face is the one the voice acted with', () => {
    const mood = { valence: 0.2, arousal: 0.4, openness: 0.4 };
    const goingOn: ShannonExpressiveEmotion = { primary: 'content', secondary: [], intensity: 0.4, target: 'ライ氏', cause: '', arousal: 0.3,
      valence: 0.3, visibility: 'expressed', startedAt: at, decay: 0.5, carryover: 0.5, continued: true };
    const resolved: ReplyEmotion = { messageEmotion: createShannonMessageEmotion(mood, goingOn), expressiveEmotion: goingOn };
    expect(resolved.messageEmotion.kind).toBe('content');
    expect(storedVoiceFace(resolved, { primary: 'triumphant', intensity: 0.7 })).toEqual({ ...mood, expression: 'determined', feeling: 'proud', kind: 'triumphant' });
    expect(storedVoiceFace(resolved, { primary: 'made-up', intensity: 0.7 })).toBe(resolved.messageEmotion);
  });
});

describe('stored rows', () => {
  const row = (kind?: unknown) => JSON.stringify({ stateVersion: 3, messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'joyful', ...(kind === undefined ? {} : { kind }) } });

  it('return a known kind, leave out one this server does not know, and read rows from before the field', () => {
    expect(parseMessageMetadata(row('gratitude'))?.messageEmotion).toEqual({ valence: 0, arousal: 0.3, openness: 0.35, expression: 'joyful', kind: 'gratitude' });
    expect(parseMessageMetadata(row('aNewerKind'))?.messageEmotion).toEqual({ valence: 0, arousal: 0.3, openness: 0.35, expression: 'joyful' });
    expect(parseMessageMetadata(row(7))?.messageEmotion).toEqual({ valence: 0, arousal: 0.3, openness: 0.35, expression: 'joyful' });
    expect(parseMessageMetadata(row())?.messageEmotion).toEqual({ valence: 0, arousal: 0.3, openness: 0.35, expression: 'joyful' });
  });
});

describe('the apps\' kind icons', () => {
  // The server deploy ships without apps/, so the check runs only where the app source is present.
  const kindIconSource = new URL('../../../apps/ios/Sources/ShannonAppCore/ShannonEmotionKindIcon.swift', import.meta.url);
  it.skipIf(!existsSync(kindIconSource))('name only kinds this server sends: every case of ShannonEmotionKindIcon is in SHANNON_EMOTION_KINDS', () => {
    const swift = readFileSync(kindIconSource, 'utf8');
    const body = swift.slice(swift.indexOf('enum ShannonEmotionKindIcon'), swift.indexOf('public var japaneseName'));
    const cases = [...body.matchAll(/^\s*case (\w+)\s*$/gm)].map(match => match[1]);
    expect(cases).toHaveLength(26);
    const sent = new Set<string>(SHANNON_EMOTION_KINDS.filter(kind => kind !== 'neutral'));
    expect(cases.filter(kind => !sent.has(kind))).toEqual([]);
  });
});
