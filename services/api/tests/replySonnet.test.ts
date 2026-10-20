import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { sonnetSettings } from '../src/infra/models/anthropic/anthropicConfig.js';
import { MemorySonnetReplyCap, ReplySonnetChatModel, type SonnetReplyCap } from '../src/infra/models/replySonnetChatModel.js';
import {
  closeReplySonnet, localDay, REPLY_SONNET_DAILY_CAP, replySonnetDailyCap, repliesOnSonnet, withReplySonnet,
} from '../src/wiring/replySonnetWiring.js';
import { SQLiteReplySonnetDays } from '../src/mind/emotion/store/replySonnetDayStore.js';
import { configuredFeeling } from '../src/wiring/feelingWiring.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { FIRST_CLAUSE_CHARACTERS, SpokenSentenceSegmenter } from '../src/surfaces/voice/spokenSentences.js';
import { VOICE_SONNET_FIRST_TOKEN } from '../src/mind/action/respond/turnRouting.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';

/**
 * Owner 2026-10-21 (「声は全部 Sonnet」, then 「文字も全部 Sonnet」; `SHANNON_REPLY_SONNET`): every reply of hers is Sonnet's, voice and
 * text, under one cap a day kept across restarts; what is not a reply is the model's of before.
 */
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const base: ShannonChatModelRequest = { scopeKey: 'owner', systemPrompt: '[シャノン]', history: [], message: 'ねえ、今日なにしてた？' };
const reply: ShannonChatModelRequest = { ...base, conversationReply: true };
const voice: ShannonVoiceModelRequest = { ...base, useWebSearch: false, conversationClass: 'direct' };

class Haiku implements ShannonChatModel {
  readonly mode = 'anthropic' as const;
  readonly model = 'claude-haiku-5-5';
  readonly seen: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  readonly turns: string[] = [];
  forTurn(scopeKey: string): ShannonChatModel { this.turns.push(scopeKey); return this; }
  async generate(request: ShannonChatModelRequest) { this.seen.push(request); return this.answer(); }
  async generateStreaming(request: ShannonChatModelRequest) { this.seen.push(request); return this.answer(); }
  async generateVoice(request: ShannonVoiceModelRequest) { this.seen.push(request); return this.answer(); }
  async generateVoiceStreaming(request: ShannonVoiceModelRequest) { this.seen.push(request); return this.answer(); }
  private answer(): ShannonChatModelResult { return { mode: this.mode, model: this.model, reply: 'haiku' }; }
}

function sonnetModel() {
  const sonnet = new AnthropicChatModel({ apiKey: 'test-only', settings: sonnetSettings({}) });
  const seen: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  const answer = (request: ShannonChatModelRequest | ShannonVoiceModelRequest) => {
    seen.push(request);
    return Promise.resolve({ mode: sonnet.mode, model: sonnet.model, reply: 'sonnet' });
  };
  sonnet.generate = answer;
  sonnet.generateStreaming = answer;
  sonnet.generateVoice = answer;
  sonnet.generateVoiceStreaming = answer;
  return { sonnet, seen };
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-reply-sonnet-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'shannon.sqlite');
}

function harness(cap = 10, day?: SonnetReplyCap) {
  const haiku = new Haiku();
  const { sonnet, seen } = sonnetModel();
  let today = '2026-10-21';
  const counted = day ?? new MemorySonnetReplyCap(cap, () => today);
  const model = new ReplySonnetChatModel(haiku, { sonnet, day: counted, log: () => undefined });
  return { haiku, sonnet, seen, day: counted, model, turnDay: (next: string) => { today = next; } };
}

