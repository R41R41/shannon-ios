import { afterEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { cacheDayLine, cacheReceiptsView, prefixFingerprint, recordCacheReceipt, resetCacheReceipts } from '../src/infra/models/anthropic/cacheReceipts.js';
import type { ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';

/** ADR-0009 stage 1, step 1: content-free cache receipts per Claude request, a ring and a daily aggregate per route. */
afterEach(() => resetCacheReceipts());

const SECRET = '秘密の合成メッセージ';
const body = (history: string, system = 'fixed system'): Anthropic.MessageCreateParamsNonStreaming => ({
  model: 'claude-haiku-5-5', max_tokens: 100, system, messages: [{ role: 'user', content: history }],
  output_config: { effort: 'medium' }, thinking: { type: 'adaptive' },
});
const usage = (read: number) => ({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: 700,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } });

describe('cache receipts', () => {
  it('keep counts and short prefix hashes, never message text', () => {
    recordCacheReceipt('text', body(SECRET), usage(0), 0, '2026-10-12T01:00:00.000Z');
    const view = cacheReceiptsView();
    expect(view.recent).toHaveLength(1);
    expect(view.recent[0]).toMatchObject({ route: 'text', round: 0, model: 'claude-haiku-5-5', input: 10, cacheRead: 0, cacheCreation1h: 700, output: 5 });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(Object.values(view.recent[0]!.prefix).every(hash => /^(?:[0-9a-f]{8}|-)$/u.test(hash))).toBe(true);
  });

  it('fingerprint a changed system or history, and nothing else, differently', () => {
    const base = prefixFingerprint(body('a'));
    expect(prefixFingerprint(body('a'))).toEqual(base);
    expect(prefixFingerprint(body('b'))).toEqual({ ...base, history: expect.not.stringMatching(base.history) });
    expect(prefixFingerprint(body('a', 'other system')).system).not.toBe(base.system);
    expect(prefixFingerprint(body('a', 'other system')).tools).toBe(base.tools);
  });

  it('count, per day and route, the turns whose first request read the cache', () => {
    recordCacheReceipt('text', body('a'), usage(0), 0, '2026-10-12T01:00:00.000Z');
    recordCacheReceipt('text', body('a'), usage(900), 0, '2026-10-12T01:05:00.000Z');
    recordCacheReceipt('text', body('a'), usage(900), 1, '2026-10-12T01:05:01.000Z');
    recordCacheReceipt('voice', body('a'), usage(0), 0, '2026-10-12T01:06:00.000Z');
    const today = cacheReceiptsView().days['2026-10-12']!;
    expect(today.text).toMatchObject({ requests: 3, turns: 2, turnsWithCacheRead: 1, cacheRead: 1800 });
    expect(today.voice).toMatchObject({ requests: 1, turns: 1, turnsWithCacheRead: 0 });
    expect(cacheDayLine('2026-10-12')).toBe('text=1/2,voice=0/1');
    expect(cacheDayLine('2026-10-11')).toBe('none');
  });

  it('are left by every native conversation request, by surface', async () => {
    const answerText = JSON.stringify({ reply: '合成の返事です。', threadSummary: null, threadTitle: null,
      taskDecision: { disposition: 'none', reason: 'synthetic' }, taskProposal: null, intentPlan: null, artifacts: null });
    const fixture = scriptedAnthropic([message([{ type: 'text', text: answerText }], 'end_turn', { usage: usage(2000) })]);
    const chat = new AnthropicChatModel({ apiKey: 'synthetic', fetch: fixture.fetcher,
      settings: { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } });
    const request: ShannonChatModelRequest = { scopeKey: 'owner', message: SECRET, history: [], systemPrompt: '合成試験', generateThreadTitle: false };
    await chat.generate(request);
    const view = cacheReceiptsView();
    expect(view.recent.map(receipt => [receipt.route, receipt.round, receipt.cacheRead])).toEqual([['text', 0, 2000]]);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });
});
