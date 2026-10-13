import { describe, expect, it } from 'vitest';
import { OpenAIResponsesChatModel } from '../src/infra/models/chatModel.js';
import {
  CONVERSATION_TOOL_CALLS, CUT_OFF_CALL_NOTE, SKIPPED_FOR_TIME, TIMED_OUT_ROUND_NOTE, TOOLS_GONE_NOTE, TURN_OUT_OF_TIME_LINE, VOICE_SECOND_PHRASE, VOICE_TOOL_OUTPUT_TOKENS,
  functionCallsOf, isWaitingAnnouncement, VoiceWaitingEcho, withToolRounds, type ShannonModelToolSession,
} from '../src/infra/models/chatModelTools.js';
import { streamedVoiceToolTurn } from '../src/infra/models/chatModelVoiceTools.js';
import { ChatSentenceSplitter, splitChatSentences } from '../src/surfaces/text/chatSentenceSplitter.js';
import { TEXT_TURN_DEADLINE, TurnDeadline, VOICE_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { CONVERSATION_WRITE_CHARACTERS, FOLDER_WRITE_CHARACTERS, offeredTools } from '../src/mind/tools/shannonTools.js';
import { chatTurnRequestBody } from '../src/infra/models/chatModelTurn.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';

const TURN = JSON.stringify({
  reply: '書斎にメモが1つあります。', threadSummary: null, taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null,
});
const functionCall = (name: string, args = '{}', id = 'call-1') => ({ type: 'function_call', id: `fc-${id}`, call_id: id, name, arguments: args });
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

function session(maximumCalls = CONVERSATION_TOOL_CALLS) {
  const calls: Array<{ name: string; args: string }> = [];
  const value: ShannonModelToolSession = {
    definitions: [shannonTool('study.list')!, shannonTool('study.read')!], maximumCalls, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
    async call(name, args) { calls.push({ name, args }); return JSON.stringify({ ok: true, text: '- id: x｜メモ「雨」', retryable: false }); },
  };
  return { value, calls };
}

function scriptedFetch(responses: unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const next = responses.shift();
    if (next && typeof next === 'object' && 'status' in next && typeof (next as { status: unknown }).status === 'number') {
      return new Response(JSON.stringify({ error: { message: 'bad tools' } }), { status: (next as { status: number }).status });
    }
    return typeof next === 'string' ? new Response(next, { status: 200 }) : new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, bodies };
}

const base = { scopeKey: 'owner', systemPrompt: '[テスト]', history: [], message: '書斎に何がある？' };