describe('her replies on Sonnet', () => {
  it('answers every reply, spoken or written, with Sonnet, and what is not a reply with the model of before', async () => {
    const h = harness();
    expect(await h.model.generateVoiceStreaming(voice, () => {})).toMatchObject({ reply: 'sonnet', servedTier: 'sonnet' });
    expect(h.seen[0]).toMatchObject({ tier: 'sonnet', firstTokenBudgetMs: VOICE_SONNET_FIRST_TOKEN.maximumMs });
    expect(await h.model.generateVoice(voice)).toMatchObject({ reply: 'sonnet' });
    expect(await h.model.generate({ ...base, spokenReply: true })).toMatchObject({ reply: 'sonnet' });
    expect(await h.model.generate(reply)).toMatchObject({ reply: 'sonnet' });
    expect(await h.model.generateStreaming(reply, () => {})).toMatchObject({ reply: 'sonnet' });
    expect(h.day.count()).toBe(5);
    // Not a reply (a helper asking the kernel's model): unchanged, not counted.
    expect(await h.model.generate(base)).toMatchObject({ reply: 'haiku' });
    expect(await h.model.generateStreaming(base, () => {})).toMatchObject({ reply: 'haiku' });
    expect(h.haiku.seen).toEqual([base, base]);
    expect(h.day.count()).toBe(5);
  });

  it('keeps the turn\'s pinned model of before, with her replies still on Sonnet', async () => {
    const h = harness();
    const turn = h.model.forTurn('owner');
    expect(h.haiku.turns).toEqual(['owner']);
    expect(await turn.generateStreaming!(reply, () => {})).toMatchObject({ reply: 'sonnet' });
  });

  it('stays on Haiku past the day\'s cap, voice and text together, and counts again the next day', async () => {
    const h = harness(2);
    await h.model.generateVoiceStreaming(voice, () => {});
    await h.model.generateStreaming(reply, () => {});
    expect(await h.model.generateVoiceStreaming(voice, () => {})).toMatchObject({ reply: 'haiku' });
    expect(await h.model.generateStreaming(reply, () => {})).toMatchObject({ reply: 'haiku' });
    h.turnDay('2026-10-22');
    expect(await h.model.generate(reply)).toMatchObject({ reply: 'sonnet' });
  });

  it('lets Haiku answer when Sonnet fails before a word, and gives the day\'s count back', async () => {
    const h = harness();
    h.sonnet.generateVoiceStreaming = async () => { throw new Error('overloaded'); };
    h.sonnet.generateStreaming = async () => { throw new Error('overloaded'); };
    expect(await h.model.generateVoiceStreaming(voice, () => {})).toMatchObject({ reply: 'haiku', servedTier: 'luna' });
    expect(await h.model.generateStreaming(reply, () => {})).toMatchObject({ reply: 'haiku', servedTier: 'luna' });
    expect(h.haiku.seen.every(request => !('tier' in request))).toBe(true);
    expect(h.day.count()).toBe(0);
  });

  it('does not ask Sonnet when a spoken turn has no room left for its first word', async () => {
    const h = harness();
    const tools = { deadline: { left: () => VOICE_SONNET_FIRST_TOKEN.marginMs + 500 } } as unknown as ShannonVoiceModelRequest['tools'];
    expect(await h.model.generateVoiceStreaming({ ...voice, tools }, () => {})).toMatchObject({ reply: 'haiku' });
    expect(h.seen).toEqual([]);
    expect(h.day.count()).toBe(0);
  });

  it('keeps one cached prefix for every voice turn: the same system and tools whatever the turn adds', async () => {
    const { fetcher, bodies } = scriptedAnthropic(() => message([{ type: 'text', text: 'うん、ずっと本を読んでたよ。' }], 'end_turn'));
    const sonnet = new AnthropicChatModel({ apiKey: 'test-only', settings: sonnetSettings({}), voiceCachePlan: true, fetch: fetcher });
    const said: string[] = [];
    await sonnet.generateVoiceStreaming({ ...voice, turnContext: '[今の気分]\nふつう' }, delta => { said.push(delta); });
    await sonnet.generateVoiceStreaming({ ...voice, message: 'それで？', turnContext: '[今の気分]\nうれしい\n\n[部屋]\n雨' }, delta => { said.push(delta); });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.model).toBe('claude-sonnet-5-5');
    expect(bodies[1]!.system).toEqual(bodies[0]!.system);
    expect(bodies[1]!.tools).toEqual(bodies[0]!.tools);
    expect(said.join('')).toContain('本を読んでたよ');
  });

  it('marks every text turn\'s request as her reply while the switch is on', async () => {
    const requests: ShannonChatModelRequest[] = [];
    const model: ShannonChatModel = { mode: 'openai', model: 'test-model', generate: async request => {
      requests.push(request);
      return { mode: 'openai', model: 'test-model', reply: 'うん。' };
    } };
    const api = createLocalApiKernel(() => '2026-10-21T03:00:00.000Z', { conversationStore: new InMemoryConversationStore(), chatModel: model });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: 'ただいま' } });
    // Off: the request is exactly as it was.
    expect(requests[0]).not.toHaveProperty('conversationReply');
    process.env.SHANNON_REPLY_SONNET = 'on';
    cleanup.push(() => { delete process.env.SHANNON_REPLY_SONNET; });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: 'ただいま、もう一回' } });
    expect(requests[1]).toMatchObject({ conversationReply: true });
  });
});

