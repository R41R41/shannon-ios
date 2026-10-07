import { describe, expect, it } from 'vitest';
import {
  MINHASH_V1, characterGrams, decodeSignature, encodeSignature, gramText, jaccard, minHashSignature, signatureSimilarity, textSimilarity,
} from '../src/index.js';

describe('MinHash over character 3-grams', () => {
  it('takes 3-grams by code point from the normalized text', () => {
    expect(gramText('  ＡＢｃ　 de ')).toBe('abc de');
    expect([...characterGrams('abcd')]).toEqual(['abc', 'bcd']);
    expect([...characterGrams('歯医者の予定')]).toEqual(['歯医者', '医者の', '者の予', 'の予定']);
    expect([...characterGrams('😀😀x')]).toEqual(['😀😀x']);
    expect([...characterGrams('ab')]).toEqual(['ab']);
    expect(characterGrams('   ').size).toBe(0);
  });

  it('computes the exact Jaccard similarity of two sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(['a']), new Set(['a']))).toBe(1);
  });

  it('has 64 deterministic positions, the same for the same grams, whatever their order or repeats', () => {
    const signature = minHashSignature('夕方の駅の話をしたい')!;
    expect(signature).toHaveLength(MINHASH_V1.permutations);
    expect(Object.isFrozen(signature)).toBe(true);
    expect(signature.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)).toBe(true);
    expect(minHashSignature('夕方の駅の話をしたい')).toEqual(signature);
    // A pinned value: a signature computed after a restart or on another machine is the same.
    expect(encodeSignature(minHashSignature('abc')!).slice(0, 32)).toBe('e2e93e8d88bedc9fcd195fde6f172000');
    expect(encodeSignature(minHashSignature('夕方の駅')!).slice(0, 32)).toBe('14e9a62e41ed8fd8706a1c11a407136e');
    expect(minHashSignature('ABC')).toEqual(minHashSignature('abc'));
    expect(minHashSignature('')).toBeNull();
    expect(minHashSignature('  ')).toBeNull();
  });

  it('estimates the Jaccard similarity: identical texts 1, unrelated texts near 0, near texts in between', () => {
    expect(textSimilarity('今日は歯医者に行く予定がある', '今日は歯医者に行く予定がある')).toBe(1);
    expect(textSimilarity('今日は歯医者に行く予定がある', 'Minecraftで家を建てた話')).toBeLessThan(0.1);
    const left = '夕方の駅で、だれかの傘が立てかけてあった話をしたい';
    const right = '夕方の駅で、だれかの傘が立てかけてあった話をしたいな';
    const exact = jaccard(characterGrams(left), characterGrams(right));
    expect(Math.abs(textSimilarity(left, right) - exact)).toBeLessThan(0.15);
    expect(textSimilarity(left, right)).toBeGreaterThan(0.75);
  });

  it('is close to the exact similarity on average over many pairs', () => {
    const base = 'シャノンとライ氏は夕方の駅で傘の話をした。帰り道に雨が降ってきた。';
    let error = 0;
    for (let cut = 1; cut <= 20; cut += 1) {
      const other = base.slice(cut) + base.slice(0, cut / 2);
      error += Math.abs(textSimilarity(base, other) - jaccard(characterGrams(base), characterGrams(other)));
    }
    expect(error / 20).toBeLessThan(0.08);
  });

  it('answers 0 for a missing or malformed signature', () => {
    expect(signatureSimilarity(null, minHashSignature('abc'))).toBe(0);
    expect(signatureSimilarity([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('stores a signature as 512 hexadecimal characters and reads it back', () => {
    const signature = minHashSignature('ライ氏の誕生日の話')!;
    const text = encodeSignature(signature);
    expect(text).toMatch(/^[0-9a-f]{512}$/u);
    expect(decodeSignature(text)).toEqual(signature);
    for (const bad of [null, 1, '', 'zz', text.slice(1), `${text}0`, text.toUpperCase()]) expect(decodeSignature(bad)).toBeNull();
  });
});
