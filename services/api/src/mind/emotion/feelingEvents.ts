import {
  OWNER_PERSON_KEY, drawersIn, episodeLine, replyFacts, foldEpisodeLedger, innerNoteDay, ledgerFacts, memoryControlFor, repetitionFacts,
  repetitionLine, watchRepetition,
  type CompanionStateSnapshot, type EpisodeLedger, type FeelingAudience, type FeelingEvent, type RepetitionWatch,
} from '@shannon/cognition';
import { observeSync } from '../../infra/observer/observerContext.js';
import type { FeelingDays } from './feelingDays.js';

/**
 * Her feeling events and what is folded from them (Syzygy ADR-0013 stage 1, items 1, 3 and 8): the one entrance every touch, word
 * and reply of hers goes through, the day's episode ledger per person and audience, and the repetition watch per audience.
 * Core: emotion. Computation only: no model, and nothing kept but the events themselves.
 *
 * Privacy (ADR-0013 §4.4, D15): a ledger is only ever folded for one key (person or scene, and audience), and the lines for an
 * audience are that audience's own (`linesFor`): the owner's ledger never reaches a turn anyone else can hear. Forgetting: an event
 * whose source the owner had her forget is left out of every fold, so the ledger is computed again without it.
 *
 * Never throws: a failure loses one event or one line, never a turn.
 */
export interface FeelingEventRecords {
  record(scopeKey: string, event: FeelingEvent, recordedAt: string): boolean;
  between(scopeKey: string, since: string, until: string, limit?: number): FeelingEvent[];
  ownReplies(scopeKey: string, audience: string, limit: number): FeelingEvent[];
  prune(scopeKey: string, before: string): number;
  bindSource?(scopeKey: string, from: string, to: string): number;
}

/** Her replies of today in the owner's Talk (text, oldest or newest first), through the conversation's forgetting filter. */
export type RepetitionSeed = (scopeKey: string, since: string, at: string, snapshot: CompanionStateSnapshot) =>
  readonly { text: string; at: string; sourceId?: string }[];

export interface FeelingLines {
  ledger: EpisodeLedger;
  watch: RepetitionWatch;
  ledgerLine: string;
  repetitionLine: string;
  /** Closed numbers for the chooser and the Observer. */
  facts: Record<string, number | string>;
  /** Stage 3: what is carried from the days before (the relationship line, episodes, boundaries), for this key's own audience. */
  carriedLines: readonly string[];
  /** The carried lines a touch is judged with: without the boundaries she was told and has not endorsed (review L2). */
  carriedTouchLines: readonly string[];
}

export interface FeelingKey {
  personKey: string;
  audience: FeelingAudience;
  sceneId: string | null;
  /** How sure it is who this is (§4.1); absent: registered for the owner, unknown for anyone else. */
  identity?: FeelingEvent['identity'];
}

export const FEELING_EVENT_LIMITS = Object.freeze({
  /** A stance is her face for this long after it was taken. */
  stanceFreshMilliseconds: 10 * 60_000,
  retentionDays: 30,
  pruneEveryMilliseconds: 60 * 60_000,
  /** A strong reply decided and never recorded (its turn failed) stops counting against the cap after this. */
  strongInFlightMilliseconds: 5 * 60_000,
  /** A voice turn is stored within this of its answer. */
  presentedFreshMilliseconds: 10 * 60_000,
  /** A touch with others present this soon after a turn of a call with others is that call's (stage 4). */
  sceneFreshMilliseconds: 10 * 60_000,
});

const DAY_MILLISECONDS = 24 * 60 * 60_000;

export class FeelingEvents {
  private readonly pruned = new Map<string, number>();
  /** The reply check of a scope's turn in progress (checked before sending), taken when its reply is recorded. */
  private readonly checks = new Map<string, { flags: readonly string[]; rewritten: boolean }>();
  /** Strong replies decided and not yet recorded, per scope and day, by when (a turn in flight counts; an abandoned one expires). */
  private readonly strongInFlight = new Map<string, number[]>();
  /** Stage 4: the call with others a scope is in, and when it was last heard (a touch with others then is that call's). */
  private readonly scenes = new Map<string, { sceneId: string; at: number }>();
  /** The presentation id a voice turn answered with, per scope, until its turn is stored (review P2-3). */
  private readonly presented = new Map<string, { id: string; utteranceId: string | null; at: number }>();

  constructor(private readonly options: { store: FeelingEventRecords; now: () => string; timeZone: string; partWord: (subject: string) => string;
    reportError?: (error: unknown) => void; seed?: RepetitionSeed;
    /** Stage 2 (`SHANNON_CORE_AFFECT`): told of every recorded event, after it is written (the shadow of her fast layer). */
    onRecorded?: (scopeKey: string, event: FeelingEvent) => void;
    /** Stage 3: her closed days and what is carried across them (absent: nothing is carried). */
    days?: FeelingDays }) {}

  get timeZone(): string { return this.options.timeZone; }

  /** A subject (a part, a region, a kind of touch) in her words. */
  partWord(subject: string): string { return this.options.partWord(subject); }

