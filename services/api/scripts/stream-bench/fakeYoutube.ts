import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RecordedComment } from './makeChat.js';

/**
 * A fake of the YouTube Data API v3 for the stream bench: `liveBroadcasts.list`, `videos.list`, `liveChatMessages.list` (with `pageToken` and
 * `pollingIntervalMillis`, `offlineAt` when the chat is over), `liveChatMessages.streamList` and `liveChatMessages.insert`. It serves a recorded
 * chat on a clock that runs `speed` times faster than the wall's, and counts what it served: the bench's "comments sent by the API" against
 * "comments the head took".
 *
 * streamList, as far as Google documents it (reference and discovery document read 2026-10-30; the ear's `youtubeLiveApi.ts` has the sources):
 * `GET /liveChat/messages/stream?part=snippet,authorDetails&liveChatId=…[&pageToken=…]`, no body, each response a `LiveChatMessageListResponse`
 * (`items` oldest first, `nextPageToken`, `offlineAt` once the stream is offline). The first response is the chat so far; new messages follow on
 * the open connection as they are said; a connection that ends is resumed with the last `nextPageToken` as `pageToken`. Google does NOT document
 * how the HTTP body is delimited, so this fake picks the usual one of a Google server stream, a JSON array that grows (`[{…},
{…},
{…}`…`]`),
 * and `framing: 'ndjson'` gives one object per line. It cuts the first connection once on purpose, in the middle of a response, to see that the
 * ear resumes from the last whole one and loses nothing.
 */
export interface FakeYoutubeOptions {
  chat: readonly RecordedComment[];
  /** Virtual seconds per real second (the polling interval YouTube asks for is stretched to the wall clock by it). */
  speed: number;
  /** The virtual clock (ms since the epoch) and its start: the replay's time. */
  now: () => number;
  epochMs: number;
  /** Virtual milliseconds YouTube asks the ear to wait between two polls. */
  pollingVirtualMilliseconds?: number;
  /** Virtual seconds after the last comment at which the chat is over. */
  tailSeconds?: number;
  /** false: there is no `liveChat/messages/stream` (404), so the ear has to fall back to polling. Default true. */
  streamList?: boolean;
  /** Cut the first stream connection once, half way through the chat and in the middle of a response. Default true. */
  cutStreamOnce?: boolean;
  /** How the stream's body is delimited. Default a growing JSON array. */
  framing?: 'array' | 'ndjson';
  videoId?: string;
  liveChatId?: string;
  channelId?: string;
}

export interface FakeYoutubeCounts {
  broadcastLists: number;
  videoLists: number;
  chatPolls: number;
  /** `liveChatMessages.streamList` connections opened, the responses pushed down them, and the connections the fake cut. */
  streamConnects: number;
  streamPushes: number;
  streamCuts: number;
  /** Distinct comments handed out (the highest index served + 1). */
  sent: number;
  inserted: string[];
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
};

/** One recorded comment as YouTube's `liveChatMessage` resource. */
export function liveChatMessage(row: RecordedComment, liveChatId: string, publishedAt: string) {
  const author = {
    channelId: row.authorId, displayName: row.authorName, isChatOwner: row.roles?.includes('owner') ?? false,
    isChatModerator: row.roles?.includes('moderator') ?? false, isChatSponsor: row.roles?.includes('member') ?? false, isVerified: false,
  };
  const base = { liveChatId, authorChannelId: row.authorId, publishedAt, hasDisplayContent: true, displayMessage: row.text };
  if (row.kind === 'superchat') {
    const { amount } = row;
    return { kind: 'youtube#liveChatMessage', id: row.id, authorDetails: author, snippet: { ...base, type: 'superChatEvent', superChatDetails: {
      amountMicros: String(amount?.micros ?? 0), currency: amount?.currency ?? 'JPY', amountDisplayString: amount?.display ?? '', userComment: row.text, tier: 3 } } };
  }
  if (row.kind === 'membership') {
    return { kind: 'youtube#liveChatMessage', id: row.id, authorDetails: author, snippet: { ...base, type: 'newSponsorEvent', newSponsorDetails: {
      memberLevelName: 'メンバー', isUpgrade: false } } };
  }
  return { kind: 'youtube#liveChatMessage', id: row.id, authorDetails: author, snippet: { ...base, type: 'textMessageEvent', textMessageDetails: { messageText: row.text } } };
}

export class FakeYoutube {
  readonly counts: FakeYoutubeCounts = { broadcastLists: 0, videoLists: 0, chatPolls: 0, streamConnects: 0, streamPushes: 0, streamCuts: 0, sent: 0, inserted: [] };
  private server: Server | null = null;
  readonly videoId: string;
  readonly liveChatId: string;
  readonly channelId: string;

  constructor(private readonly options: FakeYoutubeOptions) {
    this.videoId = options.videoId ?? 'benchVideo001';
    this.liveChatId = options.liveChatId ?? 'benchLiveChat001';
    this.channelId = options.channelId ?? 'UCbenchChannel';
  }

  /** Virtual seconds since the replay began. */
  virtualSeconds(): number { return (this.options.now() - this.options.epochMs) / 1000; }

