import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore, createShannonMessageEmotion, type ReplyEmotion, type ShannonExpressiveEmotion } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { chatSentenceStreamLines } from '../src/chatSentenceStream.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import { parseMessageMetadata } from '../src/sqliteStoreCodecs.js';
import { storedVoiceFace } from '../src/voiceEmotionPlan.js';

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

  it('follows the face with other people present: the same rule, the same reduced response otherwise', async () => {
    const { chat } = kernel();
    const emotion = (await chat('もうできたの？', PROUD, { audience: 'others' })).messageEmotion;
    expect(emotion).toMatchObject({ expression: 'determined', feeling: 'proud', kind: 'smug' });
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
