import type { MindInboxDraft } from '../../contracts/mindInboxContract.js';
import {
  MOMENT_MESSAGE_RULES, momentFactLine, momentFresh, momentIntent, momentWanted, perceiveMoments,
  type InnerNoteReader, type ProactiveMomentFacts, type ProactiveMomentState,
} from './proactiveMoments.js';
import type { ProactiveMomentDecision, SQLiteProactiveMoments, StoredProactiveMoment } from './store/proactiveMomentStore.js';

/**
 * Her moments, in her own time's process (owner decision 2026-10-14, `proactiveMoments.ts`). Each poll of her worker:
 *
 * 1. **Perceive.** The facts of the instant (her body's window, the owner's away and return, how long he has been quiet, the hour,
 *    a story waiting) become moments, each once; each new one is handed to the mind's inbox as a closed row (`moment`), so a
 *    conversation's workspace knows it too.
 * 2. **Decide, cheaply.** The free checks first (she may speak up at all now: not paused, budget left, no conversation within ten
 *    minutes, the reach-out spacing, no session of hers open, the day's caps). Then one small Jev question: would she want to say
 *    something now? Without Jev her message's writer decides, and may stay silent. A Jev that fails decides quiet.
 * 3. **Speak, maybe.** A moment she wanted is taken by her loop as a one-step cycle (`autonomyLoop.ts`), whose reach-out step writes
 *    a message in her own words with the moment as a fact in front of her, through the proactive gate (owner active, intent expiry,
 *    the same intent within 30 minutes, topic reuse) and the activity record, inside her daily budget.
 *
 * No line here is said by anyone: there is no text but the fact line of a moment.
 */
export interface ProactiveMomentPorts {
  store: SQLiteProactiveMoments;
  /** The facts of the instant, or null when they cannot be read. */
  facts: (scopeKey: string, at: string) => ProactiveMomentFacts | null;
  /** Whether anyone else may see or hear her body now, as the server was told. */
  others: (scopeKey: string, at: string) => boolean;
  /** The free checks before a decision: null when she may speak up now, otherwise a closed code. */
  blocked: (scopeKey: string, at: string) => string | null;
  /** Closed facts around the moment for the decision. */
  context: (scopeKey: string, at: string) => Pick<ProactiveMomentState,
    'owner_spoke_within_minutes' | 'own_messages_today' | 'last_own_message_minutes_ago' | 'stories_awaiting_reaction'>;
  /** Jev's probability that she wants to speak now; absent, her message's writer decides. Throws on a failure. */
  ask?: (state: ProactiveMomentState, signal?: AbortSignal) => Promise<number>;
  /** ADR-0012's inner note, once it exists; absent until then. */
  innerNote?: InnerNoteReader;
  /** The mind's inbox (`EmitMindEvent`); absent with the workspace off. */
  emit?: (scopeKey: string, draft: MindInboxDraft, at: string) => void;
  /** What one Jev call costs, and the day's caps of this path (decisions asked, moments spoken of). */
  usdPerDecision: number;
  maximumDecisionsPerDay: number;
  maximumMessagesPerDay: number;
  log?: (line: string) => void;
}

/** What her loop is handed of a moment she wanted: closed values and the one fact line; never a line to say. */
export interface TakenProactiveMoment {
  key: string;
  reason: 'share' | 'wonder';
  subject: string;
  perceivedAt: string;
  line: string;
  rules: readonly string[];
}

/** The codes after which a moment waits for the next poll (while fresh) rather than being dropped. */
const WAIT_CODES = new Set(['owner_active', 'spacing', 'cycle_open', 'in_call']);
const DAY = 24 * 60 * 60_000;

export class ProactiveMoments {
  constructor(private readonly ports: ProactiveMomentPorts) {}

  /** One poll: perceive, then decide on the newest undecided moment. Never throws. */
  async consider(scopeKey: string, at: string, signal?: AbortSignal): Promise<void> {
    try {
      this.perceive(scopeKey, at);
      await this.decideNewest(scopeKey, at, signal);
    } catch (error) {
      this.log(`moment failed:${error instanceof Error ? error.name : 'unknown'}`);
    }
  }

  /** Notes each moment of this instant once and hands each new one to the mind. Returns the new ones. */
  perceive(scopeKey: string, at: string): StoredProactiveMoment[] {
    const facts = this.ports.facts(scopeKey, at);
    if (!facts) return [];
    const audience = this.safeOthers(scopeKey, at) ? 'others' : 'owner';
    const fresh: StoredProactiveMoment[] = [];
    for (const moment of perceiveMoments(facts)) {
      if (!this.ports.store.note(scopeKey, moment, audience, at)) continue;
      fresh.push({ ...moment, scopeKey, audience, perceivedAt: at, status: 'perceived', decider: null, reason: null });
      const draft: MindInboxDraft = {
        kind: 'moment', code: moment.kind, audience, source: 'own_time', sourceId: closedKey(moment.key), deltaMinutes: moment.minutes,
      };
      this.emit(scopeKey, draft, at);
    }
    return fresh;
  }

