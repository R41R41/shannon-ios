import { randomUUID } from 'node:crypto';
import {
  CHARACTER_CORE, SHANNON_EMOTION_CONTINUITY, apologyIn, goodnightIn, innerNoteCurrent, innerNoteDay, livingLingering, presentShannonFeeling,
  settleInnerNote, shannonEmotionSign, soothingIn, teasingIn, visibleMemoryText,
  type CompanionStateSnapshot, type InnerNote, type InnerNoteDayEnd, type InnerNoteEvent, type InnerNoteReflectionFacts,
} from '@shannon/cognition';
import { observeAsync, withObserverRun } from '../../infra/observer/observerContext.js';
import { INNER_NOTE_SERVICE_LIMITS } from '../../contracts/innerNoteContract.js';
import { emotionTiming } from './emotionTiming.js';
import type { InnerNoteReflector } from './innerNoteReflection.js';
import type { InnerNotePort, InnerNoteTouch, InnerNoteTurn } from './innerNotePorts.js';
import type { SQLiteInnerNoteStore, StoredInnerNote } from './store/innerNoteStore.js';

/**
 * Her inner note's writer and its readers' source (Syzygy ADR-0012 D2–D4, stage 1). Core: emotion.
 *
 * - **When she reflects (D2.3).** After a touch she took (owner alone), an apology or kind word of his (`soothingIn`), a tease, a
 *   reply whose feeling was moderate or stronger; when the `until` she set comes; and when her day ends. Events close together are
 *   one reflection (`debounceMilliseconds`, at most `maximumWaitMilliseconds`). Reflections run one at a time, after the turn.
 * - **Her day (D4).** It ends at the earlier of 3:00 in the owner's time zone, the nightly sleep having run, and his goodnight. At
 *   its end she always reflects once more and the note is closed (never carried into the next day). A failed closing reflection
 *   still closes the note.
 * - **What the readers get.** `current` is the newest note while it belongs to the present; `pending` what happened since.
 * - **Forgetting.** A note whose source the owner had her forget is deleted on the next sweep.
 * Owner scope only. Without a reflector (no Haiku key) nothing is written and every reader finds nothing.
 */
export interface InnerNoteServiceDependencies {
  store: Pick<SQLiteInnerNoteStore, 'latest' | 'day' | 'since' | 'lastClosedSummary' | 'append' | 'forget' | 'markClosed'>;
  reflector: InnerNoteReflector | null;
  state: { snapshot(scopeKey: string): CompanionStateSnapshot };
  /** The last lines of a conversation in progress with the owner alone, oldest first (through the replay's forgetting filter). */
  recent?(scopeKey: string, at: string): readonly { role: 'user' | 'assistant'; content: string }[];
  /** The instant her nightly sleep for `dayKey` (or later) completed after `since`, or null (the day may end there, D4). */
  sleptAfter?(scopeKey: string, since: string, dayKey: string): string | null;
  ownerScope: string;
  timeZone: string;
  now(): string;
  log?(line: string): void;
  limits?: Partial<typeof INNER_NOTE_SERVICE_LIMITS>;
  /** Tests: no timers; `flush` and `sweep` are called by hand. */
  manual?: boolean;
}

interface Waiting {
  events: InnerNoteEvent[];
  sources: string[];
  timer: ReturnType<typeof setTimeout> | null;
  firstAt: number;
}