describe('her tools in a text turn', () => {
  it('runs only the names the request offers: a dotted or unknown name is refused without running (re-review 1)', async () => {
    const tools = session();
    const refused: string[] = [];
    const value = { ...tools.value, refuse: (name: string) => { refused.push(name); return JSON.stringify({ ok: false, failure: 'not_offered', name }); } };
    let round = 0;
    const sent: Array<Record<string, unknown>> = [];
    await withToolRounds({ input: [] }, value, async body => {
      sent.push(body);
      round += 1;
      return round === 1 ? { output: [functionCall('study.list', '{}', 'c1'), functionCall('folder_create', '{}', 'c2'), functionCall('study_list', '{}', 'c3')] } : { output: [message(TURN)] };
    }, { isAnswer: envelope => !functionCallsOf(envelope).length, outOfTime: () => 'out' });
    expect(tools.calls.map(call => call.name)).toEqual(['study_list']);
    expect(refused).toEqual(['study.list', 'folder_create']);
    const outputs = (sent[1]!.input as Array<Record<string, unknown>>).filter(item => item.type === 'function_call_output').map(item => JSON.parse(String(item.output)).failure);
    expect(outputs).toEqual(['not_offered', 'not_offered', undefined]);
  });

  it('offers the registry as functions, runs what the model asks for, and asks again with the result', async () => {
    const tools = session();
    const { fetcher, bodies } = scriptedFetch([
      { output: [functionCall('study_list', '{"kind":"note"}')], usage: { input_tokens: 10, output_tokens: 5 } },
      { output: [message(TURN)], usage: { input_tokens: 20, output_tokens: 8 } },
    ]);
    const model = new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher });
    const result = await model.generate({ ...base, tools: tools.value });
    expect(result.reply).toBe('書斎にメモが1つあります。');
    expect(tools.calls).toEqual([{ name: 'study_list', args: '{"kind":"note"}' }]);
    // A text turn may ask for several calls in one response (ADR-0003 stage 4); `chatModelToolStep.test.ts` holds the rest.
    expect(bodies[0]).toMatchObject({ tool_choice: 'auto', parallel_tool_calls: true });
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
    const result = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher }).generate({ ...base, tools: tools.value });
    expect(result.reply).toBe('書斎にメモが1つあります。');
    expect(tools.calls).toHaveLength(1);
    expect(bodies[0]!.tool_choice).toBe('auto');
    expect(bodies[1]!.tool_choice).toBe('none');
    // A provider that still answers the forced round with a call gives no usable answer: after a tool ran, that is her fixed
    // line and the turn is saved; nothing more runs.
    const stubborn = scriptedFetch([{ output: [functionCall('study_list')] }, { output: [functionCall('study_read', '{}', 'call-2')] }]);
    const counted = session(1);
    const ended = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher: stubborn.fetcher }).generate({ ...base, tools: counted.value });
    expect(ended).toMatchObject({ reply: TURN_OUT_OF_TIME_LINE, outOfTime: true });
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
    const envelope = await withToolRounds({ input: [] }, tools.value, async () => ({ output: [message(TURN), functionCall('study_list')] }), { isAnswer: () => true, outOfTime: () => 'out' });
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
    const result = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher }).generateVoiceStreaming(
      { ...base, useWebSearch: false, conversationClass: 'direct', tools: tools.value }, delta => { deltas.push(delta); });
    expect(deltas).toEqual(['ちょっと見てみるね。', 'メモが1つあります。']);
    expect(result.reply).toBe('ちょっと見てみるね。メモが1つあります。');
    expect(tools.calls).toHaveLength(1);
    expect(String(bodies[0]!.instructions)).toContain('ちょっと見てみますね');
    // A voice turn that searches the web offers no tools.
    const searching = scriptedFetch([sse([{ type: 'response.output_text.delta', delta: 'はい。' }, { type: 'response.completed', response: { output: [message('はい。')] } }])]);
    await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher: searching.fetcher }).generateVoiceStreaming(
      { ...base, useWebSearch: true, conversationClass: 'direct', tools: tools.value }, () => {});
    expect((searching.bodies[0]!.tools as Array<{ type: string }>).map(tool => tool.type)).toEqual(['web_search']);
  });
});

const sse = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const cutOff = (output: unknown[]) => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output });

