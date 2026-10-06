import { describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { InMemoryOrganizeStore } from '../src/integrations/voyager/organize.js';
import { LocalVoiceDecisionGateway } from '../src/voiceDecision.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import {
  VOICE_CALL_SUMMARY_HEADING, VOICE_CALL_SUMMARY_PATH, acceptedSummary, fallbackVoiceCallSummary,
} from '../src/apiVoiceCallSummary.js';
import {
  guestAddressDecision, guestCallHistory, validatedGuestCallContext, type GuestCallTurn,
} from '../src/voiceGuestCall.js';
import { promptOf } from './modelPrompt.js';

const at = '2026-10-01T03:00:00.000Z';
const delegations = '/v1/voice/gemini/cascade/delegations';

class RecordingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  readonly voiceRequests: ShannonVoiceModelRequest[] = [];
  voiceReply: string | Error = '相手: ミキさん\n話したこと: 声の印象と、シャノンにできることを話した。\n次に話したいこと: 作ったものを見せたい。';

  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: `返答${this.requests.length}` };
  }

  async generateVoice(request: ShannonVoiceModelRequest) {
    this.voiceRequests.push(request);
    if (this.voiceReply instanceof Error) throw this.voiceReply;
    return { mode: this.mode, model: this.model, reply: this.voiceReply };
  }
}

function guestBody(threadId: string, transcript: string, callContext: Record<string, unknown>, id = 'u1') {
  return {
    scopeKey: 'owner', threadId, transcript, participantMode: 'guest',
    deviceContext: {
      timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
      userUtterance: { id, text: transcript, source: 'speech', rawText: transcript, callContext },
    },
  };
}

const callTurns: GuestCallTurn[] = [
  { role: 'participant', text: 'こんにちは。声、可愛いね。' },
  { role: 'shannon', text: 'えへへ、ありがとうございます。' },
];

describe('友人も一緒: in-call context', () => {
  it('passes this call\'s earlier turns to the model and stores nothing', async () => {
    const model = new RecordingModel();
    const store = new InMemoryConversationStore();
    const api = createLocalApiKernel(() => at, { chatModel: model, conversationStore: store });
    const response = await api.dispatch({ method: 'POST', path: delegations,
      body: guestBody('thread', 'いつもこういう感じなの？', { turns: callTurns, followsShannonTurn: true }) });

    expect(response.status).toBe(200);
    expect(model.voiceRequests).toHaveLength(1);
    expect(model.voiceRequests[0]?.history).toEqual([
      { role: 'user', content: 'こんにちは。声、可愛いね。' },
      { role: 'assistant', content: 'えへへ、ありがとうございます。' },
    ]);
    expect(promptOf(model.voiceRequests[0])).toContain('The first-meeting greeting already happened');
    expect(store.conversationHistory('owner', 'thread')).toEqual([]);
    expect(store.experienceCandidates('owner')).toEqual([]);
  });

  it('bounds the context to the latest turns and trims long ones', () => {
    const turns = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 ? 'shannon' : 'participant', text: `${index}:${'あ'.repeat(900)}`,
    }));
    const context = validatedGuestCallContext({ turns });
    if (!context) throw new Error('context expected');
    expect(context.turns).toHaveLength(24);
    expect(context.turns[0]?.text.startsWith('16:')).toBe(true);
    expect(Array.from(context.turns[0]!.text)).toHaveLength(600);
    expect(guestCallHistory(context)).toHaveLength(24);
    expect(validatedGuestCallContext({ turns: [{ role: 'owner', text: 'x' }] })).toBe(false);
    expect(validatedGuestCallContext({ turns: 'x' })).toBe(false);
    expect(validatedGuestCallContext({ turns: [], addressedByName: 'yes' })).toBe(false);
  });

  it('rejects a malformed call context', async () => {
    const api = createLocalApiKernel(() => at, { chatModel: new RecordingModel() });
    await expect(api.dispatch({ method: 'POST', path: delegations,
      body: guestBody('thread', 'こんにちは', { turns: [{ role: 'owner', text: '秘密' }] }) }))
      .resolves.toMatchObject({ status: 400 });
  });

  it('ignores a call context sent with an owner turn', async () => {
    const model = new RecordingModel();
    const api = createLocalApiKernel(() => at, { chatModel: model });
    const body = { ...guestBody('thread', '今日は何しようか', { turns: callTurns }), participantMode: 'owner' };
    await api.dispatch({ method: 'POST', path: delegations, body });
    expect(model.voiceRequests[0]?.history).toEqual([]);
    expect(promptOf(model.voiceRequests[0])).not.toContain('[Introduction mode');
    expect(promptOf(model.voiceRequests[0])).toContain('[Someone else may be present]');
  });
});