  /** One event in. The Observer sees its closed shape (kind, who, audience, register, composure), never words. */
  record(scopeKey: string, event: FeelingEvent): void {
    try {
      observeSync('emotion', { phase: 'feeling.event', kind: event.kind, identity: event.identity, audience: event.audience, channel: event.channel,
        composure: 1, register: event.facts.register ?? 'normal', stance: event.facts.stance ?? null, opener: event.facts.opener ?? null },
      () => this.options.store.record(scopeKey, event, this.options.now()), written => ({ written }));
      this.prune(scopeKey);
      this.options.onRecorded?.(scopeKey, event);
    } catch (error) { this.report(error); }
  }

  /** A voice utterance's events take the stored turn's id once the app stores it (so forgetting the turn forgets them). */
  bind(scopeKey: string, from: string, to: string): void {
    try { this.options.store.bindSource?.(scopeKey, from, to); } catch (error) { this.report(error); }
  }

  /** The events of a span as they were recorded (callers filter what was forgotten). */
  between(scopeKey: string, since: string, until: string): FeelingEvent[] {
    return this.options.store.between(scopeKey, since, until);
  }

  /** The day's events still remembered (her day: owner-local, 3:00 boundary). */
  today(scopeKey: string, at: string, snapshot: CompanionStateSnapshot): FeelingEvent[] {
    const since = new Date(Date.parse(innerNoteDay(at, this.options.timeZone).endsAt) - DAY_MILLISECONDS).toISOString();
    return this.options.store.between(scopeKey, since, at).filter(event => remembered(snapshot, event.sourceId));
  }

