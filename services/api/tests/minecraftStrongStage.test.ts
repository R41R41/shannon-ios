import { describe, expect, it } from 'vitest';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { llmcModelRouter, strongStageNow } from '../src/wiring/minecraftLlmcConfiguration.js';

/** The model of a step in the End when the plan's node is still behind (seam scenes of 11/3: Opus handled the node behind 3 of 3; the router must pick it). */
const checkpoint = (current: string) => ({ fcaPlanTree: { ...seedPlan('エンダードラゴンを討伐した')!, current } });
const models = { main: { name: 'main' } as never, escalate: null, strong: { name: 'strong' } as never };

describe('the strong stage with the node behind', () => {
  it('is the End by the body\'s dimension whatever the node, and the node\'s own when it is the End or the dragon', () => {
    expect(strongStageNow(checkpoint('p15.2'), 'the_end')).toBe('end');
    expect(strongStageNow(checkpoint('p15.2'), 'overworld')).toBeNull();
    expect(strongStageNow(checkpoint('p17.1'), 'overworld')).toBe('dragon');
    expect(strongStageNow(checkpoint('p16'), null)).toBe('end');
  });
  it('the router picks the strong model in the End with the node behind, and the main one in the Nether', () => {
    expect(llmcModelRouter(models, checkpoint('p15.2'), undefined, 't', () => 'the_end')).toBe(models.strong);
    expect(llmcModelRouter(models, checkpoint('p15.2'), undefined, 't', () => 'overworld')).toBe(models.main);
    expect(llmcModelRouter(models, checkpoint('p9'), undefined, 't', () => 'the_nether')).toBe(models.main);
  });
});
