import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalApiKernel, type ShannonApiKernelOptions } from '../src/apiKernel.js';
import { OpenAIResponsesChatModel, type ShannonChatModel, type ShannonChatModelRequest, type ShannonChatModelResult } from '../src/chatModel.js';
import { chatStreamEarlyEnabled } from '../src/chatSentenceStream.js';
import type { ChatResponse, ChatStreamLine } from '../src/contracts.js';
import { dispatchWithChatSentences } from '../src/serverChatSentenceStream.js';
import { readJson, sendJson } from '../src/serverHttp.js';
import { fixtureNotionSource } from './notionFixture.js';

const at = '2026-10-02T03:00:00.000Z';
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

/** A model whose stream the test holds open: `early` is written, then it waits for `release`. */
class GatedModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  early = ['最初の文です。次の', '文です。\n最後'];
  late = ['の文'];
  reply = '最初の文です。次の文です。\n最後の文';
  extra: Partial<ShannonChatModelResult> = {};
  failure: Error | null = null;
  generateCalls = 0;
  streamingRequests: ShannonChatModelRequest[] = [];
  finished = false;
  release!: () => void;
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });

  async generate(): Promise<ShannonChatModelResult> {
    this.generateCalls += 1;
    this.finished = true;
    return { mode: this.mode, model: this.model, reply: this.reply, ...this.extra };
  }

  async generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    this.streamingRequests.push(request);
    for (const text of this.early) await onReplyText(text);
    await this.gate;
    if (this.failure) throw this.failure;
    for (const text of this.late) await onReplyText(text);
    this.finished = true;
    return { mode: this.mode, model: this.model, reply: this.reply, ...this.extra };
  }
}

function setup(model: ShannonChatModel, options: ShannonApiKernelOptions = {}, environment: Record<string, string> = {}) {
  const api = createLocalApiKernel(() => at, { chatModel: model, ...options });
  // The generic route of `server.ts`, with its catch.
  const server = createServer(async (request, response) => {
    try {
      const body = await readJson(request, 64 * 1024);
      const result = await dispatchWithChatSentences(api, response, { method: 'POST', path: request.url ?? '/', body }, environment);
      if (result) sendJson(response, result.status, result.body);
    } catch {
      sendJson(response, 502, { error: 'MODEL_UNAVAILABLE' });
    }
  });
  const ready = new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => { server.closeAllConnections(); server.close(); });
  const conversation = async () => ((await api.dispatch({ method: 'GET', path: '/v1/conversation',
    query: new URLSearchParams({ scopeKey: 'owner', threadId: 'thread' }) })).body as { messages: Array<{ content: string }> }).messages.map(message => message.content);

  /** Sends one chat request and hands out its lines one at a time, as they arrive. */
  const open = async (extra: Record<string, unknown> = {}) => {
    await ready;
    const lines: ChatStreamLine[] = [];
    const waiting: Array<(line: ChatStreamLine | null) => void> = [];
    let ended = false;
    let status = 0;
    let contentType = '';
    let raw = '';
    let pending = '';
    const outgoing = httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/v1/chat', method: 'POST',
      headers: { 'content-type': 'application/json' } }, incoming => {
      status = incoming.statusCode ?? 0;
      contentType = String(incoming.headers['content-type']);
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => {
        raw += chunk;
        if (!contentType.startsWith('application/x-ndjson')) return;
        pending += chunk;
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        for (const part of parts) {
          const line = JSON.parse(part) as ChatStreamLine;
          const waiter = waiting.shift();
          if (waiter) waiter(line); else lines.push(line);
        }
      });
      const finish = () => { ended = true; for (const waiter of waiting.splice(0)) waiter(null); };
      incoming.on('end', finish);
      incoming.on('close', finish);
    });
    outgoing.on('error', () => { ended = true; for (const waiter of waiting.splice(0)) waiter(null); });
    outgoing.end(JSON.stringify({ scopeKey: 'owner', threadId: 'thread', message: '聞こえてる？', stream: 'sentences', ...extra }));
    const next = (): Promise<ChatStreamLine | null> => {
      const line = lines.shift();
      if (line) return Promise.resolve(line);
      if (ended) return Promise.resolve(null);
      return new Promise(resolve => { waiting.push(resolve); });
    };
    const rest = async (): Promise<ChatStreamLine[]> => {
      const all: ChatStreamLine[] = [];
      for (let line = await next(); line; line = await next()) all.push(line);
      return all;
    };
    return { next, rest, hangUp: () => outgoing.destroy(), response: () => ({ status, contentType, raw }) };
  };
  return { api, open, conversation };
}

