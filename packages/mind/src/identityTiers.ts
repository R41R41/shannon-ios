import { minHashSignature, signatureSimilarity } from './minhash.js';

/**
 * The tiers of identity (Syzygy ADR-0008 stage 3, owner answer 3 of 2026-10-07, `docs/mind-workspace-contract.md`; after Graphiti):
 * whether a name she met is someone she already knows.
 *
 * 1. The exact name key, an alias or a platform link: matched automatically (as today).
 * 2. The entropy gate: a name below 1.5 bits per character, or of fewer than 6 characters without CJK, stops fuzzy matching.
 *    A CJK name skips tier 3 (3-grams of a short CJK name say little) and fails closed to tier 4.
 * 3. MinHash Jaccard ≥ 0.9 over character 3-grams: a suggestion.
 * 4. A choice over at most 15 candidates (cosine ≥ 0.6) plus "new person", followed only in the 0.9/0.1 band, in the background
 *    only: a suggestion.
 *
 * Tiers 3 and 4 only suggest (`person_identity_candidates` → `mergeSuggestions`); the owner merges. The owner is pinned: he is
 * matched only by his pins (his paired device, his online-mode uuid, his platform owner id), never by a name at any tier.
 */
export const IDENTITY_TIERS_V1 = Object.freeze({
  version: 'identity.v1',
  minimumBitsPerCharacter: 1.5,
  minimumCharacters: 6,
  jaccardAt: 0.9,
  candidates: 15,
  cosineAt: 0.6,
  band: Object.freeze({ follow: 0.9, reject: 0.1 }),
});

export interface IdentityPerson {
  personId: string;
  /** The names and aliases she knows them by (display forms; keys are taken here). */
  names: readonly string[];
  /** Platform links, as `platform:id`. */
  links: readonly string[];
  /** The owner: matched by his pins only. */
  isOwner: boolean;
}

export interface IdentityObservation {
  name: string;
  /** The platform link the surface saw, as `platform:id`, if any. */
  link?: string | null;
  /** True when the surface proved the owner (his device token, his online-mode uuid, his platform owner id). */
  ownerPinned?: boolean;
}

export type IdentityOutcome =
  | { tier: 0; verdict: 'owner' }
  | { tier: 1; verdict: 'match'; personId: string; by: 'link' | 'name' }
  | { tier: 2; verdict: 'new'; why: 'low_entropy' | 'too_short' | 'no_name' }
  | { tier: 3; verdict: 'suggest'; personId: string; jaccard: number }
  | { tier: 4; verdict: 'ask'; menu: readonly IdentityMenuItem[] }
  | { tier: 4; verdict: 'new'; why: 'no_candidate' };

export interface IdentityMenuItem { personId: string; cosine: number }

