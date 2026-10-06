import { randomUUID } from 'node:crypto';
import { bodyLookNotSeenSummary } from './bodyLook.js';
import { BODY_LOOK_ACTIVITY_THREAD, BODY_LOOK_LIMITS, type BodyLookCode, type BodyLookConfig } from './contracts/bodyLookContract.js';
import type { ActivityLookUsage, SQLiteBodyLookActivityStore } from './bodyLookActivityStore.js';
import type { SQLiteBodyLookStore, StoredBodyLook } from './bodyLookStore.js';

/**
 * Looking at the room in her own time (stage 2), seen from the activity loop's process.
 *
 * The loop cannot receive the body's answer: `POST /v1/body/looks/{id}` arrives at the API
 * process. So this desk only opens the look row, exactly as a conversation turn does
 * (the same table, the same 30 seconds, the device whose window is showing), and then
 * reads that row until the API process has closed it. What crosses between the two
 * processes is the row's outcome and code, her short text, and two token counts. The
 * frame never reaches this process, and nothing here has a parameter that could carry it.
 */
export type ActivityRoomLook =
  | { outcome: 'seen'; text: string; usage?: ActivityLookUsage }
  | { outcome: 'not_seen'; code: BodyLookCode; summary: string; usage?: ActivityLookUsage; /** The frame may have been shown to the model, so the call may have cost something. */ modelCalled: boolean };

export interface ActivityRoomLooksDependencies {
  looks: SQLiteBodyLookStore;
  hand: SQLiteBodyLookActivityStore;
  config: BodyLookConfig;
  /** `SHANNON_BODY_INGEST`: with the body switched off there is no look either. */
  ingestEnabled: boolean;
  /** Devices that registered `flags.camera: true`. */
  cameraDevices(scopeKey: string): readonly string[];
  now: () => string;
  /** Owner-local day of an instant; the same day the conversation looks are counted on. */
  dayKey(at: string): string;
  /** The pause between two reads of the look row. */
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const POLL_MILLISECONDS = 1_000;
/** A look the API process is still showing to the model is given up this long after its expiry. */
const SEEING_GRACE_MILLISECONDS = 45_000;

export class ActivityRoomLooks {
  constructor(private readonly dependencies: ActivityRoomLooksDependencies) {}

  /** `SHANNON_BODY_LOOK`, `SHANNON_BODY_INGEST`, and a stage-2 count above zero. */
  get enabled(): boolean {
    const { config, ingestEnabled } = this.dependencies;
    return config.enabled && ingestEnabled && config.activityPerDay > 0;
  }

  /** For the gate: every look in the last hour and today, conversation and activity together. Null while looks are switched off. */
  counts(scopeKey: string, at: string): { lastHour: number; maximumPerHour: number; today: number; maximumPerDay: number } | null {
    if (!this.enabled) return null;
    const { looks, config, dayKey } = this.dependencies;
    return {
      lastHour: looks.usedSince(scopeKey, new Date(Date.parse(at) - 60 * 60_000).toISOString()), maximumPerHour: config.perHour,
      today: looks.usedOnDay(scopeKey, dayKey(at)), maximumPerDay: config.perDay,
    };
  }

  /** True while a body with its camera on is showing her window, no look is open, and the overall limits have room. */
  available(scopeKey: string, at: string): boolean {
    const counts = this.counts(scopeKey, at);
    return counts !== null && counts.lastHour < counts.maximumPerHour && counts.today < counts.maximumPerDay
      && this.dependencies.looks.waiting(scopeKey).length === 0 && this.presentCamera(scopeKey, at) !== null;
  }

  /**
   * Opens one look and waits for the API process to close it. It always returns: a look the
   * body does not answer is closed here as `timeout`, and one the model never finishes as `model_failed`.
   */
  async look(scopeKey: string, input: { model: string; signal?: AbortSignal }): Promise<ActivityRoomLook> {
    const { looks, hand, now, dayKey } = this.dependencies;
    const at = now();
    const deviceId = this.enabled ? this.presentCamera(scopeKey, at) : null;
    if (!deviceId) return notSeen('window_hidden', false);
    const id = randomUUID();
    const expiresAt = new Date(Date.parse(at) + BODY_LOOK_LIMITS.lifetimeMilliseconds).toISOString();
    // The hand-off row first, so the API process finds the model whenever the answer arrives.
    hand.begin(scopeKey, id, input.model, at);
    if (!looks.open({ id, scopeKey, deviceId, threadId: BODY_LOOK_ACTIVITY_THREAD, requestedAt: at, expiresAt, ownerAsked: false }, dayKey(at))) {
      hand.discard(scopeKey, id);
      return notSeen('busy', false);
    }
    const closed = await this.untilClosed(scopeKey, id, input.signal);
    const taken = hand.take(scopeKey, id, now());
    const usage = taken?.usage ?? undefined;
    if (closed.outcome === 'seen' && taken?.note) return { outcome: 'seen', text: taken.note, ...(usage ? { usage } : {}) };
    const code: BodyLookCode = closed.outcome === 'seen' ? 'model_failed' : closed.code ?? 'failed';
    return {
      outcome: 'not_seen', code, summary: bodyLookNotSeenSummary(code, closed.outcome === 'discarded'), ...(usage ? { usage } : {}),
      // A frame that arrived and was not dropped unseen went to the model, whether or not the provider reported tokens.
      modelCalled: Boolean(closed.frameReceivedAt) && closed.outcome !== 'discarded',
    };
  }

  private async untilClosed(scopeKey: string, id: string, signal?: AbortSignal): Promise<StoredBodyLook> {
    const { looks, now } = this.dependencies;
    const wait = this.dependencies.wait ?? pause;
    let stopping = false;
    for (;;) {
      const look = looks.get(scopeKey, id)!;
      if (look.outcome !== 'pending' && look.outcome !== 'seeing') return look;
      const at = now();
      const overdue = Date.parse(at) - Date.parse(look.expiresAt);
      // The API process closes these too when it hears from the body; whoever is first wins, once.
      if (look.outcome === 'pending' && (stopping || overdue >= 0)) looks.advance(scopeKey, id, 'pending', 'expired', at, { code: 'timeout' });
      else if (look.outcome === 'seeing' && (stopping || overdue >= SEEING_GRACE_MILLISECONDS)) looks.advance(scopeKey, id, 'seeing', 'failed', at, { code: 'model_failed' });
      else {
        try { await wait(POLL_MILLISECONDS, signal); } catch { stopping = true; }
        if (signal?.aborted) stopping = true;
      }
    }
  }

  /** The camera device that read presence most recently, within the last 30 seconds. */
  private presentCamera(scopeKey: string, at: string): string | null {
    const cameras = this.dependencies.cameraDevices(scopeKey);
    if (!cameras.length) return null;
    const since = new Date(Date.parse(at) - BODY_LOOK_LIMITS.presenceFreshMilliseconds).toISOString();
    return this.dependencies.hand.presentDevices(scopeKey, since, at).find(deviceId => cameras.includes(deviceId)) ?? null;
  }
}

function notSeen(code: BodyLookCode, modelCalled: boolean): ActivityRoomLook {
  return { outcome: 'not_seen', code, summary: bodyLookNotSeenSummary(code), modelCalled };
}

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('ABORTED')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(new Error('ABORTED')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
