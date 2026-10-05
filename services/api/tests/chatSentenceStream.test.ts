import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalApiKernel, type ShannonApiKernel } from '../src/apiKernel.js';
import { BackgroundUpdateCoordinator } from '../src/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/chatModel.js';
import { CHAT_SENTENCE_MAXIMUM_LENGTH } from '../src/chatSentenceSplitter.js';
import { chatSentenceStreamLines } from '../src/chatSentenceStream.js';
import type { ApiResponse, ChatResponse, ChatStreamLine } from '../src/contracts.js';
import { ShannonMemoryService } from '../src/memoryService.js';
import { dispatchWithChatSentences } from '../src/serverChatSentenceStream.js';
import { readJson, sendJson } from '../src/serverHttp.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import { fixtureNotionSource } from './notionFixture.js';
import { promptOf } from './modelPrompt.js';

const at = '2026-10-02T03:00:00.000Z';
const REPLY = 'はい、聞こえています。\n\n「元気？うん！」と言いましたね。続きは https://example.com/a?b=1 です🎉！最後';
const directories: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class ScriptedModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  extra: Partial<ShannonChatModelResult> = {};
  /** When set, the reply repeats everything the model was given. */
  echo = false;
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    const reply = this.echo ? JSON.stringify([promptOf(request), request.history, request.priorThreadSummary ?? '']) : REPLY;
    return { mode: this.mode, model: this.model, reply, ...this.extra };
  }
}

function chatBody(extra: Record<string, unknown> = {}) {
  return { scopeKey: 'owner', threadId: 'thread', message: '聞こえてる？', ...extra };
}

async function dispatchChat(api: ShannonApiKernel, extra: Record<string, unknown> = {}): Promise<ApiResponse> {
  return api.dispatch({ method: 'POST', path: '/v1/chat', body: chatBody(extra) });
}

/** The response with the random identifiers a second kernel cannot repeat replaced. */
function comparable(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<uuid>')
    .replace(/\b[0-9a-f]{64}\b/gu, '<digest>'));
}

function sentenceText(lines: readonly ChatStreamLine[]): string {
  return lines.flatMap(line => (line.type === 'sentence' ? [line.text] : [])).join('');
}

/** A kernel that has already answered: what the HTTP layer does with a finished response. */
function answered(result: ApiResponse) {
  return { dispatch: async () => result };
}

