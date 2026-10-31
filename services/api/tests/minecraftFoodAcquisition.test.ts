import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { foodLine } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { carriedFood, FOOD_POINTS } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { foodPreparation } from '../src/surfaces/minecraft/minecraftFoodPreparation.js';
import { FOOD_ACQUISITION_KNOWLEDGE, foodYieldWords } from '../src/surfaces/minecraft/minecraftFoodAcquisition.js';
import { stageKnowledge } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { ownFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { extractRequestBytes, forgetBench, type MaxState, type Variant } from './helpers/extractRequestBytes.js';
import captured from './fixtures/run56-food-candidates.json' with { type: 'json' };

const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't',
  state: { status: 'ready', world }, facts: {}, controls: [], events: [] }) as unknown as BodyObservation;
const land = (name: string, id: number, distance: number) => ({ name, id, distance, position: { x: 232 + distance, y: 61, z: -48 } });

afterEach(() => forgetBench());

describe('food acquisition: compare return and access, not a nearby school of fish', () => {
  it('shows the recorded fish-only scene honestly, including low yield and no cooking option', () => {
    const before = JSON.stringify(captured.world), line = foodLine(frame(captured.world), 6)!;
    expect(line.match(/#\d+/gu)).toHaveLength(6);
    expect(line).toContain('tropical_fish 1.2点・調理不可');
    expect(line).toContain('経路/回収/個数は未確認');
    expect(line).not.toMatch(/調理後|\[陸\]|cow|村|畑/u);
    expect(JSON.stringify(captured.world)).toBe(before);
  });

  it('keeps land alternatives under both normal and urgent caps, while retaining an easy-fish alternative', () => {
    // Counterfactual alternatives; the recorded run did not observe these land animals.
    const observation = frame({ ...captured.world, nearbyEntities: [...captured.world.nearbyEntities, land('cow', 2001, 14), land('pig', 2002, 20)] });
    for (const limit of [3, 6]) {
      const line = foodLine(observation, limit)!;
      expect(line).toContain('cow #2001'); expect(line).toContain('pig #2002');
      expect(line).toContain('tropical_fish #1255');
      expect(line.match(/#\d+/gu)).toHaveLength(limit);
      expect(line).toContain('beef 4.8点→調理後20.8点');
      expect(line).not.toMatch(/到達可能|安全な経路|確保済み/u);
    }
  });

  it('excludes out-of-range or harmful creatures without inventing a land food source', () => {
    const observation = frame({ nearbyEntities: [land('cow', 1, 25), land('zombie', 2, 1), land('pufferfish', 3, 2)] });
    expect(foodLine(observation, 6)).toBeNull();
  });

  it('uses actual tropical-fish nutrition for carried food and never invents cooked tropical fish', () => {
    expect(carriedFood({ inventory: [{ name: 'tropical_fish', count: 2 }] }, {}).points).toBe(2.4);
    expect(foodPreparation(new Map([['tropical_fish', 2]]), 2.4, FOOD_POINTS)).toBeNull();
    expect(foodYieldWords('salmon', FOOD_POINTS)).toContain('2.4点→調理後15.6点');
    expect(foodYieldWords('cod', FOOD_POINTS)).toContain('2.4点→調理後11点');
  });

  it('delivers the same source-choice procedure to the strategy and current preparation without changing the world', () => {
    expect(ownFirstPlanSystem()).toContain(FOOD_ACQUISITION_KNOWLEDGE);
    expect(stageKnowledge({ body: { state: { dimension: 'overworld' } } })).toContain(FOOD_ACQUISITION_KNOWLEDGE);
  });

  for (const variant of ['normal', 'urgent', 'compressed'] as Variant[]) {
    it(`${variant}: the real request builder retains nutrition and land alternatives without a live model or body`, async () => {
      const state: MaxState = { hp: 20, food: 19, saturation: 5, foods: [], hits: [], holder: {}, life: 2, promises: [], queue: [], free: 30,
        foodCandidates: [...captured.world.nearbyEntities, land('cow', 2001, 14), land('pig', 2002, 20)],
        filler: { resultChars: 10_000, liveLines: 80, nearMobs: 30 } };
      const request = await extractRequestBytes({ state, variant, taskId: 'food-policy' });
      const facts = (request.live.body.facts as string[]).join('\n');
      expect(facts).toContain('cow #2001'); expect(facts).toContain('pig #2002');
      expect(facts).toContain('tropical_fish #1255');
      expect(facts).toContain('1.2点・調理不可');
      expect(facts).toContain('経路/回収/個数は未確認');
      const stages = request.request.messages.flatMap((message: { content: string | { text?: string }[] }) =>
        typeof message.content === 'string' ? [message.content] : message.content.map(block => block.text ?? '')).map((text: string) => {
        try { return JSON.parse(text).stageKnowledge ?? ''; } catch { return ''; }
      });
      expect(stages.join('\n')).toContain(FOOD_ACQUISITION_KNOWLEDGE);
    });
  }
});
