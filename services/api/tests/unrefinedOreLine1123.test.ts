import { describe, expect, it } from 'vitest';
import { mergeInventory } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';

/** 2026-11-23 (judge replay: raw_iron×2 was counted as two iron and `make bucket 3` was sent): ore not smelted yet says so in its own pack line. */
const notes = () => ({ dropped: [], fixed: [], merged: [], omitted: 0, added: [] }) as Parameters<typeof mergeInventory>[1];

describe('unrefined ore in the pack line', () => {
  it('says raw iron is not smelted, that iron_ingot is 0, and that a furnace makes it usable', () => {
    expect(mergeInventory(['raw_iron×2', 'oak_log×4'], notes())).toEqual(['raw_iron×2（精錬前。鉄インゴットは 0。かまどで焼くと使える）', 'oak_log×4']);
  });
  it('shows the ingots really held, and covers raw gold; a plain item and an ingot stay as they are', () => {
    expect(mergeInventory(['raw_iron×1', 'iron_ingot×3', 'raw_gold×2'], notes())).toEqual([
      'raw_iron×1（精錬前。鉄インゴットは 3。かまどで焼くと使える）', 'iron_ingot×3', 'raw_gold×2（精錬前。金インゴットは 0。かまどで焼くと使える）']);
  });
  it('adds stacks of one kind up before it speaks', () => {
    expect(mergeInventory(['raw_iron×1', 'raw_iron×1'], notes())).toEqual(['raw_iron×2（精錬前。鉄インゴットは 0。かまどで焼くと使える）']);
  });
});
