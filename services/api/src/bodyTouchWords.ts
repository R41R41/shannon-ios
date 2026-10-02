import { SHANNON_FIRST_PERSON, type ShannonTouchKind } from '@shannon/cognition';

/**
 * Where she was touched and where her body was (`docs/body-contract.md`, "Which part, and on which
 * surface"; owner decisions 2026-10-03: 「触った部位によって」「撫でたのかつついたのかも」「どこで触ったのかも」).
 *
 * Both are closed vocabularies a body may send, both optional. With neither, every sentence she is
 * told is exactly what it was. This module only words facts; the touch → feeling table is unchanged.
 */
export const BODY_TOUCH_REGIONS = ['head', 'face', 'side', 'hand', 'body'] as const;
export type BodyTouchRegion = typeof BODY_TOUCH_REGIONS[number];

export const BODY_SURFACES = ['windows', 'mac', 'iphone'] as const;
export type BodySurface = typeof BODY_SURFACES[number];

export const isBodyTouchRegion = (value: unknown): value is BodyTouchRegion => BODY_TOUCH_REGIONS.some(region => region === value);
export const isBodySurface = (value: unknown): value is BodySurface => BODY_SURFACES.some(surface => surface === value);

const PART: Readonly<Record<BodyTouchRegion, string>> = Object.freeze({ head: '頭', face: '頬', side: '脇', hand: '手', body: '体' });

/** The gestures whose wording takes a part. Holding hands already names the hand; being carried has no part. */
const VERBS: Partial<Record<ShannonTouchKind, { ongoing: string; done: string; memory: string }>> = Object.freeze({
  pet: { ongoing: 'なでられている', done: 'なでられた', memory: 'なでてもらった' },
  poke: { ongoing: 'つつかれている', done: 'つつかれた', memory: 'つつかれた' },
  tickle: { ongoing: 'くすぐられている', done: 'くすぐられた', memory: 'くすぐられた' },
});

/**
 * The gesture and the part as one phrase (頭をなでられた／頬をつつかれた／脇をくすぐられた／頭をつつかれた…),
 * or null when there is no part to name: the caller then keeps its gesture-only wording.
 * `memory` is the wording of a touch memory (頭をなでてもらった).
 */
export function touchPartPhrase(type: ShannonTouchKind, region: BodyTouchRegion | null | undefined, form: 'ongoing' | 'done' | 'memory'): string | null {
  const verb = VERBS[type];
  return region && verb ? `${PART[region]}を${verb[form]}` : null;
}

/** A stored part or surface that stands for "the touches of this burst did not agree" (never sent by a body). */
export const BODY_TOUCH_MIXED = 'mixed';

/** A gesture with no part named, where the wording from before parts existed names one (頭をなでられた): なでられた. */
const PARTLESS: Partial<Record<ShannonTouchKind, { ongoing: string; done: string; memory: string }>> = Object.freeze({
  pet: { ongoing: 'なでられている', done: 'なでられた', memory: 'なでてもらった' },
});

/**
 * The phrase for a burst: its part when every touch named the same one, the part-less wording when they
 * differed, and `legacy` (the wording from before parts existed) when no touch ever named one.
 */
export function burstTouchPhrase(
  type: ShannonTouchKind, burst: { region?: BodyTouchRegion; mixedRegion?: boolean }, form: 'ongoing' | 'done' | 'memory', legacy: string,
): string {
  return touchPartPhrase(type, burst.region, form) ?? (burst.mixedRegion ? PARTLESS[type]?.[form] : undefined) ?? legacy;
}

/** Her body as she is told of it. Without a surface, the wording from before bodies said where they are. */
export function bodyPlace(surface: BodySurface | null | undefined): string {
  switch (surface) {
    case 'windows': return `Windowsのデスクトップにいる${SHANNON_FIRST_PERSON}の体`;
    case 'mac': return `Macのデスクトップにいる${SHANNON_FIRST_PERSON}の体`;
    case 'iphone': return `iPhoneのアプリの中の${SHANNON_FIRST_PERSON}の体`;
    default: return `PCに表示されている${SHANNON_FIRST_PERSON}の体`;
  }
}

/** 「iPhoneのアプリの中で、」 for a touch memory; empty without a surface. */
export function bodyWhere(surface: BodySurface | null | undefined): string {
  switch (surface) {
    case 'windows': return 'Windowsのデスクトップで、';
    case 'mac': return 'Macのデスクトップで、';
    case 'iphone': return 'iPhoneのアプリの中で、';
    default: return '';
  }
}

/** A short mark for one line when touches of several surfaces stand in one block. */
export function bodySurfaceMark(surface: BodySurface | null | undefined): string {
  switch (surface) {
    case 'windows': return '（Windowsで）';
    case 'mac': return '（Macで）';
    case 'iphone': return '（iPhoneで）';
    default: return '';
  }
}
