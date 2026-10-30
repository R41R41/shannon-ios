/**
 * Mini poses (owner 2026-10-28): the small Shannon who lives on the edges of the owner's windows is drawn from a library of still
 * pictures. Each reply asks which picture fits; Jev picks one from the closest few, or says none fits, and then
 * a new one is drawn
 * (gpt-image-2.5), inspected and kept, so the library grows with use and fewer replies wait for a drawing.
 *
 * A pose is one picture in four variants (the base, mouth open, eyes closed, both) that differ only in the face. A walk has more
 * pictures, the frames of its walk cycle (`step1` to `step8`: eight, a full cycle of two steps; older walks have `step1` to
 * `step4`), that the desktop plays while she walks. `contact` is how she touches the surface; the desktop's
 * engine decides where she
 * is, the library what she does.
 */
/** `wall`: clinging to the side of a window while she climbs it. */
export const MINI_CONTACTS = ['stand', 'sit', 'lie', 'hang', 'air', 'wall'] as const;
export type MiniContact = typeof MINI_CONTACTS[number];

/** Where she can be held when carried: by a wrist, an ankle, the top of the head, the back of the collar, or round the waist. */
export const MINI_GRIPS = ['arm', 'leg', 'head', 'scruff', 'torso'] as const;
export type MiniGrip = typeof MINI_GRIPS[number];

export const MINI_VARIANTS = ['base', 'talk', 'blink', 'talkBlink', 'step1', 'step2', 'step3', 'step4', 'step5', 'step6', 'step7', 'step8'] as const;
export type MiniVariant = typeof MINI_VARIANTS[number];

/** The 22 faces every reply carries (`messageEmotion.expression`); the seed library has each of them in each everyday contact. */
export const MINI_SEED_EXPRESSIONS = [
  'joyful', 'excited', 'amused', 'laughing', 'bashful', 'embarrassed', 'relieved', 'surprised', 'curious', 'thinking', 'confused',
  'determined', 'tender', 'calm', 'jealous', 'wry', 'exasperated', 'annoyed', 'concerned', 'sad', 'sleepy', 'neutral',
] as const;

/**
 * What a picture is for. The engine's own: rest, walk, jump, fall, carried, sleep, climb, peek (from a screen
 * edge), dizzy. Shown by
 * the desktop for what the owner's screen is doing: watch (her back to the viewer, the window under her),
 * watchVideo (the same with
 * popcorn, a video in full screen), type (a tiny laptop, the owner typing), dance (music playing), point (a
 * notice), work (Shannon's
 * own task running), ask (Shannon waiting for the owner).
 */
export type MiniActivity = 'rest' | 'walk' | 'jump' | 'fall' | 'carried' | 'sleep' | 'watch' | 'climb' | 'peek' | 'dizzy'
  | 'watchVideo' | 'type' | 'dance' | 'point' | 'work' | 'ask'
  // Her own moves between and around the others (owner 2026-10-28): poke (crouched, prodding something by her feet), startle,
  // rummage (head first into a box: only above the waist is in the air, the anchor is the waist), found (holding up a sheet of
  // paper), getup (halfway up from lying), stretch (after waking), crouch (before a jump, and landing).
  | 'poke' | 'startle' | 'rummage' | 'found' | 'getup' | 'stretch' | 'crouch';

export interface MiniPoseEntry {
  id: string;
  contact: MiniContact;
  /** The face it shows, as a presentation id; null when the pose is about the body (a walk, a jump). */
  expression: string | null;
  /** What she does, in English: what Jev reads and what was drawn. */
  description: string;
  /** The same in a few Japanese words, for the owner's library page. */
  label: string;
  /** `watch`: her back to the viewer, watching the window under her (the desktop shows it while the owner works in that window). */
  activity: MiniActivity;
  variants: MiniVariant[];
  /** The point that touches the surface, in picture pixels: the window's edge under her (or her feet in the air). */
  anchor: { x: number; y: number };
  /** Her solid pixels in the picture. */
  bounds: { left: number; top: number; right: number; bottom: number };
  /**
   * Her head in the picture (top of the hair to the chin, without the buns, the ahoge and the long hair), as the reading model
   * boxed it. The image model draws her larger or smaller from pose to pose (up to half again); the desktop scales each picture
   * so the heads match. Absent on a picture not measured yet: drawn as it is.
   */
  head?: { left: number; top: number; right: number; bottom: number };
  /** A carried picture's hold: where the hand (the owner's cursor) holds her. Its anchor is that point. */
  grip?: MiniGrip;
  size: { width: number; height: number };
  source: 'seed' | 'generated';
  /** The choose request that asked for it, so a client still speaking that reply can show it when it arrives. */
  requestKey: string | null;
  createdAt: string;
  uses: number;
  lastUsedAt: string | null;
  /** Taken out by the owner: never chosen again, kept so it is not drawn again the same way. */
  retired: boolean;
}

/** What the library page and the clients read: the entries without their embeddings. */
export interface MiniLibraryView {
  version: number;
  entries: MiniPoseEntry[];
}

export interface MiniChooseRequest {
  /** Her reply (or the part being spoken), as the owner sees it. */
  text: string;
  /** The reply's face (`messageEmotion.expression` or its presentation id). */
  expression: string;
  /** The reply's expressed feeling, when the head sent one. */
  feeling?: { primary: string; intensity: number } | null;
  /** The contacts the engine can take where she is now (on an edge: stand, sit, lie, hang; falling: air). */
  contacts: MiniContact[];
  /** What she is doing now, so a pose for that activity is preferred. */
  activity?: MiniPoseEntry['activity'];
  /** Set by the client per reply: the same key twice is the same reply. */
  requestKey: string;
}

export interface MiniChooseResult {
  poseId: string | null;
  /** `library`: Jev chose a kept picture; `nearest`: none fitted (or Jev did not answer) and the closest one stands in. */
  source: 'library' | 'nearest' | 'empty';
  /** A new picture is being drawn for this reply (its entry will carry `requestKey`). */
  drawing: boolean;
  libraryVersion: number;
}

export const MINI_LIMITS = Object.freeze({
  textCharacters: 600,
  /** How many of the closest pictures Jev chooses among. */
  candidates: 8,
  /** New pictures a day unless `SHANNON_MINI_POSE_DAILY_LIMIT` says otherwise. */
  dailyDrawings: 30,
  /** Pictures drawn at once. */
  concurrentDrawings: 2,
  /** A drawing that fails its inspection is drawn again this many times at most. */
  attempts: 2,
});
