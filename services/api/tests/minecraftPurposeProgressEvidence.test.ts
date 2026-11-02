import { afterEach, expect, it } from 'vitest';
import { planFromSeeds } from '@shannon/mind';
import { purposeEvidence } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';
import { materialsOf, recipeOf, smeltingInputOf } from '../src/surfaces/minecraft/minecraftLlmcRecipes.js';
import { targetRequirements } from '../src/surfaces/minecraft/minecraftPlanRequirements.js';
import { forgetStalls, noteProgress } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
afterEach(forgetStalls);
const frame = (world: object) => ({ connected: true, state: { world }, facts: {} }) as unknown as BodyObservation;
const pack = (items: Record<string, number>) => frame({ inventory: Object.entries(items).map(([name, count]) => ({ name, count })) });
const node = (seed: Record<string, unknown>) => planFromSeeds([{ id: 'n', title: 'n', ...seed }])!.nodes[0]!;
const iron = () => node({ kind: 'iron', doneWhen: 'have:iron_ingot>=8' });
const snapshot = (purpose: Record<string, number>, items: number) => ({ node: 'iron', state: 'doing', milestone: 'iron', items, inventory: {}, purpose });

it('ore dug for an ingot target moves the evidence; surplus and unrelated stock do not', () => {
  const at = (items: Record<string, number>) => purposeEvidence(iron(), pack(items));
  expect(at({ raw_iron: 5 })).toEqual({ 'have:iron_ingot': 0, 'material:iron_ingot:raw_iron': 5 });
  expect(at({ raw_iron: 20 })['material:iron_ingot:raw_iron']).toBe(8);
  expect(at({ iron_ingot: 3, raw_iron: 1 })).toEqual({ 'have:iron_ingot': 3, 'material:iron_ingot:raw_iron': 1 });
  expect(at({ cobblestone: 90, dirt: 64, oak_log: 12 })).toEqual(at({}));
});

it('the keys do not depend on what is held, so a part that appears later is not a new key', () => {
  for (const seed of [{ doneWhen: 'have:iron_ingot>=8' }, { target: { item: 'bucket', count: 1 }, doneWhen: 'have:bucket' },
    { target: { item: 'crafting_table', count: 1 }, doneWhen: 'have:crafting_table' }]) {
    expect(Object.keys(purposeEvidence(node(seed), pack({ raw_iron: 3, oak_log: 2, iron_ingot: 1, oak_planks: 4 }))).sort())
      .toEqual(Object.keys(purposeEvidence(node(seed), pack({}))).sort());
  }
});

it('logs cut for a table or a tool count as the planks they become, raw iron as the ingots of a bucket', () => {
  const table = node({ target: { item: 'crafting_table', count: 1 }, doneWhen: 'have:crafting_table' });
  expect(purposeEvidence(table, pack({}))['material:crafting_table:planks']).toBe(0);
  expect(purposeEvidence(table, pack({ oak_log: 1 }))['material:crafting_table:planks']).toBe(4);
  expect(purposeEvidence(table, pack({ oak_log: 5, spruce_planks: 1 }))['material:crafting_table:planks']).toBe(4);
  const bucket = node({ target: { item: 'bucket', count: 1 }, doneWhen: 'have:bucket' });
  expect(purposeEvidence(bucket, pack({ iron_ingot: 2, raw_iron: 1, cobblestone: 99 }))).toEqual({ 'have:bucket': 0, 'material:bucket:iron_ingot': 3 });
  const pickaxe = node({ target: { item: 'stone_pickaxe', count: 1 }, doneWhen: 'have:stone_pickaxe' });
  expect(purposeEvidence(pickaxe, pack({ oak_log: 1 }))['material:stone_pickaxe:planks']).toBe(2);
  expect(purposeEvidence(pickaxe, pack({ cobblestone: 7 }))['material:stone_pickaxe:cobblestone']).toBe(3);
});

it('two minutes of digging ore toward an ingot target is progress, two minutes of stacking cobblestone is not', () => {
  const mining = (raw: number, cobblestone: number) => snapshot(purposeEvidence(iron(), pack({ raw_iron: raw, cobblestone })), 40 + raw + cobblestone);
  noteProgress('mine', mining(0, 0), 0);
  for (let seconds = 20; seconds <= 140; seconds += 20) expect(noteProgress('mine', mining(seconds / 20, 0), seconds * 1000), `${seconds} s`).toBeNull();
  noteProgress('stack', mining(0, 0), 0);
  for (let seconds = 20; seconds < 120; seconds += 20) expect(noteProgress('stack', mining(0, seconds), seconds * 1000)).toBeNull();
  expect(noteProgress('stack', mining(0, 200), 125_000)?.kind).toBe('node_stalled');
});

it('a name the model wrote is looked up as the table\'s own entry, never as an inherited property', () => {
  expect(recipeOf('constructor')).toBeNull();
  expect(recipeOf('toString')).toBeNull();
  expect(smeltingInputOf('constructor')).toBeUndefined();
  expect(smeltingInputOf('iron_ingot')).toBe('raw_iron');
  expect(materialsOf('constructor', 1, { chain: true, pack: new Map() })).toEqual({ spends: [], uncounted: true });
  const odd = node({ target: { item: 'constructor', count: 1 }, doneWhen: 'have:constructor' });
  expect(targetRequirements(odd, new Map())).toContain('未対応');
  expect(purposeEvidence(odd, pack({ cobblestone: 3 }))).toEqual({ 'have:constructor': 0 });
});
