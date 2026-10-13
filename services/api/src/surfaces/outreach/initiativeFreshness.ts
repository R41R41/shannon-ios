import { PROACTIVE_GATE_V1 } from '@shannon/mind';
import { localDateParts } from '../../infra/time/localDate.js';
import type { InitiativeInbox } from './store/initiativeStore.js';

/**
 * Freshness at delivery (owner decision 2026-10-14): an initiative of hers is judged again when a body of hers would say it aloud.
 *
 * The rule is the proactive gate's own intent expiry (Syzygy ADR-0008 stage 3, owner answer 2), applied a second time at the
 * moment of saying: what would have expired before it was written has also expired before it is said. A morning brief is said only
 * on its own morning, inside the brief's hours. Something past that is not rephrased (a rephrasing is a new message of hers, and
 * one of her moments may lead to one); it is handed to no body and stays an unread message in the Talk, to be read as text.
 *
 * Judged: the morning brief (`morning-brief:<date>`), a story she shows (`study:`, `share`, 75 minutes), a goal she follows
 * (`intent:`, `follow_up`, 75 minutes) and a topic of the world (any other item, `world`, 150 minutes). Not judged, as before: her
 * own messages (`reach-out…`, which the body already says only within five minutes), a look's answer (`body-look:`), a due promise
 * (`commitment:`) and a budget request (`autonomy-budget:`): how he is told of what he asked for is still his to decide.
 */
export interface InitiativeFreshnessOptions {
  timeZone: string;
  /** The morning brief's owner-local hours, [start, end). */
  morningHours: { start: number; end: number };
}

export type InitiativeVoicing = 'fresh' | 'stale' | 'unjudged';

const MINUTE = 60_000;
const NOT_JUDGED = ['reach-out', 'body-look:', 'commitment:', 'autonomy-budget:'];

function dateOf(at: string, timeZone: string): { date: string; hour: number } {
  const local = localDateParts(new Date(Date.parse(at)), timeZone);
  return { date: `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`, hour: local.hour };
}

/** Which gate reason an initiative's source was written under, or null when it is not judged here. */
export function initiativeReason(sourceItemId: string): 'share' | 'follow_up' | 'world' | null {
  if (NOT_JUDGED.some(prefix => sourceItemId.startsWith(prefix))) return null;
  if (sourceItemId.startsWith('study:')) return 'share';
  return sourceItemId.startsWith('intent:') ? 'follow_up' : 'world';
}

/** Whether a body of hers may say this initiative aloud at `at`. */
export function initiativeVoicing(sourceItemId: string, createdAt: string, at: string, options: InitiativeFreshnessOptions): InitiativeVoicing {
  const brief = /^morning-brief:(\d{4}-\d{2}-\d{2})$/u.exec(sourceItemId);
  if (brief) {
    const now = dateOf(at, options.timeZone);
    const inHours = now.hour >= options.morningHours.start && now.hour < options.morningHours.end;
    return now.date === brief[1] && inHours ? 'fresh' : 'stale';
  }
  const reason = initiativeReason(sourceItemId);
  if (!reason) return 'unjudged';
  const age = Date.parse(at) - Date.parse(createdAt);
  if (!Number.isFinite(age)) return 'stale';
  return age <= PROACTIVE_GATE_V1.expiryMinutes[reason] * MINUTE ? 'fresh' : 'stale';
}

/**
 * What `GET /v1/initiatives` and `POST /v1/initiatives/read` ask of the inbox for one device: the ids of the scope's unread
 * initiatives that this device, a body of hers, must neither be handed nor mark read now (null for a device that is not a body, or
 * with `SHANNON_BODY_INITIATIVE_FRESHNESS` off), and a read that leaves those unread.
 */
export interface InitiativeFreshness {
  heldFromBody(scopeKey: string, deviceId: string | undefined, at: string): ReadonlySet<string> | null;
  markReadExcept(scopeKey: string, threadId: string | undefined, readAt: string, except: ReadonlySet<string>): number;
}

export interface InitiativeFreshnessDependencies {
  enabled: boolean;
  isBody: (scopeKey: string, deviceId: string) => boolean;
  readState: {
    unread: (scopeKey: string) => ReadonlyArray<{ id: string; sourceItemId: string; createdAt: string }>;
    markReadExcept: InitiativeFreshness['markReadExcept'];
  };
  options: InitiativeFreshnessOptions;
}

/** The inbox with freshness at delivery: its own reads and marks, and the two parts above. */
export function freshInitiativeInbox(inbox: InitiativeInbox, dependencies: InitiativeFreshnessDependencies): InitiativeInbox & InitiativeFreshness {
  const freshness: InitiativeFreshness = {
    heldFromBody(scopeKey, deviceId, at) {
      if (!dependencies.enabled || !deviceId) return null;
      try {
        if (!dependencies.isBody(scopeKey, deviceId)) return null;
        const stale = dependencies.readState.unread(scopeKey)
          .filter(row => initiativeVoicing(row.sourceItemId, row.createdAt, at, dependencies.options) === 'stale');
        return new Set(stale.map(row => row.id));
      } catch { return null; }
    },
    markReadExcept: (scopeKey, threadId, readAt, except) => dependencies.readState.markReadExcept(scopeKey, threadId, readAt, except),
  };
  return {
    unreadMessages: scopeKey => inbox.unreadMessages(scopeKey),
    markRead: (scopeKey, threadId, readAt) => inbox.markRead(scopeKey, threadId, readAt),
    ...freshness,
  };
}
