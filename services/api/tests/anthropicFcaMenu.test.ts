import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec as codec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { sonnetTool } from '../src/infra/models/anthropic/anthropicRequest.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import type { TaskHistoryRound } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { TASK_TOOLS } from '../src/mind/tools/toolRunnerPorts.js';
import { shannonTool } from '../src/mind/tools/toolRegistryPorts.js';
import { message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

const catalog = [...TASK_TOOLS, shannonTool('web.search')!];
const input = (selected: string[], history: readonly unknown[] = []): FcaModelInput => ({
  task: { id: 'task', title: 'Research', goal: 'Find a public source', completionCriteria: 'A source was read' },
  messages: [], history, tools: catalog.filter(tool => selected.includes(tool.name)),
  catalog: catalog.map(({ name, description }) => ({ name, description })),
});
const call = (name: string, id: string, value: unknown = {}) => ({ type: 'tool_use', name, id, input: value });
const signed = { type: 'thinking', thinking: 'PRIVATE_NATIVE_THINKING', signature: 'OPAQUE_SIGNATURE' };
const redacted = { type: 'redacted_thinking', data: 'OPAQUE_REDACTED' };
const response = (content: Array<Record<string, unknown>>) => message(content, 'tool_use');
const wait = (id: string) => response([call('fca_wait', id, { summary: 'Waiting for evidence' })]);
const signal = () => new AbortController().signal;
const round = (entries: readonly unknown[]): TaskHistoryRound => ({ sequence: 1, stepId: 'step', committedAt: '2026-10-09T00:00:00Z',
  entries, status: 'running', sources: [] });
function harness(script: AnthropicMessage[]) {
  const fixture = scriptedAnthropic(script), headers: Headers[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    headers.push(new Headers(init?.headers)); return fixture.fetcher(url, init);
  }) as typeof fetch;
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher, recordUsage() {} });
  return { ...fixture, headers, model };
}
const systemChanges = (entries: readonly unknown[]) => entries.flatMap(entry => {
  const value = entry as { role: string; content: Array<{ type: string; tool: unknown }> };
  return value.role === 'system' ? value.content : [];
});

