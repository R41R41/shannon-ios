/**
 * What a body may read of how she feels in the game: `GET /v1/body/mind` (`docs/body-contract.md`).
 *
 * Owner decision 2026-11-24: the game screen shows her feeling (a sign over her head and a small window), with its reason in words.
 * `GET /v1/body/presence` keeps leaving the cause out (a stream may show the apps that read it); this route is the one that carries it, for the
 * body that draws it in the game. Nothing is stored by reading it and no model is called. What the body also shows (her line of thinking and the
 * plan node in hand) it already holds from the task the head sends, so it is not repeated here.
 */
export const BODY_MIND_PATH = '/v1/body/mind';
export const BODY_MIND_SCHEMA_VERSION = 1;

export const BODY_MIND_LIMITS = Object.freeze({
  /** How far back the flow goes. */
  flowMilliseconds: 10 * 60_000,
  /** At most this many points of the flow. */
  flowPoints: 24,
  /** A point is kept again after this long even when nothing changed. */
  samePointMilliseconds: 60_000,
  /** A change of strength this big is a new point. */
  strengthStep: 0.1,
  /** The reason is one line of at most this many characters. */
  causeCharacters: 40,
  /** The body asks again after this many seconds. */
  pollAfterSeconds: 4,
  scopes: 64,
});

export interface BodyMindPoint {
  at: string;
  /** One of her feeling kinds (`neutral` when nothing showed). */
  primary: string;
  intensity: number;
}

export interface BodyMind {
  schemaVersion: number;
  generatedAt: string;
  pollAfterSeconds: number;
  feeling: {
    /** The feeling she has now, in the game's own 20 names and the rest of her kinds; `neutral` with no strength when none shows or she hides it. */
    primary: string;
    intensity: number;
    /** Why, in one line; empty when nothing shows. */
    cause: string;
    /** Since when this feeling holds. Absent when none shows. */
    since?: string;
  };
  mood: { valence: number; arousal: number; openness: number };
  /** The last ten minutes, oldest first. */
  flow: BodyMindPoint[];
}