describe('a write that does not fit one response', () => {
  it('never runs a call cut off at the output ceiling: the model is told once, and answers without tools', async () => {
    const tools = session();
    const { fetcher, bodies } = scriptedFetch([
      cutOff([{ ...functionCall('study_create', '{"kind":"story","title":"長い話","body":"むかしむかし'), status: 'incomplete' }]),
      { output: [message(TURN)] },
    ]);
    const result = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher }).generate({ ...base, tools: tools.value });
    expect(tools.calls).toEqual([]);
    expect(result.reply).toBe('書斎にメモが1つあります。');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.tool_choice).toBe('none');
    const input = bodies[1]!.input as Array<Record<string, unknown>>;
    expect(input.filter(item => item.content === CUT_OFF_CALL_NOTE)).toHaveLength(1);
    expect(input.some(item => item.type === 'function_call')).toBe(false);
  });

  it('keeps the first round ordinary, and a conversation\'s write short enough for its deadline; her own time keeps the larger limits', () => {
    expect(chatTurnRequestBody('gpt-5.6-luna', { ...base, tools: session().value }, undefined).max_output_tokens).toBe(2_200);
    for (const surface of ['text', 'voice'] as const) {
      const offered = new Map(offeredTools(surface, 'owner_alone').map(tool => [tool.name, tool]));
      expect(offered.get('study.create')!.input.properties.body).toMatchObject({ maxLength: CONVERSATION_WRITE_CHARACTERS });
      expect(offered.get('study.update')!.input.properties.body).toMatchObject({ maxLength: CONVERSATION_WRITE_CHARACTERS });
      expect(offered.get('folder.create')!.input.properties.content).toMatchObject({ maxLength: CONVERSATION_WRITE_CHARACTERS });
      expect(offered.get('folder.update')!.description).toContain('会話では1回に1,500字まで');
    }
    const own = new Map(offeredTools('autonomy', 'owner_alone').map(tool => [tool.name, tool]));
    expect(own.get('study.create')!.input.properties.body).toMatchObject({ maxLength: 4_000 });
    expect(own.get('folder.create')!.input.properties.content).toMatchObject({ maxLength: FOLDER_WRITE_CHARACTERS });
  });

  it('ends the whole turn inside its one deadline: rounds and calls take their time from it, and the answer keeps its reserve', async () => {
    let now = 0;
    const deadline = new TurnDeadline(TEXT_TURN_DEADLINE, () => now);
    now = 5_000; // Recall and the capability context came first: the deadline runs from the request's arrival.
    const timeouts: Array<number | undefined> = [];
    const choices: unknown[] = [];
    const callTimes: Array<number | undefined> = [];
    const slow: ShannonModelToolSession = {
      definitions: [shannonTool('folder.read')!], maximumCalls: 6, deadline,
      async call(_name, _args, _signal, time) { callTimes.push(time); now += 9_000; return JSON.stringify({ ok: true, text: '読んだ', retryable: false }); },
    };
    const responses = [{ output: [functionCall('folder_read', '{"path":"a.md"}')] }, { output: [functionCall('folder_read', '{"path":"b.md"}', 'call-2')] }, { output: [message(TURN)] }];
    const envelope = await withToolRounds({ input: [], max_output_tokens: 2_200 }, slow, async (body, time) => {
      timeouts.push(time?.milliseconds); choices.push(body.tool_choice);
      expect(body.max_output_tokens).toBe(2_200);
      now += 8_000;
      return responses.shift();
    }, { isAnswer: value => functionCallsOf(value).length === 0, outOfTime: () => 'out' });
    expect(envelope).toEqual({ output: [message(TURN)] });
    // Round 1 at 5 s: 30 s cap. Call at 13 s: 10 s cap. Round 2 at 22 s: min(20, 50-22-12=16). Call at 30 s: min(10, 8).
    expect(timeouts.slice(0, 2)).toEqual([30_000, 16_000]);
    expect(callTimes).toEqual([10_000, 8_000]);
    // At 39 s only the reserve is left (11 s < 4 s + 12 s): the answer, without tools, with all that is left.
    expect(choices).toEqual([undefined, undefined, 'none']);
    expect(timeouts[2]).toBe(11_000);
  });

  it('does not run a call once the answer\'s reserve is reached, and tells the model it was not run', async () => {
    let now = 0;
    const deadline = new TurnDeadline(TEXT_TURN_DEADLINE, () => now);
    const ran: string[] = [];
    const tight: ShannonModelToolSession = {
      definitions: [shannonTool('study.list')!, shannonTool('study.read')!], maximumCalls: 6, deadline,
      async call(name) { ran.push(name); now += 36_000; return JSON.stringify({ ok: true, text: 'x', retryable: false }); },
    };
    const inputs: unknown[][] = [];
    await withToolRounds({ input: [] }, tight, async body => {
      inputs.push(body.input as unknown[]);
      now += 2_000;
      return inputs.length === 1 ? { output: [functionCall('study_list'), functionCall('study_read', '{"id":"12345678"}', 'call-2')] } : { output: [message(TURN)] };
    }, { isAnswer: value => functionCallsOf(value).length === 0, outOfTime: () => 'out' });
    expect(ran).toEqual(['study_list']);
    const outputs = (inputs[1] as Array<Record<string, unknown>>).filter(item => item.type === 'function_call_output');
    expect(outputs[1]!.output).toBe(SKIPPED_FOR_TIME);
    expect(JSON.parse(SKIPPED_FOR_TIME).text).toContain('時間が足りず実行しなかった');
  });

  it('says the fixed line, and the turn is saved, when even the answer\'s reserve is gone or the answer fails after a tool ran', async () => {
    let now = 0;
    const deadline = new TurnDeadline(TEXT_TURN_DEADLINE, () => now);
    const starving: ShannonModelToolSession = {
      definitions: [shannonTool('study.list')!], maximumCalls: 6, deadline,
      async call() { now += 48_500; return JSON.stringify({ ok: true, text: 'x', retryable: false }); },
    };
    let sends = 0;
    const starved = await withToolRounds({ input: [] }, starving, async () => { sends += 1; return { output: [functionCall('study_list')] }; },
      { isAnswer: () => false, outOfTime: () => 'out-of-time' });
    expect(starved).toBe('out-of-time');
    expect(sends).toBe(1);
    // Through the text adapter: the turn ends with her plain line, as a whole structured turn.
    const timeouts = scriptedFetch([{ output: [functionCall('study_list')] }]);
    const failing = (async (url: string, init: { body: string; signal?: AbortSignal }) => {
      if (timeouts.bodies.length >= 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return timeouts.fetcher(url, init as never);
    }) as unknown as typeof fetch;
    const tools = session();
    const result = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher: failing }).generate({ ...base, tools: { ...tools.value, deadline: new TurnDeadline(TEXT_TURN_DEADLINE) } as ShannonModelToolSession });
    expect(result.reply).toBe(TURN_OUT_OF_TIME_LINE);
    expect(tools.calls).toHaveLength(1);
  });

  it('falls back to the answer without tools when a round that offers tools runs out of time', async () => {
    let first = true;
    const choices: unknown[] = [];
    const tools = session();
    const inputs: unknown[][] = [];
    const envelope = await withToolRounds({ input: [] }, { ...tools.value, deadline: new TurnDeadline(TEXT_TURN_DEADLINE) } as ShannonModelToolSession, async body => {
      choices.push(body.tool_choice); inputs.push(body.input as unknown[]);
      if (first) { first = false; throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }
      return { output: [message(TURN)] };
    }, { isAnswer: value => functionCallsOf(value).length === 0, outOfTime: () => 'out' });
    expect(envelope).toEqual({ output: [message(TURN)] });
    expect(choices).toEqual([undefined, 'none']);
    // The answer is told that whatever the round was about to call did not run.
    expect(inputs[1]).toContainEqual({ role: 'developer', content: TIMED_OUT_ROUND_NOTE });
  });

  it('in voice: the arguments of a call count as output for the first-word bound, and a cut-off call does not fail the turn', async () => {
    const tools = session();
    const { fetcher, bodies } = scriptedFetch([
      sse([
        { type: 'response.output_text.delta', delta: 'ちょっと書いてみるね。' },
        { type: 'response.function_call_arguments.delta', delta: '{"kind":"story"' },
        { type: 'response.incomplete', response: cutOff([message('ちょっと書いてみるね。'), functionCall('study_create', '{"kind":"story"')]) },
      ]),
      sse([
        { type: 'response.output_text.delta', delta: '長すぎたので、分けて書きます。' },
        { type: 'response.completed', response: { output: [message('長すぎたので、分けて書きます。')] } },
      ]),
    ]);
    const result = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher }).generateVoiceStreaming(
      { ...base, useWebSearch: false, conversationClass: 'direct', tools: tools.value }, () => {});
    expect(result.reply).toBe('ちょっと書いてみるね。長すぎたので、分けて書きます。');
    expect(tools.calls).toEqual([]);
    expect(bodies[0]!.max_output_tokens).toBe(VOICE_TOOL_OUTPUT_TOKENS);
    expect(bodies[1]!.tool_choice).toBe('none');
  });

  it('in voice: a stream that sends only call arguments for longer than the first-word bound is not cut off', async () => {
    const tools = session();
    const encoder = new TextEncoder();
    const slowFetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { tool_choice?: unknown };
      const events = body.tool_choice === 'none'
        ? [{ type: 'response.output_text.delta', delta: 'メモが1つあります。' }, { type: 'response.completed', response: { output: [message('メモが1つあります。')] } }]
        : [
          { type: 'response.function_call_arguments.delta', delta: '{' },
          { type: 'response.function_call_arguments.delta', delta: '}' },
          { type: 'response.completed', response: { output: [functionCall('study_list')] } },
        ];
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const event of events) {
            await new Promise(resolve => setTimeout(resolve, 40));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const model = new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher: slowFetch, voiceStreamBounds: { firstOutputMilliseconds: 60, idleMilliseconds: 1_000 } });
    const tooled = { ...tools.value, maximumCalls: 1 };
    const result = await model.generateVoiceStreaming({ ...base, useWebSearch: false, conversationClass: 'direct', tools: tooled }, () => {});
    expect(tools.calls).toHaveLength(1);
    expect(result.reply).toBe('メモが1つあります。');
  });
});

