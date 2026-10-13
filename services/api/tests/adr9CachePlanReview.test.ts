import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { fieldsLines } from '../src/infra/models/anthropic/anthropicCachePlan.js';
import { claudeTextBody } from '../src/infra/models/anthropic/anthropicRequest.js';
import { cacheReceiptsView, resetCacheReceipts } from '../src/infra/models/anthropic/cacheReceipts.js';
import { bookConversationUsage, unknownCostUpperBound } from '../src/infra/models/claude/claudeUsage.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import { anthropicFixture, message } from './support/anthropicFixtures.js';
import { recordingFetch, usageLedger, type ScriptedReply } from './support/claudeRequestRecorder.js';
import { answer, cached, chat, HAIKU, text, tools } from './support/claudeForegroundScenarios.js';
import { planChat } from './support/claudePlanScenarios.js';

/**
 * The independent review of M4 (Syzygy ADR-0009 stage 1): what a cache-plan turn does when the provider refuses its request
 * (F1), when the model calls a tool in a turn without tools (F2), what the turn says of the fields it uses (F4), and the
 * unknown-cost bound that takes the input counts already reported (accounting; every path).
 */
type Body = Anthropic.MessageCreateParamsNonStreaming & { cache_control?: unknown };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  resetCacheReceipts();
});

function refused(text: string): ScriptedReply {
  const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: text } });
  return () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });
}

const context = (script: readonly ScriptedReply[]) => {
  const recorder = recordingFetch(script);
  const ledger = usageLedger();
  return { recorder, ledger, run: { fetcher: recorder.fetcher, store: ledger.store, now: () => '2026-10-12T03:00:00.000Z' } };
};

const request = { ...text, threadKey: 'synthetic-thread' };
const events = () => cacheReceiptsView().foregroundText.events;

/** The body the model sends for the same turn with the plan off, as it leaves (one-hour cache, top-level marker). */
async function offShape(turn: typeof request): Promise<Body> {
  const off = context([answer(HAIKU.model)]);
  await chat(off.run, HAIKU).generate(turn);
  return off.recorder.requests[0]!.body as Body;
}

describe('F1: a refused plan request falls back to the shape without the plan, once', () => {
  it('asks a turn without tools again with exactly the request the plan-off model sends', async () => {
    const h = context([refused('The compiled grammar is too large'), answer(HAIKU.model)]);
    const result = await planChat(h.run, HAIKU).generate(request);
    expect(result.reply).toBe('書斎にはメモが1つあります。');
    const [first, second] = h.recorder.requests.map(item => item.body as Body);
    expect(first!.tools?.map(tool => 'name' in tool && tool.name)).toEqual(['tool_open', 'tool_call']);
    expect(second).toEqual(await offShape(request));
    expect(events()).toMatchObject({ 'text:fallback': 1, 'text:recovered': 1 });
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain('"event":"cache_plan_fallback","status":400,"class":"strict_grammar_capacity"');
  });

  it('does not fall back from a refusal that is not about the offered tools or schemas', async () => {
    const h = context([refused('messages: something else entirely'), answer(HAIKU.model)]);
    await expect(planChat(h.run, HAIKU).generate(request)).rejects.toThrow();
    expect(h.recorder.requests).toHaveLength(1);
    expect(events()['text:fallback']).toBeUndefined();
  });

  it('answers a refused turn with tools without tools in the schema of the shape without the plan', async () => {
    const h = context([refused('Too many strict tools'), answer(HAIKU.model)]);
    const turn = { ...request, tools: tools(['study.list']) };
    const result = await planChat(h.run, HAIKU).generate(turn);
    expect(result.reply).toBe('書斎にはメモが1つあります。');
    const second = h.recorder.requests[1]!.body as Body;
    expect(second.tools).toBeUndefined();
    expect(second.output_config).toEqual(claudeTextBody(HAIKU, { ...turn, tools: undefined }, undefined).output_config);
    expect(events()).toMatchObject({ 'text:plain_recovery': 1, 'text:recovered': 1 });
  });
});

describe('a grammar refusal of a plan turn with tools (M4 grammar fix)', () => {
  it('moves the inline definitions to quoted data and keeps the plan\'s prefix; a second refusal answers in the plan-off shape', async () => {
    const h = context([refused('The compiled grammar is too large'), answer(HAIKU.model, 0, 2_000)]);
    const turn = { ...request, tools: tools(['study.list', 'study.read']) };
    expect((await planChat(h.run, HAIKU).generate(turn)).reply).toBe('書斎にはメモが1つあります。');
    const [first, second] = h.recorder.requests.map(item => item.body as Body);
    for (const key of ['tools', 'tool_choice', 'system', 'output_config', 'thinking'] as const) expect(second![key]).toEqual(first![key]);
    expect(JSON.stringify(first!.messages)).toContain('"tool_addition"');
    expect(JSON.stringify(second!.messages)).not.toContain('"tool_addition"');
    expect(JSON.stringify(second!.messages)).toContain('[開いている道具の入力定義・データ]');
    expect(events()).toMatchObject({ 'text:grammar_bridge': 1, 'text:recovered': 1 });
    const twice = context([refused('The compiled grammar is too large'), refused('The compiled grammar is too large'), answer(HAIKU.model)]);
    expect((await planChat(twice.run, HAIKU).generate(turn)).reply).toBe('書斎にはメモが1つあります。');
    const last = twice.recorder.requests[2]!.body as Body;
    expect(last.tools).toBeUndefined();
    expect(last.output_config).toEqual(claudeTextBody(HAIKU, { ...turn, tools: undefined }, undefined).output_config);
  });
});