/** The matching key of a name: NFKC, trimmed, lower case, no spaces or 「・」, hiragana folded to katakana (as `personNameKey`). */
export function identityNameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase().replace(/[\s・]/gu, '')
    .replace(/[ぁ-ゖ]/gu, character => String.fromCharCode(character.charCodeAt(0) + 0x60));
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Shannon entropy of the key's characters, in bits per character. */
export function bitsPerCharacter(key: string): number {
  const characters = [...key];
  if (!characters.length) return 0;
  const counts = new Map<string, number>();
  for (const character of characters) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / characters.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Tier 2: whether fuzzy matching may run on this key, and how. */
export function entropyGate(key: string): 'fuzzy' | 'cjk' | 'low_entropy' | 'too_short' | 'no_name' {
  if (!key) return 'no_name';
  if (CJK.test(key)) return 'cjk';
  if ([...key].length < IDENTITY_TIERS_V1.minimumCharacters) return 'too_short';
  if (bitsPerCharacter(key) < IDENTITY_TIERS_V1.minimumBitsPerCharacter) return 'low_entropy';
  return 'fuzzy';
}

/**
 * Tiers 0–3 for one name, and the tier-4 menu when it comes to that. `cosine` gives each person's embedding similarity to the
 * name (tier 4); absent, there is no menu. The owner is never on a menu and never matched by a name.
 */
export function identify(observation: IdentityObservation, people: readonly IdentityPerson[], cosine?: (personId: string) => number | null): IdentityOutcome {
  if (observation.ownerPinned) return { tier: 0, verdict: 'owner' };
  const others = people.filter(person => !person.isOwner);
  const link = observation.link?.trim();
  if (link) {
    const linked = others.find(person => person.links.includes(link));
    if (linked) return { tier: 1, verdict: 'match', personId: linked.personId, by: 'link' };
  }
  const key = identityNameKey(observation.name);
  const exact = key ? others.filter(person => person.names.some(name => identityNameKey(name) === key)) : [];
  // One person by that exact key is a match; two are not (the owner merges them).
  if (exact.length === 1) return { tier: 1, verdict: 'match', personId: exact[0]!.personId, by: 'name' };
  const gate = entropyGate(key);
  if (gate === 'no_name' || gate === 'too_short' || gate === 'low_entropy') return { tier: 2, verdict: 'new', why: gate };
  if (gate === 'fuzzy' && !exact.length) {
    const signature = minHashSignature(key);
    let best: { personId: string; jaccard: number } | null = null;
    for (const person of others) {
      for (const name of person.names) {
        const similarity = signatureSimilarity(signature, minHashSignature(identityNameKey(name)));
        if (similarity >= IDENTITY_TIERS_V1.jaccardAt && (!best || similarity > best.jaccard
          || (similarity === best.jaccard && person.personId < best.personId))) best = { personId: person.personId, jaccard: similarity };
      }
    }
    if (best) return { tier: 3, verdict: 'suggest', personId: best.personId, jaccard: best.jaccard };
  }
  const menu = identityMenu(others, cosine);
  return menu.length ? { tier: 4, verdict: 'ask', menu } : { tier: 4, verdict: 'new', why: 'no_candidate' };
}

/** Tier 4's menu: people other than the owner with cosine ≥ 0.6, highest first, at most 15. "New person" is always offered beside it. */
export function identityMenu(people: readonly IdentityPerson[], cosine?: (personId: string) => number | null): readonly IdentityMenuItem[] {
  if (!cosine) return Object.freeze([]);
  return Object.freeze(people.filter(person => !person.isOwner)
    .map(person => ({ personId: person.personId, cosine: cosine(person.personId) ?? Number.NaN }))
    .filter(item => Number.isFinite(item.cosine) && item.cosine >= IDENTITY_TIERS_V1.cosineAt)
    .sort((left, right) => right.cosine - left.cosine || left.personId.localeCompare(right.personId))
    .slice(0, IDENTITY_TIERS_V1.candidates)
    .map(item => Object.freeze(item)));
}

/** The menu's choices as offered: the candidates' ids and `new_person`. */
export const NEW_PERSON = 'new_person';

export type IdentityChoice =
  | { verdict: 'suggest'; personId: string; probability: number }
  | { verdict: 'new' }
  | { verdict: 'undecided' };

/**
 * Tier 4's answers (one probability per menu item that it is the same person, and one for "new person"), followed only in the
 * band: exactly one candidate at ≥ 0.9 is suggested (never merged); "new person" at ≥ 0.9, or every candidate at ≤ 0.1, is new;
 * anything else (two at ≥ 0.9, the middle) is undecided and left to the rules. An answer off the menu (the owner among it) is ignored.
 */
export function identityChoice(menu: readonly IdentityMenuItem[], answers: Readonly<Record<string, number>>): IdentityChoice {
  const { follow, reject } = IDENTITY_TIERS_V1.band;
  const probability = (id: string) => (Number.isFinite(answers[id]) ? Math.min(1, Math.max(0, answers[id]!)) : null);
  const sure = menu.flatMap(item => { const p = probability(item.personId); return p !== null && p >= follow ? [{ personId: item.personId, probability: p }] : []; });
  if (sure.length === 1) return { verdict: 'suggest', ...sure[0]! };
  if (sure.length > 1) return { verdict: 'undecided' };
  const fresh = probability(NEW_PERSON);
  if ((fresh !== null && fresh >= follow) || (menu.length > 0 && menu.every(item => { const p = probability(item.personId); return p !== null && p <= reject; }))) return { verdict: 'new' };
  return { verdict: 'undecided' };
}

/** Whether an outcome may join two people without the owner: only tier 0 (his pins) and tier 1. */
export function joinsAutomatically(outcome: IdentityOutcome): boolean {
  return outcome.verdict === 'owner' || outcome.verdict === 'match';
}
