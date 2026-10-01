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