describe('a voice round that begins a call before she said anything', () => {
  it('says a fixed waiting phrase first, as ordinary words, so the phone hears her before the call is written', async () => {
    const tools = session();
    const { fetcher } = scriptedFetch([
      sse([
        { type: 'response.output_item.added', item: { type: 'function_call', name: 'study_list' } },
        { type: 'response.function_call_arguments.delta', delta: '{}' },
        { type: 'response.completed', response: { output: [functionCall('study_list')] } },
      ]),
      sse([{ type: 'response.output_text.delta', delta: 'メモが1つあります。' }, { type: 'response.completed', response: { output: [message('メモが1つあります。')] } }]),
    ]);
    const deltas: string[] = [];
    const result = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher }).generateVoiceStreaming(
      { ...base, useWebSearch: false, conversationClass: 'direct', tools: tools.value }, delta => { deltas.push(delta); });
    expect(deltas).toEqual(['ちょっと見てみますね。', 'メモが1つあります。']);
    expect(result.reply).toBe('ちょっと見てみますね。メモが1つあります。');
  });
});

describe('a provider that refuses the request offering her tools', () => {
  it('after a tool ran: keeps what the tools returned, as text, with a note, and offers no tools', async () => {
    const tools = session();
    const { fetcher, bodies } = scriptedFetch([{ output: [functionCall('study_list')] }, { status: 400 }, { output: [message(TURN)] }]);
    const original = console.warn;
    console.warn = () => {};
    try {
      const result = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher }).generate({ ...base, tools: tools.value });
      expect(result.reply).toBe('書斎にメモが1つあります。');
    } finally { console.warn = original; }
    expect(tools.calls).toHaveLength(1);
    expect(bodies[2]).not.toHaveProperty('tools');
    const input = bodies[2]!.input as Array<Record<string, unknown>>;
    expect(input.some(item => item.type === 'function_call' || item.type === 'function_call_output')).toBe(false);
    expect(input.some(item => String(item.content).startsWith('[道具の結果]') && String(item.content).includes('メモ「雨」'))).toBe(true);
    expect(input.at(-1)).toEqual({ role: 'developer', content: TOOLS_GONE_NOTE });
  });

  it('is asked once more without them, in text and in voice, and the code is logged', async () => {
    const lines: string[] = [];
    const tools = session();
    const text = scriptedFetch([{ status: 400 }, { output: [message(TURN)] }]);
    const original = console.warn;
    console.warn = (line: string) => { lines.push(line); };
    try {
      const result = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher: text.fetcher }).generate({ ...base, tools: tools.value });
      expect(result.reply).toBe('書斎にメモが1つあります。');
      expect(text.bodies[0]).toHaveProperty('tools');
      expect(text.bodies[1]).not.toHaveProperty('tools');
      expect(String(text.bodies[1]!.instructions)).not.toContain('[ボクの道具]');
      const voice = scriptedFetch([{ status: 422 }, sse([{ type: 'response.output_text.delta', delta: 'はい。' }, { type: 'response.completed', response: { output: [message('はい。')] } }])]);
      const spoken = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher: voice.fetcher }).generateVoiceStreaming(
        { ...base, useWebSearch: false, conversationClass: 'direct', tools: tools.value }, () => {});
      expect(spoken.reply).toBe('はい。');
      expect(voice.bodies[1]).not.toHaveProperty('tools');
      // Not for a rate limit: that is not about the tools.
      const limited = scriptedFetch([{ status: 429 }]);
      await expect(new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher: limited.fetcher }).generate({ ...base, tools: tools.value })).rejects.toThrow('OPENAI_RESPONSE_429');
      expect(limited.bodies).toHaveLength(1);
    } finally { console.warn = original; }
    expect(lines).toEqual(['Shannon tools offer refused by provider: 400', 'Shannon tools offer refused by provider: 422']);
    expect(tools.calls).toEqual([]);
  });
});