export class InnerNoteService implements InnerNotePort {
  readonly timeZone: string;
  private readonly limits: typeof INNER_NOTE_SERVICE_LIMITS;
  private readonly waiting = new Map<string, Waiting>();
  private readonly reflecting = new Map<string, readonly InnerNoteEvent[]>();
  private readonly untilSeen = new Set<string>();
  private latestCache = new Map<string, StoredInnerNote | null>();
  private chain: Promise<void> = Promise.resolve();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly dependencies: InnerNoteServiceDependencies) {
    this.timeZone = dependencies.timeZone;
    this.limits = { ...INNER_NOTE_SERVICE_LIMITS, ...dependencies.limits };
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

  current(scopeKey: string, at: string): InnerNote | null {
    if (scopeKey !== this.dependencies.ownerScope) return null;
    const note = this.latest(scopeKey);
    return note && innerNoteCurrent(note, at) ? note : null;
  }

  pending(scopeKey: string): readonly InnerNoteEvent[] {
    return [...this.reflecting.get(scopeKey) ?? [], ...this.waiting.get(scopeKey)?.events ?? []];
  }

  turnEnded(turn: InnerNoteTurn): void {
    try {
      if (turn.scopeKey !== this.dependencies.ownerScope || !turn.alone) return;
      const event = turnEvent(turn);
      if (event) this.enqueue(turn.scopeKey, event, turn.sourceId);
      if (goodnightIn(turn.userMessage)) this.schedule(() => this.closeDay(turn.scopeKey, 'goodnight'));
    } catch (error) { this.log('turn', error); }
  }

  touched(touch: InnerNoteTouch): void {
    try {
      // ADR-0005 decision 6: a touch anyone else may have made leaves her no note.
      if (touch.scopeKey !== this.dependencies.ownerScope || touch.audience !== 'owner') return;
      this.enqueue(touch.scopeKey, { kind: 'touch', at: touch.at, touch: { phrase: touch.phrase, ...(touch.stance ? { stance: touch.stance } : {}),
        ...(touch.reflex ? { reflex: touch.reflex } : {}), ...(touch.said ? { said: touch.said } : {}) } }, `touch:${touch.touchId}`);
    } catch (error) { this.log('touch', error); }
  }

  /** Reflects now on what is waiting for a scope (tests; the timers call it). */
  flush(scopeKey: string): Promise<void> {
    const waiting = this.waiting.get(scopeKey);
    if (!waiting) return this.chain;
    if (waiting.timer) clearTimeout(waiting.timer);
    this.waiting.delete(scopeKey);
    return this.schedule(async () => { await this.reflect(scopeKey, waiting.events, waiting.sources, null); });
  }

  /** The `until` that came, the day that ended, and what she was asked to forget (every minute; tests call it by hand). */
  async sweep(): Promise<void> {
    const scopeKey = this.dependencies.ownerScope;
    try {
      this.forget(scopeKey);
      const note = this.latest(scopeKey);
      if (!note || note.closedAt) return;
      const at = this.dependencies.now();
      const ended = this.dayEnded(note, at);
      if (ended) return await this.schedule(() => this.closeDay(scopeKey, ended));
      if (note.hooks.until && at >= note.hooks.until && !this.untilSeen.has(note.id)) {
        this.untilSeen.add(note.id);
        this.enqueue(scopeKey, { kind: 'until', at }, undefined);
      }
    } catch (error) { this.log('sweep', error); }
  }

  /** Waits for every reflection queued so far (tests, shutdown). */
  idle(): Promise<void> { return this.chain; }

  private dayEnded(note: StoredInnerNote, at: string): InnerNoteDayEnd | null {
    if (at >= note.dayEndsAt) return 'three';
    const first = this.dependencies.store.day(this.dependencies.ownerScope, note.dayId)[0];
    const slept = first ? this.dependencies.sleptAfter?.(this.dependencies.ownerScope, first.createdAt, note.dayKey) : null;
    return slept && slept <= at ? 'sleep' : null;
  }

  private enqueue(scopeKey: string, event: InnerNoteEvent, sourceId: string | undefined): void {
    const waiting = this.waiting.get(scopeKey) ?? { events: [], sources: [], timer: null, firstAt: Date.now() };
    waiting.events.push(event);
    if (sourceId) waiting.sources.push(sourceId);
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

  private async closeDay(scopeKey: string, reason: InnerNoteDayEnd): Promise<void> {
    const note = this.latest(scopeKey);
    if (!note || note.closedAt) return;
    const waiting = this.waiting.get(scopeKey);
    if (waiting?.timer) clearTimeout(waiting.timer);
    this.waiting.delete(scopeKey);
    const at = this.dependencies.now();
    const closing: InnerNoteEvent = { kind: 'day_end', at, dayEnd: reason };
    const written = await this.reflect(scopeKey, [...waiting?.events ?? [], closing], waiting?.sources ?? [], reason).catch(() => false);
    // Never carried into the next day: without a closing note, the newest one is closed as it stands.
    if (!written) this.markClosed(scopeKey, at);
  }

  private markClosed(scopeKey: string, at: string): void {
    this.dependencies.store.markClosed(scopeKey, at);
    this.latestCache.delete(scopeKey);
  }

  /** One reflection: the facts, the call, the gates, the row. Resolves true when a note was written. */
  private async reflect(scopeKey: string, events: readonly InnerNoteEvent[], sources: readonly string[], closing: InnerNoteDayEnd | null): Promise<boolean> {
    const { reflector } = this.dependencies;
    if (!reflector || !events.length) return false;
    const at = this.dependencies.now();
    const previousNote = this.latest(scopeKey);
    // A day that ended before anyone closed it is closed first (always with a reflection of its own), then the new day begins.
    if (!closing && previousNote && !previousNote.closedAt && !innerNoteCurrent(previousNote, at)) await this.closeDay(scopeKey, 'three');
    const open = this.latest(scopeKey);
    const previous = open && !open.closedAt && (closing !== null || innerNoteCurrent(open, at)) ? open : null;
    if (!closing && this.reflectionsToday(scopeKey, at, previous) >= this.limits.reflectionsPerDay) {
      this.dependencies.log?.('inner_note_daily_cap');
      return false;
    }
    this.reflecting.set(scopeKey, events);
    try {
      return await withObserverRun({ scopeKey, surface: 'inner_note', runId: randomUUID() }, () =>
        observeAsync('emotion', { phase: 'inner_note.reflect', triggers: events.map(event => event.kind), previousIntent: previous?.hooks.intent ?? null,
          coreVersion: CHARACTER_CORE.version }, () => this.write(scopeKey, at, previous, events, sources, closing),
        written => written ? observed(this.latest(scopeKey), previous) : { written: false }));
    } finally {
      this.reflecting.delete(scopeKey);
    }
  }

  private async write(scopeKey: string, at: string, previous: StoredInnerNote | null, events: readonly InnerNoteEvent[], sources: readonly string[],
    closing: InnerNoteDayEnd | null): Promise<boolean> {
    const started = performance.now();
    const fresh = innerNoteDay(at, this.timeZone);
    const day = previous ? { dayId: previous.dayId, dayKey: previous.dayKey, dayEndsAt: previous.dayEndsAt }
      : { dayId: null, dayKey: fresh.dayKey, dayEndsAt: fresh.endsAt };
    const snapshot = this.dependencies.state.snapshot(scopeKey);
    const facts = this.facts(scopeKey, at, previous, events, day.dayEndsAt, closing !== null, snapshot);
    const signal = AbortSignal.timeout(this.limits.timeoutMilliseconds);
    const { draft, usage } = await this.dependencies.reflector!.reflect({ scopeKey, facts, signal });
    if (!draft) return this.unreadable();
    const triggers = [...new Set(events.map(event => event.kind))];
    const settled = settleInnerNote({ draft, previous, triggers, at, dayEndsAt: day.dayEndsAt, holding: holding(snapshot, at),
      visibleFrom: SHANNON_EMOTION_CONTINUITY.visibleFrom });
    this.dependencies.store.append({ scopeKey, ...day, text: draft.text, hooks: settled.hooks, triggers, events, sourceIds: [...new Set(sources)],
      flags: settled.flags, changeReason: draft.changeReason, summary: closing ? draft.summary : null, coreVersion: CHARACTER_CORE.version,
      coreHash: CHARACTER_CORE.hash, usage, elapsedMs: performance.now() - started, createdAt: at, closing: closing !== null });
    this.latestCache.delete(scopeKey);
    return true;
  }

  private facts(scopeKey: string, at: string, previous: StoredInnerNote | null, events: readonly InnerNoteEvent[], dayEndsAt: string, closing: boolean,
    snapshot: CompanionStateSnapshot): InnerNoteReflectionFacts {
    const before = previous ? this.dependencies.store.day(scopeKey, previous.dayId).flatMap(note => note.events) : [];
    const all = [...before, ...events];
    const timing = emotionTiming();
    const present = presentShannonFeeling(snapshot, at, timing);
    return {
      at, timeZone: this.timeZone, events, previous, dayEndsAt, closing,
      apologies: all.filter(event => event.kind === 'apology').map(event => event.at),
      kindnesses: all.filter(event => event.kind === 'kindness').map(event => event.at),
      feeling: { present: present.primary === 'neutral' ? null : { kind: present.primary, intensity: present.intensity },
        lingering: livingLingering(snapshot, at, timing).slice(0, 3).map(item => ({ kind: item.feeling.kind, strength: item.strength })) },
      yesterday: previous ? null : this.dependencies.store.lastClosedSummary(scopeKey)?.summary ?? null,
      recent: this.recent(scopeKey, at),
    };
  }

  private recent(scopeKey: string, at: string) {
    try { return (this.dependencies.recent?.(scopeKey, at) ?? []).slice(-this.limits.recentLines); } catch { return []; }
  }

  private reflectionsToday(scopeKey: string, at: string, previous: StoredInnerNote | null): number {
    const dayStart = new Date(Date.parse(previous?.dayEndsAt ?? innerNoteDay(at, this.timeZone).endsAt) - 86_400_000).toISOString();
    return this.dependencies.store.since(scopeKey, dayStart, this.limits.reflectionsPerDay + 1).length;
  }

  private latest(scopeKey: string): StoredInnerNote | null {
    if (!this.latestCache.has(scopeKey)) this.latestCache.set(scopeKey, this.dependencies.store.latest(scopeKey));
    return this.latestCache.get(scopeKey) ?? null;
  }

  private forget(scopeKey: string): void {
    const snapshot = this.dependencies.state.snapshot(scopeKey);
    const removed = this.dependencies.store.forget(scopeKey, id => !id.startsWith('experience:')
      || visibleMemoryText(snapshot, id.slice('experience:'.length), 'visible') !== null);
    if (!removed) return;
    this.latestCache.delete(scopeKey);
    this.dependencies.log?.(`inner_note_forgotten=${removed}`);
  }

  private unreadable(): false {
    this.dependencies.log?.('inner_note_unreadable');
    return false;
  }

  private log(where: string, error: unknown): void {
    this.dependencies.log?.(`inner_note_${where}_failed ${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`);
  }
}

/** The one event a finished turn is, if any: his apology, his kind word, a tease, or a reply she felt strongly. */
function turnEvent(turn: InnerNoteTurn): InnerNoteEvent | null {
  const base = { at: turn.at, words: turn.userMessage.slice(0, 200), reply: turn.reply.slice(0, 200) };
  const soothing = soothingIn(turn.userMessage) ?? (apologyIn(turn.userMessage) ? 'apology' : null);
  if (soothing) return { kind: soothing, ...base };
  if (teasingIn(turn.userMessage)) return { kind: 'teasing', ...base };
  const feeling = turn.feeling;
  if (feeling && feeling.kind !== 'neutral' && feeling.intensity >= 0.6) return { kind: 'strong_reply', ...base, feeling };
  return null;
}

/** How strongly she still holds an unpleasant feeling (the D3 mark of forgiving while the numbers are high). */
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
