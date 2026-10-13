import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { SHANNON_TOOLS, providerToolName, type ShannonToolDefinition } from '../src/mind/tools/shannonTools.js';
import { validToolInput } from '../src/mind/tools/shannonToolInput.js';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../src/mind/action/respond/turnDeadline.js';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { ANTHROPIC_GRAMMAR_BUDGET, requestStrictTools, strictRequestFits, strictRequestUsage, TOOL_CALL_JSON_CHARACTERS } from '../src/infra/models/anthropic/anthropicToolCapacity.js';
import { activeAnthropicToolNames } from '../src/infra/models/anthropic/anthropicForegroundMenu.js';
import { bridgedAnthropicSession } from '../src/infra/models/anthropic/anthropicToolBridge.js';
import { sonnetChatBody } from '../src/infra/models/anthropic/anthropicRequest.js';
import { anthropicFixture, message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

const request = { scopeKey: 'owner', systemPrompt: 'Synthetic owner context', history: [], message: 'マイクラを起動して' };
const productionSelection = ['minecraft.request', 'minecraft.status', 'skill.read', 'task.create', 'task.list', 'task.get', 'task.send', 'memory.search', 'minecraft.lifecycle_status', 'minecraft.start', 'minecraft.login'];
const call = (id: string, name: string, input: unknown) => message([{ type: 'thinking', thinking: '', signature: `signed-${id}` }, { type: 'tool_use', id, name, input }], 'tool_use');
function session(definitions: readonly ShannonToolDefinition[], selected: readonly string[]) {
  const calls: Array<{ name: string; input: unknown; signal?: AbortSignal; milliseconds?: number }> = [];
  let notes = 0;
  const base = { definitions, maximumCalls: 6, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
    async start(name: string, input: string, signal?: AbortSignal, milliseconds?: number) {
      const definition = definitions.find(tool => providerToolName(tool.name) === name);
      if (!definition) return { output: JSON.stringify({ ok: false, failure: 'not_offered' }), note: () => {} };
      const checked = validToolInput(input, definition.input);
      if ('problem' in checked) return { output: JSON.stringify({ ok: false, failure: 'invalid_input' }), note: () => {} };
      calls.push({ name, input: checked.input, signal, milliseconds });
      return { output: JSON.stringify({ ok: true, text: 'synthetic original receipt' }), note: () => { notes++; } };
    }, async call(name: string, input: string) { const result = await this.start(name, input); result.note(); return result.output; },
  };
  return { tools: withToolMenu(base, selected.map(providerToolName)), calls, notes: () => notes };
}
function provider(model: string, script: AnthropicMessage[]) {
  const transport = scriptedAnthropic((raw, index) => {
    const body = raw as unknown as Anthropic.MessageCreateParamsNonStreaming;
    expect(strictRequestFits(body)).toBe(true);
    if (index) {
      const previous = transport.bodies[index - 1]!;
      expect(raw.tools).toEqual(previous.tools);
      expect(raw.system).toEqual(previous.system);
      expect((raw.messages as unknown[]).slice(0, (previous.messages as unknown[]).length)).toEqual(previous.messages);
    }
    return { ...script[index]!, model };
  });
  const chat = new AnthropicChatModel({ apiKey: 'test-only', settings: { model, effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' }, fetch: transport.fetcher });
  return { ...transport, chat };
}
describe.each(['claude-haiku-5-5', 'claude-sonnet-5-5'])('actual strict request capacity: %s', model => {
  const settings = { model, effort: 'low' as const, textThinking: 'adaptive' as const, voiceThinking: 'adaptive' as const };
  it.each(['text', 'voice'] as const)('keeps mixed lifecycle/search %s tools executable within the combined optional limit', async surface => {
    const selected = ['study.search', ...SHANNON_TOOLS.filter(tool => tool.domain === 'minecraft_lifecycle').map(tool => tool.name)];
    const t = session(SHANNON_TOOLS, selected);
    const h = provider(model, [call('start', 'minecraft_start', {}), surface === 'text' ? anthropicFixture('structured-answer') : message([{ type: 'text', text: '起動しました。' }], 'end_turn')]);
    if (surface === 'text') await h.chat.generate({ ...request, tools: t.tools });
    else await h.chat.generateVoice({ ...request, tools: t.tools, useWebSearch: false, conversationClass: 'skill_simple' });
    expect(t.calls.map(item => item.name)).toEqual(['minecraft_start']);
    expect(t.notes()).toBe(1);
    const initial = h.bodies[0]! as unknown as Anthropic.MessageCreateParamsNonStreaming;
    expect(strictRequestUsage(initial).optional).toBeLessThanOrEqual(ANTHROPIC_GRAMMAR_BUDGET.optional);
    expect(requestStrictTools(initial).every(tool => tool.strict)).toBe(true);
    // Past the grammar budget the selected tools stay native, non-strict, callable by name (2026-10-13).
    expect(activeAnthropicToolNames(initial)).toContain('minecraft_logout');
    expect(JSON.stringify(initial.messages)).not.toContain('[開いている道具の入力定義・データ]');
  });
  it('retains the actual 17:57:42 production selection and executes the start through its native name', async () => {
    const t = session(SHANNON_TOOLS, productionSelection);
    const h = provider(model, [call('original-start', 'minecraft_start', {}), anthropicFixture('structured-answer')]);
    await h.chat.generate({ ...request, tools: t.tools });
    const names = activeAnthropicToolNames(h.bodies[0]! as unknown as Anthropic.MessageCreateParamsNonStreaming);
    for (const name of productionSelection) expect(names).toContain(providerToolName(name));
    expect(t.calls.map(item => item.name)).toEqual(['minecraft_start']);
  });
  it.each(['text', 'text-stream', 'voice', 'voice-stream'] as const)('recovers an explicit initial compiled-grammar 400 with all selected tools retained (%s)', async surface => {
    const t = session(SHANNON_TOOLS, productionSelection);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const final = surface.startsWith('text') ? anthropicFixture('structured-answer') : message([{ type: 'text', text: '起動しました。' }], 'end_turn');
      const transport = scriptedAnthropic((raw, index) => {
        const body = raw as unknown as Anthropic.MessageCreateParamsNonStreaming;
        expect(strictRequestFits(body)).toBe(true);
        if (!index) return grammarRejection();
        expect(body.tools).toEqual(transport.bodies[0]!.tools);
        expect(body.tool_choice).toEqual({ type: 'auto' });
        expect(requestStrictTools(body).map(tool => tool.name)).toEqual(['tool_open', 'tool_call']);
        for (const name of productionSelection) expect(JSON.stringify(body.messages)).toContain(providerToolName(name));
        return { ...(index === 1 ? call('start', 'tool_call', { name: 'minecraft_start', argumentsJson: '{}' }) : final), model };
      });
      const chat = new AnthropicChatModel({ apiKey: 'test-only', settings, fetch: transport.fetcher });
      const input = { ...request, tools: t.tools, useWebSearch: false, conversationClass: 'skill_simple' as const };
      if (surface === 'text') await chat.generate(input);
      else if (surface === 'text-stream') await chat.generateStreaming(input, () => {});
      else if (surface === 'voice') await chat.generateVoice(input);
      else await chat.generateVoiceStreaming(input, () => {});
      expect(transport.bodies).toHaveLength(3);
      expect(t.calls.map(item => item.name)).toEqual(['minecraft_start']);
      expect(t.notes()).toBe(1);
      // The rejection is counted by class (ADR-0009 stage 1), then the grammar recovery is reported once.
      expect(log).toHaveBeenCalledTimes(2);
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ event: 'anthropic_request_rejected', class: 'strict_grammar_capacity' });
      expect(JSON.parse(log.mock.calls[1]![0] as string)).toMatchObject({ category: 'strict_grammar_capacity' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-secret');
    } finally { log.mockRestore(); }
  });
  it('recovers a rejected expansion without changing the accepted signed prefix or executing any prior operation again', async () => {
    const t = session(SHANNON_TOOLS, []);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const transport = scriptedAnthropic((raw, index) => {
        if (index === 0) return { ...call('open', 'tool_open', { name: 'study_read' }), model };
        if (index === 1) return grammarRejection();
        const initial = transport.bodies[0]!;
        expect(raw.tools).toEqual(initial.tools);
        expect(raw.system).toEqual(initial.system);
        expect((raw.messages as unknown[]).slice(0, (initial.messages as unknown[]).length)).toEqual(initial.messages);
        expect((raw.messages as unknown[]).slice((initial.messages as unknown[]).length, (initial.messages as unknown[]).length + 2))
          .toEqual((transport.bodies[1]!.messages as unknown[]).slice((initial.messages as unknown[]).length, (initial.messages as unknown[]).length + 2));
        expect(requestStrictTools(raw as unknown as Anthropic.MessageCreateParamsNonStreaming).map(tool => tool.name)).not.toContain('study_read');
        // After the grammar refusal the opened definition stays native, without strict decoding: called by its own name.
        expect(activeAnthropicToolNames(raw as unknown as Anthropic.MessageCreateParamsNonStreaming)).toContain('study_read');
        return { ...(index === 2 ? call('read', 'study_read', { id: 'synthetic' }) : anthropicFixture('structured-answer')), model };
      });
      const chat = new AnthropicChatModel({ apiKey: 'test-only', settings, fetch: transport.fetcher });
      await chat.generate({ ...request, tools: t.tools });
      expect(transport.bodies).toHaveLength(4);
      expect(t.calls.map(item => item.name)).toEqual(['study_read']);
      expect(t.notes()).toBe(1);
    } finally { log.mockRestore(); }
  });
  it('opens a tool whose optional schema will not fit, then executes through the original validated session once', async () => {
    const t = session(SHANNON_TOOLS, ['study.search']);
    const h = provider(model, [call('open', 'tool_open', { name: 'schedule_upcoming' }),
      call('execute', 'tool_call', { name: 'schedule_upcoming', argumentsJson: '{}' }), anthropicFixture('structured-answer')]);
    await h.chat.generate({ ...request, tools: t.tools });
    expect(h.bodies).toHaveLength(3);
    expect(requestStrictTools(h.bodies[1]! as unknown as Anthropic.MessageCreateParamsNonStreaming).map(tool => tool.name)).not.toContain('schedule_upcoming');
    expect(JSON.stringify(h.bodies[1]!.messages)).toContain('definitionIsData');
    expect(t.calls.map(item => item.name)).toEqual(['schedule_upcoming']);
    expect(t.calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(t.calls[0]!.milliseconds).toBeGreaterThan(0);
    expect(t.notes()).toBe(1);
  });
  it('preserves discovery and execution after the cumulative native tool count is full', async () => {
    const template = SHANNON_TOOLS.find(tool => tool.name === 'minecraft.start')!;
    const filler = Array.from({ length: 18 }, (_, index) => ({ ...template, name: `fixture.tool${index}`, input: { ...template.input, properties: {} } }));
    const t = session([...filler, template], filler.map(tool => tool.name));
    const h = provider(model, [call('open', 'tool_open', { name: 'minecraft_start' }), call('start', 'tool_call', { name: 'minecraft_start', argumentsJson: '{}' }), anthropicFixture('structured-answer')]);
    await h.chat.generate({ ...request, tools: t.tools });
    expect(strictRequestUsage(h.bodies[0]! as unknown as Anthropic.MessageCreateParamsNonStreaming).tools).toBe(ANTHROPIC_GRAMMAR_BUDGET.tools);
    expect(strictRequestUsage(h.bodies[1]! as unknown as Anthropic.MessageCreateParamsNonStreaming).tools).toBe(ANTHROPIC_GRAMMAR_BUDGET.tools);
    expect(t.calls.map(item => item.name)).toEqual(['minecraft_start']);
  });
  it('counts final output unions together with strict tools and rejects capacity before any provider call', () => {
    const t = session(SHANNON_TOOLS, []);
    const body = sonnetChatBody(settings, { ...request, tools: t.tools }, undefined);
    expect(strictRequestUsage(body).unions).toBe(9);
    const extra: Anthropic.Tool = { name: 'fixture', strict: true, input_schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`field${i}`, { anyOf: [{ type: 'string' }, { type: 'null' }] }])), required: [], additionalProperties: false } };
    expect(strictRequestFits(body, [extra])).toBe(false);
  });
});

