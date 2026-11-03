import { describe, expect, it } from 'vitest';
import { reserveCondition, reserveRefusal, reserveStopIf, RESERVE_DEFAULTS } from '../src/surfaces/minecraft/minecraftLlmcReserve.js';
import type { ActInput } from '../src/contracts/minecraftActContract.js';

/** R3-1 (4): the reserve item's policy: where it is refused, and the defaults it carries (a pre and a stopIf the head adds). */
const hands = (...kinds: string[]) => kinds.map(kind => ({ do: kind })) as unknown as ActInput['hands'];
const open = { allowed: true, dimension: 'overworld', hasReserve: false, hasDecided: true };

describe('where a reserve is refused', () => {
  it('for a task that is watched or held, with none decided to follow, a second one, a replace on it', () => {
    expect(reserveRefusal({ hands: hands('pickup') }, open)).toBeNull();
    expect(reserveRefusal({ hands: hands('pickup') }, { ...open, allowed: false })).toContain('控えを受け付けない');
    expect(reserveRefusal({ hands: hands('pickup') }, { ...open, hasDecided: false })).toContain('決めた項目の後ろ');
    expect(reserveRefusal({ hands: hands('pickup') }, { ...open, hasReserve: true })).toContain('1 つまで');
    expect(reserveRefusal({ hands: hands('pickup'), replace: ['q3'] }, open)).toContain('replace は付けられない');
  });
  it('in the Nether and the End no reserve has a hand that moves the body; in the overworld it may', () => {
    for (const dimension of ['the_nether', 'nether', 'the_end', 'end']) {
      for (const kind of ['go', 'walk', 'vertical', 'portal', 'obsidian', 'pillarUp', 'fight', 'attack', 'fill']) {
        expect(reserveRefusal({ hands: hands('pickup', kind) }, { ...open, dimension }), `${dimension} ${kind}`).toContain('体を動かす手');
      }
      expect(reserveRefusal({ hands: hands('pickup', 'eat', 'equip') }, { ...open, dimension })).toBeNull();
    }
    for (const dimension of ['the_nether', 'the_end']) {
      expect(reserveRefusal({ hands: hands('fight') }, { ...open, dimension })).toContain('体を動かす手');
      expect(reserveRefusal({ hands: hands('pickup', 'attack') }, { ...open, dimension })).toContain('attack');
    }
    expect(reserveRefusal({ hands: hands('fight') }, { ...open, dimension: 'overworld' })).toBeNull();
    expect(reserveRefusal({ hands: hands('go', 'pickup') }, open)).toBeNull();
    expect(reserveRefusal({ hands: hands('go') }, { ...open, dimension: null })).toBeNull();
  });
});

describe('the defaults a reserve carries', () => {
  it('adds safe 16, health 12 and within 32 m of where it was made to every alternative that lacks them, and leaves the ones the model wrote', () => {
    const feet = { x: 10.6, y: 64, z: -3.2 };
    expect(reserveCondition(undefined, feet, 'overworld')).toEqual([[{ k: 'safe', r: 16 }, { k: 'hp', n: 12 }, { k: 'at', x: 10, y: 64, z: -4, r: 32, dim: 'overworld' }]]);
    const own = reserveCondition([[{ k: 'hp', n: 15 }, { k: 'free', n: 2 }], [{ k: 'safe', r: 8 }]], feet, 'the_end');
    expect(own[0]).toEqual([{ k: 'hp', n: 15 }, { k: 'safe', r: 16 }, { k: 'at', x: 10, y: 64, z: -4, r: 32, dim: 'the_end' }, { k: 'free', n: 2 }]);
    expect(own[1]).toEqual([{ k: 'safe', r: 8 }, { k: 'hp', n: 12 }, { k: 'at', x: 10, y: 64, z: -4, r: 32, dim: 'the_end' }]);
    // no position known: no `at`; the clause count stays within the body's six
    expect(reserveCondition(undefined, null, null)).toEqual([[{ k: 'safe', r: 16 }, { k: 'hp', n: 12 }]]);
    const full = reserveCondition([[{ k: 'free', n: 1 }, { k: 'free', n: 2 }, { k: 'free', n: 3 }, { k: 'free', n: 4 }, { k: 'free', n: 5 }]], feet, null);
    expect(full[0]).toHaveLength(6);
    // six clauses of the model's own: the safety defaults still stand and its other clauses give way (review of 11/3)
    expect(full[0]).toEqual(expect.arrayContaining([{ k: 'safe', r: 16 }, { k: 'hp', n: 12 }, { k: 'at', x: 10, y: 64, z: -4, r: 32 }]));
    const six = reserveCondition([[1, 2, 3, 4, 5, 6].map(n => ({ k: 'free' as const, n }))], feet, 'overworld');
    expect(six[0]).toHaveLength(6);
    expect(six[0]!.filter(clause => clause.k !== 'free').map(clause => clause.k).sort()).toEqual(['at', 'hp', 'safe']);
    // six legal hp clauses: one stays, the added safe and at are not cut off (review of 11/3)
    const hps = reserveCondition([[1, 2, 3, 4, 5, 6].map(n => ({ k: 'hp' as const, n: 12 + n }))], feet, 'overworld');
    expect(hps[0]!.map(clause => clause.k).sort()).toEqual(['at', 'hp', 'safe']);
  });
  it('stopIf: hostileWithin 8 and hpBelow 10 at least; a stricter word of the model stands', () => {
    expect(reserveStopIf(undefined)).toEqual({ hostileWithin: RESERVE_DEFAULTS.hostileWithin, hpBelow: RESERVE_DEFAULTS.hpBelow });
    expect(reserveStopIf({ hostileWithin: 12, hpBelow: 6, hungerBelow: 4 })).toEqual({ hostileWithin: 12, hpBelow: 10, hungerBelow: 4 });
  });
});
