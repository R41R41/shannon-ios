import {
  STREAM_FEELING_PARAMETERS, commentEvent, commentTags, foldStream, streamAfterglow, streamBlock, tellOffNotice, type CompanionStateSnapshot, type FeelingEvent,
  checkReply, rewriteNote, type FeelingStance, type LadderStep, type ReplyCheckContext, type ReplyCheckFlag, type StreamComment, type StreamState,
} from '@shannon/cognition';
import type { FeelingDays } from './feelingDays.js';
import { observeSync } from '../../infra/observer/observerContext.js';
import { remembered, type FeelingEvents } from './feelingEvents.js';

/**
 * Her feeling on a stream (Syzygy ADR-0013 stage 5, `SHANNON_FEELING_STREAM`). Core: emotion. Built for the stream audience of ADR-0010
 * and ADR-0011 before its entry exists: a comment is recorded as a feeling event (closed tags and a digest, never the words); a turn of
 * hers on the stream is given the stream's block (her register, a slip, the ladder toward the viewer, the floor) and nothing of the
 * owner's private life; a tell-off is recorded as a notice for the moderator (the owner) and nothing else: she has no tool to ban,
 * time out or mute (owner decision, 「言うだけ」). The next stream and the owner alone get the stream's afterglow when it ended worn.
 * The Observer is shown the graph's values (`feeling.stream`), never words. Never throws (but see the precondition).
 *
 * Precondition (review T2): a stream reply is written on the text path and passes its check before sending (`SHANNON_REPLY_CHECK`:
 * `private_leak`, `ai_tone`, `too_polite`, `obeyed_order`, the safe line for a private matter) before any speech is made of it. A turn
 * is given only to that path (`path: 'text_pre_send'`), with the check context to send it with; the port is never built without the
 * reply check. A voice path without that check must not be wired to it.
 */
export type StreamReplyPath = 'text_pre_send';
export interface StreamTurn {
  /** The block for her reply (after the feeling turn's). */
  block: string;
  /**
   * What the reply's check before sending is given (always checked before sending on a stream): the stance the ladder asks for (review V8,
   * so `obeyed_order` can fire), the register level, and whether the floor is up (review V7: a floor tell-off is never softened).
   */
  check: ReplyCheckContext & { audience: 'stream'; audienceChecks: true; level: number; stance: FeelingStance; floor: boolean };
  state: Omit<StreamState, 'series'>;
  /** Her tell-off, recorded as a notice for the moderator; null when there is none. */
  notice: { viewer: string; reason: string } | null;
}

/**
 * Review V8: what the model is given for a stream turn. `feelingCheck` is required (a request cannot be built without the turn's check) and
 * `tools` is the empty tuple: a stream turn hands the model no tool (no ban, no operation of the owner's world).
 */
export interface StreamModelRequest {
  readonly path: 'text_pre_send';
  readonly block: string;
  readonly feelingCheck: StreamTurn['check'];
  readonly tools: readonly [];
}
export const streamModelRequest = (turn: StreamTurn): StreamModelRequest => ({ path: 'text_pre_send', block: turn.block, feelingCheck: turn.check, tools: [] });

declare const checkedReply: unique symbol;
/** A draft that passed its check; the only thing a stream's speech may be handed (only `checkStreamReply` makes one). */
export interface CheckedStreamReply { readonly [checkedReply]: true; readonly text: string }
export type StreamReplyVerdict = { ok: true; reply: CheckedStreamReply } | { ok: false; flags: ReplyCheckFlag[]; note: string };

/** The check before sending: a draft with flags is not sendable; the note is for one rewrite. */
export function checkStreamReply(turn: StreamTurn, draft: string): StreamReplyVerdict {
  const flags = checkReply(draft, turn.check);
  return flags.length ? { ok: false, flags, note: rewriteNote(flags) } : { ok: true, reply: { text: draft } as CheckedStreamReply };
}
// TODO (stream entry, ADR-0010/0011): true enforcement needs the entry point, which does not exist yet: its speech/send port must accept only
// `CheckedStreamReply` (not `string`), and its model call must be built from `streamModelRequest(turn)` only (see the wiring `it.todo` in
// feelingStream.test.ts). Until then the type is the only guard.