describe('友人も一緒: switching inside a running call', () => {
  it('uses no owner context on the very next turn after the switch', async () => {
    const model = new RecordingModel();
    const store = new InMemoryConversationStore();
    const organize = new InMemoryOrganizeStore();
    const aetherCalls: string[] = [];
    const api = createLocalApiKernel(() => at, {
      chatModel: model, conversationStore: store, organizeStore: organize,
      aetherContext: { promptFor: (_scope, message) => { aetherCalls.push(message); return '[Aether] 秘密のノート: ハシビロコウ'; } },
    });
    const cognition = () => api.dispatch({
      method: 'GET', path: '/v1/cognition', query: new URLSearchParams({ scopeKey: 'owner' }),
    });
    // Owner period: private history, an explicit goal, and a normal owner voice turn.
    await api.dispatch({ method: 'POST', path: '/v1/chat',
      body: { scopeKey: 'owner', threadId: 'thread', message: '秘密の合言葉はミズクラゲ。覚えておいて' } });
    await api.dispatch({ method: 'POST', path: '/v1/chat',
      body: { scopeKey: 'owner', threadId: 'thread', message: 'シャノンを一貫した人格として感じられるように改善したい。' } });
    await api.dispatch({ method: 'POST', path: delegations,
      body: { scopeKey: 'owner', threadId: 'thread', transcript: 'ノートを踏まえて、前に話した合言葉を覚えてる？' } });
    const ownerRequest = model.voiceRequests.at(-1)!;
    expect(promptOf(ownerRequest)).toContain('ハシビロコウ');
    expect(JSON.stringify(ownerRequest.history)).toContain('ミズクラゲ');
    const ownerVoiceCalls = model.voiceRequests.length;
    const ownerChatCalls = model.requests.length;
    const historyBefore = store.conversationHistory('owner', 'thread');
    const cognitionBefore = await cognition();
    aetherCalls.length = 0;

    // The same call and thread, now 「友人も一緒」. Each utterance would read or write owner data in owner mode.
    const utterances = [
      'ノートとタスクを踏まえて、前に話した合言葉を教えて',
      '写真整理をタスクにして',
      'それは忘れて',
      '私は辛いものが苦手。明日映画に行こうね',
      '英語を毎日勉強できるようになりたい。',
    ];
    for (const [index, transcript] of utterances.entries()) {
      const response = await api.dispatch({ method: 'POST', path: delegations,
        body: guestBody('thread', transcript, { turns: [], introductionStart: true }, `guest-${index}`) });
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('receipt');
      expect(response.body).not.toHaveProperty('organizeSession');
      expect(response.body).not.toHaveProperty('uiBlocks');
    }
    const guestRequests = [...model.voiceRequests.slice(ownerVoiceCalls), ...model.requests.slice(ownerChatCalls)];
    expect(guestRequests).toHaveLength(utterances.length);
    for (const request of guestRequests) {
      expect(request.history).toEqual([]);
      expect(promptOf(request)).toContain('[Introduction mode — 友人も一緒]');
      expect(promptOf(request)).not.toContain('ミズクラゲ');
      expect(promptOf(request)).not.toContain('ハシビロコウ');
      expect(promptOf(request)).not.toContain('シャノンを一貫した人格');
      expect(promptOf(request)).not.toContain('[Current intention frame');
      expect(promptOf(request)).not.toContain('[Shannon shared state v1]');
      expect(promptOf(request)).not.toContain('[Someone else may be present]');
    }
    expect(aetherCalls).toEqual([]);
    expect(organize.list('owner', 'thread')).toHaveLength(0);
    expect(store.conversationHistory('owner', 'thread')).toEqual(historyBefore);
    await expect(cognition()).resolves.toEqual(cognitionBefore);

    // Back to 本人だけ: owner context returns, and nothing from the guest period is in it.
    await api.dispatch({ method: 'POST', path: delegations,
      body: { scopeKey: 'owner', threadId: 'thread', transcript: '前に話した合言葉を覚えてる？' } });
    const after = model.voiceRequests.at(-1)!;
    expect(JSON.stringify(after.history)).toContain('ミズクラゲ');
    expect(JSON.stringify(after.history)).not.toContain('辛いもの');
    expect(promptOf(after)).not.toContain('映画');
  });
});