describe('silence in a voice turn with tools', () => {
  it('says a second fixed phrase when nothing has been heard for 15 s after the first, as ordinary words', async () => {
    let now = 0;
    const encoder = new TextEncoder();
    let round = 0;
    const fetcher = (async () => {
      round += 1;
      const events = round === 1
        ? [{ type: 'response.output_item.added', item: { type: 'function_call', name: 'study_list' } },
          { type: 'response.completed', response: { output: [functionCall('study_list')] } }]
        : [{ type: 'response.output_text.delta', delta: 'メモが1つあります。' }, { type: 'response.completed', response: { output: [message('メモが1つあります。')] } }];
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      } }), { status: 200 });
    }) as unknown as typeof fetch;
    const slowTool: ShannonModelToolSession = {
      definitions: [shannonTool('study.list')!], maximumCalls: 6, deadline: new TurnDeadline(VOICE_TURN_DEADLINE, () => now),
      async call() {
        // The tool takes long: the clock moves past the silence bound, and the ticker gets its turn.
        now += 16_000;
        await new Promise(resolve => setTimeout(resolve, 30));
        return JSON.stringify({ ok: true, text: 'x', retryable: false });
      },
    };
    const heard: string[] = [];
    const turn = await streamedVoiceToolTurn({
      fetcher, endpoint: 'https://example.invalid', apiKey: 'test', body: { input: [] }, plainBody: { input: [] }, tools: slowTool,
      bounds: { firstOutputMilliseconds: 1_000, idleMilliseconds: 1_000 }, onTextDelta: text => { heard.push(text); },
      onSpent: () => {}, onSpentWithoutReply: () => {}, clock: () => now, tickMilliseconds: 5,
    });
    expect(heard).toEqual(['ちょっと見てみますね。', VOICE_SECOND_PHRASE, 'メモが1つあります。']);
    expect(turn.reply).toBe(`ちょっと見てみますね。${VOICE_SECOND_PHRASE}メモが1つあります。`);
  });

  it('ends a voice turn whose answer cannot be had in time with the fixed line, never with a failure', async () => {
    let now = 0;
    const encoder = new TextEncoder();
    const fetcher = (async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const event of [{ type: 'response.output_item.added', item: { type: 'function_call', name: 'study_create' } },
        { type: 'response.completed', response: { output: [functionCall('study_create', '{}')] } }]) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    } }), { status: 200 })) as unknown as typeof fetch;
    const committing: ShannonModelToolSession = {
      definitions: [shannonTool('study.create')!], maximumCalls: 6, deadline: new TurnDeadline(VOICE_TURN_DEADLINE, () => now),
      async call() { now += 37_000; return JSON.stringify({ ok: true, text: '書いた', retryable: false }); },
    };
    const heard: string[] = [];
    const turn = await streamedVoiceToolTurn({
      fetcher, endpoint: 'https://example.invalid', apiKey: 'test', body: { input: [] }, plainBody: { input: [] }, tools: committing,
      bounds: { firstOutputMilliseconds: 1_000, idleMilliseconds: 1_000 }, onTextDelta: text => { heard.push(text); },
      onSpent: () => {}, onSpentWithoutReply: () => {}, clock: () => now, tickMilliseconds: 1_000,
    });
    expect(heard).toEqual(['ちょっと書いてみますね。', TURN_OUT_OF_TIME_LINE]);
    expect(turn.reply).toBe(`ちょっと書いてみますね。${TURN_OUT_OF_TIME_LINE}`);
  });
});

