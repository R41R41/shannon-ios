import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpenAIResponsesChatModel } from '../src/infra/models/chatModel.js';
import { GOLDEN_BASE as base, GOLDEN_REQUESTS, GOLDEN_RESPONSES } from './chatModelGoldenCases.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';

/**
 * The text-chat provider request and the parsed result, recorded from the adapter as it was
 * before `generate` was split into `chatModelTurn.ts` (commit 6228e12). The non-streaming
 * path must keep sending these bytes and returning these objects. Regenerate only for a
 * deliberate change of the provider request: `SHANNON_WRITE_GOLDEN=1 vitest run chatModelGolden`.
 *
 * Re-recorded on the prompt-cache branch (2026-10-06, Syzygy ADR-0003 principle 4): the instructions now run from what
 * never changes to what changes every turn. The blocks of one turn (attachments, web and place search, the saved summary
 * of the Talk, the title) moved after the fixed blocks, and the `layered` case was added for the profile and the turn's
 * context. Every block is the same text as before; only its position changed. Re-recorded again on the same branch when
 * the turn's blocks left the instructions for one developer message after the history, just before the owner's words,
 * so that the history joins the prefix the next turn repeats; again the same blocks, moved. And once more when the
 * nullable `threadTitle` field was kept in every schema, so the schema is the same on the turn that asks for a title and
 * on every other (its description now says to write a title only when asked); only that turn reads it.
 *
 * Re-recorded on 2026-10-06 (no-task-after-write) for one deliberate wording change of the `[Codexで行う作業]` block: Codex
 * works in the owner's repositories and projects, and her notes, stories and files in her own places are written with her
 * own tools, never proposed as a Codex task. Only the instructions of each request changed; the results are the same.
 * Re-recorded on 2026-10-06 (folder-wording) for one more sentence of that block: looking at, listing, searching and
 * reading her own places is done with her own tools too, never a Codex task (「Mac のシャノン用フォルダを、フォルダの道具で
 * 一覧して」 became a task proposal in production). Again only the instructions changed; the results are the same.
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
