import { describe, expect, it } from 'vitest';
import { emptyTemplate } from '@shannon/mind';
import { createAnthropicFcaSummarizer } from '../src/infra/models/anthropic/anthropicFcaSummary.js';
import { scriptedAnthropic, message } from './support/anthropicFixtures.js';

const usage = { input_tokens: 12, output_tokens: 50, cache_creation_input_tokens: 700, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } };
const input = { previous: null, rounds: [{ sequence: 1, stepId: 'step', messages: [{ id: 'm', role: 'user' as const, content: 'Public transcript' }] }] };
describe('native FCA working-memory summary', () => {
  it('accounts cached usage before returning the structured template, without executing any tool', async () => {
    const { coversFromId: _from, coversToId: _to, ...template } = emptyTemplate();
    template['次'] = ['Check the result'];
    const fixture = scriptedAnthropic([message([{ type: 'tool_use', id: 'summary', name: 'fca_history_summary', input: { template: JSON.stringify(template) } }], 'tool_use', { model: 'claude-haiku-5-5', usage })]);
    const receipts: unknown[] = [];
    const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic-key', fetcher: fixture.fetcher, recordUsage: value => { receipts.push(value); } });
    const result = await summarizer.summarize(input, new AbortController().signal);
    expect(result).toMatchObject({ '次': ['Check the result'], coversFromId: null, coversToId: null });
    expect(receipts).toHaveLength(1);
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.bodies[0]).toMatchObject({ cache_control: { type: 'ephemeral', ttl: '1h' } });
  });
  it('rejects an incomplete summary after recording spend, with no hidden repair call', async () => {
    const fixture = scriptedAnthropic([message([{ type: 'tool_use', id: 'summary', name: 'fca_history_summary', input: { template: '{"次":[]}' } }], 'tool_use', { model: 'claude-haiku-5-5', usage })]);
    const receipts: unknown[] = [];
    const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic-key', fetcher: fixture.fetcher, recordUsage: value => { receipts.push(value); } });
    await expect(summarizer.summarize(input, new AbortController().signal)).rejects.toThrow('FCA_SUMMARY_INVALID');
    expect(receipts).toHaveLength(1); expect(fixture.bodies).toHaveLength(1);
  });
});