  /** The ledger and the watch of one key, as lines for that key's own audience and as numbers. */
  linesFor(scopeKey: string, key: FeelingKey, at: string, snapshot: CompanionStateSnapshot, words = ''): FeelingLines | null {
    try {
      return observeSync('emotion', { phase: 'feeling.ledger', audience: key.audience, owner: key.personKey === OWNER_PERSON_KEY }, () => {
        const ledger = foldEpisodeLedger(this.today(scopeKey, at, snapshot), key);
        const replies = this.todaysReplies(scopeKey, key, at, snapshot);
        const watch = watchRepetition(replies, key.audience);
        // Stage 2 (`SHANNON_REPLY_CHECK`): what the check found in her last reply goes to the next feeling turn (absent without it).
        const last = [...replies].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0]?.facts.checkFlags;
        const checked: Record<string, string> = last?.length ? { last_check: last.join('|') } : {};
        const carried = this.options.days?.carried(scopeKey, key, at, snapshot, words) ?? { lines: [], facts: {} };
        return { ledger, watch, ledgerLine: episodeLine(ledger, at, this.options.partWord, this.options.timeZone), repetitionLine: repetitionLine(watch),
          facts: { ...ledgerFacts(ledger, at), ...repetitionFacts(watch), ...checked, ...carried.facts }, carriedLines: carried.lines,
          carriedTouchLines: carried.touchLines ?? carried.lines };
      }, lines => lines.facts);
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  /**
   * Her replies of this day in front of this audience, for the repetition watch (owner, 2026-10-14: it persists across the day and catches
   * 「ライ氏、」 from the first turn). The owner's are seeded from today's replies of his Talk that are not events yet (before the switch, or
   * from another path), so a watch is never empty in the morning; nothing is seeded for anyone else.
   */
  private todaysReplies(scopeKey: string, key: FeelingKey, at: string, snapshot: CompanionStateSnapshot): FeelingEvent[] {
    const since = new Date(Date.parse(innerNoteDay(at, this.options.timeZone).endsAt) - DAY_MILLISECONDS).toISOString();
    const events = this.options.store.ownReplies(scopeKey, key.audience, 16)
      .filter(event => event.occurredAt >= since && remembered(snapshot, event.sourceId));
    if (key.personKey !== OWNER_PERSON_KEY || !this.options.seed) return events;
    const known = new Set(events.map(event => event.sourceId));
    const seeded = this.options.seed(scopeKey, since, at, snapshot).filter(reply => !reply.sourceId || !known.has(reply.sourceId))
      .map((reply, index): FeelingEvent => ({ ...key, id: `seed:${index}`, kind: 'own_reply', identity: 'registered', channel: 'text',
        sourceId: reply.sourceId ?? null, facts: replyFacts(reply.text, drawersIn), occurredAt: reply.at }));
    return [...events, ...seeded];
  }

  /**
   * One strong reply of the day, if the cap allows (owner decision 2026-10-14: a daily guard on Sonnet). Counted from today's recorded
   * replies that went to the strong model, plus those decided and not yet recorded. False: the cap is reached (or the count failed).
   */
  reserveStrong(scopeKey: string, at: string, cap: number): boolean {
    try {
      const day = innerNoteDay(at, this.options.timeZone);
      const since = new Date(Date.parse(day.endsAt) - DAY_MILLISECONDS).toISOString();
      const key = `${scopeKey}\u0000${day.dayKey}`;
      const recorded = this.options.store.between(scopeKey, since, at)
        .filter(event => event.kind === 'own_reply' && event.facts.replyModel === 'strong').length;
      const now = Date.parse(at);
      const pending = (this.strongInFlight.get(key) ?? []).filter(started => now - started < FEELING_EVENT_LIMITS.strongInFlightMilliseconds);
      if (recorded + pending.length >= cap) return false;
      if (this.strongInFlight.size >= 64) this.strongInFlight.clear();
      this.strongInFlight.set(key, [...pending, now]);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  /** The check of a draft written before sending (`FeelingReplyChatModel`), for its turn (review L3: never another turn's). */
  noteCheck(scopeKey: string, flags: readonly string[], rewritten: boolean, turn = ''): void {
    if (this.checks.size >= 64) this.checks.clear();
    this.checks.set(`${scopeKey}\u0000${turn}`, { flags, rewritten });
  }

  /** The check noted for a scope's turn, once. */
  takeCheck(scopeKey: string, turn = ''): { flags: readonly string[]; rewritten: boolean } | null {
    const key = `${scopeKey}\u0000${turn}`;
    const check = this.checks.get(key) ?? null;
    this.checks.delete(key);
    return check;
  }

  /** A strong reply's turn ended (its reply is recorded, or the turn failed): it no longer counts as in flight. */
  releaseStrong(scopeKey: string, at: string): void {
    const key = `${scopeKey}\u0000${innerNoteDay(at, this.options.timeZone).dayKey}`;
    const pending = this.strongInFlight.get(key) ?? [];
    if (pending.length <= 1) this.strongInFlight.delete(key); else this.strongInFlight.set(key, pending.slice(1));
  }

  /** A turn of a call with others was heard (stage 4). */
  noteScene(scopeKey: string, sceneId: string, at: string): void {
    if (this.scenes.size >= 64) this.scenes.clear();
    this.scenes.set(scopeKey, { sceneId, at: Date.parse(at) });
  }

  /** The call with others heard within `sceneFreshMilliseconds` of an instant, or null. */
  activeScene(scopeKey: string, at: string): string | null {
    const scene = this.scenes.get(scopeKey);
    const since = scene ? Date.parse(at) - scene.at : Number.NaN;
    return scene && since >= 0 && since <= FEELING_EVENT_LIMITS.sceneFreshMilliseconds ? scene.sceneId : null;
  }

  /** A voice turn answered with this presentation id (the stored turn keeps the same id). */
  notePresented(scopeKey: string, id: string, utteranceId: string | null, at: string): void {
    if (this.presented.size >= 64) this.presented.clear();
    this.presented.set(scopeKey, { id, utteranceId, at: Date.parse(at) });
  }

  /** The id a voice turn answered with, once, while fresh and for the same utterance when both name one. */
  takePresented(scopeKey: string, utteranceId: string | null, at: string): string | null {
    const noted = this.presented.get(scopeKey);
    if (!noted) return null;
    const fresh = Date.parse(at) - noted.at <= FEELING_EVENT_LIMITS.presentedFreshMilliseconds;
    const same = !utteranceId || !noted.utteranceId || utteranceId === noted.utteranceId;
    if (!fresh || !same) return null;
    this.presented.delete(scopeKey);
    return noted.id;
  }

  /** The newest stance of a key while it is fresh (the feeling turn's on her reply, or how she took a touch). */
  freshStance(scopeKey: string, key: FeelingKey, at: string, snapshot: CompanionStateSnapshot): { kind: 'turn' | 'touch'; stance: string } | null {
    try {
      const since = new Date(Date.parse(at) - FEELING_EVENT_LIMITS.stanceFreshMilliseconds).toISOString();
      const events = this.options.store.between(scopeKey, since, at, 200).filter(event => event.personKey === key.personKey && event.audience === key.audience
        && remembered(snapshot, event.sourceId)).reverse();
      for (const event of events) {
        if (event.kind === 'own_reply' && event.facts.turnStance) return { kind: 'turn', stance: event.facts.turnStance };
        if (event.kind === 'touched' && event.facts.stance) return { kind: 'touch', stance: event.facts.stance };
      }
      return null;
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  private prune(scopeKey: string): void {
    const now = Date.parse(this.options.now());
    const last = this.pruned.get(scopeKey);
    if (last !== undefined && now - last < FEELING_EVENT_LIMITS.pruneEveryMilliseconds) return;
    this.pruned.set(scopeKey, now);
    this.options.store.prune(scopeKey, new Date(now - FEELING_EVENT_LIMITS.retentionDays * DAY_MILLISECONDS).toISOString());
  }

  private report(error: unknown): void {
    (this.options.reportError ?? (value => console.error('Shannon feeling event failed', value instanceof Error ? value.name : 'unknown')))(error);
  }
}

/** A source the owner had her forget (or hid) is not folded; an event without one always is. */
export function remembered(snapshot: CompanionStateSnapshot, sourceId: string | null): boolean {
  if (!sourceId) return true;
  const control = memoryControlFor(snapshot, sourceId);
  return !control || control.status === 'active';
}
