import { describe, expect, it } from 'vitest';
import { claudeBackground } from '../src/infra/models/claude/claudeStructured.js';
import { DEFAULT_HAIKU_MODEL } from '../src/infra/models/anthropic/haikuConfig.js';
import { ClaudeLiveLineWriter, LIVE_LINE_REQUEST, configuredLiveLineWriter } from '../src/infra/models/liveLineModel.js';

/**
 * Her live line asked as one short request (not a conversation turn): the rules in the system, the facts in the user's turn, no thinking, a short
 * ceiling, the usage booked on the `chat` lane. A failure is null.
 */
const reply = (text: string, usage = { input_tokens: 300, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 5800 }) =>
  new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: DEFAULT_HAIKU_MODEL, content: [{ type: 'text', text }], stop_reason: 'end_turn',
    stop_sequence: null, usage }), { headers: { 'content-type': 'application/json' } });

describe('the live line writer', () => {
  it('sends the rules as the system and the facts as the one user turn, without thinking or a conversation schema, and returns the text', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const booked: Array<{ lane: string; model: string }> = [];
    const fetcher = (async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return reply('うわっ、ゾンビだよお！'); }) as typeof fetch;
    const usageStore = { recordLlmUsage: (row: { lane: string; model: string }) => { booked.push({ lane: row.lane, model: row.model }); } };
    const writer = new ClaudeLiveLineWriter(claudeBackground(DEFAULT_HAIKU_MODEL, { apiKey: 'test-only', fetcher, usageStore: usageStore as never })!);
    const text = await writer.complete({ scopeKey: 'owner', system: 'ボクのルール', message: '[いま起きたこと]\n- ゾンビに襲われはじめた。' });
    expect(text).toBe('うわっ、ゾンビだよお！');
    const body = bodies[0]!;
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(LIVE_LINE_REQUEST.maximumOutputTokens);
    expect(JSON.stringify(body.system)).toContain('ボクのルール');
    expect(body.messages).toEqual([{ role: 'user', content: '[いま起きたこと]\n- ゾンビに襲われはじめた。' }]);
    // The conversation's own instructions and its structured reply are not part of it.
    expect(JSON.stringify(body)).not.toContain('threadSummary');
    expect(JSON.stringify(body)).not.toContain('taskDecision');
    expect(booked).toEqual([{ lane: 'chat', model: DEFAULT_HAIKU_MODEL }]);
  });

  it('is null for an empty answer and for a request that failed, and never throws', async () => {
    const empty = new ClaudeLiveLineWriter(claudeBackground(DEFAULT_HAIKU_MODEL, { apiKey: 'test-only', fetcher: (async () => reply('  ')) as typeof fetch })!);
    expect(await empty.complete({ scopeKey: 'owner', system: 's', message: 'm' })).toBeNull();
    const broken = new ClaudeLiveLineWriter(claudeBackground(DEFAULT_HAIKU_MODEL, { apiKey: 'test-only', fetcher: (async () => { throw new Error('network'); }) as typeof fetch })!);
    expect(await broken.complete({ scopeKey: 'owner', system: 's', message: 'm' })).toBeNull();
  });

  it('is made only for a Claude model with a key', () => {
    expect(configuredLiveLineWriter({})).toBeNull();
    expect(configuredLiveLineWriter({ SHANNON_LLM_MODEL: DEFAULT_HAIKU_MODEL, SHANNON_HAIKU_API_KEY: 'test-only' })).toBeInstanceOf(ClaudeLiveLineWriter);
    expect(configuredLiveLineWriter({ SHANNON_LLM_MODEL: 'gpt-test', OPENAI_API_KEY: 'test-only' })).toBeNull();
  });
});
