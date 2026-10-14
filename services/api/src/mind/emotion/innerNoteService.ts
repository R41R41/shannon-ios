import { randomUUID } from 'node:crypto';
import {
  CHARACTER_CORE, SHANNON_EMOTION_CONTINUITY, innerNoteCurrent, innerNoteDay, innerNoteExpired, livingLingering, presentShannonFeeling,
  settleInnerNote, shannonEmotionSign, sulkingIntent,
  type CompanionStateSnapshot, type InnerNote, type InnerNoteDayEnd, type InnerNoteEvent, type InnerNoteReflectionFacts,
} from '@shannon/cognition';
import { observeAsync, withObserverRun } from '../../infra/observer/observerContext.js';
import { INNER_NOTE_SERVICE_LIMITS } from '../../contracts/innerNoteContract.js';
import { emotionTiming } from './emotionTiming.js';
import type { InnerNoteReflector } from './innerNoteReflection.js';
import type { InnerNoteBodyReader, InnerNotePort, InnerNoteTouch, InnerNoteTurn } from './innerNotePorts.js';
import { eventVisible, forgetIndex, lineage, noteForgotten, sourceVisible, turnEvent } from './innerNoteLineage.js';
import { InnerNoteTouchSessions } from './innerNoteTouchSessions.js';
import type { SQLiteInnerNoteStore, StoredInnerNote } from './store/innerNoteStore.js';

/**
 * Her inner note's writer and its readers' source (Syzygy ADR-0012 D2–D4, stage 1). Core: emotion.
 *
 * - **When she reflects (D2.3).** After a touch she took (owner alone), his apology, kind word or tease addressed to her, a reply she
 *   felt at moderate or stronger; when her sulk's time runs out (its `until`, or an ordinary sulk's hour from its start); when an
 *   ordinary sulk without `until` finds the numbers back in their usual band (D2.4); when her day ends. Events close together are one
 *   reflection (`debounceMilliseconds`, at most `maximumWaitMilliseconds`). Reflections, the sweep and forgetting run one at a time
 *   on one queue, after the turn.
 * - **Her day (D4).** It ends at the earlier of 3:00 in the owner's time zone and his goodnight to her. (Not the nightly sleep job:
 *   the common task runtime moved its completion records, so the server does not read them here.) At its end she reflects once more and
 *   the note is closed; a failed closing reflection still closes it. Events of the next day stay queued for the next day.
 * - **Forgetting and retention (D3).** A note whose lineage holds a forgotten moment is deleted on the next sweep, and never read
 *   in the meantime; a reflection whose events were forgotten while it ran is discarded. Notes older than `retentionDays` (the touches'
 *   retention) are deleted.
 * - **Touches are sessions.** A run of touches is reflected on at its start, when its kind or her stance changes, at most every
 *   `touchRefreshMilliseconds`, and at its end; reflections on touches alone take at most `touchReflectionsPerDay` (see
 *   `innerNoteTouchSessions.ts`), so an hour of petting never leaves his apology without a reflection.
 * - **Cost.** At most `reflectionsPerDay` attempts a day, failures and timeouts counted.
 * Owner scope only. Without a reflector (no Haiku key) nothing is written; the character core and the prompt cleanup still apply.
 */
export interface InnerNoteServiceDependencies {
  store: Pick<SQLiteInnerNoteStore, 'latest' | 'day' | 'since' | 'lastClosedSummary' | 'append' | 'forget' | 'markClosed' | 'rebindSource' | 'pruneBefore'
    | 'attempt'>;
  reflector: InnerNoteReflector | null;
  state: { snapshot(scopeKey: string): CompanionStateSnapshot };
  /**
   * The last lines of a conversation in progress with the owner alone, oldest first (through the replay's forgetting filter), each
   * with its stored turn (`experience:<id>`): a note that read them carries them as sources (N2).
   */
  recent?(scopeKey: string, at: string): readonly { role: 'user' | 'assistant'; content: string; sourceId?: string }[];
  ownerScope: string;
  timeZone: string;
  now(): string;
  log?(line: string): void;
  limits?: Partial<typeof INNER_NOTE_SERVICE_LIMITS>;
  /** How long a note is kept: the touches' retention (`BODY_LIMITS.retentionDays`). */
  retentionDays?: number;
  /** Tests: no timers; `flush` and `sweep` are called by hand. */
  manual?: boolean;
}

