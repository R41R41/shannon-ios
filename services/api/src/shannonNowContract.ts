/**
 * 「シャノンのいま」 for the owner's own app (`GET /v1/shannon/now`, `docs/shannon-now-contract.md`).
 *
 * One read of facts the server already holds: what she feels now and what still lingers
 * (a face and a strength, never a cause), whether her desktop body read presence lately,
 * and three short lists: looks, touches, and messages she started on her own with how each
 * was delivered. Identifiers, timestamps, closed vocabularies and numbers only. There is no
 * field for an image, for what she saw, for what anyone said, or for why she feels something.
 *
 * Owner-only and paired-device-only; nothing here is written, and nothing here is in a prompt.
 */
export const SHANNON_NOW_PATH = '/v1/shannon/now';
export const SHANNON_NOW_SCHEMA_VERSION = 1;

export const SHANNON_NOW_LIMITS = Object.freeze({
  /** Each list holds at most this many entries, newest first. */
  items: 30,
  /** Nothing older than this is returned. */
  days: 14,
  /** A presence read this recent means her body is showing on a desktop. */
  bodyFreshSeconds: 75,
  /** Feelings still underneath, strongest first. */
  lingering: 3,
  readsPerMinute: 60,
});

/**
 * `SHANNON_NOW_READ`, default on. `off`, `false`, `0` or `disabled` refuses the read with
 * `403 SHANNON_NOW_DISABLED`; the app then shows the page without these parts. A restart applies it.
 */
export function shannonNowEnabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  const value = environment.SHANNON_NOW_READ?.trim().toLowerCase();
  return !(value === 'off' || value === 'false' || value === '0' || value === 'disabled');
}

/** The scope that is the owner's; a device paired into any other scope is refused. */
export function shannonNowOwnerScope(environment: Readonly<Record<string, string | undefined>>): string {
  return environment.SHANNON_OWNER_SCOPE_KEY?.trim() || 'owner';
}

/** One of her faces, as every other screen names it (`expression`, and `feeling` for a borrowed face). */
export interface ShannonNowFace {
  expression: string;
  feeling?: string;
}

export interface ShannonNowFeeling {
  /** The quiet face of her continuous mood. */
  mood: ShannonNowFace;
  /** What she feels at this instant, when a feeling is showing. */
  present: (ShannonNowFace & { intensity: number }) | null;
  /** What still lies underneath, strongest first: a face, its present strength, and since when. */
  lingering: Array<ShannonNowFace & { strength: number; startedAt: string }>;
}

export interface ShannonNowBody {
  /** False while no body ever reported: the app says so instead of 「出ていません」. */
  known: boolean;
  /** A body read presence in the last `freshSeconds`. */
  present: boolean;
  lastReadAt: string | null;
  freshSeconds: number;
  /** Whether a registered body said it may use its camera; null when no body is registered. */
  camera: boolean | null;
}

export interface ShannonNowLook {
  id: string;
  at: string;
  /** `owner`: he asked her to look. `herself`: she wanted to. `unknown`: the record does not say. */
  askedBy: 'owner' | 'herself' | 'unknown';
  /** `body`: the camera of her desktop body. `app`: the camera of the owner's app. */
  surface: 'body' | 'app';
  /** `looking` while open, then `seen`, `refused`, `discarded`, `expired` or `failed`. */
  outcome: string;
  /** Why it did not happen, in the closed vocabulary of the look contracts. */
  code?: string;
}

export interface ShannonNowTouch {
  id: string;
  /** When the last touch of this run of touches happened. */
  at: string;
  kind: string;
  count: number;
  /** She said a line in answer. The line itself is not here. */
  answered: boolean;
}

/** How one message of hers reached the owner on one surface. Surfaces and outcomes may be added. */
export interface ShannonNowDelivery {
  /** `body` (her desktop body), `earphones` (an app said it in his earphones), `app` (read in a Talk); later `call`. */
  surface: string;
  /** `spoken`, `shown`, `away`, `hidden`, `muted` for the body; `spoken` for earphones; `read` for the app. */
  outcome: string;
  at: string;
  /** For `earphones`: which app said it, `mac` or `iphone`. */
  device?: string;
}

export interface ShannonNowReachOut {
  id: string;
  at: string;
  /** `share`, `wonder`, `upcoming`, `saw`, `follow_up`, or absent when the record does not say. */
  reason?: string;
  deliveries: ShannonNowDelivery[];
}

export interface ShannonNowResponse {
  schemaVersion: number;
  generatedAt: string;
  feeling: ShannonNowFeeling;
  body: ShannonNowBody;
  looks: ShannonNowLook[];
  touches: ShannonNowTouch[];
  reachOuts: ShannonNowReachOut[];
  limits: { items: number; days: number };
}
