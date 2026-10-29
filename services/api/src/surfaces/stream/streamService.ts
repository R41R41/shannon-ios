import { randomBytes } from 'node:crypto';
import type { CheckedStreamReply } from '../../mind/emotion/streamFeeling.js';
import {
  STREAM_LIMITS, STREAM_PLATFORM, StreamError, type IncomingComment, type StreamAnswering,
  type StreamBroadcast, type StreamControl, type StreamLineKind, type StreamLinePlan, type StreamReceipt, type StreamSessionView,
  type StreamStartInput, type StreamSummary,
} from './streamContract.js';
import type { StreamServiceParts } from './streamServiceParts.js';
import { StreamAuthor, type WrittenLine } from './streamAuthor.js';
import { chooseComments, type ChosenComments } from './streamChooser.js';
import { checkedLine } from './streamGate.js';
import { StreamChatPosts } from './streamChatPosts.js';
import { StreamGameTalk } from './streamGameTalk.js';
import { StreamLedger, type CommentRecord } from './streamLedger.js';
import { ModelBudget, StreamMeasure, percentiles } from './streamMeasure.js';
import { StreamMouth, type MouthEnd } from './streamMouth.js';
import { STREAM_CLOSINGS, STREAM_GREETINGS, nextTopicSubject } from './streamTopics.js';
import type { WriterComment, WriterPurpose } from './streamWriter.js';

/**
 * The stream's place in the head (owner 2026-10-29, `docs/stream-contract.md`): a started stream, the chat the ear brings, the choice of what
 * to answer, the gates, the writer, her commentary on the game and her own talk, all ending in one mouth (`StreamMouth`). Nothing here is
 * behind a switch: with no stream started nothing runs. Her feeling is `StreamFeeling`; every line is written from a stream turn
 * (`StreamAuthor`) and given nothing of the owner's private life. The chat's words live in memory until the stream ends. Time and every model
 * are injected; `tick()` is what a timer calls, so a test steps it by hand and `settle()` waits for the work in flight.
 */
interface Session {
  view: StreamSessionView;
  startedMs: number;
  endedMs?: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const TTL: Readonly<Record<StreamLineKind, number>> = {
  reply: 60_000, notice: 60_000, commentary: 30_000, topic: 40_000, greeting: 60_000, closing: STREAM_LIMITS.closingMilliseconds,
};
/** The recent lines of hers handed to the writer, so that she does not say them again. */
const RECENT_LINES = 8;
const ZERO_COUNTERS = { lines: 0, notices: 0, declined: 0, answered: 0, spoken: 0 };

export class StreamService {
  readonly mouth: StreamMouth;
  private session: Session | null = null;
  private ledger = new StreamLedger();
  private readonly budget: ModelBudget;
  private measure = new StreamMeasure();
  private readonly author: StreamAuthor;
  private readonly jobs = new Set<Promise<unknown>>();
  private replyJob: Promise<void> | null = null;
  private topicJob: Promise<void> | null = null;
  private commentary: StreamGameTalk | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ownLines: string[] = [];
  private readonly notices: { viewer: string; reason: string; at: string }[] = [];
  private readonly chatPosts = new StreamChatPosts();
  private readonly counters = { ...ZERO_COUNTERS };
  private lastChooseMs = -Infinity;
  private lastReplyMs = -Infinity;
  private lastLineMs = 0;
  private lastTopicMs = -Infinity;
  private lastReplyEndedMs: number | null = null;
  private topicCount = 0;

  constructor(private readonly parts: StreamServiceParts) {
    this.mouth = parts.mouth ?? new StreamMouth({ now: parts.now });
    this.budget = new ModelBudget(parts.now);
    this.author = new StreamAuthor({
      scopeKey: parts.scopeKey, now: parts.now, model: parts.model, feeling: parts.feeling, snapshot: parts.snapshot, budget: this.budget,
      measure: () => this.measure, identity: parts.identity, persona: parts.persona, body: () => parts.body?.() ?? null,
      recent: () => [...this.ownLines], crowd: () => this.crowdLine(), log: line => this.log(line),
    });
    this.mouth.provideState(() => ({ stream: this.session ? this.session.view : null }));
    this.mouth.onEnd(end => this.lineEnded(end));
    if (parts.tickMilliseconds) {
      this.timer = setInterval(() => this.tick(), parts.tickMilliseconds);
      this.timer.unref?.();
    }
  }

