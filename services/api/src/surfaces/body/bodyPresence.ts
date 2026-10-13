/** What the server knows of her body's presence and what it is doing (Syzygy ADR-0008 stage 3, S3: moved unchanged out of `shannonBody.ts`). */
import type { BodyDoing, BodyNudge } from '../../contracts/bodyContract.js';
import type { AutonomyControlLabel } from '../../mind/action/ownTime/autonomyService.js';
import type { StoredBodyCapabilities } from './store/bodyStore.js';
import type { OwnerCallElsewhere } from '../../contracts/ownerCallContract.js';
import type { AutonomyActivityDay } from '../../mind/inhibition/inhibitionPorts.js';

export interface BodyPresence {
  schemaVersion: number;
  etag: string;
  /** When this server first saw the snapshot with this `etag`. */
  changedAt: string;
  pollAfterSeconds: number;
  /** The touch vocabulary this server takes (`BODY_TOUCH_VOCABULARY`); a body sends the fields of vocabulary 2 only once it sees 2 or more. */
  touchVocabulary: number;
  mood: {
    expression: string; feeling?: string; primary: string; intensity: number; fromConversation: boolean;
    valence: number; arousal: number; openness: number;
    /** Syzygy ADR-0012 (`SHANNON_INNER_NOTE`), while her inner note is active: her true feeling shows through (a blush), and until when she means to. */
    tell?: 'blush'; until?: string;
  };
  doing: BodyDoing;
  autonomy: { state: AutonomyControlLabel };
  study: { awaitingReaction: number };
  capabilities: StoredBodyCapabilities | null;
  /** A look this device is asked to take now, or null. Absent while looks are switched off on the server. */
  look?: { id: string; requestedAt: string; expiresAt: string } | null;
  /** Unread messages she started on her own; `latestId` is the newest one's initiative id. Absent when the server does not deliver them. */
  reachOut?: { pending: number; latestId?: string };
  /** The owner is in a voice call on another of his apps (added 2026-10-05). Absent when switched off on the server. */
  ownerCallElsewhere?: OwnerCallElsewhere;
}

export type BodyPresenceUnchanged = Pick<BodyPresence, 'schemaVersion' | 'etag' | 'changedAt' | 'pollAfterSeconds' | 'touchVocabulary'> & { unchanged: true };

export interface BodyNudges {
  schemaVersion: number;
  generatedAt: string;
  limits: { notDuringConversation: true; quietAfterConversationMinutes: number; maximumPerHour: number; maximumPerDay: number };
  /** No nudge may be shown before this instant; null when no conversation is recent. */
  quietUntil: string | null;
  nudges: readonly BodyNudge[];
}

const STEP_DOING: Readonly<Record<string, BodyDoing>> = Object.freeze({
  'study.think': 'thinking', 'study.read': 'reading', 'study.notion': 'reading', 'study.note': 'noting',
  'study.draft': 'drafting', 'study.revise': 'revising', 'study.ready': 'showing', 'study.show': 'showing',
});

/** A step of the activity loop is shown for this long after its latest record. */
const DOING_FRESH_MILLISECONDS = 3 * 60_000;

/** What the loop is doing: its current or latest step while it is running, otherwise `idle`. */
export function bodyDoing(loopState: string, days: readonly AutonomyActivityDay[], at: string): BodyDoing {
  if (loopState !== 'running') return 'idle';
  const latest = days.flatMap(day => day.entries).filter(entry => entry.actor === 'shannon' && entry.tool?.startsWith('study.')
    && (entry.kind === 'action' || (entry.kind === 'decision' && entry.outcome === 'allowed')))
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (!latest) return 'idle';
  const age = Date.parse(at) - Date.parse(latest.occurredAt);
  return age >= 0 && age <= DOING_FRESH_MILLISECONDS ? STEP_DOING[latest.tool ?? ''] ?? 'idle' : 'idle';
}