interface Entry { event: InnerNoteEvent; source?: string }
/** How often an expired sulk is asked to settle before it is closed as it stands (N1). */
const SETTLE_TRIES = 3;
interface Waiting { entries: Entry[]; timer: ReturnType<typeof setTimeout> | null; firstAt: number }

export class InnerNoteService implements InnerNotePort {
  readonly timeZone: string;
  private readonly limits: typeof INNER_NOTE_SERVICE_LIMITS;
  private readonly waiting = new Map<string, Waiting>();
  private readonly reflecting = new Map<string, readonly Entry[]>();
  /** Ordinary episodes already asked to settle on their numbers (D2.4): once each. */
  private readonly settled = new Set<string>();
  /** Expired notes asked to settle (N1): how often, and not before when again. */
  private readonly settling = new Map<string, { tries: number; nextAt: number }>();
  /** The forgetting the last sweep applied (`forgetIndex` key): the sweep deletes again only when it changed. */
  private forgotKey: string | null = null;
  private latestCache = new Map<string, StoredInnerNote | null>();
  private chain: Promise<void> = Promise.resolve();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private readonly touches: InnerNoteTouchSessions;
  /** Her recent touch lines as the newest touch handed them on, for the next reflection of that day. */
  private readonly bodyLines = new Map<string, { dayKey: string; lines: readonly string[] }>();
  /** When the owner alone last touched her: a turn about touching soon after it is about her body. */
  private readonly lastTouchAt = new Map<string, number>();
  private body: InnerNoteBodyReader | null = null;

  constructor(private readonly dependencies: InnerNoteServiceDependencies) {
    this.timeZone = dependencies.timeZone;
    this.limits = { ...INNER_NOTE_SERVICE_LIMITS, ...dependencies.limits };
    this.touches = new InnerNoteTouchSessions({ quietMilliseconds: this.limits.touchQuietMilliseconds,
      refreshMilliseconds: this.limits.touchRefreshMilliseconds, held: this.limits.touchHeld });
  }