  private now(): number { return this.parts.now(); }
  private log(line: string): void { try { this.parts.log?.(line); } catch { /* the journal never fails the stream */ } }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.jobs.add(promise);
    void promise.finally(() => this.jobs.delete(promise)).catch(() => undefined);
    return promise;
  }

  /** Waits for the work in flight (tests, and the server's stop). */
  async settle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.commentary?.stop();
    this.commentary = null;
    this.mouth.closeAll();
  }

  private crowdLine(): string {
    return this.ledger.crowdReactions(this.now()) >= 5 ? 'チャットは「草」「w」「888」などが流れていて、盛り上がっている' : '';
  }

  private live(): Session | null { return this.session && this.session.view.phase !== 'ended' ? this.session : null; }

  /** The stream while it is live (the ear's and the console's view of it); null otherwise. */
  liveView(): StreamSessionView | null { return this.live()?.view ?? null; }

  /** The stream is no longer the live one (it ended, or another began) while some work for it was in flight. */
  private over(session: Session): boolean { return this.session !== session || session.view.phase === 'ended'; }

  start(input: StreamStartInput = {}): { created: boolean; stream: StreamSessionView } {
    const existing = this.live();
    if (existing) return { created: false, stream: existing.view };
    const now = this.now();
    const day = iso(now).slice(0, 10).replace(/-/gu, '');
    const title = Array.from((input.title ?? '').replace(/\s+/gu, ' ').trim()).slice(0, STREAM_LIMITS.titleCharacters).join('');
    const view: StreamSessionView = {
      streamId: `st-${day}-${randomBytes(3).toString('hex')}`, platform: STREAM_PLATFORM, startedAt: iso(now), title,
      minecraft: input.minecraft === true, chatWrites: input.chatWrites === true, phase: 'waiting_for_chat', broadcast: null, paused: false,
    };
    const session: Session = { view, startedMs: now };
    this.session = session;
    this.reset(now);
    this.mouth.begin(view.streamId);
    this.startCommentary(session);
    this.mouth.announceState();
    this.track(this.greet(session));
    this.log(`Shannon stream started id=${view.streamId} minecraft=${view.minecraft} chatWrites=${view.chatWrites}`);
    return { created: true, stream: view };
  }

  private reset(now: number): void {
    this.ledger = new StreamLedger(this.parts.salt);
    this.measure = new StreamMeasure();
    this.ownLines = [];
    this.notices.length = 0;
    this.chatPosts.reset();
    Object.assign(this.counters, ZERO_COUNTERS);
    this.lastChooseMs = this.lastReplyMs = this.lastTopicMs = -Infinity;
    this.lastLineMs = now;
    this.lastReplyEndedMs = null;
    this.topicCount = 0;
  }

  async end(streamId: string): Promise<{ stream: StreamSessionView; summary: StreamSummary }> {
    const session = this.live();
    if (!session || session.view.streamId !== streamId) throw new StreamError(409, 'STREAM_NOT_LIVE');
    // The closing word first (the mouth takes it within 20 s or it is not said), then the stream is over and the words go.
    session.view.paused = true;
    this.commentary?.stop();
    await this.closing(session);
    session.view.phase = 'ended';
    session.view.endedAt = iso(this.now());
    session.endedMs = this.now();
    const summary: StreamSummary = {
      comments: this.ledger.count(), answered: this.counters.answered, lines: this.counters.lines, notices: this.counters.notices,
      declined: this.counters.declined, durationSeconds: Math.max(0, Math.round((this.now() - session.startedMs) / 1000)),
    };
    this.commentary = null;
    this.ledger.clear();
    this.ownLines = [];
    this.chatPosts.clear();
    this.mouth.announceState();
    this.log(`Shannon stream ended id=${streamId} comments=${summary.comments} answered=${summary.answered} lines=${summary.lines}`);
    return { stream: session.view, summary };
  }

  /** The ear found the live chat (or says it ended). */
  async broadcast(input: { streamId: string; ended?: boolean } & Partial<StreamBroadcast>): Promise<StreamSessionView> {
    const session = this.live();
    if (!session || session.view.streamId !== input.streamId) throw new StreamError(409, 'STREAM_NOT_LIVE');
    if (input.ended === true) return (await this.end(input.streamId)).stream;
    session.view.broadcast = { videoId: input.videoId ?? '', liveChatId: input.liveChatId ?? '', title: input.title ?? '', channelId: input.channelId ?? '' };
    if (session.view.phase === 'waiting_for_chat') {
      session.view.phase = 'live';
      this.lastLineMs = Math.max(this.lastLineMs, this.now());
      this.mouth.announceState();
    }
    return session.view;
  }

  /** The ear's batch. Throws `STREAM_NOT_LIVE` (409) for a stream that is not the live one. */
  ingest(streamId: string, comments: readonly IncomingComment[]): { accepted: number; duplicates: number; chatPosts: { id: string; text: string }[] } {
    const session = this.live();
    if (!session || session.view.streamId !== streamId) throw new StreamError(409, 'STREAM_NOT_LIVE');
    const now = this.now();
    let accepted = 0;
    let duplicates = 0;
    for (const incoming of comments) {
      const record = this.ledger.add(incoming, now);
      if (!record) {
        duplicates += 1;
        continue;
      }
      accepted += 1;
      // Every comment moves her at once (closed tags and a digest); a reaction of the crowd is the crowd's, not a viewer's.
      this.parts.feeling.comment(this.parts.scopeKey, {
        id: record.commentId, streamId, viewer: record.reaction ? null : record.viewer, words: record.text, at: iso(now), sourceId: null,
      });
    }
    return { accepted, duplicates, chatPosts: this.pendingPosts() };
  }

  control(control: StreamControl): void {
    const session = this.live();
    if (!session) throw new StreamError(409, 'STREAM_NOT_LIVE');
    if (control.action === 'pause' || control.action === 'resume') session.view.paused = control.action === 'pause';
    else if (control.action === 'stop_line') this.stopLine();
    else this.ignoreViewer(control.commentId);
  }

  private stopLine(): void {
    const current = this.mouth.currentLine();
    if (!current) return;
    this.mouth.dropAnswering(current.commentIds);
    for (const id of current.commentIds) this.give(this.ledger.get(id), 'skipped');
  }

  private ignoreViewer(commentId: string): void {
    const record = this.ledger.get(commentId);
    if (!record) throw new StreamError(404, 'STREAM_COMMENT_UNKNOWN');
    this.mouth.dropAnswering(this.ledger.ignore(record.authorId).map(item => item.commentId));
  }

  receipt(lineId: string, receipt: StreamReceipt): 'ok' | 'repeat' | 'unknown' { return this.mouth.receipt(lineId, receipt); }

  chatPostReceipt(id: string, outcome: 'posted' | 'failed'): boolean { return this.chatPosts.receipt(id, outcome); }

  private pendingPosts(): { id: string; text: string }[] {
    return this.live()?.view.chatWrites ? this.chatPosts.pending(this.now()) : [];
  }

  /** The state for the ear: the live stream (with the chat posts it should send), or none. */
  bridgeState() {
    const session = this.live();
    if (!session) return { stream: null, chatPosts: [] };
    const { streamId, platform, phase, startedAt, title, chatWrites, broadcast } = session.view;
    return { stream: { streamId, platform, phase, startedAt, title, chatWrites, broadcast }, chatPosts: this.pendingPosts() };
  }

  stats() {
    const session = this.session;
    const duration = session ? Math.max(0, Math.round(((session.endedMs ?? this.now()) - session.startedMs) / 1000)) : 0;
    const minutes = Math.max(1 / 60, duration / 60);
    return {
      comments: this.ledger.count(), answered: this.counters.answered, lines: this.counters.lines, notices: this.counters.notices,
      declined: this.counters.declined, durationSeconds: duration, waiting: this.mouth.waitingCount(), ...this.latencies(),
      inFlight: (this.replyJob ? 1 : 0) + (this.topicJob ? 1 : 0), modelCallsLastMinute: this.budget.used(),
      measure: {
        ...this.measure.summary(), answeredPerMinute: Math.round(this.counters.answered / minutes * 100) / 100, spoken: this.counters.spoken,
        duplicates: this.ledger.duplicateCount(), chatPosts: { posted: this.chatPosts.posted, failed: this.chatPosts.failed },
        gate: this.parts.gate.stats, commentary: this.commentary?.stats() ?? null,
      },
    };
  }

  /** Comment to first sound and comment to line, in milliseconds (the receipt's `startedAt`), for the console. */
  private latencies() {
    const sound = percentiles(this.measure.commentToSoundMs);
    return { firstSoundMedianMs: sound.median, firstSoundP90Ms: sound.p90, lineMedianMs: percentiles(this.measure.commentToLineMs).median };
  }

  view() {
    return { stream: this.session ? this.session.view : null, stats: this.stats(), comments: this.ledger.view(), notices: [...this.notices] };
  }

  /** What a timer calls: the mouth moves on, comments that waited too long are given up, and the next thing is started when there is room. */
  tick(): void {
    try {
      this.mouth.tick();
      const session = this.live();
      if (!session) return;
      const now = this.now();
      this.ledger.expire(now);
      if (session.view.paused) return;
      this.maybeAnswer(session, now);
      this.maybeTalk(session, now);
    } catch (error) {
      this.log(`Shannon stream tick failed reason=${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`);
    }
  }

  private maybeAnswer(session: Session, now: number): void {
    if (this.replyJob || this.mouth.waitingCount() >= STREAM_LIMITS.waitingLines) return;
    if (now - this.lastChooseMs < STREAM_LIMITS.chooseEveryMilliseconds || !this.budget.available('reply')) return;
    const pick = chooseComments(this.ledger, now);
    if (!pick) return;
    // One reply per 6 s; what the safety floor needs (a tell-off) is not made to wait.
    if (!pick.floor && now - this.lastReplyMs < STREAM_LIMITS.replyEveryMilliseconds) return;
    this.lastChooseMs = now;
    const job = this.answer(session, pick)
      .catch(error => this.log(`Shannon stream answer failed reason=${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`))
      .finally(() => { this.replyJob = null; });
    this.replyJob = job;
    this.track(job);
  }

  private recentChat(count = 3): string[] {
    return this.ledger.all().filter(record => !record.reaction && record.status !== 'ignored').slice(-count).map(record => record.text);
  }

  /** Comments taken up and given up: back to waiting once (the writer failed or left them out), else skipped. */
  private give(record: CommentRecord | undefined, status: 'new' | 'skipped'): void {
    if (!record || (record.status !== 'picked' && record.status !== 'new')) return;
    record.status = status === 'new' && record.attempts >= 2 ? 'skipped' : status;
  }

  private writerComment(record: CommentRecord): WriterComment {
    return {
      commentId: record.commentId, authorName: record.authorName, text: record.text, kind: record.kind, amount: record.amountDisplay,
      first: record.first, named: record.named,
    };
  }

  private async answer(session: Session, pick: ChosenComments): Promise<void> {
    const { primary, group } = pick;
    const streamId = session.view.streamId;
    for (const record of group) {
      record.status = 'picked';
      record.attempts += 1;
    }
    const turn = this.parts.feeling.turn(this.parts.scopeKey, {
      streamId, viewer: primary.viewer, words: primary.text, at: iso(this.now()), snapshot: this.parts.snapshot(this.parts.scopeKey), path: 'text_pre_send',
    });
    if (!turn) return group.forEach(record => this.give(record, 'skipped'));
    if (turn.notice) {
      this.notices.push({ viewer: primary.authorName, reason: turn.notice.reason, at: iso(this.now()) });
      this.counters.notices += 1;
    }
    const tellOff = turn.state.viewer?.ladder === 'tell_off' && turn.notice !== null;
    const gate = await this.parts.gate.before(primary.text, primary.tags, this.recentChat(4).filter(text => text !== primary.text));
    if (this.over(session)) return;
    const comments = group.map(record => this.writerComment(record));
    const purpose: WriterPurpose = tellOff ? { kind: 'notice', comments } : { kind: 'reply', comments, decline: gate.declined };
    const kind: StreamLineKind = tellOff ? 'notice' : 'reply';
    const written = await this.author.write(this.authorSession(session), turn, purpose, group.map(record => record.commentId), kind);
    if (this.over(session)) return;
    if (!written) return group.forEach(record => this.give(record, 'new'));
    this.enqueueReply(group, written, kind, gate.declined);
  }

  private enqueueReply(group: CommentRecord[], written: WrittenLine, kind: StreamLineKind, declined: boolean): void {
    const named = new Set(written.draft.answered);
    // A viewer ignored while the line was written is not answered.
    const chosen = group.filter(record => named.has(record.commentId) && record.status === 'picked');
    for (const record of group) if (!chosen.includes(record)) this.give(record, 'new');
    if (!chosen.length) return;
    const answering: StreamAnswering[] = chosen.map(record => ({
      commentId: record.commentId, authorName: record.authorName, text: record.text, kind: record.kind,
      ...(record.amountDisplay ? { amount: { display: record.amountDisplay } } : {}),
    }));
    const lineId = this.mouth.enqueue({
      kind, reply: written.reply, plan: written.draft.plan, answering, commentIds: chosen.map(record => record.commentId), ttlMilliseconds: TTL[kind],
    });
    if (lineId === null) {
      this.measure.counts.noRoom += 1;
      return chosen.forEach(record => this.give(record, 'new'));
    }
    const now = this.now();
    this.noteLine(written.reply.text, now);
    if (kind === 'reply') this.lastReplyMs = now;
    for (const record of chosen) {
      record.lineAtMs = now;
      this.measure.note(this.measure.commentToLineMs, now - record.receivedMs);
      this.ledger.noteAnswered(record.authorId, now);
      if (!declined) continue;
      record.status = 'declined';
      this.counters.declined += 1;
    }
  }

  private authorSession(session: Session) {
    return { streamId: session.view.streamId, title: session.view.title, minecraft: session.view.minecraft };
  }

  private noteLine(text: string, now: number): void {
    this.counters.lines += 1;
    this.lastLineMs = now;
    this.ownLines.push(text);
    if (this.ownLines.length > RECENT_LINES) this.ownLines.shift();
  }

  private async greet(session: Session): Promise<void> {
    const line = await this.ownLine(session, { kind: 'greeting' }, 'greeting', STREAM_GREETINGS);
    if (line && !this.over(session)) this.putOwn(line.reply, line.plan, 'greeting');
  }

  private async closing(session: Session): Promise<void> {
    const minutes = Math.max(1, Math.round((this.now() - session.startedMs) / 60_000));
    const purpose: WriterPurpose = { kind: 'closing', summary: { comments: this.ledger.count(), answered: this.counters.answered, minutes } };
    const line = await this.ownLine(session, purpose, 'closing', STREAM_CLOSINGS);
    if (line) this.putOwn(line.reply, line.plan, 'closing');
  }

  /** A line of her own for a purpose, with a fixed line in its place when the model is late, over its allowance or flagged. */
  private async ownLine(session: Session, purpose: WriterPurpose, kind: 'greeting' | 'closing', fixed: readonly string[])
    : Promise<{ reply: CheckedStreamReply; plan: StreamLinePlan } | null> {
    const turn = this.author.ownTurn(session.view.streamId);
    if (!turn) return null;
    const written = await this.author.write(this.authorSession(session), turn, purpose, [], kind);
    if (written) return { reply: written.reply, plan: written.draft.plan };
    const verdict = checkedLine(turn, fixed[Math.floor(this.now() / 1000) % fixed.length]!);
    return verdict.ok ? { reply: verdict.reply, plan: { affect: 'happy', affectIntensity: 0.5, delivery: 'gentle' } } : null;
  }

  private putOwn(reply: CheckedStreamReply, plan: StreamLinePlan, kind: StreamLineKind): string | null {
    const lineId = this.mouth.enqueue({ kind, reply, plan, ttlMilliseconds: TTL[kind] });
    if (lineId !== null) this.noteLine(reply.text, this.now());
    return lineId;
  }

  private maybeTalk(session: Session, now: number): void {
    if (session.view.phase !== 'live' || this.topicJob || this.replyJob) return;
    if (now - this.lastLineMs < STREAM_LIMITS.topicAfterMilliseconds || now - this.lastTopicMs < STREAM_LIMITS.topicAfterMilliseconds) return;
    // Only into a silence: nothing is being said or waits, and a comment that could be answered is answered first.
    if (this.mouth.hasCurrent() || this.mouth.waitingCount() > 0 || !this.budget.available('low')) return;
    if (chooseComments(this.ledger, now)) return;
    this.lastTopicMs = now;
    const job = this.talk(session)
      .catch(error => this.log(`Shannon stream topic failed reason=${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`))
      .finally(() => { this.topicJob = null; });
    this.topicJob = job;
    this.track(job);
  }

  private async talk(session: Session): Promise<void> {
    const turn = this.author.ownTurn(session.view.streamId);
    if (!turn) return;
    const minecraft = session.view.minecraft && this.parts.body?.() != null;
    const subject = nextTopicSubject(this.topicCount, { minecraft, chatSpeaks: this.recentChat().length > 0 });
    this.topicCount += 1;
    const written = await this.author.write(this.authorSession(session), turn, { kind: 'topic', subject }, [], 'topic');
    if (!written || this.over(session) || session.view.phase !== 'live') return;
    if (!this.mouth.hasCurrent() && this.mouth.waitingCount() === 0) this.putOwn(written.reply, written.draft.plan, 'topic');
  }

  private startCommentary(session: Session): void {
    const factory = session.view.minecraft ? this.parts.commentary?.() ?? null : null;
    if (!factory) return;
    this.commentary = new StreamGameTalk({
      factory, turn: () => this.author.ownTurn(session.view.streamId), dropped: () => { this.measure.counts.droppedLines += 1; },
      put: reply => this.putOwn(reply, { affect: 'excited', affectIntensity: 0.5, delivery: 'quick' }, 'commentary'),
      base: {
        now: () => this.now(), log: line => this.log(line), identity: this.parts.identity, persona: () => this.parts.persona(session.view.streamId),
        body: () => this.parts.body?.() ?? '', quiet: () => session.view.paused || this.over(session),
        room: () => ({
          replying: this.replyJob !== null || this.mouth.holds('reply', 'notice'),
          sinceHumanMilliseconds: this.lastReplyEndedMs === null ? null : Math.max(0, this.now() - this.lastReplyEndedMs),
        }),
        complete: (system, message) => this.author.call('commentary', this.parts.auxiliary,
          { scopeKey: this.parts.scopeKey, systemPrompt: system, history: [], message, skipThinking: true }, 'low', 12_000),
      },
    });
    this.commentary.start();
  }

  private lineEnded(end: MouthEnd): void {
    this.commentary?.ended({ lineId: end.line.id, outcome: end.outcome, reason: String(end.reason) });
    const { line } = end;
    this.measure.reason(`${end.outcome}:${String(end.reason)}`);
    if (end.outcome !== 'spoken') {
      const stopped = end.reason === 'stopped' || end.reason === 'dropped';
      for (const id of line.commentIds) this.give(this.ledger.get(id), stopped ? 'skipped' : 'new');
      return;
    }
    this.counters.spoken += 1;
    this.spoken(line.commentIds, line.createdMs, end.receipt);
    if (line.kind === 'reply' || line.kind === 'notice') this.lastReplyEndedMs = this.now();
    // With `chatWrites`, a reply she has said is written in the chat too (the ear posts it).
    if (line.kind === 'reply' && this.live()?.view.chatWrites) this.chatPosts.add(line.id, line.text, line.answering[0]?.authorName, this.now());
  }

  private spoken(commentIds: readonly string[], createdMs: number, receipt: StreamReceipt | undefined): void {
    const startedAt = receipt?.startedAt ? Date.parse(receipt.startedAt) : Number.NaN;
    const endedAt = receipt?.endedAt ? Date.parse(receipt.endedAt) : Number.NaN;
    if (Number.isFinite(startedAt)) this.measure.note(this.measure.lineToSoundMs, startedAt - createdMs);
    if (Number.isFinite(startedAt) && Number.isFinite(endedAt)) this.measure.counts.speakingSeconds += Math.max(0, (endedAt - startedAt) / 1000);
    for (const id of commentIds) {
      const record = this.ledger.get(id);
      if (!record) continue;
      if (record.status === 'picked') {
        record.status = 'answered';
        this.counters.answered += 1;
      }
      if (!Number.isFinite(startedAt)) continue;
      record.soundAtMs = startedAt;
      this.measure.note(this.measure.commentToSoundMs, startedAt - record.receivedMs);
    }
  }

}