describe('友人も一緒: answering only when addressed', () => {
  const quiet = { turns: callTurns, followsShannonTurn: false, addressedByName: false, introductionStart: false };
  const following = { ...quiet, followsShannonTurn: true };

  it('stays quiet for talk between the people at the table', () => {
    expect(guestAddressDecision('声とか返答のモデルは外部のものを使ってる。', quiet, 'speech')).toMatchObject({ respond: false });
    expect(guestAddressDecision('へえ。それを全部つなげてるんだ。結構大変そう。', quiet, 'speech')).toMatchObject({ respond: false });
    expect(guestAddressDecision('自分で何かやってて、あとから見せてくれたら面白いなって思ってて、そういうのを作ってる。', following, 'speech'))
      .toEqual({ respond: false, reason: 'explanation' });
  });

  it('answers a name, a question, a request, a greeting, and a short reaction to her own turn', () => {
    expect(guestAddressDecision('シャノンも、そういうことしてみたい', quiet, 'speech')).toEqual({ respond: true, reason: 'named' });
    expect(guestAddressDecision('そうなんだ', { ...quiet, addressedByName: true }, 'speech')).toEqual({ respond: true, reason: 'named' });
    expect(guestAddressDecision('何ができるの？', quiet, 'speech')).toEqual({ respond: true, reason: 'question' });
    expect(guestAddressDecision('普段何話してるの', quiet, 'speech')).toEqual({ respond: true, reason: 'question' });
    expect(guestAddressDecision('今日も開発してたの', quiet, 'speech')).toEqual({ respond: true, reason: 'question' });
    expect(guestAddressDecision('なんか歌って', quiet, 'speech')).toEqual({ respond: true, reason: 'request' });
    expect(guestAddressDecision('はじめまして', quiet, 'speech')).toEqual({ respond: true, reason: 'social' });
    expect(guestAddressDecision('また話そうね', quiet, 'speech')).toEqual({ respond: true, reason: 'social' });
    expect(guestAddressDecision('自分で言うんだよね', following, 'speech').respond).toBe(true);
    expect(guestAddressDecision('たまに聞き間違えるけどね。', following, 'speech')).toEqual({ respond: true, reason: 'reaction' });
  });

  it('always answers the first turn, typed input, and clients that send no call context', () => {
    expect(guestAddressDecision('うん', { ...quiet, introductionStart: true }, 'speech')).toEqual({ respond: true, reason: 'introduction' });
    expect(guestAddressDecision('外部のものを使ってる。', quiet, 'typed').respond).toBe(true);
    expect(guestAddressDecision('外部のものを使ってる。', null, 'speech').respond).toBe(true);
  });

  it('returns an empty reply without calling the model when not addressed', async () => {
    const model = new RecordingModel();
    const api = createLocalApiKernel(() => at, { chatModel: model });
    const response = await api.dispatch({ method: 'POST', path: delegations,
      body: guestBody('thread', '声とか返答のモデルは外部のものを使ってる。', quiet) });
    expect(response).toMatchObject({ status: 200, body: { reply: '', voicePlan: { shouldRespond: false } } });
    expect(model.voiceRequests).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
  });

  it('does not call the router model for overheard talk', async () => {
    const local = new LocalVoiceDecisionGateway();
    const routed: string[] = [];
    const api = createLocalApiKernel(() => at, { chatModel: new RecordingModel(), voiceDecision: {
      mode: 'openai', model: 'router-test',
      decide: input => { routed.push(input.transcript); return local.decide(input); },
    } });
    await api.dispatch({ method: 'POST', path: delegations,
      body: guestBody('thread', '声とか返答のモデルは外部のものを使ってる。', quiet) });
    expect(routed).toEqual([]);
    await api.dispatch({ method: 'POST', path: delegations, body: guestBody('thread', 'シャノン、何ができるの？', quiet) });
    expect(routed).toEqual(['シャノン、何ができるの？']);
  });

  it('greets when the owner switches by the control and nobody has spoken yet', async () => {
    const model = new RecordingModel();
    const store = new InMemoryConversationStore();
    const api = createLocalApiKernel(() => at, { chatModel: model, conversationStore: store });
    const cue = '（ライ氏が「友人も一緒」に切り替えました。そばにいるお友達に、はじめましての挨拶をしてください。）';
    const response = await api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript: cue, participantMode: 'guest',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: 'cue', text: cue, source: 'typed', callContext: { turns: [], introductionStart: true } } },
    } });
    expect(response).toMatchObject({ status: 200, body: { voicePlan: { shouldRespond: true } } });
    expect(promptOf(model.voiceRequests[0])).toContain('Greet the friend now');
    expect(store.conversationHistory('owner', 'thread')).toEqual([]);
  });

  it('greets on the first turn even when the utterance is only an acknowledgement', async () => {
    const model = new RecordingModel();
    const api = createLocalApiKernel(() => at, { chatModel: model });
    const response = await api.dispatch({ method: 'POST', path: delegations,
      body: guestBody('thread', 'うん', { turns: [], introductionStart: true }) });
    expect(response).toMatchObject({ status: 200, body: { voicePlan: { shouldRespond: true } } });
    expect(promptOf(model.voiceRequests[0])).toContain('Greet the friend now');
  });
});

