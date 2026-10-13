import { PROACTIVE_GATE_V1 } from '@shannon/mind';
import { localDateParts } from '../../infra/time/localDate.js';
import type { InitiativeInbox, InitiativeMessage } from './store/initiativeStore.js';
import type { InitiativeSource } from './store/initiativeSources.js';

/**
 * A body's spoken delivery of her initiatives (owner decision 2026-10-14). Only the body's own poll asks for it, by the marker
 * `GET /v1/initiatives?for=body`; without the marker the list is what it always was, for every client (the Windows desk shares
 * the body's device id), and reading marks read as it always did.
 *
 * For the body, each unread initiative is judged again at the moment of saying:
 * - **Freshness.** The proactive gate's own intent expiry, applied a second time: a story she shows and a goal 75 minutes, a topic
 *   of the world 150 minutes. A morning brief only on its own morning, inside the brief's hours. What is past that is left out of
 *   the body's answer (it stays unread text in the Talk and the apps). It is not rephrased: a new word of hers about it would be a
 *   new message, and one of her moments may lead to one.
 * - **Text only** (`spoken: false`, a bubble and never a voice, on every body): a budget request (a system request, not her
 *   speech), a goal's state (neutral text), and a topic of the world that does not carry her own words.
 * - **Not judged**, as before: her own messages (`reach-out…`, which the body says only within five minutes), a look's answer
 *   (`body-look:`) and a due promise (`commitment:`): how he is told of what he asked for is still his to decide.
 */
export interface InitiativeFreshnessOptions {
  timeZone: string;
  /** The morning brief's owner-local hours, [start, end). */
  morningHours: { start: number; end: number };
}

export type InitiativeDelivery = 'voice' | 'text' | 'stale' | 'unjudged';

const MINUTE = 60_000;
const NOT_JUDGED = ['reach-out', 'body-look:', 'commitment:'];

function dateOf(at: string, timeZone: string): { date: string; hour: number } {
  const local = localDateParts(new Date(Date.parse(at)), timeZone);
  return { date: `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`, hour: local.hour };
}

function fresh(reason: 'share' | 'follow_up' | 'world', createdAt: string, at: string): boolean {
  const age = Date.parse(at) - Date.parse(createdAt);
  return Number.isFinite(age) && age <= PROACTIVE_GATE_V1.expiryMinutes[reason] * MINUTE;
}

/** How a body delivers one initiative at `at`. */
export function initiativeDelivery(source: InitiativeSource, at: string, options: InitiativeFreshnessOptions): InitiativeDelivery {
  const { sourceItemId, createdAt } = source;
  const brief = /^morning-brief:(\d{4}-\d{2}-\d{2})$/u.exec(sourceItemId);
  if (brief) {
    const now = dateOf(at, options.timeZone);
    return now.date === brief[1] && now.hour >= options.morningHours.start && now.hour < options.morningHours.end ? 'voice' : 'stale';
  }
  if (NOT_JUDGED.some(prefix => sourceItemId.startsWith(prefix))) return 'unjudged';
  if (sourceItemId.startsWith('autonomy-budget:')) return 'text';
  if (sourceItemId.startsWith('study:')) return fresh('share', createdAt, at) ? 'voice' : 'stale';
  if (sourceItemId.startsWith('intent:')) return fresh('follow_up', createdAt, at) ? 'text' : 'stale';
  if (!fresh('world', createdAt, at)) return 'stale';
  return source.authored ? 'voice' : 'text';
}

/** The body's answer: what is past its time is left out, and what is text only says so (`spoken: false`). */
export interface InitiativeBodyDelivery {
  forBody(scopeKey: string, messages: readonly InitiativeMessage[], at: string): Array<InitiativeMessage & { spoken?: false }>;
}

export interface InitiativeFreshnessDependencies {
  enabled: boolean;
  sources: (scopeKey: string, ids: readonly string[]) => ReadonlyMap<string, InitiativeSource>;
  options: InitiativeFreshnessOptions;
}

/** The inbox with the body's delivery (`SHANNON_BODY_INITIATIVE_FRESHNESS`); off, the body's answer is the list as it was. */
export function freshInitiativeInbox(inbox: InitiativeInbox, dependencies: InitiativeFreshnessDependencies): InitiativeInbox & InitiativeBodyDelivery {
  return {
    unreadMessages: scopeKey => inbox.unreadMessages(scopeKey),
    markRead: (scopeKey, threadId, readAt) => inbox.markRead(scopeKey, threadId, readAt),
    forBody(scopeKey, messages, at) {
      if (!dependencies.enabled) return [...messages];
      let known: ReadonlyMap<string, InitiativeSource>;
      try { known = dependencies.sources(scopeKey, messages.map(message => message.id)); } catch { return [...messages]; }
      return messages.flatMap(message => {
        const source = known.get(message.id);
        const delivery = source ? initiativeDelivery(source, at, dependencies.options) : 'unjudged';
        if (delivery === 'stale') return [];
        return delivery === 'text' ? [{ ...message, spoken: false as const }] : [message];
      });
    },
  };
}
