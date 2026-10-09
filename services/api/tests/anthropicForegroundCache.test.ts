import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { activeAnthropicToolNames } from '../src/infra/models/anthropic/anthropicForegroundMenu.js';
import { observedAnthropicRequest } from '../src/infra/models/anthropic/observerProjection.js';
import { HAIKU_PROTOCOL_PREFIX } from '../src/infra/models/anthropic/haikuCache.js';
import type { ShannonModelToolSession } from '../src/infra/models/chatModelTools.js';
import { offerWithMenu, withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { shannonTool, type ShannonToolDefinition } from '../src/mind/tools/shannonTools.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { anthropicFixture, message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

type Body = Record<string, unknown>;
type Messages = Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
type Lane = 'text' | 'text-stream' | 'voice' | 'voice-stream';
const base = { scopeKey: 'owner', systemPrompt: 'Canonical identity fixture', profilePrompt: 'Fixed profile fixture',
  history: [{ role: 'user' as const, content: 'Earlier owner turn' }, { role: 'assistant' as const, content: 'Earlier reply' }],
  message: 'Current owner turn', turnContext: 'Current private context', useWebSearch: false, conversationClass: 'skill_simple' as const };
const offered = ['study.list', 'folder.list'].map(name => shannonTool(name)!);
const nativeBody = (body: Body) => body as unknown as Anthropic.MessageCreateParamsNonStreaming;
const definitions = (body: Body) => (body.messages as Messages).flatMap(item => Array.isArray(item.content)
  ? item.content.flatMap(block => block.type === 'tool_addition' ? [(block.tool as { definition: Anthropic.Tool }).definition] : []) : []);
const call = (name: string, id: string, input: unknown = {}) => message([
  { type: 'thinking', thinking: '', signature: `opaque-${id}` }, { type: 'tool_use', name, id, input },
], 'tool_use');
const final = (lane: Lane) => lane.startsWith('voice') ? message([{ type: 'text', text: '確認しました。' }], 'end_turn') : anthropicFixture('structured-answer');
function session(definitions: readonly ShannonToolDefinition[] = offered) {
  const call = vi.fn<ShannonModelToolSession['call']>(async () => JSON.stringify({ ok: true, text: 'Original execution receipt', retryable: false }));
  return { definitions, maximumCalls: 6, deadline: new TurnDeadline(TEXT_TURN_DEADLINE), call };
}
function native(model: string, script: (body: Body, index: number) => AnthropicMessage) {
  const fixture = scriptedAnthropic((body, index) => ({ ...script(body, index), model }));
  return { ...fixture, chat: new AnthropicChatModel({ apiKey: 'synthetic', fetch: fixture.fetcher,
    settings: { model, effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } }) };
}
function run(chat: AnthropicChatModel, lane: Lane, tools: ReturnType<typeof withToolMenu>, options: Partial<typeof base> = {}) {
  const request = { ...base, ...options, tools };
  if (lane === 'text') return chat.generate(request);
  if (lane === 'text-stream') return chat.generateStreaming(request, () => {});
  if (lane === 'voice') return chat.generateVoice(request);
  return chat.generateVoiceStreaming(request, () => {});
}

describe.each(['claude-haiku-5-5', 'claude-sonnet-5-5'])('stable foreground cache: %s', model => {
  it.each<Lane>(['text', 'text-stream', 'voice', 'voice-stream'])('keeps tools/system stable across Jev choices and catalog changes (%s)', async lane => {
    const selected = ['study_list', 'folder_list', 'study_list'];
    const h = native(model, (_body, index) => index % 2 === 0 ? call(selected[Math.floor(index / 2)]!, `selected-${index}`) : final(lane));
    for (let turn = 0; turn < selected.length; turn++) {
      const raw = session(turn === 2 ? [...offered, shannonTool('task.list')!] : offered);
      const narrowed = await offerWithMenu({ tools: raw }, Promise.resolve({ menu: { chosen: [selected[turn]!] } }));
      await run(h.chat, lane, narrowed.tools);
      expect(raw.call).toHaveBeenCalledOnce(); // The selected schema is usable immediately, without a tool_open round.
      expect(raw.call.mock.calls[0]?.[0]).toBe(selected[turn]);
      const initial = h.bodies[turn * 2]!, next = h.bodies[turn * 2 + 1]!;
      expect(initial.tools).toEqual(h.bodies[0]!.tools);
      expect(initial.system).toEqual(h.bodies[0]!.system);
      expect(initial.tools).toEqual([expect.objectContaining({ name: 'tool_open', strict: true,
        input_schema: { type: 'object', properties: { name: { type: 'string', description: expect.any(String) } },
          required: ['name'], additionalProperties: false } })]);
      expect((initial.system as Anthropic.TextBlockParam[])[0]).toEqual({ type: 'text', text: HAIKU_PROTOCOL_PREFIX,
        cache_control: { type: 'ephemeral', ttl: '1h' } });
      expect(initial.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
      expect(JSON.stringify(initial.system)).not.toContain('[ボクの道具・献立]');
      expect(JSON.stringify(initial.system)).not.toContain(base.turnContext);
      expect(definitions(initial).map(tool => tool.name)).toEqual([selected[turn]]);
      expect(activeAnthropicToolNames(nativeBody(initial))).toEqual(['tool_open', selected[turn]]);
      expect(observedAnthropicRequest(nativeBody(initial)).offeredTools).toEqual(['tool_open', offered[turn === 1 ? 1 : 0]!.name]);
      const menu = (initial.messages as Messages).at(-1)!;
      expect(menu.role).toBe('system');
      for (const tool of raw.definitions) expect(JSON.stringify(menu)).toContain(`- ${tool.name.replaceAll('.', '_')}: `);
      expect((initial.messages as Messages).slice(0, 3)).toEqual([
        ...base.history.map(item => ({ role: item.role, content: [{ type: 'text', text: item.content }] })),
        { role: 'user', content: [{ type: 'text', text: base.message }] },
      ]);
      expect(next.tools).toEqual(initial.tools);
      expect(next.system).toEqual(initial.system);
      expect((next.messages as Messages).slice(0, (initial.messages as Messages).length)).toEqual(initial.messages);
      expect((next.messages as Messages)[(initial.messages as Messages).length]).toEqual({ role: 'assistant',
        content: call(selected[turn]!, `selected-${turn * 2}`).content });
      expect(definitions(next)).toEqual(definitions(initial)); // No duplicate definitions after the selected call.
    }
    expect(h.bodies).toHaveLength(6);
  });

  it('extends conversation history before the new selection without moving the current context into its prefix', async () => {
    const h = native(model, () => final('text'));
    await run(h.chat, 'text', withToolMenu(session(), ['study_list']));
    await run(h.chat, 'text', withToolMenu(session(), ['folder_list']), {
      history: [...base.history, { role: 'user', content: base.message }, { role: 'assistant', content: 'Previous final reply' }],
      message: 'Next owner turn', turnContext: 'Next private context',
    });
    expect(h.bodies[1]!.tools).toEqual(h.bodies[0]!.tools);
    expect(h.bodies[1]!.system).toEqual(h.bodies[0]!.system);
    expect((h.bodies[1]!.messages as Messages).slice(0, 3)).toEqual((h.bodies[0]!.messages as Messages).slice(0, 3));
    expect(JSON.stringify(h.bodies[1]!.messages)).not.toContain(base.turnContext);
    expect(JSON.stringify((h.bodies[1]!.messages as Messages).slice(0, 5))).not.toContain('folder_list');
  });

  it('does not let the stable string opener bypass the current offer or original execution gate', async () => {
    const raw = session([shannonTool('study.list')!]);
    const gate = vi.fn(() => JSON.stringify({ ok: false, text: 'Current gate refuses', failure: 'forbidden', retryable: false }));
    raw.call.mockImplementation(async () => gate());
    const tools = withToolMenu(raw, ['study_list']);
    const answers = [call('tool_open', 'missing', { name: 'folder_list' }), call('folder_list', 'hidden'),
      call('tool_open', 'already-open', { name: 'study_list' }), call('study_list', 'offered'), final('text')];
    const h = native(model, (_body, index) => answers[index]!);
    await run(h.chat, 'text', tools);
    expect(raw.call).toHaveBeenCalledOnce();
    expect(raw.call.mock.calls[0]?.[0]).toBe('study_list');
    expect(gate).toHaveBeenCalledOnce();
    for (const body of h.bodies) expect(definitions(body).map(tool => tool.name)).toEqual(['study_list']);
    const results = (h.bodies.at(-1)!.messages as Messages).flatMap(item => Array.isArray(item.content)
      ? item.content.filter(block => block.type === 'tool_result') : []);
    expect(results.filter(block => String(block.content).includes('not_offered'))).toHaveLength(2);
    expect(results.at(-1)?.content).toContain('Current gate refuses');
  });

  it('preserves the original deadline, start/note and voice audience restrictions for small sessions without Jev', async () => {
    const raw = session([shannonTool('study.list')!]);
    const note = vi.fn();
    const start = vi.fn<NonNullable<ShannonModelToolSession['start']>>(async () => ({ output: '{"ok":true,"text":"Receipt","retryable":false}', note }));
    const offered = { ...raw, start, writesWithheld: true };
    const h = native(model, (_body, index) => index === 0 ? call('study_list', 'direct') : final('voice'));
    await run(h.chat, 'voice', offered);
    expect(start).toHaveBeenCalledOnce(); expect(note).toHaveBeenCalledOnce(); expect(raw.call).not.toHaveBeenCalled();
    expect(start.mock.calls[0]).toMatchObject(['study_list', '{}', expect.any(AbortSignal), expect.any(Number)]);
    expect(start.mock.calls[0]![3]).toBeLessThanOrEqual(raw.deadline.plan.firstRoundMilliseconds);
    expect(JSON.stringify(h.bodies[0]!.messages)).toContain('聞き取りが確かでない');
    expect(JSON.stringify(h.bodies[0]!.system)).not.toContain('聞き取りが確かでない');
    expect(definitions(h.bodies[0]!).map(tool => tool.name)).toEqual(['study_list']);
  });

  it.each([19, 20])('counts the stable opener within the strict 20-tool boundary for a raw %i-tool session', async count => {
    const definitions = Array.from({ length: count }, (_, index) => ({ ...shannonTool('study.list')!, name: `fixture.tool${index}` }));
    const h = native(model, () => final('text'));
    await run(h.chat, 'text', session(definitions));
    const body = h.bodies[0]!;
    expect(activeAnthropicToolNames(nativeBody(body))).toHaveLength(count === 19 ? 20 : 1);
    for (const tool of definitions) expect(JSON.stringify(body.messages)).toContain(`- ${tool.name.replaceAll('.', '_')}: `);
    expect(body.tools).toEqual([expect.objectContaining({ name: 'tool_open', strict: true })]);
  });
});

it('projects only closed active names, including inline changes, without exposing context or schemas', () => {
  const body = { model: 'claude-haiku-5-5', max_tokens: 100, tools: [{ name: 'tool_open' }, { name: 'study_read', defer_loading: true }],
    system: 'private system', messages: [{ role: 'user', content: 'private owner words' }, { role: 'system', content: [
      { type: 'text', text: 'private menu text' },
      { type: 'tool_addition', tool: { type: 'tool_reference', name: 'study_read' } },
      { type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'private-unregistered-name', description: 'private schema' } } },
      { type: 'tool_removal', tool: { type: 'tool_reference', name: 'tool_open' } },
    ] }] };
  const projected = observedAnthropicRequest(nativeBody(body));
  expect(projected).toEqual({ model: body.model, messageCount: 2, maximumOutputTokens: 100, offeredTools: ['study.read', 'unknown'] });
  expect(JSON.stringify(projected)).not.toContain('private');
});
