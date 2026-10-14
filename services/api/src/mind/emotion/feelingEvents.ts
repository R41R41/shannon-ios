import {
  OWNER_PERSON_KEY, drawersIn, episodeLine, replyFacts, foldEpisodeLedger, innerNoteDay, ledgerFacts, memoryControlFor, repetitionFacts,
  repetitionLine, watchRepetition,
  type CompanionStateSnapshot, type EpisodeLedger, type FeelingAudience, type FeelingEvent, type RepetitionWatch,
} from '@shannon/cognition';
import { observeSync } from '../../infra/observer/observerContext.js';

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
}

export interface FeelingKey {
  personKey: string;
  audience: FeelingAudience;
  sceneId: string | null;
}

export const FEELING_EVENT_LIMITS = Object.freeze({
  /** A stance is her face for this long after it was taken. */
  stanceFreshMilliseconds: 10 * 60_000,
  retentionDays: 30,
  pruneEveryMilliseconds: 60 * 60_000,
});

const DAY_MILLISECONDS = 24 * 60 * 60_000;

export class FeelingEvents {
  private readonly pruned = new Map<string, number>();

  constructor(private readonly options: { store: FeelingEventRecords; now: () => string; timeZone: string; partWord: (subject: string) => string;
    reportError?: (error: unknown) => void; seed?: RepetitionSeed }) {}

  get timeZone(): string { return this.options.timeZone; }

  /** One event in. The Observer sees its closed shape (kind, who, audience, register, composure), never words. */
  record(scopeKey: string, event: FeelingEvent): void {
    try {
      observeSync('emotion', { phase: 'feeling.event', kind: event.kind, identity: event.identity, audience: event.audience, channel: event.channel,
        composure: 1, register: event.facts.register ?? 'normal', stance: event.facts.stance ?? null, opener: event.facts.opener ?? null },
      () => this.options.store.record(scopeKey, event, this.options.now()), written => ({ written }));
      this.prune(scopeKey);
    } catch (error) { this.report(error); }
  }

  /** A voice utterance's events take the stored turn's id once the app stores it (so forgetting the turn forgets them). */
  bind(scopeKey: string, from: string, to: string): void {
    try { this.options.store.bindSource?.(scopeKey, from, to); } catch (error) { this.report(error); }
  }

  /** The day's events still remembered (her day: owner-local, 3:00 boundary). */
  today(scopeKey: string, at: string, snapshot: CompanionStateSnapshot): FeelingEvent[] {
    const since = new Date(Date.parse(innerNoteDay(at, this.options.timeZone).endsAt) - DAY_MILLISECONDS).toISOString();
    return this.options.store.between(scopeKey, since, at).filter(event => remembered(snapshot, event.sourceId));
  }

  /** The ledger and the watch of one key, as lines for that key's own audience and as numbers. */
  linesFor(scopeKey: string, key: FeelingKey, at: string, snapshot: CompanionStateSnapshot): FeelingLines | null {
    try {
      return observeSync('emotion', { phase: 'feeling.ledger', audience: key.audience, owner: key.personKey === OWNER_PERSON_KEY }, () => {
        const ledger = foldEpisodeLedger(this.today(scopeKey, at, snapshot), key);
        const watch = watchRepetition(this.todaysReplies(scopeKey, key, at, snapshot), key.audience);
        return { ledger, watch, ledgerLine: episodeLine(ledger, at, this.options.partWord, this.options.timeZone), repetitionLine: repetitionLine(watch),
          facts: { ...ledgerFacts(ledger, at), ...repetitionFacts(watch) } };
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
function remembered(snapshot: CompanionStateSnapshot, sourceId: string | null): boolean {
  if (!sourceId) return true;
  const control = memoryControlFor(snapshot, sourceId);
  return !control || control.status === 'active';
}
