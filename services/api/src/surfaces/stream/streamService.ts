import { randomBytes } from 'node:crypto';
import { stopStreamLine, ignoreStreamViewer } from './streamControls.js';
import { StreamProgramRunner } from './streamProgramRunner.js';
import { streamStats, recordSpoken } from './streamStats.js';
import { StreamProgram } from './streamProgram.js';
import { StreamConversation } from './streamConversation.js';
import type { CheckedStreamReply } from '../../mind/emotion/streamFeeling.js';
import {
  STREAM_LIMITS, STREAM_PLATFORM, StreamError, type IncomingComment, type StreamAnswering,
  type StreamBroadcast, type StreamControl, type StreamLineKind, type StreamLinePlan, type StreamReceipt, type StreamSessionView,
  type StreamStartInput, type StreamSummary,
} from './streamContract.js';
import type { StreamServiceParts } from './streamServiceParts.js';
import { StreamAuthor, type WrittenLine } from './streamAuthor.js';
import { chooseComments, type ChosenComments } from './streamChooser.js';
import { StreamChatPosts } from './streamChatPosts.js';
import { StreamGameTalk } from './streamGameTalk.js';
import { StreamLedger, type CommentRecord } from './streamLedger.js';
import { ModelBudget, StreamMeasure } from './streamMeasure.js';
import { StreamMouth, type MouthEnd } from './streamMouth.js';
import { nextTopicSubject } from './streamTopics.js';
import type { WriterComment, WriterPurpose } from './streamWriter.js';

/** 配信セッションの調停役。耳のコメント・番組進行・公開会話・既存の書き手を、一つの口へつなぐ。
 * 時刻とモデルは注入し、tickとsettleで無料の決定的テストを行う。持ち主の私的な情報は取り込まない。
 */
interface Session {
  /** The end in progress: a second ask for it (the ear's retry) is the same end. */
  ending?: Promise<{ stream: StreamSessionView; summary: StreamSummary }>;
  view: StreamSessionView;
  program: StreamProgram;
  startedMs: number;
  endedMs?: number;
  summary?: StreamSummary;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const TTL: Readonly<Record<StreamLineKind, number>> = {
  reply: 60_000, notice: 60_000, commentary: 30_000, topic: 40_000, greeting: 60_000, closing: STREAM_LIMITS.closingMilliseconds,
};
/** 再生済みの発言だけを書き手に渡す。 */
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
  private readonly programRunner: StreamProgramRunner;
  private readonly conversation = new StreamConversation();
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
  private topicCount = 0;