/** The stance a stream reply is checked against: a feeling order is declined; otherwise the ladder's step toward the one being answered. */
const STANCE_OF_STEP: Readonly<Record<LadderStep, FeelingStance>> = {
  let_go: 'neutral', tease_back: 'snipe', scold: 'scold', end_topic: 'rebuff', tell_off: 'rebuff',
};

const STREAM_LOOKBACK_MS = 12 * 60 * 60_000;
const AFTERGLOW_MS = 36 * 60 * 60_000;

/** The stream ids of events, newest last. */
const streamIdOf = (event: FeelingEvent) => (event.sceneId?.startsWith('stream:') ? event.sceneId.slice('stream:'.length) : null);

export class StreamFeeling {
  /** Review T5: the digests of recent comments, in memory only (a repeat within the window is not recorded again); never stored. */
  private readonly seen = new Map<string, number>();

  constructor(private readonly options: { events: FeelingEvents; days?: FeelingDays | null; replyCheck: boolean;
    reportError?: (error: unknown) => void }) {
    if (!options.replyCheck) throw new Error('STREAM_FEELING_NEEDS_REPLY_CHECK');
  }

  /** One comment in (its words are read for closed tags and a digest, then dropped; a repeat within the window is one event). */
  comment(scopeKey: string, comment: StreamComment): void {
    try {
      const { facts: { digest, ...facts }, ...event } = commentEvent(comment);
      // Review V1: this dedup is volume damping only (the same words from anyone within the window are one event for the fast layer); the
      // floor and the tell-off never read it: a turn reads the words of the comment it answers.
      if (digest && this.repeated(`${scopeKey}\u0000${comment.streamId}\u0000${digest}`, Date.parse(comment.at))) return;
      this.options.events.record(scopeKey, { ...event, facts });
    } catch (error) { this.report(error); }
  }