  start(): () => void {
    if (this.dependencies.manual || this.sweeper) return () => this.stop();
    this.sweeper = setInterval(() => { void this.sweep(); }, this.limits.sweepMilliseconds);
    this.sweeper.unref?.();
    return () => this.stop();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const waiting of this.waiting.values()) if (waiting.timer) clearTimeout(waiting.timer);
  }

  /** Her newest note while it belongs to the present and nothing of it was forgotten (a forgotten one is deleted on the queue). */
  current(scopeKey: string, at: string): InnerNote | null {
    if (scopeKey !== this.dependencies.ownerScope) return null;
    const note = this.latest(scopeKey);
    if (!note || !innerNoteCurrent(note, at)) return null;
    if (!noteForgotten(this.dependencies.state.snapshot(scopeKey), note)) return note;
    void this.schedule(async () => this.forget(scopeKey, true));
    return null;
  }

  pending(scopeKey: string): readonly InnerNoteEvent[] {
    const snapshot = this.dependencies.state.snapshot(scopeKey);
    return [...this.reflecting.get(scopeKey) ?? [], ...this.touches.waiting(scopeKey), ...this.waiting.get(scopeKey)?.entries ?? []]
      .filter(entry => this.entryVisible(snapshot, entry)).map(entry => entry.event);
  }

  turnEnded(turn: InnerNoteTurn): void {
    try {
      if (turn.scopeKey !== this.dependencies.ownerScope || !turn.alone) return;
      const last = this.lastTouchAt.get(turn.scopeKey);
      const since = last === undefined ? Number.NaN : Date.parse(turn.at) - last;
      const { event, goodnight } = turnEvent(turn, { recentTouch: since >= 0 && since <= this.limits.consentTouchMilliseconds });
      if (event) this.enqueue(turn.scopeKey, event, turn.sourceId);
      if (goodnight) void this.schedule(() => this.closeDay(turn.scopeKey, 'goodnight'));
    } catch (error) { this.log('turn', error); }
  }

  touched(touch: InnerNoteTouch): void {
    try {
      // ADR-0005 decision 6: a touch anyone else may have made leaves her no note.
      if (touch.scopeKey !== this.dependencies.ownerScope || touch.audience !== 'owner') return;
      const entry = { event: { kind: 'touch' as const, at: touch.at, touch: { phrase: touch.phrase, ...(touch.stance ? { stance: touch.stance } : {}),
        ...(touch.reflex ? { reflex: touch.reflex } : {}), ...(touch.said ? { said: touch.said } : {}) } },
        ...(touch.sourceId ? { source: touch.sourceId } : {}) };
      this.lastTouchAt.set(touch.scopeKey, Date.parse(touch.at));
      if (touch.lines) this.bodyLines.set(touch.scopeKey, { dayKey: innerNoteDay(touch.at, this.timeZone).dayKey, lines: touch.lines });
      // Another kind, another part or another stance than the session's is reflected on at once (owner decision 2026-10-14).
      const now = this.touches.arrive(touch.scopeKey, entry, `${touch.kind ?? ''}|${touch.part ?? ''}|${touch.stance ?? ''}`, Date.parse(touch.at));
      for (const next of now) this.enqueue(touch.scopeKey, next.event, next.source);
    } catch (error) { this.log('touch', error); }
  }

  useBody(reader: InnerNoteBodyReader): void {
    this.body = reader;
  }

  /** A source known later by its stored id (a voice turn's utterance, `utterance:<id>`, once stored as `experience:<id>`). */
  bind(scopeKey: string, from: string, to: string): void {
    for (const entry of this.waiting.get(scopeKey)?.entries ?? []) if (entry.source === from) entry.source = to;
    void this.schedule(async () => {
      this.dependencies.store.rebindSource(scopeKey, from, to);
      this.latestCache.delete(scopeKey);
    });
  }

  /** Reflects now on what is waiting for a scope (tests; the timers call it). */
  flush(scopeKey: string): Promise<void> {
    const waiting = this.waiting.get(scopeKey);
    if (!waiting) return this.chain;
    if (waiting.timer) clearTimeout(waiting.timer);
    this.waiting.delete(scopeKey);
    return this.schedule(async () => { await this.reflect(scopeKey, waiting.entries, null); });
  }

  /** Retention, forgetting, the day's end and a sulk that ran out (every minute; tests call it by hand). On the one queue. */
  sweep(): Promise<void> {
    const scopeKey = this.dependencies.ownerScope;
    return this.schedule(async () => {
      this.retain(scopeKey);
      this.forget(scopeKey);
      const at = this.dependencies.now();
      for (const held of this.touches.ended(scopeKey, Date.parse(at))) this.enqueue(scopeKey, held.event, held.source);
      const note = this.latest(scopeKey);
      if (!note || note.closedAt) return;
      if (at >= note.dayEndsAt) return await this.closeDay(scopeKey, 'three');
      if (innerNoteExpired(note, at)) return this.settleExpired(scopeKey, note, at);
      if (this.calmSettling(scopeKey, note, at)) this.enqueue(scopeKey, { kind: 'until', at }, undefined);
    });
  }

  /**
   * N1: an expired sulk asks her to settle, again with backoff while the reflection fails (2, 4, 8 minutes); after
   * `SETTLE_TRIES` failures the note is closed as it stands, so a sulk never lingers past its time.
   */
  private settleExpired(scopeKey: string, note: StoredInnerNote, at: string): void {
    const state = this.settling.get(note.id) ?? { tries: 0, nextAt: 0 };
    if (Date.parse(at) < state.nextAt) return;
    if (state.tries >= SETTLE_TRIES) {
      this.dependencies.log?.('inner_note_settle_gave_up');
      this.settling.delete(note.id);
      return this.endEpisode(scopeKey, note, at);
    }
    if (this.settling.size >= 64) this.settling.clear();
    this.settling.set(note.id, { tries: state.tries + 1, nextAt: Date.parse(at) + 2 ** (state.tries + 1) * 60_000 });
    this.enqueue(scopeKey, { kind: 'until', at }, undefined);
  }

  /** Waits for everything queued so far (tests, shutdown). */
  idle(): Promise<void> { return this.chain; }

  /** D2.4: an ordinary sulk without `until` whose numbers are back in their usual band asks her to settle, once per episode. */
  private calmSettling(scopeKey: string, note: StoredInnerNote, at: string): boolean {
    const calm = sulkingIntent(note.hooks.intent) && note.hooks.scale === 'ordinary' && note.hooks.until === null
      && holding(this.dependencies.state.snapshot(scopeKey), at) < SHANNON_EMOTION_CONTINUITY.visibleFrom;
    return calm && this.once(`episode:${note.episodeStartedAt ?? note.id}`);
  }

  private once(key: string): boolean {
    if (this.settled.has(key)) return false;
    if (this.settled.size >= 512) this.settled.clear();
    this.settled.add(key);
    return true;
  }

  private enqueue(scopeKey: string, event: InnerNoteEvent, source: string | undefined): void {
    const waiting = this.waiting.get(scopeKey) ?? { entries: [], timer: null, firstAt: Date.now() };
    // A reflection on anything but a touch takes the touches a session holds (they are part of what happened).
    if (event.kind !== 'touch') waiting.entries.push(...this.touches.fold(scopeKey));
    waiting.entries.push({ event, ...(source ? { source } : {}) });
    this.waiting.set(scopeKey, waiting);
    if (this.dependencies.manual) return;
    if (waiting.timer) clearTimeout(waiting.timer);
    const left = Math.max(0, this.limits.maximumWaitMilliseconds - (Date.now() - waiting.firstAt));
    waiting.timer = setTimeout(() => { void this.flush(scopeKey); }, Math.min(this.limits.debounceMilliseconds, left));
    waiting.timer.unref?.();
  }

  private schedule(work: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(work).catch(error => this.log('reflect', error));
    return this.chain;
  }

  /** Closes the note's day with a reflection; events after the day's end stay queued for the next day. Runs on the queue. */
  private async closeDay(scopeKey: string, reason: InnerNoteDayEnd): Promise<void> {
    const note = this.latest(scopeKey);
    if (!note || note.closedAt) return;
    const at = this.dependencies.now();
    const waiting = this.waiting.get(scopeKey);
    const held = this.touches.fold(scopeKey);
    this.touches.carry(scopeKey, held.filter(entry => entry.event.at >= note.dayEndsAt));
    const ofDay = [...held.filter(entry => entry.event.at < note.dayEndsAt), ...waiting?.entries.filter(entry => entry.event.at < note.dayEndsAt) ?? []];
    if (waiting) waiting.entries = waiting.entries.filter(entry => entry.event.at >= note.dayEndsAt);
    if (waiting && !waiting.entries.length) {
      if (waiting.timer) clearTimeout(waiting.timer);
      this.waiting.delete(scopeKey);
    }
    const written = await this.reflect(scopeKey, [...ofDay, { event: { kind: 'day_end', at, dayEnd: reason } }], reason).catch(() => false);
    // Never carried into the next day: without a closing note, the newest one is closed as it stands.
    if (!written) this.markClosed(scopeKey, at);
  }

  /**
   * N8: her sulk ends in code after its settling failed: one row of the same day, calm (intent none, no until, nothing shown), marked
   * `endedByCode`; the day goes on (its id, its apologies, its summary). Readers give its words only as what she felt a while ago.
   */
  private endEpisode(scopeKey: string, note: StoredInnerNote, at: string): void {
    this.dependencies.store.append({ scopeKey, dayId: note.dayId, dayKey: note.dayKey, dayEndsAt: note.dayEndsAt, text: note.text,
      hooks: { ...note.hooks, shown: 'neutral', tell: 'none', until: null, intent: 'none' }, triggers: ['until'], events: [], sourceIds: note.sourceIds,
      flags: { endedByCode: true }, changeReason: null, summary: null, coreVersion: CHARACTER_CORE.version, coreHash: CHARACTER_CORE.hash,
      episodeStartedAt: null, usage: null, elapsedMs: 0, createdAt: at, closing: false });
    this.latestCache.delete(scopeKey);
  }

  private markClosed(scopeKey: string, at: string): void {
    this.dependencies.store.markClosed(scopeKey, at);
    this.latestCache.delete(scopeKey);
  }

  /** One reflection: the facts, the call, the gates, the row. Resolves true when a note was written. Runs on the queue. */
  private async reflect(scopeKey: string, entries: readonly Entry[], closing: InnerNoteDayEnd | null): Promise<boolean> {
    const { reflector } = this.dependencies;
    const visible = entries.filter(entry => this.entryVisible(this.dependencies.state.snapshot(scopeKey), entry));
    if (!reflector || !visible.length) return false;
    const at = this.dependencies.now();
    const previousNote = this.latest(scopeKey);
    // A day that ended before anyone closed it is closed first (always with a reflection of its own), then the new day begins.
    if (!closing && previousNote && !previousNote.closedAt && !innerNoteCurrent(previousNote, at)) await this.closeDay(scopeKey, 'three');
    const open = this.latest(scopeKey);
    const previous = open && !open.closedAt && (closing !== null || innerNoteCurrent(open, at)) ? open : null;
    if (!closing && !this.attempt(scopeKey, previous?.dayKey ?? innerNoteDay(at, this.timeZone).dayKey, visible)) return false;
    this.reflecting.set(scopeKey, visible);
    try {
      return await withObserverRun({ scopeKey, surface: 'inner_note', runId: randomUUID() }, () =>
        observeAsync('emotion', { phase: 'inner_note.reflect', triggers: visible.map(entry => entry.event.kind), previousIntent: previous?.hooks.intent ?? null,
          coreVersion: CHARACTER_CORE.version }, () => this.write(scopeKey, at, previous, visible, closing),
        written => written ? observed(this.latest(scopeKey), previous) : { written: false }));
    } finally {
      this.reflecting.delete(scopeKey);
    }
  }

  /**
   * Counts an attempt against the day's cap in the database (a restart keeps it), whatever becomes of it: failures cost too. A
   * reflection on touches alone first takes one of the touches' own (`<day>/touch`); past it, the touches wait for his words.
   */
  private attempt(scopeKey: string, dayKey: string, entries: readonly Entry[]): boolean {
    const touchesOnly = entries.every(entry => entry.event.kind === 'touch');
    if (touchesOnly && !this.dependencies.store.attempt(scopeKey, `${dayKey}/touch`, this.limits.touchReflectionsPerDay)) {
      this.dependencies.log?.('inner_note_touch_cap');
      this.touches.carry(scopeKey, entries);
      return false;
    }
    if (this.dependencies.store.attempt(scopeKey, dayKey, this.limits.reflectionsPerDay)) return true;
    this.dependencies.log?.('inner_note_daily_cap');
    return false;
  }

  private async write(scopeKey: string, at: string, previous: StoredInnerNote | null, entries: readonly Entry[], closing: InnerNoteDayEnd | null) {
    const started = performance.now();
    const fresh = innerNoteDay(at, this.timeZone);
    const day = previous ? { dayId: previous.dayId, dayKey: previous.dayKey, dayEndsAt: previous.dayEndsAt }
      : { dayId: null, dayKey: fresh.dayKey, dayEndsAt: fresh.endsAt };
    const snapshot = this.dependencies.state.snapshot(scopeKey);
    const events = entries.map(entry => entry.event);
    const yesterday = previous && !closing ? null : this.dependencies.store.lastClosedSummary(scopeKey);
    const recent = this.recent(scopeKey, at);
    const facts = this.facts(scopeKey, at, previous, events, day.dayEndsAt, closing !== null, snapshot, previous ? null : yesterday?.summary ?? null, recent);
    const { draft, usage } = await this.dependencies.reflector!.reflect({ scopeKey, facts, signal: AbortSignal.timeout(this.limits.timeoutMilliseconds) });
    if (!draft) return this.unreadable();
    // Forgotten while the call ran: what it wrote is about a moment he took back, and is not kept.
    if (!entries.every(entry => this.entryVisible(this.dependencies.state.snapshot(scopeKey), entry))) return this.discarded();
    const triggers = [...new Set(events.map(event => event.kind))];
    const settled = settleInnerNote({ draft, previous, triggers, at, dayEndsAt: day.dayEndsAt, holding: holding(snapshot, at),
      visibleFrom: SHANNON_EMOTION_CONTINUITY.visibleFrom });
    this.dependencies.store.append({ scopeKey, ...day, text: draft.text, hooks: settled.hooks, triggers, events,
      sourceIds: lineage([...entries.map(entry => entry.source), ...recent.map(line => line.sourceId)], previous, previous ? null : summarySources(yesterday),
        closing && yesterday ? { yesterday: summarySources(yesterday)!.sourceIds } : null), flags: settled.flags, changeReason: draft.changeReason,
      summary: closing ? draft.summary : null, coreVersion: CHARACTER_CORE.version, coreHash: CHARACTER_CORE.hash, episodeStartedAt: settled.episodeStartedAt,
      usage, elapsedMs: performance.now() - started, createdAt: at, closing: closing !== null });
    this.latestCache.delete(scopeKey);
    return true;
  }

  private facts(scopeKey: string, at: string, previous: StoredInnerNote | null, events: readonly InnerNoteEvent[], dayEndsAt: string, closing: boolean,
    snapshot: CompanionStateSnapshot, yesterday: string | null, recent: readonly { role: 'user' | 'assistant'; content: string }[]): InnerNoteReflectionFacts {
    const before = previous ? this.dependencies.store.day(scopeKey, previous.dayId).flatMap(note => note.events) : [];
    const all = [...before, ...events];
    const timing = emotionTiming();
    const present = presentShannonFeeling(snapshot, at, timing);
    return {
      at, timeZone: this.timeZone, events, previous, dayEndsAt, closing, yesterday, ...this.bodyFacts(scopeKey, at, all, snapshot),
      apologies: all.filter(event => event.kind === 'apology').map(event => event.at),
      kindnesses: all.filter(event => event.kind === 'kindness').map(event => event.at),
      feeling: { present: present.primary === 'neutral' ? null : { kind: present.primary, intensity: present.intensity },
        lingering: livingLingering(snapshot, at, timing).slice(0, 3).map(item => ({ kind: item.feeling.kind, strength: item.strength })) },
      recent: recent.map(line => ({ role: line.role, content: line.content })),
    };
  }

  /**
   * Her body this day (owner decision 2026-10-14): how often each part was touched since her day began, read from the body now (so what
   * he had her forget since is left out), her recent lines of that day while their words may still be read, and the day's turns about
   * touching her.
   */
  private bodyFacts(scopeKey: string, at: string, all: readonly InnerNoteEvent[], snapshot: CompanionStateSnapshot)
    : Pick<InnerNoteReflectionFacts, 'touches' | 'consents' | 'ledger' | 'fastLayer' | 'relationship'> {
    const consents = all.filter(event => event.consent !== undefined && eventVisible(snapshot, event));
    const day = innerNoteDay(at, this.timeZone);
    const today = this.partCounts(scopeKey, new Date(Date.parse(day.endsAt) - 86_400_000).toISOString(), at);
    const kept = this.bodyLines.get(scopeKey);
    const lines = kept?.dayKey === day.dayKey ? kept.lines.filter(said => eventVisible(snapshot, { kind: 'touch', at, touch: { phrase: '', said } })) : [];
    const touches = today.length || lines.length ? { today, lines } : null;
    const ledger = this.ledgerLine(scopeKey, at);
    const fast = this.fastLayer(scopeKey, at);
    const relationship = this.relationship(scopeKey, at);
    return { ...(touches ? { touches } : {}), ...(consents.length ? { consents } : {}), ...(ledger ? { ledger } : {}),
      ...(fast !== null ? { fastLayer: fast } : {}), ...(relationship !== null ? { relationship } : {}) };
  }

  private partCounts(scopeKey: string, since: string, at: string): readonly { part: string; count: number }[] {
    try { return (this.body?.partCounts(scopeKey, since, at) ?? []).filter(item => item.count > 0); } catch { return []; }
  }

  /** ADR-0013: the same ledger line her replies are given ('' without feeling events). */
  private ledgerLine(scopeKey: string, at: string): string {
    try { return this.body?.ledger?.(scopeKey, at) ?? ''; } catch { return ''; }
  }

  /** ADR-0013 §6: her fast layer in words while she is the narrator, else null (the reflection of before). */
  private fastLayer(scopeKey: string, at: string): string | null {
    try { return this.body?.fastLayer?.(scopeKey, at) ?? null; } catch { return null; }
  }

  /** Stage 3: the relationship line while the ledger carries over (ADR-0012 D4 as revised), else null. */
  private relationship(scopeKey: string, at: string): string | null {
    try { return this.body?.relationship?.(scopeKey, at) ?? null; } catch { return null; }
  }

  private recent(scopeKey: string, at: string) {
    try { return (this.dependencies.recent?.(scopeKey, at) ?? []).slice(-this.limits.recentLines); } catch { return []; }
  }

  private latest(scopeKey: string): StoredInnerNote | null {
    if (!this.latestCache.has(scopeKey)) this.latestCache.set(scopeKey, this.dependencies.store.latest(scopeKey));
    return this.latestCache.get(scopeKey) ?? null;
  }

  private entryVisible(snapshot: CompanionStateSnapshot, entry: Entry): boolean {
    return (!entry.source || sourceVisible(snapshot, entry.source)) && eventVisible(snapshot, entry.event);
  }

  /** Deletes what the owner had her forget; the stored notes are scanned only when his forgetting changed (N3). */
  private forget(scopeKey: string, always = false): void {
    const snapshot = this.dependencies.state.snapshot(scopeKey);
    const waiting = this.waiting.get(scopeKey);
    if (waiting) waiting.entries = waiting.entries.filter(entry => this.entryVisible(snapshot, entry));
    const key = forgetIndex(snapshot).key;
    if (!always && key === this.forgotKey) return;
    this.forgotKey = key;
    const removed = this.dependencies.store.forget(scopeKey, note => noteForgotten(snapshot, note));
    this.latestCache.delete(scopeKey);
    if (removed) this.dependencies.log?.(`inner_note_forgotten=${removed}`);
  }

  private retain(scopeKey: string): void {
    const days = this.dependencies.retentionDays;
    if (!days) return;
    const before = new Date(Date.parse(this.dependencies.now()) - days * 86_400_000).toISOString();
    if (this.dependencies.store.pruneBefore(scopeKey, before)) this.latestCache.delete(scopeKey);
  }

  private unreadable(): false {
    this.dependencies.log?.('inner_note_unreadable');
    return false;
  }

  private discarded(): false {
    this.dependencies.log?.('inner_note_discarded_forgotten');
    return false;
  }

  private log(where: string, error: unknown): void {
    this.dependencies.log?.(`inner_note_${where}_failed ${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`);
  }
}