describe('FCA selected native schemas', () => {
  it('offers full catalog metadata and only selected inline schemas, then appends changes without altering signed history or cached declarations', async () => {
    const f = harness([response([signed, redacted, call('tool_open', 'open-web', { name: 'web_search' })]), wait('wait-2'), wait('wait-3'), wait('wait-4')]);
    const first = await f.model.decide(input(['task.list']), signal());
    expect(first.decision).toEqual({ kind: 'tools', calls: [{ id: 'open-web', name: 'tool.open', input: { name: 'web_search' } }] });
    const body = f.bodies[0]!;
    expect((body.tools as Anthropic.Tool[]).map(tool => tool.name)).toEqual(['tool_open', 'fca_wait', 'fca_complete']);
    expect(systemChanges(first.history)).toEqual([{ type: 'tool_addition', tool: { type: 'tool_definition', definition: sonnetTool(TASK_TOOLS[1]!) } }]);
    const context = JSON.parse((body.messages as Array<{ content: string }>).at(-1)!.content) as { catalog: unknown[] };
    expect(context.catalog).toEqual(catalog.map(tool => ({ name: tool.name.replaceAll('.', '_'), description: tool.description })));
    expect(JSON.stringify(context.catalog)).not.toMatch(/input_schema|additionalProperties/u);
    expect(f.headers[0]!.get('anthropic-beta')).toBe('inline-tools-2026-09-15');
    expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const old = [...first.history, f.model.toolResults([{ id: 'open-web', text: 'Definition opened', ok: true }])];
    const saved = JSON.stringify(old);
    const second = await f.model.decide(input(['task.list', 'web.search'], old), signal());
    expect(systemChanges(second.history)).toEqual([{ type: 'tool_addition', tool: { type: 'tool_definition', definition: sonnetTool(shannonTool('web.search')!) } }]);
    expect((f.bodies[1]!.messages as unknown[]).slice(0, old.length)).toEqual(old);
    expect(JSON.stringify(old)).toBe(saved);
    const prefix = [...old, ...second.history];
    const third = await f.model.decide(input(['web.search'], prefix), signal());
    expect(systemChanges(third.history)).toEqual([{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'task_list' } }]);
    const fourth = await f.model.decide(input(['web.search'], [...prefix, ...third.history]), signal());
    expect(systemChanges(fourth.history)).toEqual([]);
    for (const next of f.bodies.slice(1)) { expect(next.system).toEqual(body.system); expect(next.tools).toEqual(body.tools); }
    expect(f.bodies).toHaveLength(4);
  });

  it('keeps recovery available when Jev selects no tools', async () => {
    const f = harness([response([call('tool_open', 'open', { name: 'task_list' })])]);
    const output = await f.model.decide(input([]), signal());
    expect(systemChanges(output.history)).toEqual([]);
    expect(output.decision).toMatchObject({ kind: 'tools', calls: [{ name: 'tool.open' }] });
    expect((f.bodies[0]!.tools as Anthropic.Tool[]).map(tool => tool.name)).toContain('tool_open');
    expect((f.bodies[0]!.messages as unknown[])).toHaveLength(1);
  });

  it('removes a changed definition before appending its replacement and refuses ambiguous catalogs before dispatch', async () => {
    const f = harness([wait('first'), wait('second')]);
    const first = await f.model.decide(input(['task.list']), signal());
    const next = input(['task.list'], first.history);
    next.tools = next.tools.map(tool => ({ ...tool, description: 'Updated tool definition' }));
    const second = await f.model.decide(next, signal());
    expect(systemChanges(second.history).map(change => change.type)).toEqual(['tool_removal', 'tool_addition']);
    const invalid = input([]); invalid.catalog = [...invalid.catalog!, { name: 'task_list', description: 'Provider collision' }];
    await expect(f.model.decide(invalid, signal())).rejects.toThrow('FCA_MODEL_TOOL_CONFLICT');
    expect(f.bodies).toHaveLength(2);
  });

  it('starts a fresh public epoch and then preserves its fixed bootstrap and new native signed rounds', async () => {
    const f = harness([response([signed, redacted, call('task_list', 'before')]),
      response([{ ...signed, thinking: 'NEW_PRIVATE_THINKING', signature: 'NEW_SIGNATURE' }, call('task_list', 'after')]), wait('later')]);
    const first = await f.model.decide(input(['task.list']), signal());
    const originals = [...first.history, f.model.toolResults([{ id: 'before', text: 'Public observed result', ok: true }])];
    const originalBytes = JSON.stringify(originals), projected = codec.project(round(originals));
    expect(projected).not.toBeNull();
    const bootstrap = codec.bootstrap(JSON.stringify({ summary: 'Earlier work', rounds: projected }));
    const second = await f.model.decide(input(['task.list'], bootstrap), signal());
    expect(systemChanges(second.history)).toHaveLength(1);
    const secondBody = JSON.stringify(f.bodies[1]);
    expect(secondBody).toContain('Public observed result');
    expect(secondBody).not.toMatch(/PRIVATE_NATIVE_THINKING|OPAQUE_SIGNATURE|OPAQUE_REDACTED/u);
    const next = [...bootstrap, ...second.history, f.model.toolResults([{ id: 'after', text: 'New result', ok: true }])];
    await f.model.decide(input(['task.list'], next), signal());
    expect((f.bodies[2]!.messages as unknown[]).slice(0, next.length)).toEqual(next);
    expect(JSON.stringify(f.bodies[2])).toContain('NEW_SIGNATURE');
    expect(JSON.stringify(originals)).toBe(originalBytes);
  });
});

describe('FCA public native history codec', () => {
  const complete = [
    { role: 'user', content: 'User request' },
    { role: 'assistant', content: [signed, redacted, { type: 'text', text: 'Public response' }, call('task_list', 'one'), call('task_get', 'two', { id: 'child' })] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: 'Public list', is_error: false },
      { type: 'tool_result', tool_use_id: 'two', content: [{ type: 'text', text: 'Public error' }], is_error: true }] },
  ];
  it('projects complete pairs and public messages without reasoning, signatures, redacted data or tool schemas', () => {
    const change = { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'task_list', description: 'SCHEMA_DESCRIPTION', input_schema: { type: 'object' } } } }] };
    const projected = codec.project(round([change, ...complete]))!;
    expect(projected.map(item => item.role)).toEqual(['user', 'user', 'assistant', 'tool_call', 'tool_call', 'tool_result', 'tool_result']);
    expect(projected.filter(item => item.role === 'tool_result').map(item => JSON.parse(item.content).ok)).toEqual([true, false]);
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_NATIVE_THINKING|OPAQUE_SIGNATURE|OPAQUE_REDACTED|SCHEMA_DESCRIPTION|input_schema/u);
    expect(JSON.stringify(projected)).toContain('tool_addition');
  });

  it.each([
    complete.slice(0, -1),
    [...complete.slice(0, -1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: 'Only one result' }] }],
    [...complete.slice(0, -1), { role: 'user', content: 'Missing results' }, complete.at(-1)],
    [...complete, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: 'Duplicate' }] }],
    [{ role: 'assistant', content: [call('task_list', 'same'), call('task_get', 'same')] }],
    [{ role: 'user', content: [signed] }],
    [{ role: 'assistant', content: [signed, redacted] }],
    [{ role: 'assistant', content: [{ type: 'future_unsupported_block', private: 'unknown' }] }],
    [{ role: 'system', content: 'Unrecognized native system block' }],
  ].map(entries => [entries]))('rejects unsupported or incomplete round %#', entries => { expect(codec.project(round(entries))).toBeNull(); });
});
