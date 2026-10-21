import { describe, expect, it } from 'vitest';
import type { BodyObservation, BodyValue } from '../src/contracts/bodyControlContract.js';
import { minecraftTransientObservation } from '../src/surfaces/minecraft/minecraftTransientObservation.js';
import { createPaceLedger, paceKind } from '../src/surfaces/minecraft/minecraftPaceLedger.js';
import { minecraftPhaseFacts, minecraftTransientBody } from '../src/surfaces/minecraft/minecraftTransientBody.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';

const frame = (world: Record<string, BodyValue>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 9, stateAt: '2026-10-17T00:00:00Z',
  receivedAt: '2026-10-17T00:00:01Z', connected: true, state: { world }, facts: { alive: true, 'slot:0': 'dirt×1' } });
const entity = (name: string, distance: number) => ({ name, kind: name === 'zombie' ? 'hostile' : 'passive', distance, position: { x: 1.26, y: 64, z: -3.04 } });

describe('transient observation', () => {
  it('lists all 16 entities, each kind counted with its nearest, a hostile once, numbers rounded to 0.1, and no timestamps', () => {
    const entities = [...Array.from({ length: 7 }, (_, i) => entity('pig', 5.04 + i)), entity('sheep', 12.34), entity('zombie', 6.66), ...Array.from({ length: 7 }, (_, i) => entity('chicken', 9 + i))];
    const out = minecraftTransientObservation(frame({ observedAt: 'T', position: { x: 100.57, y: 64, z: -20.25 }, health: 20, dimension: 'overworld',
      inventory: [{ name: 'stone_pickaxe', count: 1 }], nearbyEntities: entities, nearbyThreats: [entity('zombie', 6.66)] }));
    expect(out.position).toEqual({ x: 100.6, y: 64, z: -20.2 });
    expect((out.nearbyEntities as unknown[]).length).toBe(15);
    expect((out.nearbyThreats as unknown[]).length).toBe(1);
    const kinds = out.entityKinds as Array<{ name: string; count: number; nearest: number }>;
    expect(kinds.find(kind => kind.name === 'sheep')).toMatchObject({ count: 1, nearest: 12.3 });
    expect(kinds.find(kind => kind.name === 'pig')).toMatchObject({ count: 7, nearest: 5 });
    expect(kinds.find(kind => kind.name === 'zombie')!.count).toBe(1);
    expect(JSON.stringify(out)).not.toMatch(/observedAt|stateAt|receivedAt|slot:0/u);
  });
  it('keeps to its bound by naming what it drops', () => {
    const out = minecraftTransientObservation(frame({ position: { x: 1, y: 2, z: 3 }, dimension: 'overworld', health: 1, food: 1,
      landmarks: Array.from({ length: 70 }, (_, i) => ({ name: `L${i}`, note: 'あ'.repeat(8) })), memo: { a: 'x'.repeat(500) } }));
    expect(JSON.stringify(out).length).toBeLessThan(9_100);
  });
});

describe('phase facts and the pace ledger', () => {
  it('states tier, bed, cooked food, food items or none, village, biome and surface', () => {
    const facts = minecraftPhaseFacts(frame({ dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, biome: '', rememberedPlaces: { 村: '1,2,3' },
      inventory: [{ name: 'stone_pickaxe', count: 1 }, { name: 'white_bed', count: 1 }, { name: 'cooked_beef', count: 4 }, { name: 'bread', count: 1 }] }), 12);
    // Five things to eat are enough for stage 3 beside the bed (four, `FOOD_STOCK`, since mb-r23; six before it).
    expect(facts).toMatchObject({ tier: 3, hasBed: true, cookedFood: 5, foodItems: ['cooked_beef×4', 'bread×1'], villageKnown: true, biome: null, onSurface: true, elapsedMinutes: 12 });
    expect(minecraftPhaseFacts(frame({ dimension: 'overworld', position: { x: 0, y: 20, z: 0 }, biome: 'plains', inventory: [] }), 1))
      .toMatchObject({ tier: 1, hasBed: false, noFood: true, villageKnown: false, biome: 'plains', onSurface: false });
  });
  it('measures minutes since the last new item kind, the last 15 minutes by kind, and a repeated failure', () => {
    let time = 0;
    const ledger = createPaceLedger({ kept: undefined, began: 0, now: () => time });
    ledger.use();
    ledger.observe(carriedItemCounts({ inventory: [{ name: 'wooden_pickaxe', count: 1 }] }, {}));
    time = 300_000; ledger.observe(carriedItemCounts({ inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'cobblestone', count: 3 }] }, {}));
    time = 600_000;
    ledger.note({ name: 'mc.mine-block', input: { blockName: 'iron_ore' } }, { ok: false, failure: 'failed' }, 90_000);
    ledger.note({ name: 'mc.mine-block', input: { blockName: 'iron_ore' } }, { ok: false, failure: 'failed' }, 30_000);
    ledger.note({ name: 'task.get', input: {} }, { ok: true }, 5);
    const snapshot = ledger.snapshot();
    expect(snapshot).toMatchObject({ sinceAchievementMinutes: 5, last15min: { mining: 2 }, sameFailure: { tool: 'mc.mine-block', times: 2 } });
    // It survives the checkpoint, and a success clears the failure run.
    const next = createPaceLedger({ kept: ledger.checkpoint().minecraftPaceLedger, began: 0, now: () => time });
    expect(next.snapshot().sameFailure?.times).toBe(2);
    next.note({ name: 'mc.move-to', input: {} }, { ok: true }, 1_000);
    expect(next.snapshot().sameFailure).toBeUndefined();
    expect(createPaceLedger({ kept: undefined, began: 0, now: () => 0 }).checkpoint()).toEqual({});
    expect(['mc.dig-shelter', 'mc.wait-time', 'mc.craft-one', 'mc.start-smelting', 'task.get', 'mc.zzz'].map(paceKind)).toEqual(['sheltering', 'waiting', 'crafting', 'smelting', null, 'other']);
  });
  it('assembles the body part with the jobs when the frame reports them and the notice for a repeated failure', () => {
    const ledger = createPaceLedger({ kept: undefined, began: 0, now: () => 0 });
    ledger.note({ name: 'mc.move-to', input: {} }, { ok: false }, 1); ledger.note({ name: 'mc.move-to', input: {} }, { ok: false }, 1);
    const body = minecraftTransientBody({ observation: frame({ dimension: 'overworld', inventory: [], jobs: [{ kind: 'furnace', finishesInSeconds: 30 }] }),
      pace: { elapsedMinutes: 3 }, fields: { skillPointers: ['mc-early-toolchain（x）'] }, ledger });
    expect(body).toMatchObject({ jobs: [{ kind: 'furnace' }], skillPointers: ['mc-early-toolchain（x）'], sameFailure: { times: 2 }, pace: { elapsedMinutes: 3 } });
    expect(Object.keys(minecraftTransientBody({ observation: null, pace: { elapsedMinutes: null }, fields: {}, ledger }))).not.toContain('jobs');
  });
});
