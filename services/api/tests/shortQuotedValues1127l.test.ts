import { describe, expect, it } from 'vitest';
import { lineToHand } from '../src/contracts/minecraftActShortContract.js';

// end1127 run 14: Haiku wrote `shoot target="#1115" item=bow` (the way the knowledge teaches it) and the quotes went to the body inside the target.
describe('a value or word wrapped in one layer of quotes is read without them', () => {
  it('shoot target="#1115" item=bow', () => {
    expect(lineToHand('shoot target="#1115" item=bow')).toEqual({ do: 'shoot', target: '#1115', item: 'bow' });
  });
  it('shoot "#1115" (the word)', () => {
    expect(lineToHand('shoot "#1115"')).toEqual({ do: 'shoot', target: '#1115' });
    expect(lineToHand("shoot '#1115' item=bow")).toEqual({ do: 'shoot', target: '#1115', item: 'bow' });
  });
  it('attack target="end_crystal"', () => {
    expect(lineToHand('attack target="end_crystal"')).toEqual({ do: 'attack', target: 'end_crystal' });
    expect(lineToHand('attack "end_crystal" seconds=10')).toMatchObject({ do: 'attack', target: 'end_crystal', seconds: 10 });
  });
  it("target='#7' and the escaped target=\\\"#7\\\"", () => {
    expect(lineToHand("shoot target='#7'")).toEqual({ do: 'shoot', target: '#7' });
    expect(lineToHand('shoot target=\\"#7\\"')).toEqual({ do: 'shoot', target: '#7' });
    expect(lineToHand('shoot \\"#7\\"')).toEqual({ do: 'shoot', target: '#7' });
  });
  it('without quotes it reads as before', () => {
    expect(lineToHand('shoot target=#1115 item=bow')).toEqual({ do: 'shoot', target: '#1115', item: 'bow' });
    expect(lineToHand('shoot #1115 item=bow')).toEqual({ do: 'shoot', target: '#1115', item: 'bow' });
    expect(lineToHand('attack end_crystal')).toEqual({ do: 'attack', target: 'end_crystal' });
  });
  it('the type test comes after the quotes are taken off', () => {
    expect(lineToHand('fight enderman seconds="20" flee="true"')).toMatchObject({ seconds: 20, stance: 'flee' });
    expect(lineToHand('go 1,2,3 seconds=20')).toMatchObject({ seconds: 20 });
  });
  it('a quoted value with spaces stays one value', () => {
    expect(lineToHand('shoot target="ender dragon" item=bow')).toEqual({ do: 'shoot', target: 'ender dragon', item: 'bow' });
    expect(lineToHand('attack "ender dragon" seconds=5')).toMatchObject({ target: 'ender dragon', seconds: 5 });
    expect(lineToHand('shoot target=\\"ender dragon\\" item=bow')).toEqual({ do: 'shoot', target: 'ender dragon', item: 'bow' });
  });
  it('a quote left open does not swallow the next fields', () => {
    expect(lineToHand('go 1,2,3 dig="a place="b" maxDig=5')).toMatchObject({ canPlace: ['b'], maxDig: 5 });
    expect(lineToHand('shoot target="#1 item="bow" n=3')).toMatchObject({ item: 'bow', n: 3 });
  });
  it('dependsOn may be quoted', () => {
    expect(lineToHand('shoot target="#1" dependsOn="1"')).toMatchObject({ dependsOn: [1] });
    expect(lineToHand('shoot target="#1" dependsOn="none"')).toMatchObject({ dependsOn: [] });
    expect(lineToHand('shoot target="#1" dependsOn=\\"1,2\\"')).toMatchObject({ dependsOn: [1, 2] });
  });
  it('a quote that never closes, and note=, are as before', () => {
    expect(lineToHand('shoot target="#1115 item=bow')).toMatchObject({ do: 'shoot' });
    expect(lineToHand('shoot target="#1115" item=bow note="end crystal"')).toEqual({ do: 'shoot', target: '#1115', item: 'bow', note: 'end crystal' });
    expect(lineToHand('equip iron_sword note=近い blaze を剣で打つ')).toMatchObject({ do: 'equip', note: '近い blaze を剣で打つ' });
  });
});
