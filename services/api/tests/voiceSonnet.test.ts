import { describe, expect, it } from 'vitest';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { sonnetSettings } from '../src/infra/models/anthropic/anthropicConfig.js';
import { VoiceReplyChatModel, VoiceSonnetDay } from '../src/infra/models/voiceReplyChatModel.js';
import { localDay, VOICE_SONNET_DAILY_CAP, voiceSonnetDailyCap, withVoiceSonnet } from '../src/wiring/voiceSonnetWiring.js';
import { FIRST_CLAUSE_CHARACTERS, SpokenSentenceSegmenter } from '../src/surfaces/voice/spokenSentences.js';
import { VOICE_SONNET_FIRST_TOKEN } from '../src/mind/action/respond/turnRouting.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';

/** Owner 2026-10-21 (「声は全部 Sonnet」, `SHANNON_VOICE_SONNET`): every spoken reply is Sonnet's; a typed reply is the model's of before. */
const base: ShannonChatModelRequest = { scopeKey: 'owner', systemPrompt: '[シャノン]', history: [], message: 'ねえ、今日なにしてた？' };
const voice: ShannonVoiceModelRequest = { ...base, useWebSearch: false, conversationClass: 'direct' };

class Haiku implements ShannonChatModel {
  readonly mode = 'anthropic' as const;
  readonly model = 'claude-haiku-5-5';
  readonly seen: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  readonly turns: string[] = [];
  forTurn(scopeKey: string): ShannonChatModel { this.turns.push(scopeKey); return this; }
  async generate(request: ShannonChatModelRequest) { this.seen.push(request); return { mode: this.mode, model: this.model, reply: 'haiku' }; }
  async generateStreaming(request: ShannonChatModelRequest) { this.seen.push(request); return { mode: this.mode, model: this.model, reply: 'haiku' }; }
  async generateVoice(request: ShannonVoiceModelRequest) { this.seen.push(request); return { mode: this.mode, model: this.model, reply: 'haiku' }; }
  async generateVoiceStreaming(request: ShannonVoiceModelRequest) { this.seen.push(request); return { mode: this.mode, model: this.model, reply: 'haiku' }; }
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

function harness(cap = 10) {
  const haiku = new Haiku();
  const { sonnet, seen } = sonnetModel();
  const logs: string[] = [];
  let today = '2026-10-21';
  const day = new VoiceSonnetDay(cap, () => today, line => logs.push(line));
  const model = new VoiceReplyChatModel(haiku, { sonnet, day, log: line => logs.push(line) });
  return { haiku, sonnet, seen, logs, day, model, turnDay: (next: string) => { today = next; } };
}

describe('her voice on Sonnet', () => {
  it('answers every spoken reply with Sonnet, its first word bounded, and every typed reply with the model of before', async () => {
    const h = harness();
    expect(await h.model.generateVoiceStreaming(voice, () => {})).toMatchObject({ reply: 'sonnet', servedTier: 'sonnet' });
    expect(h.seen[0]).toMatchObject({ tier: 'sonnet', firstTokenBudgetMs: VOICE_SONNET_FIRST_TOKEN.maximumMs });
    expect(await h.model.generateVoice(voice)).toMatchObject({ reply: 'sonnet' });
    // A voice turn's structured request, and a platform's voice turn answered as a typed turn (dc-voice).
    expect(await h.model.generate({ ...base, spokenReply: true })).toMatchObject({ reply: 'sonnet' });
    expect(await h.model.generateStreaming({ ...base, voiceReply: true }, () => {})).toMatchObject({ reply: 'sonnet' });
    expect(h.day.count()).toBe(4);
    // Typed: unchanged, not counted.
    expect(await h.model.generate(base)).toMatchObject({ reply: 'haiku' });
    expect(await h.model.generateStreaming(base, () => {})).toMatchObject({ reply: 'haiku' });
    expect(h.haiku.seen).toEqual([base, base]);
    expect(h.day.count()).toBe(4);
  });

  it('keeps the turn\'s pinned model of before, with her voice still on Sonnet', async () => {
    const h = harness();
    const turn = h.model.forTurn('owner');
    expect(h.haiku.turns).toEqual(['owner']);
    expect(await turn.generateVoiceStreaming!(voice, () => {})).toMatchObject({ reply: 'sonnet' });
  });

  it('stays on Haiku past the day\'s cap, says so once, and counts again the next day', async () => {
    const h = harness(1);
    await h.model.generateVoiceStreaming(voice, () => {});
    expect(await h.model.generateVoiceStreaming(voice, () => {})).toMatchObject({ reply: 'haiku' });
    expect(await h.model.generateVoiceStreaming(voice, () => {})).toMatchObject({ reply: 'haiku' });
    expect(h.logs.filter(line => line.includes('cap of 1 Sonnet replies'))).toHaveLength(1);
    h.turnDay('2026-10-22');
    expect(await h.model.generateVoiceStreaming(voice, () => {})).toMatchObject({ reply: 'sonnet' });
  });

  it('lets Haiku answer when Sonnet fails before a word, and gives the day\'s count back', async () => {
    const h = harness();
    h.sonnet.generateVoiceStreaming = async () => { throw new Error('overloaded'); };
    expect(await h.model.generateVoiceStreaming(voice, () => {})).toMatchObject({ reply: 'haiku', servedTier: 'luna' });
    expect(h.haiku.seen[0]).not.toHaveProperty('tier');
    expect(h.day.count()).toBe(0);
  });

  it('does not ask Sonnet when the turn has no room left for its first word', async () => {
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
});

describe('the wiring and its cap', () => {
  const now = () => '2026-10-21T15:30:00.000Z';
  it('is the model as it was while switched off or without the key', () => {
    const haiku = new Haiku();
    expect(withVoiceSonnet({}, haiku, { timeZone: 'Asia/Tokyo', now })).toBe(haiku);
    expect(withVoiceSonnet({ SHANNON_VOICE_SONNET: 'on' }, haiku, { timeZone: 'Asia/Tokyo', now })).toBe(haiku);
    expect(withVoiceSonnet({ SHANNON_VOICE_SONNET: 'on', ANTHROPIC_API_KEY: 'test-only' }, haiku, { timeZone: 'Asia/Tokyo', now }))
      .toBeInstanceOf(VoiceReplyChatModel);
  });

  it('reads the cap as a whole number from 0 to 10 000, and counts the server\'s own day', () => {
    expect(voiceSonnetDailyCap({})).toBe(VOICE_SONNET_DAILY_CAP);
    expect(voiceSonnetDailyCap({ SHANNON_VOICE_SONNET_DAILY_CAP: '50' })).toBe(50);
    expect(voiceSonnetDailyCap({ SHANNON_VOICE_SONNET_DAILY_CAP: '0' })).toBe(0);
    expect(voiceSonnetDailyCap({ SHANNON_VOICE_SONNET_DAILY_CAP: '1.5' })).toBe(VOICE_SONNET_DAILY_CAP);
    expect(voiceSonnetDailyCap({ SHANNON_VOICE_SONNET_DAILY_CAP: '20000' })).toBe(VOICE_SONNET_DAILY_CAP);
    expect(localDay('Asia/Tokyo', now)()).toBe('2026-10-22');
    expect(localDay('Etc/UTC', now)()).toBe('2026-10-21');
  });
});

describe('her first clause, said at once', () => {
  const reply = 'えっとね、今日は天気がいいから、散歩に行こうか。それでね、また話そう。';
  it('cuts the first sentence at its first long-enough clause outside quotes while it is written, and only the first', () => {
    const segmenter = new SpokenSentenceSegmenter({ firstClauseCharacters: FIRST_CLAUSE_CHARACTERS });
    const segments = [...reply].flatMap(character => segmenter.append(character)).concat(segmenter.flush());
    expect(segments).toEqual(['えっとね、今日は天気がいいから、', '散歩に行こうか。', 'それでね、また話そう。']);
    // Never inside a quotation.
    const quoted = new SpokenSentenceSegmenter({ firstClauseCharacters: FIRST_CLAUSE_CHARACTERS });
    expect([...'あのね、「今日は天気がいいね、ほんとに」って言ってたよ、みんな。'].flatMap(character => quoted.append(character))).toEqual(['あのね、「今日は天気がいいね、ほんとに」って言ってたよ、', 'みんな。']);
  });

  it('says whole sentences, as before, without the option', () => {
    const segmenter = new SpokenSentenceSegmenter();
    const segments = [...reply].flatMap(character => segmenter.append(character)).concat(segmenter.flush());
    expect(segments).toEqual(['えっとね、今日は天気がいいから、散歩に行こうか。', 'それでね、また話そう。']);
  });
});