const text = (lines: readonly ChatStreamLine[]) => lines.flatMap(line => (line.type === 'sentence' ? [line.text] : [])).join('');

describe('stream: sentences while the model writes', () => {
  it('delivers the first sentences before the model has finished, then the rest and done', async () => {
    const model = new GatedModel();
    const { open, conversation } = setup(model);
    const stream = await open();

    const start = await stream.next();
    const first = await stream.next();
    // The ordering proof: these lines are in the client's hands while the model call is still open.
    expect(model.finished).toBe(false);
    expect(start).toEqual({ type: 'start', threadId: 'thread', audience: 'owner' });
    expect(first).toEqual({ type: 'sentence', index: 0, text: '最初の文です。' });
    expect(await stream.next()).toEqual({ type: 'sentence', index: 1, text: '次の文です。\n' });
    expect(model.finished).toBe(false);
    expect(await conversation()).toEqual([]);

    model.release();
    const rest = await stream.rest();
    expect(rest.map(line => line.type)).toEqual(['sentence', 'done']);
    expect(rest[0]).toEqual({ type: 'sentence', index: 2, text: '最後の文' });
    const done = rest[1] as { response: ChatResponse };
    expect(done).not.toHaveProperty('fallback');
    expect(text([first!, { type: 'sentence', index: 1, text: '次の文です。\n' }, ...rest])).toBe(done.response.reply);
    // The turn id is known only once the turn is stored: it is in done, not in an early start.
    expect(done.response.turnId).toEqual(expect.any(String));
    expect(model.generateCalls).toBe(0);
    expect(await conversation()).toEqual(['聞こえてる？', model.reply]);
  });

  it('gives the model the request it gives without stream, and the same response object', async () => {
    const streamedModel = new GatedModel();
    streamedModel.release();
    const streamed = setup(streamedModel);
    const done = (await (await streamed.open()).rest()).at(-1) as { response: ChatResponse };

    const plainModel = new GatedModel();
    const plain = (await setup(plainModel).api.dispatch({ method: 'POST', path: '/v1/chat',
      body: { scopeKey: 'owner', threadId: 'thread', message: '聞こえてる？' } })).body as ChatResponse;
    expect(plainModel.streamingRequests).toEqual([]);
    expect(plainModel.generateCalls).toBe(1);
    expect({ ...done.response, turnId: '' }).toEqual(JSON.parse(JSON.stringify({ ...plain, turnId: '' })));
    expect(streamedModel.streamingRequests).toHaveLength(1);
  });

  it('retracts: a turn rejected after sentences were sent ends with error and stores nothing', async () => {
    const model = new GatedModel();
    model.failure = new Error('OPENAI_RESPONSE_SCHEMA_INVALID');
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { open, conversation } = setup(model);
    const stream = await open();
    expect((await stream.next())?.type).toBe('start');
    expect((await stream.next())?.type).toBe('sentence');
    model.release();
    const rest = await stream.rest();
    expect(rest.at(-1)).toEqual({ type: 'error', status: 502, error: 'MODEL_UNAVAILABLE' });
    expect(rest.some(line => line.type === 'done')).toBe(false);
    expect(await conversation()).toEqual([]);
    // The log names the error class only.
    expect(failed.mock.calls).toEqual([['Shannon request failed', 'Error']]);
    failed.mockRestore();
  });

  it('answers a turn that fails before any sentence with the plain error response', async () => {
    const model = new GatedModel();
    model.early = [];
    model.failure = new Error('OPENAI_RESPONSE_500');
    model.release();
    const { open, conversation } = setup(model);
    const stream = await open();
    expect(await stream.rest()).toEqual([]);
    expect(stream.response()).toMatchObject({ status: 502, contentType: 'application/json; charset=utf-8' });
    expect(await conversation()).toEqual([]);
  });

  it('completes and stores the turn when the reader hangs up mid-stream', async () => {
    const model = new GatedModel();
    const { open, conversation } = setup(model);
    const stream = await open();
    await stream.next();
    await stream.next();
    stream.hangUp();
    await new Promise(resolve => setTimeout(resolve, 20));
    model.release();
    await vi.waitFor(async () => expect(await conversation()).toEqual(['聞こえてる？', model.reply]));
    // The next turn is answered.
    const again = new GatedModel();
    again.release();
    expect((await (await setup(again).open()).rest()).at(-1)?.type).toBe('done');
  });

  it('ends with error when what was sent early is not how the finished reply begins', async () => {
    const model = new GatedModel();
    model.reply = '別の文です。まったく違います。';
    model.late = [];
    model.release();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lines = await (await setup(model).open()).rest();
    expect(lines.at(-1)).toEqual({ type: 'error', status: 502, error: 'STREAM_FAILED' });
    expect(lines.some(line => line.type === 'done')).toBe(false);
    expect(warned.mock.calls).toEqual([['Shannon chat sentence stream failed', { name: 'EarlyLinesDiffer' }]]);
    warned.mockRestore();
  });
});