describe('友人も一緒: optional call summary', () => {
  const turns: GuestCallTurn[] = [
    { role: 'participant', text: 'はじめまして、ミキです。声が可愛いね。' },
    { role: 'shannon', text: 'ミキさん、ありがとうございます。' },
    { role: 'participant', text: '作ったら私にも見せてね。' },
    { role: 'shannon', text: 'はい。次は作ったものをお見せしたいです。' },
  ];

  it('saves one marked note with a single model call and no memory source', async () => {
    const model = new RecordingModel();
    const store = new InMemoryConversationStore();
    const api = createLocalApiKernel(() => at, { chatModel: model, conversationStore: store });
    const response = await api.dispatch({ method: 'POST', path: VOICE_CALL_SUMMARY_PATH,
      body: { scopeKey: 'owner', threadId: 'thread', turns } });

    expect(response).toMatchObject({ status: 201, body: { threadId: 'thread', source: 'model' } });
    expect(model.voiceRequests).toHaveLength(1);
    expect(model.requests).toHaveLength(0);
    expect(model.voiceRequests[0]?.history).toEqual([]);
    expect(model.voiceRequests[0]?.useWebSearch).toBe(false);
    const history = store.conversationHistory('owner', 'thread');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: 'assistant' });
    expect(history[0]?.content.startsWith(VOICE_CALL_SUMMARY_HEADING)).toBe(true);
    expect(history[0]?.content).toContain('ミキさん');
    expect(history[0]?.content).not.toContain('声が可愛いね');
    expect(store.experienceCandidates('owner')).toEqual([]);
    const cognition = await api.dispatch({
      method: 'GET', path: '/v1/cognition', query: new URLSearchParams({ scopeKey: 'owner' }),
    });
    expect(JSON.stringify(cognition.body)).not.toContain('ミキ');
  });

  it('keeps a content-free note when the model fails or quotes speech', async () => {
    const model = new RecordingModel();
    model.voiceReply = new Error('OPENAI_RESPONSE_500');
    const store = new InMemoryConversationStore();
    const api = createLocalApiKernel(() => at, { chatModel: model, conversationStore: store });
    const response = await api.dispatch({ method: 'POST', path: VOICE_CALL_SUMMARY_PATH,
      body: { scopeKey: 'owner', threadId: 'thread', turns } });
    expect(response).toMatchObject({ status: 201, body: { source: 'fallback' } });
    expect(store.conversationHistory('owner', 'thread')[0]?.content).toContain(fallbackVoiceCallSummary(turns));
    expect(store.conversationHistory('owner', 'thread')[0]?.content).not.toContain('ミキ');

    expect(acceptedSummary('話したこと: 「はじめまして、ミキです。声が可愛いね。」と言われた', turns)).toBeNull();
    expect(acceptedSummary('相手: ミキさん\n話したこと: 声の印象。', turns)).toBe('相手: ミキさん\n話したこと: 声の印象。');
    expect(acceptedSummary('  \n ', turns)).toBeNull();
    expect(Array.from(acceptedSummary('あ'.repeat(900), turns) ?? '')).toHaveLength(400);
  });

  it('rejects requests that are not a call and limits repeated summaries', async () => {
    const model = new RecordingModel();
    const api = createLocalApiKernel(() => at, { chatModel: model, conversationStore: new InMemoryConversationStore() });
    const post = (body: Record<string, unknown>) => api.dispatch({ method: 'POST', path: VOICE_CALL_SUMMARY_PATH, body });
    await expect(post({ scopeKey: 'owner', turns: [{ role: 'participant', text: 'こんにちは' }] })).resolves.toMatchObject({ status: 400 });
    await expect(post({ scopeKey: 'owner', turns: 'x' })).resolves.toMatchObject({ status: 400 });
    await expect(post({ scopeKey: 'owner', threadId: 7, turns })).resolves.toMatchObject({ status: 400 });
    expect(model.voiceRequests).toHaveLength(0);
    for (let index = 0; index < 6; index += 1) {
      await expect(post({ scopeKey: 'owner', turns })).resolves.toMatchObject({ status: 201 });
    }
    await expect(post({ scopeKey: 'owner', turns })).resolves.toMatchObject({ status: 429 });
    expect(model.voiceRequests).toHaveLength(6);
  });

  it('stores nothing for a call that ends without the summary request', async () => {
    const model = new RecordingModel();
    const store = new InMemoryConversationStore();
    const api = createLocalApiKernel(() => at, { chatModel: model, conversationStore: store });
    for (const [index, transcript] of ['はじめまして、ミキです', 'シャノン、何ができるの？', 'また話そうね'].entries()) {
      await api.dispatch({ method: 'POST', path: delegations,
        body: guestBody('thread', transcript, { turns: turns.slice(0, index), introductionStart: index === 0 }, `g${index}`) });
    }
    expect(model.voiceRequests).toHaveLength(3);
    expect(store.conversationHistory('owner', 'thread')).toEqual([]);
    expect(store.experienceCandidates('owner')).toEqual([]);
    expect(store.listThreads('owner')).toEqual([]);
  });

  it('writes the SQLite note as display history only', () => {
    const store = new SQLiteShannonStore({ path: ':memory:', now: () => at });
    const threadId = store.createThread('owner', '紹介');
    const note = store.appendNote('owner', threadId, `${VOICE_CALL_SUMMARY_HEADING}\n相手: お友達`, at, 'voice_call_summary');
    expect(note).toMatchObject({ role: 'assistant' });
    expect(store.conversationHistory('owner', threadId)).toHaveLength(1);
    expect(store.experienceCandidates('owner')).toEqual([]);
    expect(store.events('owner')).toEqual([]);
    expect(store.pendingBackgroundJobCount()).toBe(0);
    expect(store.dailyUserMessages('owner', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')).toEqual([]);
    store.close();
  });
});
