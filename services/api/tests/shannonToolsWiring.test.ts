import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalApiKernel } from '../src/infra/http/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { createInMemoryAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { TOOLS_WITHHELD_INSTRUCTIONS } from '../src/infra/models/chatModelTools.js';
import { TEXT_TURN_DEADLINE, TurnDeadline, VOICE_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { chatTurnRequestBody } from '../src/infra/models/chatModelTurn.js';
import { OTHERS_HEARD_WINDOW_MILLISECONDS, ToolAudienceWatch } from '../src/mind/inhibition/shannonToolAudience.js';
import { asksAboutOwnThings, conversationTools } from '../src/mind/tools/shannonToolSession.js';

/** Which turns are offered her tools: the owner alone, on text always and on voice when the words are about her writing or folder. */
const at = '2026-10-05T03:00:00.000Z';
const delegations = '/v1/voice/gemini/cascade/delegations';

class RecordingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly all: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  get last() { return this.all.at(-1)!; }
  async generate(request: ShannonChatModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'はい。' }; }
  async generateVoice(request: ShannonVoiceModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'はい。' }; }
}

function kernel(clock = { at }) {
  const model = new RecordingModel();
  const api = createLocalApiKernel(() => clock.at, { chatModel: model });
  const chat = async (message: string, extra: Record<string, unknown> = {}) => {
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message, ...extra } });
    expect(response.status).toBe(200);
    return model.last;
  };
  const voice = async (transcript: string, extra: { companionPresent?: boolean; participantMode?: 'guest'; threadId?: string } = {}) => {
    const response = await api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: extra.threadId ?? 'thread', transcript, ...(extra.participantMode ? { participantMode: extra.participantMode } : {}),
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, ...(extra.companionPresent ? { companionPresent: true } : {}),
        userUtterance: { id: `u-${transcript.length}`, text: transcript, source: 'speech', rawText: transcript,
          ...(extra.participantMode ? { callContext: { callId: 'call-tools-0001', turns: [], introductionStart: true } } : {}) } },
    } });
    expect(response.status).toBe(200);
    return model.last;
  };
  return { model, chat, voice };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('which conversation turns are offered her tools', () => {
  it('offers the study tools in a text turn the owner alone reads, and nothing while anyone else may read it', async () => {
    const { chat } = kernel();
    const alone = await chat('書斎の下書き、どうなってる？');
    expect(alone.tools?.definitions.map(tool => tool.name)).toEqual([
      'study.list', 'study.search', 'study.read', 'study.create', 'study.update', 'study.rename', 'study.move', 'study.delete', 'study.restore',
    ]);
    // No device is registered for her folder here, so its tools are not offered at all.
    expect(alone.tools?.definitions.some(tool => tool.name.startsWith('folder.'))).toBe(false);
    // A turn that forces a web search still carries the session; the adapter does not offer it there (chatModelTools.test.ts).
    expect((await chat('今日の天気を調べて', { webSearch: true })).tools).toBeDefined();
    expect((await chat('書斎の下書き、どうなってる？', { audience: 'others' })).tools).toBeUndefined();
    // The server remembers that others were there: for ten minutes even a turn that says "owner" gets no tools.
    expect((await chat('書斎の下書き、どうなってる？')).tools).toBeUndefined();
  });

  it('offers them in a voice turn only with the owner alone and words about her writing or her folder', async () => {
    const { voice } = kernel();
    expect((await voice('おはよう、今日は寒いね')).tools).toBeUndefined();
    // The local router gives no reliability score, so a spoken turn reads only until he says yes (shannonToolFollowUps.test.ts).
    expect((await voice('書斎のメモを読んで')).tools?.definitions.map(tool => tool.name)).toEqual(['study.list', 'study.search', 'study.read']);
    // An ordinary turn after such a talk is a follow-up (shannonToolFollowUps.test.ts); in another Talk it is not.
    expect((await voice('おはよう、今日は寒いね', { threadId: 'other' })).tools).toBeUndefined();
    expect((await voice('書斎のメモを読んで', { companionPresent: true })).tools).toBeUndefined();
    expect((await voice('書斎のメモを読んで', { participantMode: 'guest' })).tools).toBeUndefined();
    expect(asksAboutOwnThings('君のフォルダのファイル見て')).toBe(true);
    expect(asksAboutOwnThings('シャノンが書いた物語を読みたい')).toBe(true);
    // Common words alone are not about her things.
    for (const words of ['いい天気だね', 'メモしておいて', 'この書類に書いて', 'フォルダのファイル見て', 'あの映画の物語がよかった']) expect(asksAboutOwnThings(words), words).toBe(false);
  });

  it('offers nothing while a 「友人も一緒」 call was heard in the last ten minutes, whatever the next turn says', async () => {
    const clock = { at };
    const { chat, voice } = kernel(clock);
    await voice('こんにちは、はじめまして', { participantMode: 'guest' });
    expect((await chat('書斎の下書き、どうなってる？')).tools).toBeUndefined();
    expect((await voice('書斎のメモを読んで')).tools).toBeUndefined();
    clock.at = new Date(Date.parse(at) + OTHERS_HEARD_WINDOW_MILLISECONDS + 1_000).toISOString();
    expect((await chat('書斎の下書き、どうなってる？')).tools).toBeDefined();
  });

  it('offers nothing while her body says someone else can see or hear it, or when that cannot be read', () => {
    const runner = { tools: createInMemoryAutonomyService(() => at).tools };
    const secrets = () => ({ carries: () => false });
    const deadline = new TurnDeadline(TEXT_TURN_DEADLINE);
    const offer = (othersPresent: () => boolean) => conversationTools(runner, 'owner', 'text', true, { audience: new ToolAudienceWatch({ othersPresent }, () => at), secrets }, 'thread\nmessage', deadline);
    expect(offer(() => false).tools).toBeDefined();
    expect(offer(() => true)).toEqual({ toolsWithheld: true });
    expect(offer(() => { throw new Error('unreadable'); })).toEqual({ toolsWithheld: true });
    // She is told in one line, with no names, that her tools are withheld; the line is in no ordinary turn.
    const withheld = chatTurnRequestBody('gpt-5.6-luna', { scopeKey: 'owner', systemPrompt: '', history: [], message: 'x', toolsWithheld: true }, undefined);
    expect(String(withheld.instructions)).toContain(TOOLS_WITHHELD_INSTRUCTIONS);
    expect(String(chatTurnRequestBody('gpt-5.6-luna', { scopeKey: 'owner', systemPrompt: '', history: [], message: 'x' }, undefined).instructions)).not.toContain('[ボクの道具]');
    // Without what the server knows of the audience, nothing is offered, and nothing is said about it.
    expect(conversationTools(runner, 'owner', 'text', true, {}, 'thread\nmessage', deadline)).toEqual({});
    // The session carries the turn's deadline, not as part of what the model is asked.
    const offered = conversationTools(runner, 'owner', 'text', true, { audience: new ToolAudienceWatch({ othersPresent: () => false }, () => at), secrets }, 'thread\nmessage', deadline);
    expect(offered.tools?.deadline).toBe(deadline);
    expect(Object.keys(offered.tools!)).toEqual(['definitions', 'maximumCalls']);
  });

  it('gives the turn one deadline from the request\'s arrival: time before the model is counted, and voice has its own', async () => {
    let ticks = 0;
    // Every reading of the kernel's clock is a second later: what happens before the model call takes time.
    const clock = () => new Date(Date.parse(at) + 1_000 * ticks++).toISOString();
    const model = new RecordingModel();
    const api = createLocalApiKernel(clock, { chatModel: model });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: '書斎の下書き、どうなってる？' } });
    const text = (model.last as ShannonChatModelRequest).tools!.deadline;
    expect(text.plan).toBe(TEXT_TURN_DEADLINE);
    expect(text.left()).toBeLessThan(TEXT_TURN_DEADLINE.totalMilliseconds - 1_000);
    // A voice turn answered through generate() (as the provisional-intent path does) carries the voice deadline.
    const voiceModel: ShannonChatModel & { last?: unknown } = {
      mode: 'openai', model: 'test-model',
      async generate(request) { voiceModel.last = request; return { mode: 'openai', model: 'test-model', reply: 'はい。' }; },
    };
    const voiceApi = createLocalApiKernel(() => at, { chatModel: voiceModel });
    await voiceApi.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript: '書斎のメモを読んで',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, userUtterance: { id: 'u-1', text: '書斎のメモを読んで', source: 'speech', rawText: '書斎のメモを読んで' } },
    } });
    expect((voiceModel.last as ShannonChatModelRequest).tools!.deadline.plan).toBe(VOICE_TURN_DEADLINE);
  });

  it('offers nothing anywhere with SHANNON_OWN_TOOLS=off', async () => {
    vi.stubEnv('SHANNON_OWN_TOOLS', 'off');
    const { chat, voice } = kernel();
    expect((await chat('書斎の下書き、どうなってる？')).tools).toBeUndefined();
    expect((await voice('書斎のメモを読んで')).tools).toBeUndefined();
  });
});
