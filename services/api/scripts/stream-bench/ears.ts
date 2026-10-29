import { spawn, type ChildProcess } from 'node:child_process';
import type { ScaledClock } from './benchParts.js';

/**
 * The ears of the stream bench. `InlineEar` is a small one of the bench's own: it reads the fake YouTube the way the real ear does (the
 * broadcast, then the chat page by page by `nextPageToken` at the pace YouTube asks for) and hands everything to the head. `ExternalEar` runs
 * the legacy runtime's ear process (`backend/src/services/youtube/ear/cli.ts` of the Shannon-vtuber repo) against the same fake.
 */
export interface Ear {
  start(): Promise<void>;
  stop(): Promise<EarReport>;
}

export interface EarReport {
  kind: 'inline' | 'external';
  /** Comments the ear took from the API and comments the head accepted from it (the ear's own count, when it keeps one). */
  read: number | null;
  sent: number | null;
  posted: number;
  detail: unknown;
}

interface Resource { id?: string; snippet?: Record<string, any>; authorDetails?: Record<string, any> }

/** A YouTube `liveChatMessage` as the head's comment (`docs/stream-contract.md` §2). */
function comment(item: Resource) {
  const snippet = item.snippet ?? {}, author = item.authorDetails ?? {};
  const roles = [author.isChatOwner ? 'owner' : null, author.isChatModerator ? 'moderator' : null, author.isChatSponsor ? 'member' : null].filter(Boolean);
  const type = String(snippet.type ?? '');
  const paid = type === 'superChatEvent' ? snippet.superChatDetails : null;
  return {
    id: item.id, authorId: author.channelId ?? snippet.authorChannelId, authorName: author.displayName ?? '', publishedAt: snippet.publishedAt,
    text: paid ? paid.userComment ?? '' : type === 'newSponsorEvent' ? 'メンバーになりました' : snippet.textMessageDetails?.messageText ?? snippet.displayMessage ?? '',
    kind: paid ? 'superchat' : type === 'newSponsorEvent' ? 'membership' : 'text', roles,
    ...(paid ? { amount: { display: paid.amountDisplayString, micros: Number(paid.amountMicros), currency: paid.currency } } : {}),
  };
}

export class InlineEar implements Ear {
  private stopped = false;
  private running: Promise<void> | null = null;
  private readCount = 0;
  private sentCount = 0;
  private posted = 0;

  constructor(private readonly options: { youtube: string; head: string; token: string; clock: ScaledClock }) {}

  private async head(path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const response = await fetch(`${this.options.head}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  private async youtube(path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.options.youtube}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response.json();
  }

  private wait(virtual: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, this.options.clock.real(virtual))); }

  async start(): Promise<void> { this.running = this.run(); }

  async stop(): Promise<EarReport> {
    this.stopped = true;
    await this.running?.catch(() => undefined);
    return { kind: 'inline', read: this.readCount, sent: this.sentCount, posted: this.posted, detail: null };
  }

  private async run(): Promise<void> {
    let streamId = '';
    // The state of the head is polled every five seconds until a stream is live; then the broadcast is found and told.
    while (!this.stopped && !streamId) {
      const state = await this.head('/v1/platform/stream/state').catch(() => null);
      if (state?.json?.stream) streamId = state.json.stream.streamId;
      else await this.wait(5000);
    }
    const found = (await this.youtube('/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all'))?.items?.[0];
    if (!found || this.stopped) return;
    const broadcast = { streamId, videoId: found.id, liveChatId: found.snippet.liveChatId, title: found.snippet.title, channelId: found.snippet.channelId };
    await this.head('/v1/platform/stream/broadcast', broadcast);
    let token = '', polling = 3000;
    while (!this.stopped) {
      const page = await this.youtube(`/liveChat/messages?liveChatId=${broadcast.liveChatId}&part=snippet,authorDetails&maxResults=200${token ? `&pageToken=${token}` : ''}`);
      token = page.nextPageToken ?? token;
      polling = page.pollingIntervalMillis ?? polling;
      const items = (page.items ?? []) as Resource[];
      this.readCount += items.length;
      if (items.length) {
        const result = await this.head('/v1/platform/stream/comments', { streamId, comments: items.map(comment) });
        this.sentCount += result.json?.accepted ?? 0;
        await this.post(result.json?.chatPosts ?? [], broadcast.liveChatId);
      }
      if (page.offlineAt) {
        await this.head('/v1/platform/stream/broadcast', { streamId, ended: true });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(10, polling)));
    }
  }

  private async post(chatPosts: { id: string; text: string }[], liveChatId: string): Promise<void> {
    for (const post of chatPosts) {
      await this.youtube('/liveChat/messages?part=snippet', { snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: post.text } } });
      await this.head(`/v1/platform/stream/chat-posts/${post.id}/receipt`, { outcome: 'posted' });
      this.posted += 1;
    }
  }
}

/** The legacy runtime's ear, started as a child process by a command given on the bench's command line. */
export class ExternalEar implements Ear {
  private child: ChildProcess | null = null;
  private output = '';

  constructor(private readonly options: { command: string; youtube: string; head: string; token: string; clock: ScaledClock; cwd?: string }) {}

  async start(): Promise<void> {
    const { clock } = this.options;
    const every = String(Math.max(20, Math.round(clock.real(5000))));
    this.child = spawn(this.options.command, { shell: true, detached: process.platform !== 'win32', ...(this.options.cwd ? { cwd: this.options.cwd } : {}), env: {
      ...process.env, SHANNON_CORE_PLATFORM_URL: `${this.options.head}/v1/platform/turns`, SHANNON_CORE_PLATFORM_TOKEN: this.options.token,
      YOUTUBE_API_BASE: this.options.youtube, YOUTUBE_ACCESS_TOKEN: 'bench-token', EAR_STATE_EVERY_MS: every, EAR_DISCOVERY_EVERY_MS: every,
      EAR_MIN_POLL_MS: '20', EAR_MAX_POLL_MS: '10000',
    } });
    this.child.stdout?.on('data', chunk => { this.output += String(chunk); });
    this.child.stderr?.on('data', chunk => { this.output += String(chunk); });
    const started = Date.now();
    while (!/"ear":"(ready|error)"/u.test(this.output)) {
      if (Date.now() - started > 60_000 || this.child.exitCode !== null) throw new Error(`the ear did not start: ${this.output.slice(-300)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (this.output.includes('"ear":"error"')) throw new Error(`the ear refused to start: ${this.output.slice(-300)}`);
  }

  async stop(): Promise<EarReport> {
    const child = this.child;
    if (child && child.exitCode === null) {
      // The shell, npx and the ear itself are one group: the signal reaches the ear, which says how it went.
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { child.kill('SIGTERM'); }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    const status = /\{"ear":"stopped"[^\n]*\}/u.exec(this.output)?.[0];
    let detail: any = null;
    try { detail = status ? JSON.parse(status) : { unparsed: this.output.slice(-400) }; } catch { detail = { unparsed: this.output.slice(-400) }; }
    const counters = detail?.status ?? {};
    return { kind: 'external', read: counters.commentsRead ?? counters.read ?? null, sent: counters.commentsSent ?? counters.sent ?? null, posted: counters.chatPosted ?? 0, detail };
  }
}