function grammarRejection() {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'The compiled grammar is too large, which would cause performance issues. synthetic-secret' } }),
    { status: 400, headers: { 'content-type': 'application/json' } });
}

describe('strict bridge preserves the original offer and validation', () => {
  it('refuses unknown, un-opened, malformed, oversized and invalid original input; a valid call retains notes and cancellation', async () => {
    const t = session(SHANNON_TOOLS.filter(tool => ['minecraft.start', 'minecraft.login'].includes(tool.name)), ['minecraft.start']);
    const wrapped = bridgedAnthropicSession(t.tools, new Set(['tool_open', 'tool_call', 'minecraft_start']));
    const invoke = (name: string, argumentsJson: string) => wrapped.call('tool_call', JSON.stringify({ name, argumentsJson }));
    for (const [name, args] of [['unknown', '{}'], ['minecraft_login', '{}'], ['minecraft_start', '[]'], ['minecraft_start', '{'], ['minecraft_start', 'x'.repeat(TOOL_CALL_JSON_CHARACTERS + 1)], ['minecraft_start', '{"serverId":1}']]) {
      expect(JSON.parse(await invoke(name!, args!)).ok).toBe(false);
    }
    expect(t.calls).toEqual([]);
    expect(JSON.parse(wrapped.meta!('tool_open', '{"name":"minecraft_login"}')!).ok).toBe(true);
    expect(JSON.parse(await invoke('minecraft_login', '{}')).ok).toBe(true);
    expect(t.calls.map(item => item.name)).toEqual(['minecraft_login']);
    expect(t.notes()).toBe(1);
  });
});
