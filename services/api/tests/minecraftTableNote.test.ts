import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { tableNote } from '../src/surfaces/minecraft/minecraftLlmcTableNote.js';
import { holdV2 } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';

/** The crafting table's place and reach said beside a make that needs a table (the coordinator's list for 11/4, item 4: no_table). */
const frame = (found: Array<{ block: string; distance: number }>, scanned = true): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't',
  connected: true, facts: {}, state: { world: { dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory: [], worn: '',
    utilities: { radius: 16, dim: 'overworld', scanned, found } } as never } });
const make = (item: string) => ({ hands: [{ do: 'make', item }] });

describe('the table note', () => {
  it('says the nearest table\'s distance and the reach when it is out of reach, and what to do', () => {
    const note = tableNote(make('stone_pickaxe'), frame([{ block: 'crafting_table', distance: 9.2 }]))!;
    for (const word of ['手 1 make stone_pickaxe', '一番近い作業台は 9.2 m 先', '4.5 m 以内', '先に go で作業台へ寄るか', '板 4 で作業台を place']) expect(note, word).toContain(word);
  });
  it('says that no table is in the scan\'s radius', () => {
    expect(tableNote(make('iron_pickaxe'), frame([]))).toContain('半径 16 m 内に作業台が見えない');
  });
  it('says nothing when the table is within reach, the item needs none, the scan was not made, or a hand before it moves or places a table', () => {
    expect(tableNote(make('stone_pickaxe'), frame([{ block: 'crafting_table', distance: 3 }]))).toBeNull();
    expect(tableNote(make('stick'), frame([]))).toBeNull();
    expect(tableNote(make('oak_planks'), frame([]))).toBeNull();
    expect(tableNote(make('stone_pickaxe'), frame([], false))).toBeNull();
    expect(tableNote({ hands: [{ do: 'go', to: { x: 5, y: 70, z: 5 } }, { do: 'make', item: 'stone_pickaxe' }] }, frame([]))).toBeNull();
    expect(tableNote({ hands: [{ do: 'place', block: 'crafting_table', at: [{ x: 1, y: 70, z: 0 }] }, { do: 'make', item: 'stone_pickaxe' }] }, frame([]))).toBeNull();
    expect(tableNote({ hands: [{ do: 'equip', item: 'shield' }, { do: 'craft', item: 'iron_pickaxe' }] }, frame([]))).toContain('手 2 craft iron_pickaxe');
  });
  it('goes to the act as a note: nothing is held', () => {
    expect(holdV2(make('stone_pickaxe'), frame([]), 'tn')).toMatchObject({ note: expect.stringContaining('作業台が見えない') });
  });
});