/** The same call `server.ts` makes. */
async function listen(api: ShannonApiKernel): Promise<string> {
  const server = createServer(async (request, response) => {
    const body = await readJson(request, 64 * 1024);
    const result = await dispatchWithChatSentences(api, response, { method: 'POST', path: request.url ?? '/', body });
    if (result) sendJson(response, result.status, result.body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(origin: string, body: unknown): Promise<{ status: number; contentType: string; headers: Headers; text: string }> {
  const response = await fetch(`${origin}/v1/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', headers: response.headers, text: await response.text() };
}

function parsedLines(text: string): ChatStreamLine[] {
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n').map(line => JSON.parse(line) as ChatStreamLine);
}

describe('POST /v1/chat without stream', () => {
  it('returns the object it returned before the field existed', async () => {
    const plain = await dispatchChat(createLocalApiKernel(() => at, { chatModel: new ScriptedModel() }));
    expect(Object.keys(plain).sort()).toEqual(['body', 'status']);

    const model = new ScriptedModel();
    const streamed = await dispatchChat(createLocalApiKernel(() => at, { chatModel: model }), { stream: 'sentences' });
    expect(comparable(streamed.body)).toEqual(comparable(plain.body));
    // The model is asked the same thing either way.
    const plainModel = new ScriptedModel();
    await dispatchChat(createLocalApiKernel(() => at, { chatModel: plainModel }));
    expect(model.requests).toEqual(plainModel.requests);
  });

  it('is sent as one JSON document over HTTP, byte for byte the kernel body', async () => {
    const api = createLocalApiKernel(() => at, { chatModel: new ScriptedModel() });
    const origin = await listen(api);
    const response = await post(origin, chatBody());
    expect(response.contentType).toBe('application/json; charset=utf-8');
    const body = JSON.parse(response.text) as ChatResponse;
    expect(body.reply).toBe(REPLY);
    const again = await dispatchChat(createLocalApiKernel(() => at, { chatModel: new ScriptedModel() }));
    expect(response.text.replace(body.turnId!, '<id>')).toBe(JSON.stringify(again.body).replace((again.body as ChatResponse).turnId!, '<id>'));
  });

  it('refuses an unknown stream value before a model is called', async () => {
    const model = new ScriptedModel();
    const api = createLocalApiKernel(() => at, { chatModel: model });
    for (const stream of ['tokens', true, '', null]) {
      expect(await dispatchChat(api, { stream })).toMatchObject({ status: 400 });
    }
    expect(model.requests).toHaveLength(0);
    // A refused request is plain JSON even though it asked for a stream.
    const response = await post(await listen(api), chatBody({ stream: 'sentences', audience: 'everyone' }));
    expect(response.status).toBe(400);
    expect(response.contentType).toBe('application/json; charset=utf-8');
  });
});

describe('POST /v1/chat with stream: sentences', () => {
  it('sends start, the sentences in order, and done with the non-streaming object', async () => {
    const api = createLocalApiKernel(() => at, { chatModel: new ScriptedModel() });
    const response = await post(await listen(api), chatBody({ stream: 'sentences' }));
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('application/x-ndjson; charset=utf-8');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const lines = parsedLines(response.text);
    const done = lines.at(-1) as Extract<ChatStreamLine, { type: 'done' }>;
    const body = done.response as ChatResponse;
    expect(lines[0]).toEqual({ type: 'start', threadId: 'thread', turnId: body.turnId, audience: 'owner' });
    expect(lines.slice(1, -1)).toEqual([
      { type: 'sentence', index: 0, text: 'はい、聞こえています。\n\n' },
      { type: 'sentence', index: 1, text: '「元気？うん！」と言いましたね。' },
      { type: 'sentence', index: 2, text: '続きは https://example.com/a?b=1 です🎉！' },
      { type: 'sentence', index: 3, text: '最後' },
    ]);
    // The equality rule: the sentence texts joined with nothing between them are `reply`.
    expect(sentenceText(lines)).toBe(body.reply);
    expect(body.reply).toBe(REPLY);
    expect(done).not.toHaveProperty('fallback');

    const plain = await dispatchChat(createLocalApiKernel(() => at, { chatModel: new ScriptedModel() }));
    expect(comparable(body)).toEqual(comparable(plain.body));
    // The turn is the one stored: the conversation holds the same reply.
    const stored = await api.dispatch({ method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: 'owner', threadId: 'thread' }) });
    expect((stored.body as { messages: Array<{ role: string; content: string }> }).messages.map(message => message.content)).toEqual(['聞こえてる？', REPLY]);
  });

  it('streams a turn that carries an artifact or a work proposal and keeps them in done', async () => {
    const model = new ScriptedModel();
    model.extra = {
      artifacts: [{ name: 'memo.md', mimeType: 'text/markdown', content: '# メモ' }],
      taskProposal: { title: 'ログイン修正', goal: 'ログイン画面を修正する', projectHint: 'shannon-ios' },
    };
    const lines = chatSentenceStreamLines(await dispatchChat(createLocalApiKernel(() => at, { chatModel: model }), { stream: 'sentences' }));
    const body = (lines.at(-1) as { response: ChatResponse }).response;
    expect(lines[0]?.type).toBe('start');
    expect(sentenceText(lines)).toBe(body.reply);
    expect(body.artifacts).toEqual(model.extra.artifacts);
    expect(body.uiBlocks?.map(block => block.type)).toEqual(['agent_task_proposal']);
  });

  it.each([
    ['an explicit command', { message: '写真整理をタスクにして' }, 'command'],
    ['an organize turn', { message: '整理して' }, 'command'],
    ['attachments', { attachments: [{ name: 'notes.md', mimeType: 'text/markdown', text: '本文' }] }, 'attachments'],
    ['web search', { webSearch: true }, 'web_search'],
    ['place search', { message: '浜松駅の近くの公園を地図で探して' }, 'place_search'],
    ['a reply with a source list', { message: 'ウサカテのシナリオを読んで' }, 'sources'],
  ] as const)('answers %s with a single done line', async (_name, extra, fallback) => {
    const build = () => {
      const model = new ScriptedModel();
      model.extra = { webSources: [{ title: '出典', url: 'https://example.com/source' }] };
      return createLocalApiKernel(() => at, { chatModel: model, notion: fixtureNotionSource().source });
    };
    const result = await dispatchChat(build(), { ...extra, stream: 'sentences' });
    expect(result.status).toBe(200);
    const lines = chatSentenceStreamLines(result);
    expect(lines).toEqual([{ type: 'done', response: result.body, fallback }]);
    const plain = await dispatchChat(build(), extra);
    expect(comparable(JSON.parse(JSON.stringify(lines[0])).response)).toEqual(comparable(plain.body));
  });

  it('keeps a source list out of the sentences: such a reply is never cut', async () => {
    const model = new ScriptedModel();
    model.extra = { webSources: [{ title: '出典', url: 'https://example.com/source' }] };
    const result = await dispatchChat(createLocalApiKernel(() => at, { chatModel: model }), { webSearch: true, stream: 'sentences' });
    expect((result.body as ChatResponse).reply).toContain('### 参照した情報源');
    expect(chatSentenceStreamLines(result).map(line => line.type)).toEqual(['done']);
  });
});

describe('docs/chat-stream-contract.md', () => {
  it('names every line type and every fallback the code can send', () => {
    const document = readFileSync(new URL('../../../docs/chat-stream-contract.md', import.meta.url), 'utf8');
    for (const word of ['"stream": "sentences"', '`start`', '`sentence`', '`done`', '`error`', 'STREAM_FAILED',
      '`command`', '`attachments`', '`web_search`', '`place_search`', '`sources`', 'MODEL_UNAVAILABLE', 'SHANNON_CHAT_STREAM_EARLY', 'discard every sentence', `${CHAT_SENTENCE_MAXIMUM_LENGTH} UTF-16 units`]) {
      expect(document, word).toContain(word);
    }
    for (const example of ['../../../.env.example', '../../../deploy/azure/api.env.example']) {
      expect(readFileSync(new URL(example, import.meta.url), 'utf8')).toContain('SHANNON_CHAT_STREAM_EARLY=on');
    }
  });
});

/** Words that exist only in hard-withheld content: a secret, and an item the owner marked 機微 by hand. */
const HARD = ['ウォンバット会', 'アルマジロ'];

async function seeded() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-chat-stream-'));
  directories.push(directory);
  const store = new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => at });
  closers.push(() => store.close());
  const model = new ScriptedModel();
  const api = createLocalApiKernel(() => at, {
    chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store,
    background: new BackgroundUpdateCoordinator(store, store),
    memoryStore: new ShannonMemoryService(store, store, () => at, store),
  });
  const chat = async (message: string, threadId: string, extra: Record<string, unknown> = {}) => {
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId, message, ...extra } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await api.waitForBackground('owner');
    return response;
  };
  await chat('私は紅茶が好き', 'hobby');
  await chat('内緒だけど、ウォンバット会に入っている', 'private');
  const marked = (await chat('最近アルマジロの置物を集めている', 'collection')).body as ChatResponse;
  expect((await api.dispatch({ method: 'POST', path: '/v1/memories/action', body: { scopeKey: 'owner', memoryId: marked.turnId, action: 'mark-sensitive' } })).status).toBe(200);
  model.echo = true;
  return { api, chat, model };
}

describe('stream: sentences with other people watching', () => {
  it('never puts owner-only content in any line, even when the model repeats all it was given', async () => {
    const { chat } = await seeded();
    for (const [message, thread] of [['前に話した会のこと覚えてる？', 'private'], ['前に話した置物のこと覚えてる？', 'collection'],
      ['ウォンバット会とアルマジロの置物のこと教えて', 'elsewhere']] as const) {
      const result = await chat(message, thread, { audience: 'others', stream: 'sentences' });
      const lines = chatSentenceStreamLines(result);
      expect(lines[0]).toMatchObject({ type: 'start', audience: 'others' });
      expect(lines.filter(line => line.type === 'sentence').length).toBeGreaterThan(0);
      const done = lines.at(-1) as { response: ChatResponse };
      expect(sentenceText(lines)).toBe(done.response.reply);
      // The user's own message of this turn is not in a line; only what the server chose to say or return is.
      const wire = lines.map(line => JSON.stringify(line)).join('\n');
      for (const word of HARD) {
        const allowed = message.includes(word) ? wire.split(message).join('') : wire;
        expect(allowed, `${word} in a streamed line`).not.toContain(word);
      }
      // What an `others` response withholds stays withheld in `done`.
      expect(promptOf(done.response)).toBe('');
      expect(done.response).not.toHaveProperty('thread');
      expect(done.response.audience).toBe('others');
      expect(lines.every(line => line.type === 'done' || !('systemPrompt' in line))).toBe(true);
    }
  });

  it('is the same test when the owner is alone: the repeated prompt does carry the secret', async () => {
    const { chat } = await seeded();
    const lines = chatSentenceStreamLines(await chat('前に話した会のこと覚えてる？', 'private', { stream: 'sentences' }));
    expect(sentenceText(lines)).toContain('ウォンバット会');
  });

  it('sends an others turn the same lines its single response would give', async () => {
    const first = await seeded();
    const streamed = await first.chat('今日は何の話をしようか', 'elsewhere', { audience: 'others', stream: 'sentences' });
    const second = await seeded();
    const plain = await second.chat('今日は何の話をしようか', 'elsewhere', { audience: 'others' });
    expect(comparable(streamed.body)).toEqual(comparable(plain.body));
    expect(first.model.requests.at(-1)).toEqual(second.model.requests.at(-1));
  });
});

function fakeResponse(behaviour: { closeAfter?: number; throwOn?: number; destroyed?: boolean } = {}) {
  const written: string[] = [];
  let writes = 0;
  const response = Object.assign(new EventEmitter(), {
    headersSent: false, destroyed: behaviour.destroyed ?? false, ended: false,
    writeHead() { this.headersSent = true; return this; },
    write(value: string) {
      writes += 1;
      if (behaviour.throwOn === writes) throw new Error('boom');
      written.push(value);
      if (behaviour.closeAfter === writes) {
        // The reader went away: the write is not flushed and the connection closes.
        queueMicrotask(() => { response.destroyed = true; response.emit('close'); });
        return false;
      }
      return true;
    },
    end() { this.ended = true; },
  });
  return { response: response as unknown as ServerResponse & { ended: boolean }, written };
}

describe('chat sentence stream delivery', () => {
  async function completedTurn() {
    const api = createLocalApiKernel(() => at, { chatModel: new ScriptedModel() });
    const body = chatBody({ stream: 'sentences' });
    const result = await api.dispatch({ method: 'POST', path: '/v1/chat', body });
    const conversation = async () => ((await api.dispatch({ method: 'GET', path: '/v1/conversation',
      query: new URLSearchParams({ scopeKey: 'owner', threadId: 'thread' }) })).body as { messages: Array<{ content: string }> }).messages.map(message => message.content);
    return { body, result, conversation };
  }

  it('stops quietly when the reader disconnects mid-stream, and the turn is stored', async () => {
    const { body, result, conversation } = await completedTurn();
    const { response, written } = fakeResponse({ closeAfter: 2 });
    await expect(dispatchWithChatSentences(answered(result), response, { method: 'POST', path: '/v1/chat', body })).resolves.toBeNull();
    expect(written).toHaveLength(2);
    expect(response.ended).toBe(false);
    expect(await conversation()).toEqual(['聞こえてる？', REPLY]);
  });

  it('writes nothing to a connection that closed while the reply was being made, and the turn is stored', async () => {
    const { body, result, conversation } = await completedTurn();
    const { response, written } = fakeResponse({ destroyed: true });
    await expect(dispatchWithChatSentences(answered(result), response, { method: 'POST', path: '/v1/chat', body })).resolves.toBeNull();
    expect(written).toEqual([]);
    expect(await conversation()).toEqual(['聞こえてる？', REPLY]);
  });

  it('stores the turn when a real client hangs up after the first line', async () => {
    const api = createLocalApiKernel(() => at, { chatModel: new ScriptedModel() });
    const origin = new URL(await listen(api));
    const firstLine = await new Promise<string>((resolve, reject) => {
      const outgoing = httpRequest({ host: origin.hostname, port: origin.port, path: '/v1/chat', method: 'POST', headers: { 'content-type': 'application/json' } }, incoming => {
        incoming.once('data', (chunk: Buffer) => { resolve(chunk.toString('utf8').split('\n')[0]!); outgoing.destroy(); });
      });
      outgoing.once('error', reject);
      outgoing.end(JSON.stringify(chatBody({ stream: 'sentences' })));
    });
    expect(JSON.parse(firstLine)).toMatchObject({ type: 'start', threadId: 'thread' });
    const stored = await api.dispatch({ method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: 'owner', threadId: 'thread' }) });
    expect((stored.body as { messages: Array<{ content: string }> }).messages.map(message => message.content)).toEqual(['聞こえてる？', REPLY]);
    // The server still answers the next turn.
    expect((await post(origin.origin, chatBody({ stream: 'sentences' }))).status).toBe(200);
  });

  it('ends a stream that fails after it began with one error line', async () => {
    const { body, result } = await completedTurn();
    const { response, written } = fakeResponse({ throwOn: 2 });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(dispatchWithChatSentences(answered(result), response, { method: 'POST', path: '/v1/chat', body })).resolves.toBeNull();
    // The log names the failure and carries no reply text.
    expect(warned.mock.calls).toEqual([['Shannon chat sentence stream failed', { name: 'WriteError' }]]);
    warned.mockRestore();
    expect(written.map(line => JSON.parse(line) as ChatStreamLine).map(line => line.type)).toEqual(['start', 'error']);
    expect(JSON.parse(written.at(-1)!)).toEqual({ type: 'error', status: 502, error: 'STREAM_FAILED' });
    expect(written.at(-1)!.endsWith('\n')).toBe(true);
    expect(response.ended).toBe(true);
  });

  it('leaves every other response to the JSON path', async () => {
    const { result } = await completedTurn();
    const cases: Array<[string, unknown, ApiResponse]> = [
      ['/v1/chat', chatBody(), result],
      ['/v1/chat', undefined, result],
      ['/v1/state', chatBody({ stream: 'sentences' }), result],
      ['/v1/chat', chatBody({ stream: 'sentences' }), { status: 400, body: { error: 'INVALID_REQUEST' } }],
    ];
    for (const [path, body, response] of cases) {
      const fake = fakeResponse();
      await expect(dispatchWithChatSentences(answered(response), fake.response, { method: 'POST', path, body })).resolves.toBe(response);
      expect(fake.written).toEqual([]);
      expect(fake.response.headersSent).toBe(false);
    }
  });
});