describe('turns that are not sent while the model writes', () => {
  /** Runs one opted-in turn with the model held open and reports whether anything arrived before it finished. */
  async function run(extra: Record<string, unknown>, options: ShannonApiKernelOptions = {}, environment: Record<string, string> = {}) {
    const model = new GatedModel();
    model.release();
    const { open } = setup(model, options, environment);
    const lines = await (await open(extra)).rest();
    return { model, lines };
  }

  it.each([
    ['other people can see the reply', { audience: 'others' }, {}, ['start', 'sentence', 'sentence', 'sentence', 'done'], undefined],
    ['a Notion page was read', { message: 'ウサカテのシナリオを読んで' }, { notion: fixtureNotionSource().source }, ['done'], 'sources'],
    ['attachments', { attachments: [{ name: 'notes.md', mimeType: 'text/markdown', text: '本文' }] }, {}, ['done'], 'attachments'],
    ['web search', { webSearch: true }, {}, ['done'], 'web_search'],
    ['place search', { message: '浜松駅の近くの公園を地図で探して' }, {}, ['done'], 'place_search'],
    ['an explicit command', { message: '写真整理をタスクにして' }, {}, ['done'], 'command'],
  ] as const)('when %s', async (_name, extra, options, types, fallback) => {
    const { model, lines } = await run(extra, options as ShannonApiKernelOptions);
    expect(model.streamingRequests).toEqual([]);
    expect(lines.map(line => line.type)).toEqual(types);
    const done = lines.at(-1) as { response: ChatResponse; fallback?: string };
    expect(done.fallback).toBe(fallback);
    if (!fallback) {
      expect(text(lines)).toBe(done.response.reply);
      // Sent after the turn was complete, so start already carries the turn id.
      expect(lines[0]).toMatchObject({ type: 'start', turnId: done.response.turnId });
    }
  });

  // Notes and tasks are read before the model call and do not change the reply text (owner decision 2026-10-02).
  it.each([
    ['an Aether note was read', {}, { aetherContext: { promptFor: () => '[Aether note projection] メモ本文' } }],
    ['a Voyager task was read', { message: 'シャノンのタスクを見せて' }, { voyagerCatalog: { searchTasks: async () => [], listProjects: async () => [] } as never }],
  ] as const)('still sends the turn while the model writes when %s', async (_name, extra, options) => {
    const { model, lines } = await run(extra, options as ShannonApiKernelOptions);
    expect(model.streamingRequests).toHaveLength(1);
    expect(lines.map(line => line.type)).toEqual(['start', 'sentence', 'sentence', 'sentence', 'done']);
    expect(text(lines)).toBe((lines.at(-1) as { response: ChatResponse }).response.reply);
  });

  it('holds an others turn back until the model has finished', async () => {
    const model = new GatedModel();
    let reached = false;
    model.generate = async () => { reached = true; await new Promise<void>(resolve => { model.release = resolve; }); model.finished = true; return { mode: 'openai', model: 'test-model', reply: model.reply }; };
    const { open } = setup(model);
    const stream = await open({ audience: 'others' });
    const first = stream.next();
    await vi.waitFor(() => expect(reached).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 20));
    // Nothing has been written while the model is still working.
    expect(stream.response()).toEqual({ status: 0, contentType: '', raw: '' });
    model.release();
    expect(await first).toMatchObject({ type: 'start', audience: 'others' });
    expect(model.finished).toBe(true);
    expect(model.streamingRequests).toEqual([]);
  });

  it('SHANNON_CHAT_STREAM_EARLY=off sends every turn after it is complete', async () => {
    for (const value of ['off', 'OFF', 'false', '0', 'disabled']) expect(chatStreamEarlyEnabled({ SHANNON_CHAT_STREAM_EARLY: value })).toBe(false);
    for (const value of [undefined, '', 'on', 'true']) expect(chatStreamEarlyEnabled({ SHANNON_CHAT_STREAM_EARLY: value })).toBe(true);

    const off = await run({}, {}, { SHANNON_CHAT_STREAM_EARLY: 'off' });
    expect(off.model.streamingRequests).toEqual([]);
    expect(off.model.generateCalls).toBe(1);
    const on = await run({});
    expect(on.model.streamingRequests).toHaveLength(1);
    // The reader sees the same lines either way, except that the early start has no turn id yet.
    const strip = (lines: ChatStreamLine[]) => JSON.parse(JSON.stringify(lines).replace(/"turnId":"[^"]+",?/gu, ''));
    expect(strip(off.lines)).toEqual(strip(on.lines));
  });

  it('a model that cannot stream is answered as stage 1', async () => {
    const model = new GatedModel();
    (model as { generateStreaming?: unknown }).generateStreaming = undefined;
    const { open } = setup(model);
    const lines = await (await open()).rest();
    expect(lines.map(line => line.type)).toEqual(['start', 'sentence', 'sentence', 'sentence', 'done']);
    expect(model.generateCalls).toBe(1);
  });
});