  /** The chat is over in virtual time (the last comment and the tail have passed). */
  over(): boolean {
    const last = this.options.chat.at(-1)?.at ?? 0;
    return this.virtualSeconds() >= last + (this.options.tailSeconds ?? 20);
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/youtube/v3`;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/^\/youtube\/v3/u, '');
      if (path === '/liveBroadcasts' && request.method === 'GET') return this.broadcasts(response);
      if (path === '/videos' && request.method === 'GET') return this.videos(response);
      if (path === '/liveChat/messages/stream' && request.method === 'GET') return this.stream(url, request, response);
      if (path === '/liveChat/messages' && request.method === 'GET') return this.messages(url, response);
      if (path === '/liveChat/messages' && request.method === 'POST') return await this.insert(request, response);
      json(response, 404, { error: { code: 404, message: 'not found' } });
    } catch {
      json(response, 500, { error: { code: 500, message: 'fake youtube failed' } });
    }
  }

  private broadcasts(response: ServerResponse): void {
    this.counts.broadcastLists += 1;
    json(response, 200, { kind: 'youtube#liveBroadcastListResponse', items: [{ id: this.videoId, snippet: { title: '雑談とマイクラ（台）', channelId: this.channelId,
      liveChatId: this.liveChatId, actualStartTime: new Date(this.options.epochMs).toISOString() }, status: { lifeCycleStatus: 'live' } }] });
  }

  private videos(response: ServerResponse): void {
    this.counts.videoLists += 1;
    json(response, 200, { kind: 'youtube#videoListResponse', items: [{ id: this.videoId, snippet: { title: '雑談とマイクラ（台）', channelId: this.channelId,
      liveBroadcastContent: 'live' }, liveStreamingDetails: { activeLiveChatId: this.liveChatId, actualStartTime: new Date(this.options.epochMs).toISOString() } }] });
  }

  private messages(url: URL, response: ServerResponse): void {
    this.counts.chatPolls += 1;
    const from = Math.max(0, Number(url.searchParams.get('pageToken')) || 0);
    const virtual = this.virtualSeconds();
    const due = this.options.chat.filter(row => row.at <= virtual);
    const items = due.slice(from, from + 200);
    this.counts.sent = Math.max(this.counts.sent, from + items.length);
    const polling = Math.max(20, Math.round((this.options.pollingVirtualMilliseconds ?? 3000) / this.options.speed));
    const published = (row: RecordedComment) => new Date(this.options.epochMs + row.at * 1000).toISOString();
    json(response, 200, {
      kind: 'youtube#liveChatMessageListResponse', pollingIntervalMillis: polling, pageInfo: { totalResults: due.length, resultsPerPage: items.length },
      nextPageToken: String(from + items.length), items: items.map(row => liveChatMessage(row, this.liveChatId, published(row))),
      ...(this.over() ? { offlineAt: new Date(this.options.now()).toISOString() } : {}),
    });
  }

  private stream(url: URL, request: IncomingMessage, response: ServerResponse): void {
    if (this.options.streamList === false) return json(response, 404, { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } });
    this.counts.streamConnects += 1;
    const framing = this.options.framing ?? 'array';
    // The token is the number of comments already taken, as the polling route's is.
    let index = Math.max(0, Number(url.searchParams.get('pageToken')) || 0);
    let written = 0;
    let finished = false;
    const published = (row: RecordedComment) => new Date(this.options.epochMs + row.at * 1000).toISOString();
    const text = (body: unknown) => {
      const json = JSON.stringify(body);
      const first = written === 0;
      written += 1;
      return framing === 'ndjson' ? `${json}\n` : `${first ? '[' : ',\n'}${json}`;
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    const push = () => {
      if (finished) return;
      const due = this.options.chat.filter(row => row.at <= this.virtualSeconds());
      const items = due.slice(index, index + 200);
      const done = this.over() && index + items.length >= this.options.chat.length;
      if (items.length === 0 && !done) return;
      const body = {
        kind: 'youtube#liveChatMessageListResponse', nextPageToken: String(index + items.length),
        pageInfo: { totalResults: due.length, resultsPerPage: items.length }, items: items.map(row => liveChatMessage(row, this.liveChatId, published(row))),
        ...(done ? { offlineAt: new Date(this.options.now()).toISOString() } : {}),
      };
      // The one cut: half way through the chat's time, half of a response is written and the socket is destroyed.
      const cutAt = (this.options.chat.at(-1)?.at ?? 0) / 2;
      if ((this.options.cutStreamOnce ?? true) && this.counts.streamCuts === 0 && this.counts.streamPushes > 0 && this.virtualSeconds() >= cutAt && items.length > 0) {
        const half = text(body);
        response.write(half.slice(0, Math.floor(half.length / 2)));
        this.counts.streamCuts += 1;
        finished = true;
        clearInterval(timer);
        setTimeout(() => request.socket.destroy(), 5);
        return;
      }
      response.write(text(body));
      index += items.length;
      this.counts.streamPushes += 1;
      this.counts.sent = Math.max(this.counts.sent, index);
      if (done) {
        finished = true;
        clearInterval(timer);
        response.end(framing === 'array' ? ']' : undefined);
      }
    };
    const timer = setInterval(push, 20);
    response.on('close', () => { finished = true; clearInterval(timer); });
    push();
  }

  private async insert(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request) as { snippet?: { textMessageDetails?: { messageText?: string } } } | undefined;
    const text = body?.snippet?.textMessageDetails?.messageText ?? '';
    this.counts.inserted.push(text);
    json(response, 200, { kind: 'youtube#liveChatMessage', id: `bench-insert-${this.counts.inserted.length}`, snippet: { type: 'textMessageEvent' } });
  }
}
