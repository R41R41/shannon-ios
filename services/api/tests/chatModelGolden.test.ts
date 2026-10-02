import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpenAIResponsesChatModel } from '../src/chatModel.js';
import { GOLDEN_BASE as base, GOLDEN_REQUESTS, GOLDEN_RESPONSES } from './chatModelGoldenCases.js';
import type { LlmUsageEvent } from '../src/llmUsage.js';

/**
 * The text-chat provider request and the parsed result, recorded from the adapter as it was
 * before `generate` was split into `chatModelTurn.ts` (commit 6228e12). The non-streaming
 * path must keep sending these bytes and returning these objects. Regenerate only for a
 * deliberate change of the provider request: `SHANNON_WRITE_GOLDEN=1 vitest run chatModelGolden`.
 */
const fixture = new URL('./fixtures/chat-model-turn-v1.json', import.meta.url);
const at = '2026-10-02T03:00:00.000Z';

async function capturedRequests() {
  const out: Record<string, { url: string; headers: unknown; body: string }> = {};
  for (const [name, entry] of Object.entries(GOLDEN_REQUESTS)) {
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      out[name] = { url: String(url), headers: init?.headers, body: String(init?.body) };
      return new Response(JSON.stringify(GOLDEN_RESPONSES.plain!.envelope));
    };
    await new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: fetcher as typeof fetch, now: () => at,
      ...(entry.agentHostHint ? { agentHostHint: entry.agentHostHint } : {}), ...(entry.model ? { model: entry.model } : {}) }).generate(entry.request);
  }
  return out;
}

async function capturedResults() {
  const out: Record<string, { result?: unknown; error?: string; usage: LlmUsageEvent[] }> = {};
  for (const [name, entry] of Object.entries(GOLDEN_RESPONSES)) {
    const recorded: LlmUsageEvent[] = [];
    const model = new OpenAIResponsesChatModel({ apiKey: 'test-only', now: () => at,
      usageStore: { recordLlmUsage: (event: LlmUsageEvent) => { recorded.push(event); } } as never,
      fetcher: (async () => new Response(JSON.stringify(entry.envelope), { status: entry.status ?? 200 })) as typeof fetch });
    try {
      out[name] = { result: await model.generate(entry.request ?? base), usage: recorded };
    } catch (error) {
      out[name] = { error: (error as Error).message, usage: recorded };
    }
  }
  return out;
}

describe('text chat provider adapter, non-streaming', () => {
  it('sends the recorded request bytes and returns the recorded results and usage', async () => {
    const current = JSON.parse(JSON.stringify({ requests: await capturedRequests(), results: await capturedResults() }));
    if (process.env.SHANNON_WRITE_GOLDEN === '1' || !existsSync(fixture)) writeFileSync(fixture, `${JSON.stringify(current, null, 1)}\n`);
    const recorded = JSON.parse(readFileSync(fixture, 'utf8'));
    expect(Object.keys(current.requests)).toEqual(Object.keys(recorded.requests));
    for (const name of Object.keys(recorded.requests)) expect(current.requests[name], name).toEqual(recorded.requests[name]);
    expect(current.results).toEqual(recorded.results);
    // The cases are not all the same thing.
    expect(new Set(Object.values(recorded.requests).map(entry => (entry as { body: string }).body)).size).toBe(Object.keys(GOLDEN_REQUESTS).length);
    expect(Object.values(recorded.results).filter(entry => (entry as { error?: string }).error).length).toBe(4);
  });
});
