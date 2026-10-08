import { describe, expect, it } from 'vitest';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { anthropicFixture, message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

const model = 'claude-haiku-5-5';
const base = { scopeKey: 'owner', systemPrompt: 'Identity', history: [], message: 'Read the study' };
const signed = (id: string, name: string, input: unknown = {}): AnthropicMessage => paid(message([
  { type: 'thinking', thinking: '', signature: `signed-${id}` }, { type: 'tool_use', id, name, input },
], 'tool_use'));
const paid = (value: AnthropicMessage): AnthropicMessage => ({ ...value, model,
  usage: { ...value.usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 900,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } });
type Body = Record<string, unknown>;
type Messages = Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
function native(script: (body: Body, index: number) => AnthropicMessage | Response, selected = model) {
  const transport = scriptedAnthropic((body, index) => { legalSystemSections(body); return script(body, index); });
  const headers: Headers[] = [];
  const chat = new AnthropicChatModel({ apiKey: 'test-only', settings: { model: selected, effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' },
    fetch: (input, init) => { headers.push(new Headers(init?.headers)); return transport.fetcher(input, init); } });
  return { chat, headers, bodies: transport.bodies };
}
/** The official placement rule applies to an entire consecutive system section, not to each entry separately. */
function legalSystemSections(body: Body) {
  const messages = body.messages as Messages;
  for (let start = 0; start < messages.length; start++) {
    if (messages[start]!.role !== 'system') continue;
    let end = start + 1;
    while (messages[end]?.role === 'system') end++;
    expect(messages[start - 1]?.role).toBe('user'); // These fixtures use client-tool results, not server-tool pauses.
    expect(end === messages.length || messages[end]!.role === 'assistant').toBe(true);
    start = end - 1;
  }
}
function tools() {
  const calls: string[] = [];
  const session = withToolMenu({ definitions: [shannonTool('study.list')!, shannonTool('study.read')!], maximumCalls: 6,
    deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
    async call(name) { calls.push(name); return JSON.stringify({ ok: true, text: 'canonical result', retryable: false }); },
  }, []);
  return { session, calls };
}
function unchangedPrefix(previous: Body, next: Body, assistant: AnthropicMessage) {
  expect(next.system).toEqual(previous.system);
  expect(next.tools).toEqual(previous.tools);
  const prior = previous.messages as Messages;
  const current = next.messages as Messages;
  expect(current.slice(0, prior.length)).toEqual(prior);
  expect(current[prior.length]).toEqual({ role: 'assistant', content: assistant.content });
  expect(current[prior.length + 1]).toMatchObject({ role: 'user', content: [{ type: 'tool_result' }] });
}

describe('Haiku signed thinking with a lazy tool menu', () => {
  it.each([false, true])('opens strict schemas by value append-only and runs only an opened tool (voice=%s)', async voice => {
    const opened = signed('open-list', 'tool_open', { name: 'study_list' });
    const read = signed('read-list', 'study_list');
    const answer = voice ? paid(message([{ type: 'text', text: 'メモがあります。' }], 'end_turn')) : paid(anthropicFixture('structured-answer'));
    const t = tools();
    const h = native((body, index) => {
      if (index === 0) return opened;
      unchangedPrefix(h.bodies[index - 1]!, body, index === 1 ? opened : read);
      if (index === 1) {
        expect((body.messages as Messages).at(-1)).toEqual({ role: 'system', content: [
          { type: 'tool_addition', tool: { type: 'tool_definition', definition: expect.objectContaining({ name: 'study_list', strict: true }) } },
        ] });
        return read;
      }
      return answer;
    });
    const result = voice ? await h.chat.generateVoiceStreaming({ ...base, useWebSearch: false, conversationClass: 'skill_simple', tools: t.session }, () => {})
      : await h.chat.generate({ ...base, tools: t.session });
    expect(result.reply).toBeTruthy();
    expect(result.outOfTime).toBeUndefined();
    expect(t.calls).toEqual(['study_list']);
    expect(h.bodies).toHaveLength(3);
    expect(h.bodies[0]!.tools).toEqual([expect.objectContaining({ name: 'tool_open', strict: true })]);
    expect(h.bodies.every(body => body.cache_control && (body.cache_control as { ttl: string }).ttl === '1h')).toBe(true);
    expect(h.headers.every(header => header.get('anthropic-beta') === 'inline-tools-2026-09-15')).toBe(true);
  });

  it('recovers once after a tool ran without changing the signed prefix or its original result', async () => {
    const first = signed('original', 'study_list');
    let calls = 0;
    const h = native((body, index) => {
      if (index === 0) return first;
      unchangedPrefix(h.bodies[0]!, body, first);
      if (index === 1) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'synthetic offered tool refusal' } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
      expect((body.messages as Messages).slice(0, (h.bodies[1]!.messages as Messages).length)).toEqual(h.bodies[1]!.messages);
      expect(body.tool_choice).toEqual({ type: 'none' });
      expect((body.messages as Messages).at(-1)).toMatchObject({ role: 'system', content: expect.any(String) });
      return paid(anthropicFixture('structured-answer'));
    });
    const result = await h.chat.generate({ ...base, tools: { definitions: [shannonTool('study.list')!], maximumCalls: 6,
      deadline: new TurnDeadline(TEXT_TURN_DEADLINE), async call() { calls++; return 'original canonical result'; } } });
    expect(result.outOfTime).toBeUndefined();
    expect(h.bodies).toHaveLength(3);
    expect(calls).toBe(1);
    expect(JSON.stringify(h.bodies[2]!.messages)).toContain('original canonical result');
  });

  it('recovers after a signed tool_open and a 400 with one legal appended system section', async () => {
    const opened = signed('open-before-400', 'tool_open', { name: 'study_list' });
    const t = tools();
    const h = native((body, index) => {
      if (index === 0) return opened;
      unchangedPrefix(h.bodies[0]!, body, opened);
      if (index === 1) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
      const prior = h.bodies[1]!.messages as Messages;
      expect((body.messages as Messages).slice(0, prior.length)).toEqual(prior);
      expect((body.messages as Messages).slice(-2)).toEqual([
        { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: expect.objectContaining({ name: 'study_list', strict: true }) } }] },
        { role: 'system', content: expect.any(String) },
      ]);
      expect(body.tool_choice).toEqual({ type: 'none' });
      return paid(anthropicFixture('structured-answer'));
    });
    expect((await h.chat.generate({ ...base, tools: t.session })).outOfTime).toBeUndefined();
    expect(h.bodies).toHaveLength(3);
    expect(t.calls).toEqual([]); // tool_open changes visibility, without executing a tool or counting one.
    expect(h.headers.every(header => header.get('anthropic-beta') === 'inline-tools-2026-09-15')).toBe(true);
  });

  it.each(['claude-sonnet-5-5', 'claude-haiku-4-5-20251001'])('retains %s menu loading without the 5.5 inline-tools feature', async selected => {
    const opened = signed('open', 'tool_open', { name: 'study_list' });
    const t = tools();
    const h = native((_body, index) => ({ ...(index === 0 ? opened : paid(anthropicFixture('structured-answer'))), model: selected }), selected);
    await h.chat.generate({ ...base, tools: t.session });
    expect((h.bodies[0]!.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(['tool_open']);
    expect((h.bodies[1]!.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(['study_list', 'tool_open']);
    expect(h.headers.every(header => !header.has('anthropic-beta'))).toBe(true);
    expect(JSON.stringify(h.bodies[1]!.messages)).not.toContain('tool_addition');
    expect(t.calls).toEqual([]);
  });
});