  constructor(private readonly parts: StreamServiceParts) {
    this.mouth = parts.mouth ?? new StreamMouth({ now: parts.now });
    this.budget = new ModelBudget(parts.now);
    this.author = new StreamAuthor({
      scopeKey: parts.scopeKey, now: parts.now, model: parts.model, feeling: parts.feeling, snapshot: parts.snapshot, budget: this.budget,
      measure: () => this.measure, identity: parts.identity, persona: parts.persona, body: () => parts.body?.() ?? null,
      context: () => [this.session?.program.block() ?? '', this.conversation.block()].filter(Boolean).join('\n\n'),
      recent: () => [...this.ownLines], crowd: () => this.crowdLine(), log: line => this.log(line),
    });
    this.programRunner = new StreamProgramRunner({
      author: this.author, mouth: this.mouth, now: () => this.now(), occupied: () => Boolean(this.replyJob || this.topicJob),
      stale: (session, epoch) => this.stale(session as Session, epoch), track: job => this.track(job),
      put: (reply, plan, kind) => this.putOwn(reply, plan, kind),
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

  liveView(): StreamSessionView | null { return this.live()?.view ?? null; }

  /** The stream is no longer the live one (it ended, or another began) while some work for it was in flight. */
  private over(session: Session): boolean { return this.session !== session || session.view.phase === 'ended'; }

  start(input: StreamStartInput = {}): { created: boolean; stream: StreamSessionView } {
    const existing = this.live();
    if (existing) return { created: false, stream: existing.view };
    const now = this.now();
    const day = iso(now).slice(0, 10).replace(/-/gu, '');
    const title = Array.from((input.title ?? '').replace(/\s+/gu, ' ').trim()).slice(0, STREAM_LIMITS.titleCharacters).join('');
    const program = new StreamProgram(input.program, title);
    const view: StreamSessionView = {
      streamId: `st-${day}-${randomBytes(3).toString('hex')}`, platform: STREAM_PLATFORM, startedAt: iso(now), title,
      minecraft: input.minecraft === true, chatWrites: input.chatWrites === true, phase: 'waiting_for_chat', broadcast: null,
      paused: false, program: program.view,
      ...(input.targetVideoId ? { targetVideoId: input.targetVideoId } : {}),
    };
    const session: Session = { view, program, startedMs: now };
    this.session = session;
    this.reset(now);
    this.mouth.begin(view.streamId);
    this.startCommentary(session);
    this.mouth.announceState();
    this.log(`Shannon stream started id=${view.streamId} minecraft=${view.minecraft} chatWrites=${view.chatWrites}`);
    return { created: true, stream: view };
  }

  private reset(now: number): void {
    this.ledger = new StreamLedger(this.parts.salt);
    this.measure = new StreamMeasure();
    this.ownLines = [];
    this.conversation.clear();
    this.notices.length = 0;
    this.chatPosts.reset();
    Object.assign(this.counters, ZERO_COUNTERS);
    this.lastChooseMs = this.lastReplyMs = this.lastTopicMs = -Infinity;
    this.lastLineMs = now;
    this.topicCount = 0;
  }

  async end(streamId: string): Promise<{ stream: StreamSessionView; summary: StreamSummary }> {
    const session = this.live();
    if (!session || session.view.streamId !== streamId) throw new StreamError(409, 'STREAM_NOT_LIVE');
    session.ending ??= this.finish(session);
    return session.ending;
  }

  private async finish(session: Session): Promise<{ stream: StreamSessionView; summary: StreamSummary }> {
    const streamId = session.view.streamId;
    session.view.paused = true;
    this.commentary?.stop();
    const closingInMouth = this.mouth.holds('closing');
    const finished = session.program.view.finished;
    session.program.move('closing', this.now());
    session.program.view.layout = 'ending';
    session.program.view.finished = finished;
    if (!closingInMouth) {
      this.mouth.clearWaiting();
      if (session.program.view.ready && !finished) await this.programRunner.closing(session, {
        comments: this.ledger.count(), answered: this.counters.answered,
        minutes: Math.max(1, Math.round((this.now() - session.startedMs) / 60_000)),
      });
    }
    session.program.clear();
    session.view.phase = 'ended';
    session.view.endedAt = iso(this.now());
    session.endedMs = this.now();
    const summary: StreamSummary = {
      comments: this.ledger.count(), answered: this.counters.answered, lines: this.counters.lines, notices: this.counters.notices,
      declined: this.counters.declined, durationSeconds: Math.max(0, Math.round((this.now() - session.startedMs) / 1000)),
    };
    session.summary = summary;
    this.commentary = null;
    this.ledger.clear();
    this.ownLines = [];
    this.chatPosts.clear();
    this.mouth.announceState();
    this.log(`Shannon stream ended id=${streamId} comments=${summary.comments} answered=${summary.answered} lines=${summary.lines}`);
    return { stream: session.view, summary };
  }

  async broadcast(input: { streamId: string; ended?: boolean } & Partial<StreamBroadcast>): Promise<StreamSessionView> {
    const ended = this.session?.view.streamId === input.streamId && this.session.view.phase === 'ended';
    if (input.ended === true && ended) return this.session!.view;
    const session = this.live();
    if (!session || session.view.streamId !== input.streamId) throw new StreamError(409, 'STREAM_NOT_LIVE');
    if (input.ended === true) return (await this.end(input.streamId)).stream;
    if (session.view.targetVideoId && input.videoId !== session.view.targetVideoId) throw new StreamError(409, 'STREAM_VIDEO_MISMATCH');
    session.view.broadcast = { onAir: input.onAir === true, videoId: input.videoId ?? '', liveChatId: input.liveChatId ?? '', title: input.title ?? '',
      channelId: input.channelId ?? '' };
    if (input.onAir === true && session.view.phase === 'waiting_for_chat') {
      session.program.ready();
      session.view.phase = 'live';
      this.lastLineMs = Math.max(this.lastLineMs, this.now());
      this.mouth.announceState();
      this.programRunner.schedule(session);
    }
    return session.view;
  }

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
      this.measure.note(this.measure.transportMs, now - Date.parse(incoming.publishedAt));
      // Every comment moves her at once (closed tags and a digest); a reaction of the crowd is the crowd's, not a viewer's. An event is no speech.
      if (record.event) continue;
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
    else if (control.action === 'stop_line') stopStreamLine(this.mouth, this.ledger, (record, status) => this.give(record, status));
    else if (control.action === 'ignore') ignoreStreamViewer(this.mouth, this.ledger, control.commentId);
    else this.programRunner.control(session, control);
    this.mouth.announceState();
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
    const { streamId, platform, phase, startedAt, title, chatWrites, broadcast, targetVideoId } = session.view;
    return { stream: { streamId, platform, phase, startedAt, title, chatWrites, broadcast, ...(targetVideoId ? { targetVideoId } : {}) },
      chatPosts: this.pendingPosts() };
  }

  stats() {
    const session = this.session;
    return streamStats({
      ...this.counters, comments: session?.summary?.comments ?? this.ledger.count(),
      durationSeconds: session ? Math.max(0, Math.round(((session.endedMs ?? this.now()) - session.startedMs) / 1000)) : 0,
      waiting: this.mouth.waitingCount(), inFlight: Number(Boolean(this.replyJob)) + Number(Boolean(this.topicJob)) + Number(this.programRunner.busy()),
      modelCallsLastMinute: this.budget.used(), measure: this.measure, duplicates: this.ledger.duplicateCount(),
      chatPosts: { posted: this.chatPosts.posted, failed: this.chatPosts.failed },
      gate: this.parts.gate.stats, commentary: this.commentary?.stats() ?? null,
    });
  }

  view() {
    return { stream: this.session ? this.session.view : null, stats: this.stats(), comments: this.ledger.view(), notices: [...this.notices] };
  }

  tick(): void {
    try {
      this.mouth.tick();
      const session = this.live();
      if (!session) return;
      const now = this.now();
      this.ledger.expire(now);
      if (session.view.paused || !session.program.view.ready || session.program.view.finished) return;
      if (session.program.view.stage !== 'activity') {
        this.programRunner.schedule(session);
        return;
      }
      this.maybeAnswer(session, now);
      this.maybeTalk(session, now);
    } catch (error) {
      this.log(`Shannon stream tick failed reason=${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`);
    }
  }

  private maybeAnswer(session: Session, now: number): void {
    if (this.programRunner.busy() || this.replyJob || this.mouth.waitingCount() >= STREAM_LIMITS.waitingLines) return;
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
      first: record.first, named: record.named, event: record.event,
    };
  }

  private async answer(session: Session, pick: ChosenComments): Promise<void> {
    const epoch = session.program.epoch;
    const { primary, group } = pick;
    this.measure.note(this.measure.selectionMs, this.now() - primary.receivedMs);
    const streamId = session.view.streamId;
    for (const record of group) Object.assign(record, { status: 'picked', attempts: record.attempts + 1 });
    const { scopeKey } = this.parts;
    const turn = this.parts.feeling.turn(scopeKey, {
      streamId, viewer: primary.viewer, words: primary.event ? '' : primary.text, at: iso(this.now()), snapshot: this.parts.snapshot(scopeKey),
      path: 'text_pre_send',
    });
    if (!turn) return group.forEach(record => this.give(record, 'skipped'));
    if (turn.notice) {
      this.notices.push({ viewer: primary.authorName, reason: turn.notice.reason, at: iso(this.now()) });
      this.counters.notices += 1;
    }
    const tellOff = turn.state.viewer?.ladder === 'tell_off' && turn.notice !== null;
    // An event the ear described is no request: there is nothing to read for what it asks.
    const recent = this.recentChat(4).filter(text => text !== primary.text);
    const gateAt = this.now();
    const gate = primary.event ? { declined: false } : await this.parts.gate.before(primary.text, primary.tags, recent);
    this.measure.note(this.measure.gateMs, this.now() - gateAt);
    if (this.stale(session, epoch)) {
      group.forEach(record => this.give(record, 'new'));
      return;
    }
    const comments = group.map(record => this.writerComment(record));
    const purpose: WriterPurpose = tellOff ? { kind: 'notice', comments } : { kind: 'reply', comments, decline: gate.declined };
    const kind: StreamLineKind = tellOff ? 'notice' : 'reply';
    const writerAt = this.now();
    const written = await this.author.write(this.authorSession(session), turn, purpose, group.map(record => record.commentId), kind);
    this.measure.note(this.measure.writerMs, this.now() - writerAt);
    if (this.stale(session, epoch)) {
      group.forEach(record => this.give(record, 'new'));
      return;
    }
    if (!written) return group.forEach(record => this.give(record, 'new'));
    this.enqueueReply(group, written, kind, gate.declined);
  }

  private enqueueReply(group: CommentRecord[], written: WrittenLine, kind: StreamLineKind, declined: boolean): void {
    const named = new Set(written.draft.answered);
    // A viewer ignored while the line was written is not answered.
    const chosen = group.filter(record => named.has(record.commentId) && record.status === 'picked');
    for (const record of group) if (!chosen.includes(record)) this.give(record, 'new');
    if (!chosen.length) {
      this.measure.counts.notChosen += 1;
      return;
    }
    const answering: StreamAnswering[] = chosen.map(record => ({
      commentId: record.commentId, authorName: record.authorName, text: declined ? '配信ではお答えできない内容' : record.text, kind: record.kind,
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
    this.noteLine(now);
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

  private noteLine(now: number): void {
    this.counters.lines += 1;
    this.lastLineMs = now;
  }

  private stale(session: Session, epoch: number): boolean {
    return this.over(session) || session.program.epoch !== epoch || session.view.paused;
  }

  private putOwn(reply: CheckedStreamReply, plan: StreamLinePlan, kind: StreamLineKind): string | null {
    const lineId = this.mouth.enqueue({ kind, reply, plan, ttlMilliseconds: TTL[kind] });
    if (lineId !== null) this.noteLine(this.now());
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
    const epoch = session.program.epoch;
    const turn = this.author.ownTurn(session.view.streamId);
    if (!turn) return;
    const minecraft = session.view.minecraft && this.parts.body?.() != null;
    const subject = nextTopicSubject(this.topicCount, { minecraft, chatSpeaks: this.recentChat().length > 0 });
    this.topicCount += 1;
    const written = await this.author.write(this.authorSession(session), turn, { kind: 'topic', subject }, [], 'topic');
    if (!written || this.over(session) || session.view.phase !== 'live' || session.view.paused
      || session.program.epoch !== epoch) return;
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
        body: () => this.parts.body?.() ?? '', quiet: () => session.view.paused || this.over(session) || !session.program.view.ready
          || session.program.view.stage !== 'activity',
        // A stream is a show that talks all the time: a moment waits only while a reply is being written (one model call at a time), not
        // behind the replies waiting in her mouth or the quiet after one (a busy chat left the game without a word in the bench).
        room: () => ({ replying: this.replyJob !== null, sinceHumanMilliseconds: null }),
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
      this.session?.program.ended(line.id, false, this.now());
      const stopped = end.reason === 'stopped' || end.reason === 'dropped';
      for (const id of line.commentIds) this.give(this.ledger.get(id), stopped ? 'skipped' : 'new');
      return;
    }
    if (this.session?.view.phase !== 'ended') {
      const declined = line.commentIds.some(id => this.ledger.get(id)?.status === 'declined');
      this.conversation.spoken(line, declined);
      this.ownLines.push(line.text);
      if (this.ownLines.length > RECENT_LINES) this.ownLines.shift();
    }
    if (this.session?.program.ended(line.id, true, this.now())) this.mouth.announceState();
    this.counters.spoken += 1;
    recordSpoken(this.ledger, this.measure, this.counters, line.commentIds, line.createdMs, end.receipt);
    // With `chatWrites`, a reply she has said is written in the chat too (the ear posts it).
    if (line.kind === 'reply' && this.live()?.view.chatWrites) this.chatPosts.add(line.id, line.text, line.answering[0]?.authorName, this.now());
  }
}