describe('F2: a call in a plan turn without tools', () => {
  it('is declined once, and the answer after it is asked for with tool_choice none', async () => {
    const call = cached(message([{ type: 'tool_use', id: 'toolu_stray', name: 'tool_open', input: { name: 'study_list' } }], 'tool_use',
      { id: 'msg_stray' }), HAIKU.model, 0, 2_000);
    const h = context([call, answer(HAIKU.model)]);
    await planChat(h.run, HAIKU).generate(request);
    const bodies = h.recorder.requests.map(item => item.body as Body);
    expect(bodies.map(body => body.tool_choice)).toEqual([{ type: 'auto' }, { type: 'none' }]);
    expect(events()).toEqual({ 'text:schema_common': 1, 'text:declined': 1 });
  });
});

describe('F4: the fields a plan turn uses', () => {
  it('says feeling is null on a common turn that does not offer it, and nothing on an exception turn', () => {
    expect(fieldsLines(request)).toEqual(['[このターンの返答の欄] feeling はこのターンでは使わないので null にする。']);
    expect(fieldsLines({ ...request, offerReplyFeeling: true })).toEqual([]);
    expect(fieldsLines({ ...request, offerMinecraftIntent: true })).toEqual([]);
  });

  it('counts each plan turn\'s schema and keeps an exception turn\'s receipts in their own lane', async () => {
    const h = context([answer(HAIKU.model, 0, 2_000), answer(HAIKU.model, 300, 2_000)]);
    await planChat(h.run, HAIKU).generate(request);
    await planChat(h.run, HAIKU).generate({ ...request, offerAppLook: true });
    expect(events()).toEqual({ 'text:schema_common': 1, 'text:schema_exception': 1 });
    expect(cacheReceiptsView().recent.map(receipt => receipt.planSchema)).toEqual(['common', 'exception']);
    const lanes = Object.values(cacheReceiptsView().foregroundText.days).flatMap(day => Object.keys(day));
    expect(lanes.sort()).toEqual(['plan', 'plan_exception']);
  });

  it('counts how often an offered feeling was answered, with and without the plan', async () => {
    const feeling = (value: unknown) => {
      const found = anthropicFixture('structured-answer');
      const reply = { ...JSON.parse(String(found.content[1]!.text)) as object, feeling: value };
      return cached({ ...found, content: [found.content[0]!, { type: 'text', text: JSON.stringify(reply), citations: null }] }, HAIKU.model);
    };
    const on = context([feeling({ kind: 'happy', strength: 'subtle' }), feeling(null)]);
    await planChat(on.run, HAIKU).generate({ ...request, offerReplyFeeling: true });
    await planChat(on.run, HAIKU).generate({ ...request, offerReplyFeeling: true });
    const off = context([feeling(null)]);
    await chat(off.run, HAIKU).generate({ ...request, offerReplyFeeling: true });
    await chat(context([answer(HAIKU.model)]).run, HAIKU).generate(request);
    expect(cacheReceiptsView().foregroundText.feeling).toEqual({
      plan: { offered: 2, answered: 1, rate: 0.5 }, base: { offered: 1, answered: 0, rate: 0 },
    });
  });
});

describe('the unknown-cost bound', () => {
  it('prices the input counts already reported, with the whole output ceiling', () => {
    expect(unknownCostUpperBound('claude-haiku-5-5', 16_000, 0, { input: 420, cacheWrite: 1_800, cacheRead: 2_000 })).toBe(0.008422);
    expect(unknownCostUpperBound('claude-haiku-5-5', 16_000)).toBe(1.04);
    expect(unknownCostUpperBound('claude-haiku-5-5', 16_000, 0, { input: 120_000, cacheWrite: 0, cacheRead: 0 })).toBe(0.1);
  });

  it('books a stream that broke after message_start at its reported input, and a web search still at the full bound', () => {
    const rows: LlmUsageEvent[] = [];
    const store = { recordLlmUsage: (row: LlmUsageEvent) => { rows.push(row); }, backgroundLlmCostUsd: () => 0 };
    const usage = { input_tokens: 420, output_tokens: 1, cache_creation_input_tokens: 1_800, cache_read_input_tokens: 0 } as Anthropic.Message['usage'];
    const entry = { scopeKey: 'owner', model: 'claude-haiku-5-5', usage, maximumOutputTokens: 16_000, finalUsage: false, at: () => '2026-10-12T03:00:00.000Z' };
    bookConversationUsage(store, { ...entry, maximumSearches: 0 });
    bookConversationUsage(store, { ...entry, maximumSearches: 2 });
    expect(rows.map(row => row.estimatedCostUsd)).toEqual([0.008402, 1.06]);
  });
});