describe('one cap a day, kept across restarts', () => {
  it('counts voice and text together in the database, and a new process reads the same count', () => {
    const path = databasePath();
    const now = () => '2026-10-21T03:00:00.000Z';
    const first = new SQLiteReplySonnetDays(path, 2, () => '2026-10-21', now, () => undefined);
    expect([first.take(), first.take()]).toEqual([true, true]);
    first.close();
    const lines: string[] = [];
    const restarted = new SQLiteReplySonnetDays(path, 2, () => '2026-10-21', now, line => lines.push(line));
    cleanup.push(() => restarted.close());
    expect(restarted.count()).toBe(2);
    expect([restarted.take(), restarted.take()]).toEqual([false, false]);
    expect(lines).toHaveLength(1);
    restarted.release();
    expect(restarted.take()).toBe(true);
  });

  it('is the model as it was while switched off or without the key; on, it counts in the database', async () => {
    const haiku = new Haiku();
    const parts = { timeZone: 'Asia/Tokyo', now: () => '2026-10-21T15:30:00.000Z', database: databasePath() };
    expect(withReplySonnet({}, haiku, parts)).toBe(haiku);
    expect(withReplySonnet({ SHANNON_REPLY_SONNET: 'on' }, haiku, parts)).toBe(haiku);
    expect(repliesOnSonnet({ SHANNON_REPLY_SONNET: 'on' })).toBe(false);
    const wrapped = withReplySonnet({ SHANNON_REPLY_SONNET: 'on', ANTHROPIC_API_KEY: 'test-only' }, haiku, parts);
    cleanup.push(closeReplySonnet);
    expect(wrapped).toBeInstanceOf(ReplySonnetChatModel);
  });

  it('reads the cap as a whole number from 0 to 10 000, and counts the server\'s own day', () => {
    const now = () => '2026-10-21T15:30:00.000Z';
    expect(replySonnetDailyCap({})).toBe(REPLY_SONNET_DAILY_CAP);
    expect(replySonnetDailyCap({ SHANNON_REPLY_SONNET_DAILY_CAP: '50' })).toBe(50);
    expect(replySonnetDailyCap({ SHANNON_REPLY_SONNET_DAILY_CAP: '0' })).toBe(0);
    expect(replySonnetDailyCap({ SHANNON_REPLY_SONNET_DAILY_CAP: '1.5' })).toBe(REPLY_SONNET_DAILY_CAP);
    expect(replySonnetDailyCap({ SHANNON_REPLY_SONNET_DAILY_CAP: '20000' })).toBe(REPLY_SONNET_DAILY_CAP);
    expect(localDay('Asia/Tokyo', now)()).toBe('2026-10-22');
    expect(localDay('Etc/UTC', now)()).toBe('2026-10-21');
  });

  it('lets the feeling turn\'s own Sonnet and its cap stand aside: one cap counts every reply', () => {
    const environment = { SHANNON_FEELING_EVENTS: 'on', SHANNON_FEELING_TURN: 'on', SHANNON_FEELING_STRONG_REPLY_MODEL: 'on', ANTHROPIC_API_KEY: 'test-only' };
    const parts = { databasePath: databasePath(), timeZone: 'Asia/Tokyo', now: () => '2026-10-21T03:00:00.000Z', trace: null };
    const before = configuredFeeling(environment, parts)!;
    cleanup.push(() => before.close());
    expect(before.port.strong).toBeDefined();
    const now = configuredFeeling({ ...environment, SHANNON_REPLY_SONNET: 'on' }, parts)!;
    cleanup.push(() => now.close());
    expect(now.port.strong).toBeUndefined();
  });
});

describe('her first clause, said at once', () => {
  const said = 'えっとね、今日は天気がいいから、散歩に行こうか。それでね、また話そう。';
  it('cuts the first sentence at its first long-enough clause outside quotes while it is written, and only the first', () => {
    const segmenter = new SpokenSentenceSegmenter({ firstClauseCharacters: FIRST_CLAUSE_CHARACTERS });
    const segments = [...said].flatMap(character => segmenter.append(character)).concat(segmenter.flush());
    expect(segments).toEqual(['えっとね、今日は天気がいいから、', '散歩に行こうか。', 'それでね、また話そう。']);
    // Never inside a quotation.
    const quoted = new SpokenSentenceSegmenter({ firstClauseCharacters: FIRST_CLAUSE_CHARACTERS });
    expect([...'あのね、「今日は天気がいいね、ほんとに」って言ってたよ、みんな。'].flatMap(character => quoted.append(character)))
      .toEqual(['あのね、「今日は天気がいいね、ほんとに」って言ってたよ、', 'みんな。']);
  });

  it('says whole sentences, as before, without the option', () => {
    const segmenter = new SpokenSentenceSegmenter();
    const segments = [...said].flatMap(character => segmenter.append(character)).concat(segmenter.flush());
    expect(segments).toEqual(['えっとね、今日は天気がいいから、散歩に行こうか。', 'それでね、また話そう。']);
  });
});
