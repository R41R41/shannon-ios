import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SECTIONS, emptyTemplate } from '@shannon/mind';
import { createAnthropicFcaSummarizer, FcaSummaryInvalidError } from '../src/infra/models/anthropic/anthropicFcaSummary.js';
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

afterEach(() => { vi.restoreAllMocks(); });
/** One summary answer through the native adapter, as Haiku sent it. */
async function answered(content: Array<Record<string, unknown>>) {
  const fixture = scriptedAnthropic([message(content, 'tool_use', { model: 'claude-haiku-5-5', usage })]);
  const receipts: unknown[] = [];
  const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic-key', fetcher: fixture.fetcher, recordUsage: value => { receipts.push(value); } });
  const result: { value?: unknown; error?: unknown } = await summarizer.summarize(input, new AbortController().signal)
    .then(value => ({ value }), (error: unknown) => ({ error }));
  return { ...result, receipts, fixture };
}
const call = (template: unknown) => [{ type: 'tool_use', id: 'summary', name: 'fca_history_summary', input: { template } }];

/**
 * Minebot lane run 2 (2026-10-14, task 94e879f8, Haiku): one fca_history_summary call came back (stop tool_use, 2,105 of 4,000
 * output tokens) and an exact shape check refused it as FCA_SUMMARY_INVALID; the step was left unknown and the task paused. Each
 * shape below was refused that way before; the shared compaction rule (`checkedTemplate`) reads them now.
 */
describe('a summary that misses the exact shape is read by the shared compaction rule (Minebot lane run 2)', () => {
  const long = '原木を探すため mc.find-blocks を半径48で実行し、北東に約33mの位置 (x=112, y=71, z=-40) にオークの原木を見つけた。まだ近づいていない。';
  const full = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}の事実`]]));

  it('keeps a template given as an object, an item longer than 80 characters, six items, and an extra key', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const template = { ...full, '済み': ['1', '2', '3', '4', '5', long], '重要な文脈': long, coversFromId: 'fca-round:1' };
    const { value, error, receipts, fixture } = await answered(call(template));
    expect(error).toBeUndefined();
    expect([...long].length).toBeGreaterThan(80);
    expect(value).toMatchObject({ '目的': ['目的の事実'], coversFromId: null, coversToId: null });
    const kept = value as unknown as Record<string, string[]>;
    expect(kept['済み']).toHaveLength(5);
    expect(kept['済み']!.at(-1)).toMatch(/…$/u);
    expect([...kept['重要な文脈']![0]!]).toHaveLength(80);
    expect(receipts).toHaveLength(1); expect(fixture.bodies).toHaveLength(1);
    // Content-free evidence of the shape the provider actually sent.
    const shape = info.mock.calls.map(args => String(args[0])).find(line => line.includes('fca_summary_shape'));
    expect(JSON.parse(shape!)).toEqual({ event: 'fca_summary_shape', given: 'object', otherKeys: 1, missingSections: 0, cutItems: 2, droppedItems: 1 });
    expect(shape).not.toContain('原木');
  });

  it('keeps a JSON string with a section missing', async () => {
    const { ['詰まり']: _missing, ...rest } = full;
    const { value, error } = await answered(call(JSON.stringify(rest)));
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ '詰まり': [], '次': ['次の事実'] });
  });

  it('keeps the previous summary\'s items for a section the answer leaves out, and replaces one it gives (even as empty)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const previous = { ...emptyTemplate(), '制約': ['夜は拠点から出ない'], '詰まり': ['斧がない'], '次': ['原木へ向かう'], coversFromId: 'fca-round:1', coversToId: 'fca-round:2' };
    const fixture = scriptedAnthropic([message(call(JSON.stringify({ '目的': ['原木を集める'], '次': ['原木を3個掘る'], '詰まり': [] })), 'tool_use',
      { model: 'claude-haiku-5-5', usage })]);
    const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic-key', fetcher: fixture.fetcher, recordUsage() {} });
    const result = await summarizer.summarize({ ...input, previous }, new AbortController().signal);
    expect(result).toMatchObject({ '目的': ['原木を集める'], '制約': ['夜は拠点から出ない'], '詰まり': [], '次': ['原木を3個掘る'], '済み': [] });
    const shape = info.mock.calls.map(args => String(args[0])).find(line => line.includes('fca_summary_shape'));
    expect(JSON.parse(shape!)).toMatchObject({ missingSections: 5 });
  });

  it('still refuses, with a closed reason and its spend recorded, an answer with no usable summary', async () => {
    for (const [content, reason] of [
      [[{ type: 'tool_use', id: 'done', name: 'fca_complete', input: { summary: '完了' } }], 'call'],
      [call('not json {'), 'template'],
      [call(['a list']), 'template'],
      [call(JSON.stringify({ '次': [], other: ['x'] })), 'empty'],
    ] as const) {
      const { error, receipts } = await answered([...content]);
      expect(error).toBeInstanceOf(FcaSummaryInvalidError);
      expect(error).toMatchObject({ message: 'FCA_SUMMARY_INVALID', reason });
      expect(receipts).toHaveLength(1);
    }
  });
});
