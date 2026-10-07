/**
 * MinHash over character 3-grams (Syzygy ADR-0008 stage 3, `docs/mind-workspace-contract.md`): the proactive gate's topic reuse
 * and identity tier 3 compare short texts by an estimate of the Jaccard similarity of their 3-gram sets. Only signatures are
 * stored (`proactive_topics`), never the text.
 *
 * Pure and deterministic: the 64 "permutations" are 64 fixed 32-bit mixes of one FNV-1a hash per 3-gram, seeded by a fixed
 * sequence, so a signature computed today equals one computed after a restart or on another machine.
 */
export const MINHASH_V1 = Object.freeze({ version: 'minhash.v1', permutations: 64, gram: 3 });

/** 64 unsigned 32-bit minima, frozen. */
export type MinHashSignature = readonly number[];

/** NFKC, lower case, whitespace collapsed to one space and trimmed: the text the grams are taken from. */
export function gramText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** The set of character 3-grams (by code point). A text shorter than three characters is its own single gram; an empty one has none. */
export function characterGrams(text: string, size: number = MINHASH_V1.gram): ReadonlySet<string> {
  const characters = [...gramText(text)];
  if (!characters.length) return new Set();
  if (characters.length <= size) return new Set([characters.join('')]);
  const grams = new Set<string>();
  for (let index = 0; index + size <= characters.length; index += 1) grams.add(characters.slice(index, index + size).join(''));
  return grams;
}

/** The exact Jaccard similarity of two sets (0 when both are empty). */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size && !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const character of text) {
    let code = character.codePointAt(0)!;
    // Four bytes per code point, so every character contributes the same way.
    for (let byte = 0; byte < 4; byte += 1) {
      hash ^= code & 0xff;
      hash = Math.imul(hash, 0x01000193);
      code >>>= 8;
    }
  }
  return hash >>> 0;
}

/** MurmurHash3's finalizer: an invertible mix of 32 bits. */
function mix(value: number): number {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** The fixed seeds of the 64 permutations (splitmix-style steps from a constant). */
const SEEDS: readonly number[] = Object.freeze(Array.from({ length: MINHASH_V1.permutations }, (_, index) => mix(Math.imul(index + 1, 0x9e3779b9))));

/** The signature of a text, or null when it has no gram (an empty text matches nothing). */
export function minHashSignature(text: string): MinHashSignature | null {
  const grams = characterGrams(text);
  if (!grams.size) return null;
  const minima = new Array<number>(MINHASH_V1.permutations).fill(0xffffffff);
  for (const gram of grams) {
    const base = fnv1a(gram);
    for (let index = 0; index < SEEDS.length; index += 1) {
      const value = mix(base ^ SEEDS[index]!);
      if (value < minima[index]!) minima[index] = value;
    }
  }
  return Object.freeze(minima);
}

/** The estimated Jaccard similarity: the share of positions where the minima agree. 0 for a missing or malformed signature. */
export function signatureSimilarity(left: MinHashSignature | null, right: MinHashSignature | null): number {
  if (!left || !right || left.length !== MINHASH_V1.permutations || right.length !== MINHASH_V1.permutations) return 0;
  let same = 0;
  for (let index = 0; index < left.length; index += 1) if (left[index] === right[index]) same += 1;
  return same / left.length;
}

/** The estimated similarity of two texts. */
export function textSimilarity(left: string, right: string): number {
  return signatureSimilarity(minHashSignature(left), minHashSignature(right));
}

/** 512 hexadecimal characters, for a TEXT column. */
export function encodeSignature(signature: MinHashSignature): string {
  return signature.map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Restores a stored signature, or null when the text is not one. */
export function decodeSignature(text: unknown): MinHashSignature | null {
  if (typeof text !== 'string' || !/^[0-9a-f]{512}$/u.test(text)) return null;
  return Object.freeze(Array.from({ length: MINHASH_V1.permutations }, (_, index) => Number.parseInt(text.slice(index * 8, index * 8 + 8), 16)));
}
