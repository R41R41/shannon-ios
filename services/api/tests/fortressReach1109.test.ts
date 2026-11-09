import { describe, expect, it } from 'vitest';
import { cautionFact } from '../src/surfaces/minecraft/minecraftLlmcCaution.js';

// end1109f03: 「blaze #993 は目から 4.4m: 手が届かない（3m まで）」 stood as a plan rule and she waited ten minutes for blazes to come within 3 m.
describe('a creature\'s distance is not a standing caution (end1109f03)', () => {
  const sight = JSON.stringify({ v: 1, kind: 'sight', text: 'blaze #993：見える。目から 4.4m', visible: true, reach: false, reachLimit: 3, distance: 4.4,
    between: [], target: { at: { x: 1, y: 2, z: 3 }, name: 'blaze #993' } });
  it('a sight on #id notes nothing', () => {
    expect(cautionFact({ code: 'miss', nth: 2, hand: { do: 'attack', aim: null, line: '届かない' } }, [{ kind: 'sight', target: '#993' }], [sight])).toBeNull();
  });
  it('a sight on a block still notes its fact', () => {
    const fact = cautionFact({ code: 'dig', nth: 2, hand: null }, [{ kind: 'sight', target: { x: 1, y: 2, z: 3 } }], [sight]);
    expect(fact).toContain('手が届かない');
  });
});
