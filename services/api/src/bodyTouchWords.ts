import { SHANNON_FIRST_PERSON, type ShannonTouchKind } from '@shannon/cognition';
import type { BodyTouchGesture, BodyTouchSide } from './bodyContract.js';

/**
 * Where she was touched and where her body was (`docs/body-contract.md`, "Which part, and on which
 * surface"; owner decisions 2026-10-03: 「触った部位によって」「撫でたのかつついたのかも」「どこで触ったのかも」).
 *
 * Both are closed vocabularies a body may send, both optional. With neither, every sentence she is
 * told is exactly what it was. This module only words facts; the touch → feeling table is unchanged.
 * The finer `part` of touch vocabulary 2 has its words here too (`BODY_TOUCH_PART_WORDS`).
 */
export const BODY_TOUCH_REGIONS = ['head', 'face', 'side', 'hand', 'body'] as const;
export type BodyTouchRegion = typeof BODY_TOUCH_REGIONS[number];

export const BODY_SURFACES = ['windows', 'mac', 'iphone'] as const;
export type BodySurface = typeof BODY_SURFACES[number];

export const isBodyTouchRegion = (value: unknown): value is BodyTouchRegion => BODY_TOUCH_REGIONS.some(region => region === value);
export const isBodySurface = (value: unknown): value is BodySurface => BODY_SURFACES.some(surface => surface === value);

/**
 * The finer part a body may name beside `region` (touch vocabulary 2, Syzygy ADR-0005 and its owner answers of
 * 2026-10-05): the parts she may not want touched (neck, chest, waist, leg, skirt) are named one by one, so that
 * she can be told the part itself. Each has its word and its parent `region`, the old five-word vocabulary a body
 * keeps sending beside it. Since stage 1b (2026-10-06) the reaction prompt tells her the part, the side and the gesture
 * (`touchDetailPhrase`); the `[体に起きたこと]` block and the memory of a touch still come from `region`.
 */
export const BODY_TOUCH_PARTS = [
  'head', 'hair', 'forehead', 'cheek', 'face', 'shoulder', 'arm', 'hand', 'belly', 'side', 'neck', 'chest', 'waist', 'leg', 'skirt', 'other',
] as const;
export type BodyTouchPart = typeof BODY_TOUCH_PARTS[number];
export const isBodyTouchPart = (value: unknown): value is BodyTouchPart => BODY_TOUCH_PARTS.some(part => part === value);

export const BODY_TOUCH_PART_WORDS: Readonly<Record<BodyTouchPart, { word: string; region: BodyTouchRegion }>> = Object.freeze({
  head: { word: '頭', region: 'head' },
  hair: { word: '髪', region: 'head' },
  forehead: { word: 'おでこ', region: 'face' },
  cheek: { word: '頬', region: 'face' },
  face: { word: '顔', region: 'face' },
  shoulder: { word: '肩', region: 'body' },
  arm: { word: '腕', region: 'body' },
  hand: { word: '手', region: 'hand' },
  belly: { word: 'お腹', region: 'body' },
  side: { word: '脇', region: 'side' },
  neck: { word: '首', region: 'body' },
  chest: { word: '胸', region: 'body' },
  waist: { word: '腰', region: 'body' },
  leg: { word: '脚', region: 'body' },
  skirt: { word: 'スカート', region: 'body' },
  other: { word: '体', region: 'body' },
});

/** 「首」「スカート」: the word of a part. */
export const bodyTouchPartWord = (part: BodyTouchPart): string => BODY_TOUCH_PART_WORDS[part].word;

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
 * A burst in which a touch landed on a part where her body flinches first (Syzygy ADR-0005 stage 1b): stroking and a hand
 * resting there are told as being touched, factually and with no favour in the verb (not なでてもらった, not 手をつないで
 * もらった, which read the touch as kindness). Poking, tickling and carrying are already factual and keep their words.
 */
const REFLEX_BURST: Partial<Record<ShannonTouchKind, { ongoing: string; done: string; memory: string }>> = Object.freeze({
  pet: { ongoing: '触れられている', done: '触れられた', memory: '触れられた' },
  holdHand: { ongoing: '触れられている', done: '触れられた', memory: '触れられた' },
});

/**
 * The phrase for a burst: its part when every touch named the same one, the part-less wording when they
 * differed, and `legacy` (the wording from before parts existed) when no touch ever named one. A burst with a touch
 * on a part where her body flinches first (`reflex`) never takes a wording of favour: see `REFLEX_BURST`.
 */
export function burstTouchPhrase(
  type: ShannonTouchKind, burst: { region?: BodyTouchRegion; mixedRegion?: boolean; reflex?: boolean }, form: 'ongoing' | 'done' | 'memory', legacy: string,
): string {
  const neutral = burst.reflex ? REFLEX_BURST[type] : undefined;
  if (neutral) return `${burst.region ? `${PART[burst.region]}に` : ''}${neutral[form]}`;
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

/** What was done, by the gesture of touch vocabulary 2, on a named part (Syzygy ADR-0005 stage 1b). Carrying and holding keep their own words. */
const GESTURE_VERBS: Readonly<Partial<Record<BodyTouchGesture, { ongoing: string; done: string; particle: 'を' | 'に' }>>> = Object.freeze({
  stroke: { ongoing: 'なでられている', done: 'なでられた', particle: 'を' },
  poke: { ongoing: 'つつかれている', done: 'つつかれた', particle: 'を' },
  tickle: { ongoing: 'くすぐられている', done: 'くすぐられた', particle: 'を' },
  rest: { ongoing: '触れられている', done: '触れられた', particle: 'に' },
});
/** The gesture a `type` means when the body named none. */
const TYPE_GESTURE: Readonly<Partial<Record<ShannonTouchKind, BodyTouchGesture>>> = Object.freeze({ pet: 'stroke', poke: 'poke', tickle: 'tickle' });
const SIDE_WORDS: Readonly<Record<BodyTouchSide, string>> = Object.freeze({ left: '左の', right: '右の' });

/**
 * The part and the gesture of touch vocabulary 2 as one phrase, as she is told them (首をつつかれた／左の頬をなでられている／
 * 胸に触れられた), with the side from her own view. Null without a `part`, and for carrying and holding hands, whose
 * wording names no part: the caller then keeps the wording from `type` and `region`, so a touch in the old shape is
 * told exactly as before. Facts only, in the vocabulary the body sends.
 */
export function touchDetailPhrase(
  type: ShannonTouchKind, detail: { part?: BodyTouchPart; side?: BodyTouchSide; gesture?: BodyTouchGesture }, form: 'ongoing' | 'done',
): string | null {
  const gesture = detail.gesture ?? TYPE_GESTURE[type];
  const verb = gesture && type !== 'holdHand' && type !== 'carry' ? GESTURE_VERBS[gesture] : undefined;
  if (!detail.part || !verb) return null;
  return `${detail.side ? SIDE_WORDS[detail.side] : ''}${bodyTouchPartWord(detail.part)}${verb.particle}${verb[form]}`;
}
