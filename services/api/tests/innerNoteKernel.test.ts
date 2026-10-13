import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CHARACTER_CORE, InMemoryCompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { SQLiteBodyStore } from '../src/surfaces/body/store/bodyStore.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { emotionTiming } from '../src/mind/emotion/emotionTiming.js';
import { SQLiteInnerNoteStore } from '../src/mind/emotion/store/innerNoteStore.js';
import { InnerNoteService } from '../src/mind/emotion/innerNoteService.js';

const scope = 'owner';
const NIGHT = '2026-10-14T13:30:00.000Z';

class ScriptedModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  reply = 'はい。';
  private result(): ShannonChatModelResult { return { mode: this.mode, model: this.model, reply: this.reply }; }
  async generate(request: ShannonChatModelRequest) { this.requests.push(request); return this.result(); }
  async generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>) {
    this.requests.push(request);
    await onReplyText(this.reply);
    return this.result();
  }
}

async function harness(withNote: boolean) {
  const now = () => NIGHT;
  const model = new ScriptedModel();
  const stateStore = new InMemoryCompanionStateStore(now, emotionTiming());
  const notes = new SQLiteInnerNoteStore(new DatabaseSync(':memory:'));
  const service = new InnerNoteService({ store: notes, state: stateStore, ownerScope: scope, timeZone: 'Asia/Tokyo', now, manual: true,
    reflector: { model: 'test', reflect: async () => ({ usage: null, draft: { text: { honne: 'ほんとは、ちょっと嬉しかった。', tatemae: 'そっけなくする。',
      reason: '安く見られたくない。', plan: '三十分くらい。', bottom: '好きなまま。' }, shown: 'sulky', tell: 'blush', intent: 'keep', scale: 'ordinary',
      dayReason: null, untilMinutes: 30, changeReason: null, routeSummary: 'Shannon is a little sulky.', summary: null } }) } });
  if (withNote) {
    service.touched({ scopeKey: scope, audience: 'owner', at: NIGHT, touchId: 't1', phrase: 'ライ氏に胸をつつかれた', stance: 'dislike' });
    await service.flush(scope);
  }
  const api = createLocalApiKernel(now, { chatModel: model, stateStore, conversationStore: new InMemoryConversationStore(),
    body: { store: new SQLiteBodyStore(':memory:'), ingestEnabled: true }, ...(withNote ? { innerNote: service } : {}) });
  const chat = async (message: string, reply: string) => {
    model.reply = reply;
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: scope, message }, deviceId: 'iphone' });
    await new Promise<void>(resolve => setImmediate(resolve));
    return response.body as { messageEmotion: { expression: string; feeling?: string; kind?: string } };
  };
  return { model, chat, service };
}

describe('a text turn reads her inner note (ADR-0012 stage 1)', () => {
  it('without the port: the persona of before and no note in the turn', async () => {
    const { model, chat } = await harness(false);
    await chat('こんばんは', 'こんばんは。');
    const request = model.requests.at(-1)!;
    expect(request.systemPrompt).toContain('メイドAI');
    expect(request.turnContext ?? '').not.toContain('[心のメモ]');
  });

  it('with it: her character core in the cached identity, her note at the end of the turn, and the turn told back', async () => {
    const { model, chat, service } = await harness(true);
    const body = await chat('ごめん、出来心で', 'ごめんなさい……じゃなくて。もう知りません。');
    const request = model.requests.at(-1)!;
    expect(request.systemPrompt).toContain(CHARACTER_CORE.text);
    expect(request.systemPrompt).not.toContain('メイドAI');
    expect(request.turnContext).toContain('[心のメモ]');
    expect(request.turnContext).toContain('本音: ほんとは、ちょっと嬉しかった。');
    expect(request.turnContext!.trimEnd().endsWith('- 見せる気持ち: sulky（本音が少しにじむ: 頬が赤くなる） / 23:00ごろまで')).toBe(true);
    // D5.2: her own 「ごめん」 does not take her face while the note is active.
    expect(body.messageEmotion.kind).not.toBe('apologetic');
    expect(body.messageEmotion.feeling).not.toBe('apologetic');
    expect(service.pending(scope).map(event => event.kind)).toEqual(['apology']);
  });
});
