import { SHANNON_CURRENT_GOAL, SHANNON_MOTIVE } from './persona.js';

/**
 * Shannon's own pursuits (「シャノンのやりたいこと」): what she herself wants to make,
 * find out, or finish. It is a separate ledger from the owner's intentions and is
 * never merged with them in a prompt.
 */
export type ShannonPursuitKind = 'goal' | 'question' | 'work';
export type ShannonPursuitStatus = 'active' | 'resting' | 'done' | 'dropped';
export type ShannonPursuitOrigin = 'seed' | 'conversation' | 'self';

export interface ShannonPursuitLink {
  readonly label: string;
  /** A note or draft she produced: an HTTPS URL or an `aether://` / `voyager://` reference. */
  readonly url: string;
}

export interface ShannonPursuit {
  readonly id: string;
  readonly kind: ShannonPursuitKind;
  readonly title: string;
  /** Why she cares, in her own words. */
  readonly why: string;
  readonly status: ShannonPursuitStatus;
  readonly origin: ShannonPursuitOrigin;
  readonly links: readonly ShannonPursuitLink[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const SHANNON_PURSUIT_LIMITS = Object.freeze({
  title: 120,
  why: 400,
  links: 8,
  linkLabel: 80,
  linkUrl: 500,
  /** Non-seed entries that may be open (active or resting) at once. */
  open: 24,
});

/**
 * The goal and motive the owner decided in ADR-0002. They are part of her purpose:
 * no ledger operation changes or removes them, and editing this list is a core change.
 */
export const SHANNON_SEED_PURSUITS = Object.freeze([
  Object.freeze({
    id: 'seed-goal-moving-story',
    kind: 'goal' as const,
    title: SHANNON_CURRENT_GOAL,
    why: `${SHANNON_MOTIVE}からです。`,
  }),
  Object.freeze({
    id: 'seed-motive-know-people-and-world',
    kind: 'question' as const,
    title: '人間と世界を知りたい',
    why: 'これがボクの動機です。物語は、そのためにいま選んでいる道です。',
  }),
]);

export function isSeedPursuitId(id: string): boolean {
  return SHANNON_SEED_PURSUITS.some(seed => seed.id === id);
}

export function seedPursuits(at: string): readonly ShannonPursuit[] {
  return SHANNON_SEED_PURSUITS.map(seed => Object.freeze({
    ...seed, status: 'active' as const, origin: 'seed' as const, links: Object.freeze([]), createdAt: at, updatedAt: at,
  }));
}

const KIND_LABEL: Readonly<Record<ShannonPursuitKind, string>> = { goal: '目標', question: '問い', work: '作品' };

export function pursuitKindLabel(kind: ShannonPursuitKind): string {
  return KIND_LABEL[kind];
}

/**
 * Compact, bounded projection for a response prompt. Seed entries are already stated in
 * the persona, and resting, finished, or dropped entries are not current, so both are
 * left out; with nothing else to say the section is empty.
 */
export function buildShannonPursuitsPrompt(
  pursuits: readonly ShannonPursuit[],
  options: { maximumItems?: number; maximumCharacters?: number } = {},
): string {
  const maximumItems = Math.max(0, Math.min(8, Math.trunc(options.maximumItems ?? 4)));
  const maximumCharacters = Math.max(0, options.maximumCharacters ?? 360);
  const current = pursuits
    .filter(pursuit => pursuit.status === 'active' && pursuit.origin !== 'seed')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, maximumItems);
  if (!current.length) return '';
  const header = '[ボク自身のやりたいこと]（持ち主の目的とは別。やったことの証拠ではない）';
  let result = header;
  for (const pursuit of current) {
    const line = `- ${KIND_LABEL[pursuit.kind]}: ${pursuit.title.slice(0, 60)}`;
    if (result.length + 1 + line.length > maximumCharacters) break;
    result += `\n${line}`;
  }
  return result === header ? '' : result;
}

/** One note she wrote after a look at the room in her own time: when, and her own words. */
export interface ShannonSeenNote {
  /** Owner-local, such as 「10月2日 10時」. */
  readonly when: string;
  readonly text: string;
}

export const SHANNON_SEEN_LIMITS = Object.freeze({ notes: 3, characters: 400, days: 7 });
const SEEN_TITLE = '[ボクが体のカメラで見たこと]';
const SEEN_HEADER = `${SEEN_TITLE}（自分の時間に部屋を一度ずつ見て、書斎に書いたメモ。話が合う時や聞かれた時に、自分の言葉で話してよい）`;
/** The header while other people are present: what she saw is the owner's room, so the speak-time check applies. */
const SEEN_GUARDED_HEADER = `${SEEN_TITLE}（自分の時間に部屋を一度ずつ見て、書斎に書いたメモ。ライ氏の部屋とライ氏のことなので、この場では【機微:…】の確かめに従う）`;

/**
 * Her recent notes about what she saw of the room, for a conversation the owner is part of.
 * With `marker` (other people can hear or read the reply) every line carries it, so the
 * speak-time check treats what she saw as personal information of the owner's.
 */
export function buildShannonSeenPrompt(notes: readonly ShannonSeenNote[] | null | undefined, options: { marker?: string } = {}): string {
  const lines = (notes ?? []).slice(0, SHANNON_SEEN_LIMITS.notes).flatMap(note => {
    const text = note.text.replace(/\s+/gu, ' ').trim();
    const clipped = text.length > SHANNON_SEEN_LIMITS.characters ? `${text.slice(0, SHANNON_SEEN_LIMITS.characters - 1)}…` : text;
    return clipped ? [`- ${options.marker ?? ''}${note.when.replace(/\s+/gu, ' ').trim().slice(0, 20)}: ${clipped}`] : [];
  });
  return lines.length ? [SEEN_HEADER, ...lines].join('\n') : '';
}

/**
 * The same block taken out of an assembled owner prompt and marked, for a turn in which other
 * people are present with the owner. Everything else of the owner's own-time prompt is dropped.
 */
export function guardedShannonSeenPrompt(ownerPrompt: string, marker: string): string {
  const block = ownerPrompt.split('\n\n').find(section => section.startsWith(SEEN_HEADER));
  if (!block || !marker) return '';
  return [SEEN_GUARDED_HEADER, ...block.split('\n').slice(1).map(line => (line.startsWith('- ') ? `- ${marker}${line.slice(2)}` : line))].join('\n');
}

/**
 * What she is doing in her own time, from the activity record and her study: facts, not
 * wishes. By the owner's decision of 2026-10-05 she knows the titles of her own unshown
 * drafts too; the line says they are not shown yet, and when to say the title is hers to decide.
 */
export interface ShannonOwnWork {
  /** What she did today, each already a short phrase such as 「公開ページを2つ読んだ」. */
  readonly today: readonly string[];
  /** `unshown`: the owner cannot read this piece yet; `title` is then her current title, for her alone. */
  readonly pieces: readonly { readonly title?: string; readonly stage: string; readonly unshown?: boolean }[];
  /**
   * What followed a message she started on her own today, each a sentence of facts from her record such as
   * 「13:05に話しかけた。3分待ったが返事はなかった。」. Never what was said, by her or by the owner.
   */
  readonly reachOuts?: readonly string[];
}

const UNSHOWN_NOTE = '（まだ見せていない。題名や中身をいつ言うかは自分で決める）';
// Matched on the unshown note that ends the line, whatever the stage says; the greedy title keeps every 」: of the title in it.
const UNSHOWN_LINE = /^- 作っている物語「.*」: ([^\n]*)（まだ見せていない。題名や中身をいつ言うかは自分で決める）$/gmu;

/**
 * The same prompt with the title of every unshown draft taken out, for anything that leaves the server: the system
 * prompt a chat response carries, and the instructions of a model that runs on a device (owner decision 2026-10-05:
 * the title is hers to know, and stays on the server).
 */
export function withoutUnshownTitles(prompt: string): string {
  return prompt.replace(UNSHOWN_LINE, '- まだ見せていない下書き: $1（題名と中身は、見せる時まで言わなくてよい）');
}

/** Compact, bounded lines for an owner one-to-one prompt. Empty when there is nothing to say. */
export function buildShannonOwnWorkPrompt(work: ShannonOwnWork | null | undefined, options: { maximumCharacters?: number } = {}): string {
  if (!work) return '';
  const reachOuts = (work.reachOuts ?? []).slice(0, 2).map(line => line.replace(/\s+/gu, ' ').trim().slice(0, 200)).filter(Boolean);
  // What followed her messages has its own room, so it never pushes a piece out of the block.
  const maximumCharacters = Math.max(0, options.maximumCharacters ?? 320 + reachOuts.reduce((sum, line) => sum + line.length + 40, 0));
  const lines = [
    ...(work.today.length ? [`- 今日したこと: ${work.today.slice(0, 6).join('、')}`] : []),
    ...reachOuts.map(line => `- 自分から話しかけた時のこと（気になるなら自分から触れてよい）: ${line}`),
    ...work.pieces.slice(0, 3).map(piece => (piece.title && piece.unshown
      ? `- 作っている物語「${piece.title.replace(/\s+/gu, ' ').slice(0, 40)}」: ${piece.stage}${UNSHOWN_NOTE}`
      : piece.title ? `- 物語「${piece.title.slice(0, 40)}」: ${piece.stage}`
        : `- 作っている物語: ${piece.stage}（まだ見せていない。題名と中身は、見せる時まで言わなくてよい）`)),
  ];
  if (!lines.length) return '';
  const header = '[ボクがひとりの時間にしていること]（記録にある事実。何をしていたか聞かれたら自分の言葉で話す）';
  let result = header;
  for (const line of lines) {
    if (result.length + 1 + line.length > maximumCharacters) break;
    result += `\n${line}`;
  }
  return result === header ? '' : result;
}
