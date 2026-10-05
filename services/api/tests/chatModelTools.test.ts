import { describe, expect, it } from 'vitest';
import { OpenAIResponsesChatModel } from '../src/chatModel.js';
import { CONVERSATION_TOOL_CALLS, functionCallsOf, withToolRounds, type ShannonModelToolSession } from '../src/chatModelTools.js';
import { chatTurnRequestBody } from '../src/chatModelTurn.js';
import { shannonTool } from '../src/shannonTools.js';

const TURN = JSON.stringify({
  reply: '書斎にメモが1つあります。', threadSummary: null, taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null,
});
const functionCall = (name: string, args = '{}', id = 'call-1') => ({ type: 'function_call', id: `fc-${id}`, call_id: id, name, arguments: args });
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

function session(maximumCalls = CONVERSATION_TOOL_CALLS) {
  const calls: Array<{ name: string; args: string }> = [];
  const value: ShannonModelToolSession = {
    definitions: [shannonTool('study.list')!, shannonTool('study.read')!], maximumCalls,
    async call(name, args) { calls.push({ name, args }); return JSON.stringify({ ok: true, text: '- id: x｜メモ「雨」', retryable: false }); },
  };
  return { value, calls };
}

function scriptedFetch(responses: unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const next = responses.shift();
    return typeof next === 'string' ? new Response(next, { status: 200 }) : new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, bodies };
}

const base = { scopeKey: 'owner', systemPrompt: '[テスト]', history: [], message: '書斎に何がある？' };

describe('her tools in a text turn', () => {
  it('offers the registry as functions, runs what the model asks for, and asks again with the result', async () => {
    const tools = session();
    const { fetcher, bodies } = scriptedFetch([
      { output: [functionCall('study_list', '{"kind":"note"}')], usage: { input_tokens: 10, output_tokens: 5 } },
      { output: [message(TURN)], usage: { input_tokens: 20, output_tokens: 8 } },
    ]);
    const model = new OpenAIResponsesChatModel({ apiKey: 'test', fetcher });
    const result = await model.generate({ ...base, tools: tools.value });
    expect(result.reply).toBe('書斎にメモが1つあります。');
    expect(tools.calls).toEqual([{ name: 'study_list', args: '{"kind":"note"}' }]);
    expect(bodies[0]).toMatchObject({ tool_choice: 'auto', parallel_tool_calls: false });
    expect((bodies[0]!.tools as Array<{ name: string; type: string }>).map(tool => [tool.type, tool.name])).toEqual([['function', 'study_list'], ['function', 'study_read']]);
    expect(String(bodies[0]!.instructions)).toContain('[ボクの道具]');
    const input = bodies[1]!.input as Array<Record<string, unknown>>;
    expect(input.slice(-2)).toEqual([
      { type: 'function_call', call_id: 'call-1', name: 'study_list', arguments: '{"kind":"note"}' },
      { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ ok: true, text: '- id: x｜メモ「雨」', retryable: false }) },
    ]);
  });

  it('stops offering tools after the turn\'s calls are used up', async () => {
    const tools = session(1);
    const { fetcher, bodies } = scriptedFetch([{ output: [functionCall('study_list')] }, { output: [message(TURN)] }]);
    const result = await new OpenAIResponsesChatModel({ apiKey: 'test', fetcher }).generate({ ...base, tools: tools.value });
    expect(result.reply).toBe('書斎にメモが1つあります。');
    expect(tools.calls).toHaveLength(1);
    expect(bodies[0]!.tool_choice).toBe('auto');
    expect(bodies[1]!.tool_choice).toBe('none');
    // A provider that still answers the forced round with a call ends the turn like any unparsable one; nothing more runs.
    const stubborn = scriptedFetch([{ output: [functionCall('study_list')] }, { output: [functionCall('study_read', '{}', 'call-2')] }]);
    const counted = session(1);
    await expect(new OpenAIResponsesChatModel({ apiKey: 'test', fetcher: stubborn.fetcher }).generate({ ...base, tools: counted.value })).rejects.toThrow();
    expect(counted.calls).toHaveLength(1);
  });

  it('leaves a turn without tools, or one that forces a web search, exactly as it was', () => {
    const plain = chatTurnRequestBody('gpt-5.6-luna', base, undefined);
    expect(plain).not.toHaveProperty('tools');
    expect(String(plain.instructions)).not.toContain('[ボクの道具]');
    const searching = chatTurnRequestBody('gpt-5.6-luna', { ...base, useWebSearch: true, tools: session().value }, undefined);
    expect(searching.tools).toEqual([{ type: 'web_search', search_context_size: 'medium' }]);
    expect(String(searching.instructions)).not.toContain('[ボクの道具]');
  });

  it('runs no tool for a round that is already a whole answer', async () => {
    const tools = session();
    const envelope = await withToolRounds({ input: [] }, tools.value, async () => ({ output: [message(TURN), functionCall('study_list')] }), { isAnswer: () => true });
    expect(functionCallsOf(envelope)).toHaveLength(1);
    expect(tools.calls).toEqual([]);
  });
});

describe('her tools in a voice turn', () => {
  it('streams the waiting phrase of the round that calls a tool, then the answer, and speaks both', async () => {
    const tools = session();
    const sse = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    const { fetcher, bodies } = scriptedFetch([
      sse([
        { type: 'response.output_text.delta', delta: 'ちょっと見てみるね。' },
        { type: 'response.completed', response: { output: [message('ちょっと見てみるね。'), functionCall('study_list')], usage: { input_tokens: 5, output_tokens: 5 } } },
      ]),
      sse([
        { type: 'response.output_text.delta', delta: 'メモが1つあります。' },
        { type: 'response.completed', response: { output: [message('メモが1つあります。')], usage: { input_tokens: 5, output_tokens: 5 } } },
      ]),
    ]);
    const deltas: string[] = [];
    const result = await new OpenAIResponsesChatModel({ apiKey: 'test', fetcher }).generateVoiceStreaming(
      { ...base, useWebSearch: false, conversationClass: 'direct', tools: tools.value }, delta => { deltas.push(delta); });
    expect(deltas).toEqual(['ちょっと見てみるね。', 'メモが1つあります。']);
    expect(result.reply).toBe('ちょっと見てみるね。メモが1つあります。');
    expect(tools.calls).toHaveLength(1);
    expect(String(bodies[0]!.instructions)).toContain('ちょっと見てみるね');
    // A voice turn that searches the web offers no tools.
    const searching = scriptedFetch([sse([{ type: 'response.output_text.delta', delta: 'はい。' }, { type: 'response.completed', response: { output: [message('はい。')] } }])]);
    await new OpenAIResponsesChatModel({ apiKey: 'test', fetcher: searching.fetcher }).generateVoiceStreaming(
      { ...base, useWebSearch: true, conversationClass: 'direct', tools: tools.value }, () => {});
    expect((searching.bodies[0]!.tools as Array<{ type: string }>).map(tool => tool.type)).toEqual(['web_search']);
  });
});