describe('an answer under way is never cut at a step\'s time and asked again', () => {
  const encoder = new TextEncoder();
  /** A stream of events, then either an end or a stall that only an abort ends. */
  const stream = (events: unknown[], stall: boolean, before?: () => void) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      before?.();
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      if (!stall) controller.close();
    },
  }), { status: 200 });

  it('streamed text: a round that sent reply text and then ran out stands, cut where its sentences were sent, and the line follows', async () => {
    let now = 0;
    let round = 0;
    const fetcher = (async () => {
      round += 1;
      if (round === 1) return stream([{ type: 'response.completed', response: { output: [functionCall('study_list')] } }], false);
      // The answer starts; then the turn's clock is nearly spent, and the provider stalls.
      return stream([{ type: 'response.output_text.delta', delta: '{"reply":"一文目です。二文目は途' }], true, () => { now = TEXT_TURN_DEADLINE.totalMilliseconds - 150; });
    }) as unknown as typeof fetch;
    const tools = session();
    const sent: string[] = [];
    const splitter = new ChatSentenceSplitter();
    const result = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher }).generateStreaming(
      { ...base, tools: { ...tools.value, deadline: new TurnDeadline(TEXT_TURN_DEADLINE, () => now) } as ShannonModelToolSession },
      text => { sent.push(...splitter.append(text)); });
    expect(round).toBe(2);
    expect(sent).toEqual(['一文目です。']);
    expect(result).toMatchObject({ reply: `一文目です。${TURN_OUT_OF_TIME_LINE}`, outOfTime: true });
    // What the client was sent is the start of the finished reply, sentence for sentence (no EarlyLinesDiffer).
    expect(splitChatSentences(result.reply).slice(0, sent.length)).toEqual(sent);
  });

  it('voice: words already spoken stand; the line follows; nothing is said twice', async () => {
    let now = 0;
    let round = 0;
    const fetcher = (async () => {
      round += 1;
      if (round === 1) return stream([{ type: 'response.completed', response: { output: [functionCall('study_list')] } }], false);
      return stream([{ type: 'response.output_text.delta', delta: 'メモは1つです。それは' }], true, () => { now = VOICE_TURN_DEADLINE.totalMilliseconds - 150; });
    }) as unknown as typeof fetch;
    const tools = session();
    const heard: string[] = [];
    const turn = await streamedVoiceToolTurn({
      fetcher, endpoint: 'https://example.invalid', apiKey: 'test', body: { input: [] }, plainBody: { input: [] },
      tools: { ...tools.value, deadline: new TurnDeadline(VOICE_TURN_DEADLINE, () => now) } as ShannonModelToolSession,
      bounds: { firstOutputMilliseconds: 5_000, idleMilliseconds: 5_000 }, onTextDelta: text => { heard.push(text); },
      onSpent: () => {}, onSpentWithoutReply: () => {}, clock: () => now, tickMilliseconds: 1_000,
    });
    expect(round).toBe(2);
    // Round 1 called a tool without a word: the waiting phrase came first. Then her answer, and the line; nothing twice.
    expect(heard).toEqual(['メモは1つです。それは', TURN_OUT_OF_TIME_LINE]);
    expect(turn.reply).toBe(`メモは1つです。${TURN_OUT_OF_TIME_LINE}`);
  });

  it('non-streaming voice (the body\'s /delegations): after a tool ran, an empty answer is the fixed line, and the turn is saved', async () => {
    const tools = session();
    const { fetcher, bodies } = scriptedFetch([{ output: [functionCall('study_list')] }, { output: [] }]);
    const result = await new OpenAIResponsesChatModel({ model: 'gpt-5.6-luna', apiKey: 'test', fetcher }).generateVoice({ ...base, useWebSearch: false, conversationClass: 'direct', tools: tools.value });
    expect(result.reply).toBe(TURN_OUT_OF_TIME_LINE);
    expect(bodies).toHaveLength(2);
    expect(tools.calls).toHaveLength(1);
  });
});

