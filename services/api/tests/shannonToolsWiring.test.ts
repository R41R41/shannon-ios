import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { createInMemoryAutonomyService } from '../src/autonomyService.js';
import { TOOLS_WITHHELD_INSTRUCTIONS } from '../src/chatModelTools.js';
import { chatTurnRequestBody } from '../src/chatModelTurn.js';
import { OTHERS_HEARD_WINDOW_MILLISECONDS, ToolAudienceWatch } from '../src/shannonToolAudience.js';
import { asksAboutOwnThings, conversationTools } from '../src/shannonToolSession.js';

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
  const voice = async (transcript: string, extra: { companionPresent?: boolean; participantMode?: 'guest' } = {}) => {
    const response = await api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript, ...(extra.participantMode ? { participantMode: extra.participantMode } : {}),
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
    expect((await voice('書斎のメモを読んで')).tools?.definitions.length).toBe(9);
    expect((await voice('おはよう、今日は寒いね')).tools).toBeUndefined();
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
    const offer = (othersPresent: () => boolean) => conversationTools(runner, 'owner', 'text', true, { audience: new ToolAudienceWatch({ othersPresent }, () => at), secrets });
    expect(offer(() => false).tools).toBeDefined();
    expect(offer(() => true)).toEqual({ toolsWithheld: true });
    expect(offer(() => { throw new Error('unreadable'); })).toEqual({ toolsWithheld: true });
    // She is told in one line, with no names, that her tools are withheld; the line is in no ordinary turn.
    const withheld = chatTurnRequestBody('gpt-5.6-luna', { scopeKey: 'owner', systemPrompt: '', history: [], message: 'x', toolsWithheld: true }, undefined);
    expect(String(withheld.instructions)).toContain(TOOLS_WITHHELD_INSTRUCTIONS);
    expect(String(chatTurnRequestBody('gpt-5.6-luna', { scopeKey: 'owner', systemPrompt: '', history: [], message: 'x' }, undefined).instructions)).not.toContain('[ボクの道具]');
    // Without what the server knows of the audience, nothing is offered.
    expect(conversationTools(runner, 'owner', 'text', true).tools).toBeUndefined();
  });

  it('offers nothing anywhere with SHANNON_OWN_TOOLS=off', async () => {
    vi.stubEnv('SHANNON_OWN_TOOLS', 'off');
    const { chat, voice } = kernel();
    expect((await chat('書斎の下書き、どうなってる？')).tools).toBeUndefined();
    expect((await voice('書斎のメモを読んで')).tools).toBeUndefined();
  });
});