/** How strongly she still holds an unpleasant feeling (the D3 mark of forgiving while the numbers are high; D2.4's band). */
function holding(snapshot: CompanionStateSnapshot, at: string): number {
  const strengths = livingLingering(snapshot, at, emotionTiming()).filter(item => shannonEmotionSign(item.feeling.kind) < 0).map(item => item.strength);
  return strengths.length ? Math.max(...strengths) : 0;
}

/** What the Observer sees of a reflection: the hooks, the change of intent and the marks; never her words (D3). */
function observed(note: StoredInnerNote | null, previous: StoredInnerNote | null) {
  if (!note) return { written: false };
  return { written: true, intent: { from: previous?.hooks.intent ?? null, to: note.hooks.intent }, shown: note.hooks.shown, tell: note.hooks.tell,
    scale: note.hooks.scale, until: note.hooks.until, closed: note.closedAt !== null, flags: Object.keys(note.flags),
    costUsd: note.usage?.costUsd ?? null, cacheReadTokens: note.usage?.cacheReadTokens ?? null, elapsedMs: note.elapsedMs };
}

/** A day summary as a source: its own sources and the note itself (`note:<id>`), so that deleting the summary takes what read it (N6). */
function summarySources(summary: { id: string; sourceIds: readonly string[] } | null): { sourceIds: readonly string[] } | null {
  return summary ? { sourceIds: [...summary.sourceIds, `note:${summary.id}`] } : null;
}