describe('the second waiting phrase after her own lead-in', () => {
  it('is said after 15 s of silence when a call began, also when she spoke her own lead-in first', async () => {
    let now = 0;
    const encoder = new TextEncoder();
    let round = 0;
    const fetcher = (async () => {
      round += 1;
      const events = round === 1
        ? [{ type: 'response.output_text.delta', delta: '見てみますね。' }, { type: 'response.output_item.added', item: { type: 'function_call', name: 'study_list' } },
          { type: 'response.completed', response: { output: [message('見てみますね。'), functionCall('study_list')] } }]
        : [{ type: 'response.output_text.delta', delta: 'メモが1つあります。' }, { type: 'response.completed', response: { output: [message('メモが1つあります。')] } }];
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      } }), { status: 200 });
    }) as unknown as typeof fetch;
    const slowTool: ShannonModelToolSession = {
      definitions: [shannonTool('study.list')!], maximumCalls: 6, deadline: new TurnDeadline(VOICE_TURN_DEADLINE, () => now),
      async call() { now += 16_000; await new Promise(resolve => setTimeout(resolve, 30)); return JSON.stringify({ ok: true, text: 'x', retryable: false }); },
    };
    const heard: string[] = [];
    await streamedVoiceToolTurn({
      fetcher, endpoint: 'https://example.invalid', apiKey: 'test', body: { input: [] }, plainBody: { input: [] }, tools: slowTool,
      bounds: { firstOutputMilliseconds: 1_000, idleMilliseconds: 1_000 }, onTextDelta: text => { heard.push(text); },
      onSpent: () => {}, onSpentWithoutReply: () => {}, clock: () => now, tickMilliseconds: 5,
    });
    expect(heard).toEqual(['見てみますね。', VOICE_SECOND_PHRASE, 'メモが1つあります。']);
  });
});