describe('the provider adapter under the sentence stream', () => {
  const turn = { reply: ' \n はい、聞こえています🎉。\n\n「元気？」と\\聞きましたね。 \n', threadSummary: null,
    taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null };
  const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;

  function provider(json: string, pieceLength: number) {
    const bodies: string[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (!JSON.parse(String(init?.body)).stream) return new Response(JSON.stringify({ output_text: json, usage: { input_tokens: 9, output_tokens: 5 } }));
      const events: string[] = [];
      for (let index = 0; index < json.length; index += pieceLength) events.push(sse({ type: 'response.output_text.delta', delta: json.slice(index, index + pieceLength) }));
      events.push(sse({ type: 'response.completed', response: { output_text: json, usage: { input_tokens: 9, output_tokens: 5 } } }));
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(events.join(''))); controller.close(); } }));
    }) as typeof fetch;
    return { model: new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher, now: () => at }), bodies };
  }

  it('sentences join to the trimmed reply for every way the provider cuts the completion', async () => {
    const json = JSON.stringify(turn);
    const plain = (await setup(provider(json, 1).model).api.dispatch({ method: 'POST', path: '/v1/chat',
      body: { scopeKey: 'owner', threadId: 'thread', message: '聞こえてる？' } })).body as ChatResponse;
    expect(plain.reply).toBe(turn.reply.trim());
    for (const pieceLength of [1, 2, 3, 5, 8, 13, json.length]) {
      const { model, bodies } = provider(json, pieceLength);
      const lines = await (await setup(model).open()).rest();
      expect(lines.map(line => line.type), `pieces of ${pieceLength}`).toEqual(['start', 'sentence', 'sentence', 'done']);
      expect(lines[0]).not.toHaveProperty('turnId');
      const done = lines.at(-1) as { response: ChatResponse };
      expect(text(lines)).toBe(done.response.reply);
      expect(done.response.reply).toBe(plain.reply);
      expect({ ...done.response, turnId: '' }).toEqual(JSON.parse(JSON.stringify({ ...plain, turnId: '' })));
      expect(JSON.parse(bodies[0]!).stream).toBe(true);
    }
  });
});
