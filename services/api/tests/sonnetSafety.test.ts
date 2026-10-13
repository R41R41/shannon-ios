import { describe, expect, it } from 'vitest';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { sonnetSettings } from '../src/infra/models/anthropic/anthropicConfig.js';
import { claudeToolLoop } from '../src/infra/models/claude/claudeToolLoop.js';
import { TieredChatModel } from '../src/infra/models/tieredChatModel.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { TEXT_TURN_DEADLINE, TURN_OUT_OF_TIME_LINE, TurnDeadline } from '../src/mind/action/respond/turnDeadline.js';
import { VOICE_SONNET_FIRST_TOKEN, tierRequest } from '../src/mind/action/respond/turnRouting.js';
import { conversationTools, type ConversationToolServer } from '../src/mind/tools/shannonToolSession.js';
import { anthropicFixture, sse } from './support/anthropicFixtures.js';

/**
 * Review H1–H3 of Syzygy ADR-0008 stage 2 (`docs/skill-and-routing-contract.md`, 「Sonnet の段」): Sonnet falls back to luna only
 * while nothing of the turn has happened, and a voice turn's Sonnet must give its first word or tool call within a budget.
 */
const base: ShannonChatModelRequest = { scopeKey: 'owner', systemPrompt: '[シャノン]', history: [], message: '書斎に何がある？' };
const voice: ShannonVoiceModelRequest = { ...base, useWebSearch: false, conversationClass: 'direct' };

class Luna implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'gpt-5.6-luna';
  readonly seen: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  async generate(request: ShannonChatModelRequest) { this.seen.push(request); return { mode: this.mode, model: this.model, reply: 'luna' }; }
  async generateStreaming(request: ShannonChatModelRequest) { this.seen.push(request); return { mode: this.mode, model: this.model, reply: 'luna' }; }
  async generateVoice(request: ShannonVoiceModelRequest) { this.seen.push(request); return { mode: this.mode, model: this.model, reply: 'luna' }; }
  async generateVoiceStreaming(request: ShannonVoiceModelRequest) { this.seen.push(request); return { mode: this.mode, model: this.model, reply: 'luna' }; }
}

/** A fetch that answers after `delayMs` (or never, before an abort), streamed or not. */
function slowAnthropic(delayMs: number) {
  let calls = 0;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
    });
    const answer = anthropicFixture('structured-answer');
    return body.stream ? new Response(sse(answer), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetcher, calls: () => calls };
}

const model = (fetcher?: typeof fetch) => new AnthropicChatModel({ apiKey: 'test-only', settings: sonnetSettings({}), ...(fetcher ? { fetch: fetcher } : {}) });

describe('no fallback once anything of the turn happened (H1, H2)', () => {
  it('ends with her fixed line, never luna, after streamed text or speech', async () => {
    const luna = new Luna();
    const sonnet = model();
    sonnet.generateStreaming = async (_request, onReplyText) => { await onReplyText('書斎には'); throw new Error('stream reset'); };
    sonnet.generateVoiceStreaming = async (_request, onTextDelta) => { await onTextDelta('えっと、書斎には。'); throw new Error('stream reset'); };
    const lines: string[] = [];
    const tiered = new TieredChatModel(luna, sonnet, line => lines.push(line));
    const written: string[] = [];
    const text = await tiered.generateStreaming({ ...base, tier: 'sonnet' }, delta => { written.push(delta); });
    expect(text).toMatchObject({ outOfTime: true });
    expect(text.reply.endsWith(TURN_OUT_OF_TIME_LINE)).toBe(true);
    const spoken: string[] = [];
    const said = await tiered.generateVoiceStreaming({ ...voice, tier: 'sonnet' }, delta => { spoken.push(delta); });
    expect(said).toMatchObject({ outOfTime: true, reply: `えっと、書斎には。${TURN_OUT_OF_TIME_LINE}` });
    expect(spoken).toEqual(['えっと、書斎には。', TURN_OUT_OF_TIME_LINE]);
    expect(luna.seen).toEqual([]);
    expect(lines.every(line => line.startsWith('Shannon sonnet tier ended with the fixed line'))).toBe(true);
  });

  it('ends with her fixed line, never luna, once a tool ran in the turn (a write never runs twice)', async () => {
    const luna = new Luna();
    const autonomy = createInMemoryAutonomyService(() => '2026-10-07T03:00:00.000Z');
    const server: Partial<ConversationToolServer> = { audience: { othersKnown: () => false, noteOthers: () => undefined }, now: () => '2026-10-07T03:00:00.000Z' };
    const tools = conversationTools(autonomy, 'owner', 'text', true, server, 'thread\n書斎に何がある？', new TurnDeadline(TEXT_TURN_DEADLINE)).tools!;
    const sonnet = model();
    sonnet.generate = async request => { await request.tools!.call('study_list', '{}'); throw new Error('overloaded'); };
    const result = await new TieredChatModel(luna, sonnet, () => undefined).generate({ ...base, tools, tier: 'sonnet' });
    expect(result).toMatchObject({ outOfTime: true, reply: TURN_OUT_OF_TIME_LINE });
    expect(luna.seen).toEqual([]);
    // Before anything happened, luna answers as plain luna.
    sonnet.generate = async () => { throw new Error('overloaded'); };
    expect((await new TieredChatModel(luna, sonnet, () => undefined).generate({ ...base, tier: 'sonnet', firstTokenBudgetMs: 10 })).reply).toBe('luna');
    expect(luna.seen.at(-1)).not.toHaveProperty('firstTokenBudgetMs');
  });
});