describe('one waiting phrase a spoken turn (2026-10-13)', () => {
  it('tells an announcement of a look from an answer', () => {
    for (const said of ['ちょっと調べてみますね、ライ氏。', '少し確認してみますね。', 'ライ氏、ちょっと見てきますね！', 'うん、書いてみますね。']) {
      expect(isWaitingAnnouncement(said), said).toBe(true);
    }
    for (const said of ['書斎にメモが1つありますね。', '調べてみたら晴れでしたね。', '16時半ごろ出れば余裕です。', 'それなら明日一緒に見てみますね、映画の話の続きも楽しみです。']) {
      expect(isWaitingAnnouncement(said), said).toBe(false);
    }
  });

  it('holds the first sentence after a call, drops a repeated announcement and passes everything else unchanged', () => {
    const echo = new VoiceWaitingEcho();
    expect(echo.take('先に')).toBe('先に');
    echo.arm();
    expect(echo.take('ちょっと調べて')).toBe('');
    expect(echo.take('みますね、ライ氏。メモが')).toBe('メモが');
    expect(echo.take('1つあります。')).toBe('1つあります。');
    echo.arm();
    expect(echo.take('晴れです。')).toBe('晴れです。');
    echo.arm();
    expect(echo.take('見てみますね')).toBe('');
    expect(echo.flush()).toBe('');
  });
});
