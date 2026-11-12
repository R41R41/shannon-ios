import { describe, expect, it } from 'vitest';
import { HAND_KINDS, type ActHand } from '../src/contracts/minecraftActContract.js';
import { HAND_FIELDS, handProblem } from '../src/contracts/minecraftActHandRules.js';
import { handToLine, lineToHand, SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';
import { actExpectedMilliseconds } from '../src/contracts/minecraftActTime.js';
import { dropCandidates, packFacts, packLines, tidyExtras } from '../src/surfaces/minecraft/minecraftLlmcPack.js';
import { keepWordsOf, planMaterials } from '../src/surfaces/minecraft/minecraftLlmcTidyKeep.js';
import { actSpends } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { factsIn, PLAN_FACTS_KEY, planFactsOf } from '../src/surfaces/minecraft/minecraftPlanFacts.js';

/**
 * 2026-11-13 (flow design C): the tidy hand (the head's half of the contract) and the pack's words for a nearly full pack. The pack's words that
 * are conditional (3 free slots or fewer) stay out of the always-on text.
 */
const tidy = (fields: Record<string, unknown>) => ({ do: 'tidy', ...fields }) as unknown as ActHand;
const filler = (n: number) => Array.from({ length: n }, (_, i) => `item_${i}×1`);

describe('the tidy hand: fields, reading and writing', () => {
  it('is a kind of hand with items, keep, room, smelt and seconds, none needed', () => {
    expect(HAND_KINDS).toContain('tidy');
    expect(HAND_FIELDS.tidy).toEqual({ needs: [], may: ['items', 'keep', 'room', 'smelt', 'seconds'] });
    expect(handProblem(tidy({}))).toBeNull();
    expect(handProblem(tidy({ items: [{ item: 'dirt', count: 9 }], keep: [{ item: 'iron_ingot', count: 12 }], room: 8, smelt: false, seconds: 60 }))).toBeNull();
  });
  it('refuses a room out of 1..20, a keep without a count, a count under 1 and other fields', () => {
    expect(handProblem(tidy({ room: 0 }))).toContain('room は 1〜20');
    expect(handProblem(tidy({ room: 21 }))).toContain('room は 1〜20');
    expect(handProblem(tidy({ keep: [{ item: 'coal', count: 0 }] }))).toContain('keep は');
    expect(handProblem(tidy({ items: [{ item: 'dirt', count: 0 }] }))).toContain('items は');
    expect(handProblem(tidy({ seconds: 4 }))).toContain('seconds');
    expect(handProblem(tidy({ target: 'cow' }))).toContain('使えない');
  });
  it('reads `tidy` bare, with kinds and counts, keep=, room=, smelt=off; the line round-trips', () => {
    expect(lineToHand('tidy')).toEqual({ do: 'tidy' });
    expect(lineToHand('tidy cobblestone:64,dirt keep=iron_ingot:12,coal:8 room=8 smelt=off')).toEqual({
      do: 'tidy', items: [{ item: 'cobblestone', count: 64 }, { item: 'dirt' }], keep: [{ item: 'iron_ingot', count: 12 }, { item: 'coal', count: 8 }], room: 8, smelt: false });
    expect(lineToHand('tidy dirt gravel')).toEqual({ do: 'tidy', items: [{ item: 'dirt' }, { item: 'gravel' }] });
    for (const hand of [tidy({}), tidy({ room: 10 }), tidy({ smelt: false }), tidy({ items: [{ item: 'dirt', count: 3 }, { item: 'gravel' }], keep: [{ item: 'coal', count: 4 }], room: 6, seconds: 60 })]) {
      const line = handToLine(hand);
      expect(line.startsWith('json ')).toBe(false);
      expect(lineToHand(line)).toEqual(hand);
    }
  });
  it('refuses a keep without a count, a place and a bad smelt word, each with its reason', () => {
    expect(lineToHand('tidy keep=coal')).toEqual({ error: expect.stringContaining('keep=') });
    expect(lineToHand('tidy 1,2,3')).toEqual({ error: expect.stringContaining('座標は要らない') });
    expect(lineToHand('tidy smelt=maybe')).toEqual({ error: expect.stringContaining('smelt は off か on') });
  });
  it('is in the short manual in one line, and its ceiling is its seconds (default 90) and 2 s', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('tidy [物[:数],…] [keep=物:数,…] [room=N] [smelt=off]');
    expect(SHORT_ACT_DESCRIPTION).toContain('物を省くと体が選ぶ。要る物は keep=');
    expect(actExpectedMilliseconds({ hands: [tidy({})] } as never)).toBeLessThanOrEqual(92_000);
  });
});

