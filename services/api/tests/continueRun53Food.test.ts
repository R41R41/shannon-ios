import { describe, expect, it } from 'vitest';
import { foodPreparation } from '../src/surfaces/minecraft/minecraftFoodPreparation.js';
import { carriedFood, createFoodTrend, FOOD_POINTS, minecraftLlmcLive, minecraftLlmcUrgentLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { preparationShortage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { BEFORE_GATE } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { FOOD_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { candidateLive } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import captured from './fixtures/run52-food-wait.json' with { type: 'json' };

const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't',
  state: { status: 'ready', world }, facts: {}, controls: [], events: [] } as unknown as BodyObservation);
describe('run53: show preparation without crediting unmade food', () => {
  it('delivers the recorded night-wait inventory as 6.4 actual points, and 26.4 only if cooked', () => {
    const world = captured.world, counts = carriedItemCounts(world, {}), actual = carriedFood(world, {});
    const before = JSON.stringify(world);
    const live = minecraftLlmcLive({ observation: frame(world), elapsedMinutes: 32, trend: createFoodTrend(), events: [] });
    expect(live.foodPoints).toMatchObject({ total: 6.4 });
    expect(live.foodPreparation).toMatchObject({ unprepared: true, pointsIfPrepared: 26.4, cookSecondsInOneFurnace: 20, smeltsFromCarriedCoal: 0 });
    const shown = candidateLive({ body: live }).live.body as Record<string, unknown>;
    expect(shown.foodPreparation).toEqual(live.foodPreparation);
    expect(shown.foodPoints).toMatchObject({ total: 6.4 });
    expect(preparationShortage({ dimension: 'overworld', counts, food: actual.points, nowKinds: ['diamond'] })).toContain('6.4');
    expect(JSON.stringify(world)).toBe(before);
  });
  it('keeps the two foods separate when cooking has really completed in a fresh observation', () => {
    const world = { inventory: [{ name: 'cooked_chicken', count: 2 }] };
    expect(carriedFood(world, {}).points).toBe(26.4);
    expect(foodPreparation(carriedItemCounts(world, {}), 26.4, FOOD_POINTS)).toBeNull();
  });
  it('shows cooking and bread from carried ingredients, without assuming fuel or a furnace', () => {
    const counts = new Map([['porkchop', 2], ['hay_block', 1], ['wheat', 2], ['charcoal', 1]]);
    const result = foodPreparation(counts, 9.6, FOOD_POINTS)!;
    expect(result).toMatchObject({ pointsIfPrepared: 74.6, breadFromCarriedWheatAndHay: 3, cookSecondsInOneFurnace: 20, smeltsFromCarriedCoal: 8 });
    expect(result).not.toHaveProperty('ready');
    expect(counts.get('hay_block')).toBe(1);
  });
  it('does not create a food source from rotten meat, absent ingredients or invalid counts', () => {
    expect(foodPreparation(new Map([['rotten_flesh', 10], ['beef', NaN], ['wheat', -3]]), 0, FOOD_POINTS)).toBeNull();
  });
  it('keeps emergency input about immediate food and danger, without a cooking project', () => {
    const live = minecraftLlmcUrgentLive({ observation: frame(captured.world), elapsedMinutes: 32, events: [], urgent: ['矢を受けた'], planNowTitle: null, mode: '急ぎの版' });
    expect(live).not.toHaveProperty('foodPreparation');
    expect(live.foodPoints).toMatchObject({ total: 6.4 });
  });
  it('gives the first planner the same entry food threshold as the preparation verifier', () => {
    expect(Number(/ネザーに入る前に (\d+) 点/u.exec(FOOD_KNOWLEDGE)?.[1])).toBe(BEFORE_GATE.food);
    expect(FOOD_KNOWLEDGE).toContain('入った後の奥への出発は 100');
  });
});