  /** The decision on the newest undecided moment, if any may be decided now. */
  async decideNewest(scopeKey: string, at: string, signal?: AbortSignal): Promise<StoredProactiveMoment['status'] | null> {
    const { store } = this.ports;
    const moment = store.undecided(scopeKey, at);
    if (!moment) return null;
    const blocked = this.ports.blocked(scopeKey, at);
    if (blocked && WAIT_CODES.has(blocked)) {
      store.waiting(scopeKey, moment.key, blocked);
      return 'perceived';
    }
    if (blocked) return this.settle(scopeKey, moment, { status: 'skipped', reason: blocked }, at);
    const usage = store.usage(scopeKey, new Date(Date.parse(at) - DAY).toISOString());
    if (usage.taken >= this.ports.maximumMessagesPerDay) return this.settle(scopeKey, moment, { status: 'skipped', reason: 'message_cap' }, at);
    if (!this.ports.ask) return this.settle(scopeKey, moment, { status: 'wanted', decider: 'writer' }, at);
    if (usage.decisions >= this.ports.maximumDecisionsPerDay) return this.settle(scopeKey, moment, { status: 'skipped', reason: 'decision_cap' }, at);
    const wanted = await this.asked(this.state(scopeKey, moment, at), signal);
    const costUsd = this.ports.usdPerDecision;
    if (wanted === null) return this.settle(scopeKey, moment, { status: 'quiet', decider: 'jev', reason: 'jev_failed', costUsd }, at);
    return this.settle(scopeKey, moment, { status: wanted ? 'wanted' : 'quiet', decider: 'jev', costUsd }, at);
  }

  /** The newest moment she wanted, for her loop: taken once, while fresh. */
  take(scopeKey: string, at: string): TakenProactiveMoment | null {
    try {
      const moment = this.ports.store.take(scopeKey, at);
      return moment ? taken(moment) : null;
    } catch { return null; }
  }

  /** A moment her loop took, read again when its step is prepared: null once it is no longer worth a word. */
  get(scopeKey: string, key: string, at: string): TakenProactiveMoment | null {
    try {
      const moment = this.ports.store.get(scopeKey, key);
      return moment && moment.status === 'taken' && momentFresh(moment.kind, moment.perceivedAt, at) ? taken(moment) : null;
    } catch { return null; }
  }

  /** The closed state Jev is shown. */
  state(scopeKey: string, moment: StoredProactiveMoment, at: string): ProactiveMomentState {
    let note: ReturnType<InnerNoteReader> = null;
    try { note = this.ports.innerNote?.(scopeKey, at) ?? null; } catch { note = null; }
    const facts = this.ports.facts(scopeKey, at);
    return {
      moment: moment.kind, minutes: moment.minutes, local_hour: facts?.localHour ?? -1, others_present: this.safeOthers(scopeKey, at),
      ...this.ports.context(scopeKey, at),
      ...(note ? { inner_note_shown: note.shown, inner_note_intent: note.intent } : {}),
    };
  }

  private async asked(state: ProactiveMomentState, signal?: AbortSignal): Promise<boolean | null> {
    try {
      return momentWanted(await this.ports.ask!(state, signal));
    } catch { return null; }
  }

  private settle(
    scopeKey: string, moment: StoredProactiveMoment, input: ProactiveMomentDecision, at: string,
  ): StoredProactiveMoment['status'] | null {
    if (!this.ports.store.decide(scopeKey, moment.key, input, at)) return null;
    this.log(`moment ${moment.kind}:${input.status}${input.reason ? `:${input.reason}` : ''}`);
    return input.status;
  }

  private safeOthers(scopeKey: string, at: string): boolean {
    try { return this.ports.others(scopeKey, at); } catch { return true; }
  }

  private emit(scopeKey: string, draft: MindInboxDraft, at: string): void {
    try { this.ports.emit?.(scopeKey, draft, at); } catch { /* the mind never stops a moment */ }
  }

  private log(line: string): void {
    try { this.ports.log?.(line.replace(/[^a-z0-9_:., -]/giu, '_').slice(0, 200)); } catch { /* the log is optional */ }
  }
}

function taken(moment: StoredProactiveMoment): TakenProactiveMoment {
  const intent = momentIntent(moment);
  return {
    key: moment.key, reason: intent.reason, subject: intent.subject, perceivedAt: moment.perceivedAt, line: momentFactLine(moment), rules: MOMENT_MESSAGE_RULES,
  };
}

/** A moment's key as a closed identifier of the inbox. */
function closedKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.:@-]/gu, '_').slice(0, 159);
}