describe('the pack words of a nearly full pack (the always-on text does not grow)', () => {
  it('says nothing of tidy at 4 free slots; at 3 it names the clutter and the tidy line', () => {
    expect(packLines(['cobblestone×300', ...filler(20)], { free: 4 }).join('\n')).not.toContain('tidy');
    const soon = packLines(['cobblestone×300', 'rotten_flesh×4', 'spider_eye×2', 'poisonous_potato×1', 'red_terracotta×6', 'oak_door×1', 'poppy×3', ...filler(20)], { free: 3 }).join('\n');
    for (const word of ['rotten_flesh×4', 'spider_eye×2', 'poisonous_potato×1', 'red_terracotta×6', 'oak_door×1', 'poppy×3', 'tidy で空ける（捨てる物と焼く原石を体が選ぶ）。要る物は keep=物:数']) expect(soon).toContain(word);
  });
  it('counts a wooden tool only while a stone one of its kind is held, a stone sword only while an iron one is, a few nuggets and emeralds as clutter', () => {
    const names = (lines: string[]) => packFacts(lines).junk.map(([name]) => name).sort();
    expect(names(['wooden_pickaxe×1', 'stone_pickaxe×1', 'wooden_axe×1', 'stone_sword×1', 'wooden_sword×1'])).toEqual(['wooden_pickaxe', 'wooden_sword']);
    expect(names(['stone_sword×1', 'iron_sword×1', 'wooden_pickaxe×1'])).toEqual(['stone_sword']);
    expect(names(['gold_nugget×4', 'emerald×2'])).toEqual(['emerald', 'gold_nugget']);
    expect(names(['gold_nugget×9', 'emerald×12'])).toEqual([]);
  });
  it('says the bread only with hay_block and a way to make it (a table carried or near, or 4 planks), never without', () => {
    expect(tidyExtras(['hay_block×4', ...filler(30)], 2)).toEqual([]);
    expect(tidyExtras(['hay_block×4', 'crafting_table×1'], 2)).toEqual(['hay_block×4 は tidy で食料のパンになる（約 132 点）']);
    expect(tidyExtras(['hay_block×4', 'oak_planks×4'], 2)).toHaveLength(1);
    expect(tidyExtras(['hay_block×4'], 2, { near: { table: true } })).toHaveLength(1);
    expect(tidyExtras(['hay_block×4', 'crafting_table×1'], 4)).toEqual([]);
    expect(packLines(['hay_block×4', 'crafting_table×1', ...filler(28)], { free: 2 }).join('\n')).toContain('は tidy で食料のパンになる');
    expect(packLines(['hay_block×4', ...filler(28)], { free: 2 }).join('\n')).not.toContain('パンになる');
  });
  it('says raw ore is smelted only with fuel and a furnace (carried, near, or 8 cobblestone to make one)', () => {
    expect(tidyExtras(['raw_iron×8', 'coal×4', 'furnace×1'], 1)).toEqual(['原石 raw_iron×8 は tidy で焼ける']);
    expect(tidyExtras(['raw_iron×8', 'raw_gold×2', 'oak_log×3', 'cobblestone×64'], 1)).toEqual(['原石 raw_iron×8・raw_gold×2 は tidy で焼ける']);
    expect(tidyExtras(['raw_iron×8', 'coal×4'], 1, { near: { furnace: true } })).toHaveLength(1);
    expect(tidyExtras(['raw_iron×8', 'furnace×1'], 1)).toEqual([]);
    expect(tidyExtras(['raw_iron×8', 'coal×4', 'cobblestone×3'], 1)).toEqual([]);
    expect(tidyExtras(['raw_copper×8', 'coal×4', 'furnace×1'], 1)).toEqual([]);
  });
  it('keeps one stack (64) of the most carried filler with 0 or 1 free slot, 128 with 2 or 3', () => {
    const lines = ['cobblestone×200', ...filler(26)];
    expect(packLines(lines, { free: 1 }).join('\n')).toContain('cobblestone 64 は柱と橋に残す');
    expect(packLines(lines, { free: 1 }).join('\n')).toContain('cobblestone×136');
    expect(packLines(lines, { free: 3 }).join('\n')).toContain('cobblestone 128 は柱と橋に残す');
    expect(dropCandidates([['cobblestone', 200]])).toEqual([['cobblestone', 72]]);
    expect(dropCandidates([['cobblestone', 200]], () => 0, 64)).toEqual([['cobblestone', 136]]);
  });
  it('names what the plan will spend as an example of keep= (only what is carried), and holds it back from the drop candidates', () => {
    const carried = new Map([['iron_ingot', 14], ['raw_iron', 4], ['coal', 3], ['cobblestone', 300]]);
    const held = planMaterials(['iron_armor'], carried);
    expect(held.get('iron_ingot')).toBe(14);
    expect(held.get('raw_iron')).toBe(4);
    expect(held.get('coal')).toBe(3);
    expect(held.has('cobblestone')).toBe(false);
    expect(keepWordsOf(held)).toBe('iron_ingot:14,raw_iron:4,coal:3');
    expect(planMaterials(['wood'], carried).size).toBe(0);
    const soon = packLines(['cobblestone×300', 'iron_ingot×14', ...filler(24)], { free: 3, held: item => item === 'cobblestone' ? 100 : 0, keepWords: 'iron_ingot:14' }).join('\n');
    expect(soon).toContain('keep=iron_ingot:14');
    expect(soon).toContain('cobblestone×72');
  });
});

describe('the tidy hand is seen by the open promises', () => {
  it('counts the throws a tidy names as a spend, like a drop', () => {
    expect(actSpends([{ do: 'tidy', items: [{ item: 'oak_planks', count: 8 }] }, { do: 'tidy' }])).toEqual([{ item: 'oak_planks', count: 8 }]);
  });
  it('carries the open promises in the plan facts (none closed), and reads them back', () => {
    const promise = (item: string, count: number, state: 'open' | 'closed') => ({ id: 1, rev: 1, item, count, use: 'x', state, ledger: [] });
    const tree = { schema: 'v2', revision: 1, current: null, nodes: [], promises: [promise('white_bed', 2, 'open'), promise('cobblestone', 8, 'closed')] };
    const facts = planFactsOf(tree as never);
    expect(facts?.promised).toEqual([{ item: 'white_bed', count: 2 }]);
    expect(factsIn({ [PLAN_FACTS_KEY]: facts })?.promised).toEqual([{ item: 'white_bed', count: 2 }]);
    expect(planFactsOf({ ...tree, promises: [] } as never)?.promised).toBeUndefined();
  });
});
