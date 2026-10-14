import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { switchOn } from '@shannon/switches';
import type { ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { FakeChat, reactionHarness } from './bodyReactionHarness.js';
import { fakeFeelingJev, type FeelingChoice } from './support/feelingHarness.js';
import { composedFeeling } from '../src/wiring/feelingWiring.js';
import type { ChatResponse, ChatStreamLine } from '../src/contracts/contracts.js';
import { chatSentenceStreamLines, generateChatTurn } from '../src/surfaces/text/chatSentenceStream.js';

/**
 * Item 10 (Syzygy ADR-0013; owner's choice 「B. 形＋間と分け方」; `SHANNON_TEXT_REGISTER`): the text reply carries its form and pacing for
 * the device (old clients ignore the field), and the model is told the form; urgency, safety, promises and system notices bypass it.
 */
const DAY = '2026-10-14T04:00:00.000Z';

class SaidChat extends FakeChat {
  constructor(private readonly said: string) { super(); }
  override async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: this.said };
  }
}

async function turn(options: { register: boolean; choice: FeelingChoice; said?: string; message?: string }) {
  const clock = { at: DAY };
  const jev = fakeFeelingJev(() => options.choice);
  const chatModel = new SaidChat(options.said ?? '別に。怒ってません。');
  const configured = composedFeeling({ database: new DatabaseSync(':memory:'), now: () => clock.at, timeZone: 'Asia/Tokyo', chooser: jev.chooser,
    turn: true, singleFace: false, textRegister: options.register });
  const harness = await reactionHarness({ feeling: configured.port, chatModel, stage2: false });
  harness.clock.at = DAY;
  const response = (await harness.send('POST', '/v1/chat', { message: options.message ?? '怒ってる？' }, 'iphone')).body as ChatResponse;
  return { response, prompt: chatModel.requests.at(-1)!.turnContext ?? '' };
}

const sulk = { stance: 'sulk', intensity: 'strong', drawer: 'none' };

describe('the text register on the reply (SHANNON_TEXT_REGISTER)', () => {
  it('is off by default: no field, and the prompt of before', async () => {
    expect(switchOn({}, 'SHANNON_TEXT_REGISTER')).toBe(false);
    const off = await turn({ register: false, choice: sulk });
    expect('textRegister' in off.response).toBe(false);
    expect(off.prompt).not.toContain('[この番の書き方]');
  });

  it('carries the pacing and the two messages, and tells the model the form', async () => {
    const { response, prompt } = await turn({ register: true, choice: sulk });
    expect(response.textRegister).toMatchObject({ version: 1, pauseMs: 20_000, split: true, emoji: 'none', parts: ['別に。', '怒ってません。'] });
    expect(response.textRegister!.bypass).toBeUndefined();
    expect(prompt).toContain('[この番の書き方]');
    expect(prompt.indexOf('[この番の書き方]')).toBeGreaterThan(prompt.indexOf('[この番の気持ち]'));
  });

  it('is bypassed by urgency: delivered at once, whole', async () => {
    const { response } = await turn({ register: true, choice: sulk, message: '地震だ、大丈夫？', said: '大丈夫です。すぐ机の下に入ってください。' });
    expect(response.textRegister).toMatchObject({ bypass: 'urgent', pauseMs: 0, typingMs: 0, split: false });
    expect(response.textRegister!.parts).toBeUndefined();
  });

  it('keeps one message when the reply has one sentence', async () => {
    const { response } = await turn({ register: true, choice: sulk, said: '……知りません。' });
    expect(response.textRegister!.parts).toBeUndefined();
  });
});

describe('the sentence stream', () => {
  const directive = { version: 1 as const, length: 'short' as const, maxCharacters: 30, punctuation: 'trailing' as const, emoji: 'none' as const,
    endings: 'flat' as const, lineBreaks: false, pauseMs: 12_000, typingMs: 4_000, split: true, gapMs: 1_600 };
  const streaming = () => {
    const calls: string[] = [];
    const model = {
      mode: 'local-stub' as const, model: 'fake',
      async generate() { calls.push('generate'); return { mode: 'local-stub' as const, model: 'fake', reply: '別に。' }; },
      async generateStreaming(_request: unknown, onText: (text: string) => void) { calls.push('stream'); onText('別に。怒って'); return { mode: 'local-stub' as const, model: 'fake', reply: '別に。' }; },
    };
    return { model, calls };
  };
  const base = { body: { scopeKey: 'owner', message: 'x', stream: 'sentences' as const }, threadId: 't', audience: { audience: 'owner' as const, alone: true },
    capability: { prompt: '', sources: [] }, placeSearch: false };

  it('sends a turn she keeps quiet first only once it is complete; one without a pause early, with its directive on start', async () => {
    const lines: ChatStreamLine[] = [];
    const paused = streaming();
    await generateChatTurn(paused.model as never, { write: line => lines.push(line) }, { ...base, textRegister: directive }, {} as never);
    expect(paused.calls).toEqual(['generate']);
    const early = streaming();
    await generateChatTurn(early.model as never, { write: line => lines.push(line) }, { ...base, textRegister: { ...directive, pauseMs: 0 } }, {} as never);
    expect(early.calls).toEqual(['stream']);
    expect(lines[0]).toMatchObject({ type: 'start', textRegister: { pauseMs: 0, split: true } });
  });

  it('puts the reply\'s directive on the start line of a stream sent once complete', () => {
    const body = { threadId: 't', audience: 'owner', reply: '別に。怒ってません。', textRegister: { ...directive, parts: ['別に。', '怒ってません。'] } };
    const lines = chatSentenceStreamLines({ status: 200, body, sentenceStream: { fallback: null } });
    expect(lines[0]).toMatchObject({ type: 'start', textRegister: { pauseMs: 12_000 } });
  });
});