describe('the voice first-token watchdog (H3)', () => {
  it('gives voice Sonnet min(left − 6 s, 4 s), and no budget to text or to luna', () => {
    const sonnet = { tier: 'sonnet', served: 'sonnet', reason: 'strong', mappedDown: 'none', rethinks: 0, verify: false, escalateOnTrouble: false, kind: 'analysis' } as const;
    expect(tierRequest(sonnet, 30_000)).toMatchObject({ tier: 'sonnet', firstTokenBudgetMs: VOICE_SONNET_FIRST_TOKEN.maximumMs });
    expect(tierRequest(sonnet, 8_000)).toMatchObject({ firstTokenBudgetMs: 2_000 });
    expect(tierRequest(sonnet)).not.toHaveProperty('firstTokenBudgetMs');
    expect(tierRequest({ ...sonnet, tier: 'luna', served: 'luna' }, 30_000)).not.toHaveProperty('firstTokenBudgetMs');
  });

  it('aborts Sonnet whose first token is late and answers with luna; in time, Sonnet answers', async () => {
    for (const streamed of [true, false]) {
      const luna = new Luna();
      const slow = slowAnthropic(400);
      const tiered = new TieredChatModel(luna, model(slow.fetcher), () => undefined);
      const started = performance.now();
      const result = streamed ? await tiered.generateVoiceStreaming({ ...voice, tier: 'sonnet', firstTokenBudgetMs: 50 }, () => undefined)
        : await tiered.generateVoice({ ...voice, tier: 'sonnet', firstTokenBudgetMs: 50 });
      expect(result.reply).toBe('luna');
      expect(performance.now() - started).toBeLessThan(350);
      expect(luna.seen).toHaveLength(1);
    }
    const quick = slowAnthropic(5);
    const luna = new Luna();
    const result = await new TieredChatModel(luna, model(quick.fetcher), () => undefined).generateVoiceStreaming({ ...voice, tier: 'sonnet', firstTokenBudgetMs: 2_000 }, () => undefined);
    expect(result.model).toBe('claude-sonnet-5-5');
    expect(luna.seen).toEqual([]);
  });

  it('streams a structured Sonnet turn that has a first-token budget, so the budget times its first token, not the whole reply', async () => {
    const seen: boolean[] = [];
    const recording = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push((JSON.parse(String(init?.body)) as { stream?: boolean }).stream === true);
      return slowAnthropic(5).fetcher(url, init);
    }) as typeof fetch;
    const luna = new Luna();
    const result = await new TieredChatModel(luna, model(recording), () => undefined).generate({ ...base, tier: 'sonnet', firstTokenBudgetMs: 2_000 });
    expect(result.model).toBe('claude-sonnet-5-5');
    expect(luna.seen).toEqual([]);
    await model(recording).generate(base); // No budget: the request is as it was, unstreamed.
    expect(seen).toEqual([true, false]);
  });

  it('keeps voice first-token samples apart from text ones', async () => {
    const sonnet = model(slowAnthropic(1).fetcher);
    for (let index = 0; index < 3; index += 1) await sonnet.generateStreaming(base, () => undefined);
    expect(sonnet.textFirstTokenLatency.estimate()).not.toBeNull();
    expect(sonnet.firstTokenLatency.estimate()).toBeNull();
  });

  it('on voice, a round that ran out of time before any tool fails over to luna instead of asking Sonnet again', async () => {
    const timedOut = Object.assign(new Error('round timed out'), { name: 'TimeoutError' });
    let sends = 0;
    const session = { definitions: [], maximumCalls: 4, deadline: new TurnDeadline(TEXT_TURN_DEADLINE), call: async () => '' } as never;
    const send = async () => { sends += 1; throw timedOut; };
    await expect(claudeToolLoop({ model: 'm', max_tokens: 10, messages: [] }, { session, send, isAnswer: () => false, timedOutRound: 'fail' })).rejects.toBe(timedOut);
    expect(sends).toBe(1);
  });
});