  /** Her turn on the stream, for the text path with its check before sending only: the block, the state, the check, the notice. */
  turn(scopeKey: string, input: { streamId: string; viewer: string | null; words: string; at: string; snapshot: CompanionStateSnapshot;
    path: StreamReplyPath }): StreamTurn | null {
    if (input.path !== 'text_pre_send') return null;
    try {
      const events = this.recent(scopeKey, input.at, input.snapshot);
      const remembered = this.viewerLines(scopeKey, input.viewer, input.at, input.snapshot);
      // Review V1, V2, V3: the floor, the ladder's top and the notice all read the tags of the comment being answered, for a viewer or the crowd.
      const answered = commentTags(input.words);
      const state = observeSync('emotion', { phase: 'feeling.stream', stream: true },
        () => foldStream(events, input.streamId, input.at, input.viewer, remembered.wary, answered), value => graphPoint(value));
      const notice = tellOffNotice(state, answered);
      if (notice) this.recordNotice(scopeKey, input.streamId, notice, input.at);
      const before = this.afterglowOf(events, input.at, input.streamId);
      const { series: _series, ...rest } = state;
      const asked = commentEvent({ id: 'x', streamId: input.streamId, viewer: input.viewer, words: input.words, at: input.at });
      const order = asked.facts.commentKind === 'feeling_order';
      const stance = order ? 'not_play_along' : STANCE_OF_STEP[state.viewer?.ladder ?? 'let_go'];
      const floor = state.viewer?.floor ?? false;
      return { block: [streamBlock(state), ...remembered.lines, before].filter(Boolean).join('\n'), state: rest, notice,
        check: { audience: 'stream', order, audienceChecks: true, level: state.level, stance, floor, violation: false,
          intensity: floor ? 'strong' : 'moderate' } };
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  /** The tell-offs of a span, for the moderator (the owner): viewer digest, reason, when. */
  notices(scopeKey: string, since: string, until: string): { viewer: string; reason: string; at: string; streamId: string | null }[] {
    return this.options.events.between(scopeKey, since, until).flatMap(event => (event.kind === 'own_refusal' && event.facts.tellOff
      ? [{ ...event.facts.tellOff, at: event.occurredAt, streamId: streamIdOf(event) }] : []));
  }

  /** What the last stream left (worn, hurt, irritated), for the owner alone; '' when nothing. */
  afterglow(scopeKey: string, at: string, snapshot: CompanionStateSnapshot): string {
    try { return this.afterglowOf(this.recent(scopeKey, at, snapshot, AFTERGLOW_MS), at, null); } catch (error) {
      this.report(error);
      return '';
    }
  }

  /** A viewer's own light ledger from earlier streams (review T4): their line, and whether she is wary of them from the start. */
  private viewerLines(scopeKey: string, viewer: string | null, at: string, snapshot: CompanionStateSnapshot): { lines: string[]; wary: boolean } {
    if (!viewer || !this.options.days) return { lines: [], wary: false };
    const carried = this.options.days.carried(scopeKey, { personKey: `viewer:${viewer}`, audience: 'stream', sceneId: null }, at, snapshot, '', 'text');
    const irritation = Number(carried.facts.rel_irritation ?? 0);
    // Provisional (review U3): 0.15 is not among the approved coefficients; the owner is asked before stage 5 goes on.
    return { lines: [...carried.lines], wary: irritation >= 0.15 };
  }

  private repeated(key: string, at: number): boolean {
    const last = this.seen.get(key);
    if (this.seen.size > 5_000) this.seen.clear();
    this.seen.set(key, at);
    return last !== undefined && at - last <= STREAM_FEELING_PARAMETERS.dedupeWindowMs;
  }

  private afterglowOf(events: readonly FeelingEvent[], at: string, except: string | null): string {
    const near = (event: FeelingEvent) => Date.parse(at) - Date.parse(event.occurredAt) <= AFTERGLOW_MS;
    const last = [...events].reverse().find(event => streamIdOf(event) !== null && streamIdOf(event) !== except && near(event));
    if (!last) return '';
    const id = streamIdOf(last)!;
    return streamAfterglow(foldStream(events, id, last.occurredAt));
  }

  private recordNotice(scopeKey: string, streamId: string, notice: { viewer: string; reason: string }, at: string): void {
    this.options.events.record(scopeKey, { id: `telloff:${streamId}:${notice.viewer}:${at}`, kind: 'own_refusal', personKey: notice.viewer,
      identity: 'platform', audience: 'stream', channel: 'stream_comment', sceneId: `stream:${streamId}`, sourceId: null, facts: { tellOff: notice },
      occurredAt: at });
  }

  private recent(scopeKey: string, at: string, snapshot: CompanionStateSnapshot, span = STREAM_LOOKBACK_MS): FeelingEvent[] {
    const since = new Date(Date.parse(at) - span).toISOString();
    return this.options.events.between(scopeKey, since, at).filter(event => remembered(snapshot, event.sourceId));
  }

  private report(error: unknown): void {
    (this.options.reportError ?? (value => console.error('Shannon stream feeling failed', value instanceof Error ? value.name : 'unknown')))(error);
  }
}

/** The Observer's graph point (§4.8: composure and register over time), closed values only. */
export function graphPoint(state: StreamState): Record<string, number | string | boolean | null> {
  const ladder: LadderStep | null = state.viewer?.ladder ?? null;
  return { composure: state.composure, level: state.level, register: state.register, slip: state.slip, coverUp: state.coverUp,
    temperature: state.temperature, label: state.label, blame: state.blame, mood: state.mood, slips: state.slips, ladder, floor: state.viewer?.floor ?? null };
}
