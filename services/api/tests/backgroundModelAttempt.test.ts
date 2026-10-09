import { expect, it, vi } from 'vitest';
import { backgroundModelAttempt } from '../src/infra/models/backgroundModelAttempt.js';
import { OpenAISkillSleepModel } from '../src/mind/sleep/skillSleepModel.js';
import { OpenAIKnowledgeAnalyzer } from '../src/mind/sleep/knowledgeConsolidation.js';
import { OpenAISleepMemoryAnalyzer } from '../src/mind/sleep/sleepConsolidation.js';
import { OpenAIPlatformSummaryWriter } from '../src/surfaces/platform/platformPeopleSummaries.js';
import { OpenAIImpressionAnalyzer } from '../src/mind/memory/impressionUpdater.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
const AT = '2026-10-09T03:00:00.000Z';
function ledger() { const rows: LlmUsageEvent[] = []; return { rows, store: { recordLlmUsage: (row: LlmUsageEvent) => { rows.push(row); }, backgroundLlmCostUsd: () => 0 } }; }
const input = { person: 'ミキ', localDate: '2026-10-09', lines: ['猫について'], impressions: [], maximumNew: 1 };
it('keeps known spend on post-response failure, charges uncertain attempts once, and never retries', async () => {
  const h = ledger(), signal = new AbortController().signal, request = vi.fn(async () => { throw Error('connection lost'); });
  await expect(backgroundModelAttempt({ model: 'gpt-5.6-terra', scopeKey: 'owner', lane: 'sleep', maxOutputTokens: 400, usageStore: h.store, signal }, request)).rejects.toThrow('connection lost');
  expect(request).toHaveBeenCalledTimes(1); expect(h.rows).toHaveLength(1); expect(h.rows[0]!.estimatedCostUsd).toBeGreaterThan(0.5);
  await expect(backgroundModelAttempt({ model: 'gpt-5.6-terra', scopeKey: 'owner', lane: 'sleep', maxOutputTokens: 400, usageStore: h.store, signal }, async accounted => {
    accounted(); throw Error('invalid output');
  })).rejects.toThrow('invalid output');
  expect(h.rows).toHaveLength(1);
});
it('cancellation before dispatch costs nothing; legacy failures without the FCA signal preserve previous accounting', async () => {
  const h = ledger(), controller = new AbortController(); controller.abort();
  const run = vi.fn(async () => { throw Error('lost'); });
  const options = { model: 'gpt-5.6-terra', scopeKey: 'owner', lane: 'sleep' as const, maxOutputTokens: 400, usageStore: h.store };
  await expect(backgroundModelAttempt({ ...options, signal: controller.signal }, run)).rejects.toThrow(); expect(run).not.toHaveBeenCalled();
  await expect(backgroundModelAttempt(options, run)).rejects.toThrow('lost'); expect(h.rows).toEqual([]);
});
it('all sleep adapters include response body consumption in unknown accounting', async () => {
  const h = ledger(), signal = new AbortController().signal;
  const fetcher = vi.fn(async () => ({ ok: true, text: async () => { throw Error('body stream lost'); } })) as unknown as typeof fetch;
  const options = { apiKey: 'fake', model: 'gpt-5.6-terra', usageStore: h.store, fetcher };
  const calls = [
    () => new OpenAISkillSleepModel(options).json('owner', 'test', 'test', {}, {}, signal),
    () => new OpenAIKnowledgeAnalyzer(options).analyze('owner', { experiences: [], knowledge: [] } as never, signal),
    () => new OpenAISleepMemoryAnalyzer(options).analyze([{ content: '猫', observedAt: AT }], { scopeKey: 'owner', occurredAt: AT, signal }),
    () => new OpenAIPlatformSummaryWriter(options).summarize('owner', { place: '', names: [], lines: [] }, signal),
    () => new OpenAIImpressionAnalyzer(options).analyze('owner', input, signal),
  ];
  for (const call of calls) await expect(call()).rejects.toThrow('body stream lost');
  expect(fetcher).toHaveBeenCalledTimes(5); expect(h.rows).toHaveLength(5);
  expect(h.rows.every(row => row.estimatedCostUsd > 0)).toBe(true);
});
it('keeps a paid late response counted but never adopts its answer; missing usage is unknown', async () => {
  const h = ledger(), controller = new AbortController();
  const fetcher = vi.fn(async () => { controller.abort(); return new Response(JSON.stringify({ output_text: '{}', usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } })); });
  const model = new OpenAISkillSleepModel({ apiKey: 'fake', usageStore: h.store, fetcher });
  await expect(model.json('owner', 'test', 'test', {}, {}, controller.signal)).rejects.toThrow();
  expect(h.rows).toHaveLength(1); expect(h.rows[0]).toMatchObject({ inputTokens: 80, outputTokens: 20 });
  const missing = new OpenAISkillSleepModel({ apiKey: 'fake', usageStore: h.store, fetcher: async () => new Response(JSON.stringify({ output_text: '{}' })) });
  await expect(missing.json('owner', 'test', 'test', {}, {}, new AbortController().signal)).rejects.toThrow('USAGE_UNKNOWN');
  expect(h.rows.at(-1)!.estimatedCostUsd).toBeGreaterThan(0.5);
});
