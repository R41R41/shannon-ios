import { describe, expect, it } from 'vitest';
import { stageKnowledge, stagesFor } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

describe('blaze knowledge requires a planned or observed blaze', () => {
  it('does not turn the actual S1d overworld spawner scan into blaze evidence', () => {
    const live = { body: { state: { dimension: 'overworld' },
      scan: ['構造物：廃坑 北 31m・下 95、壊れたポータル 南東 71m・下 15。スポナー 39（最寄り 北西 44m・下 101）。'] } };
    expect(stagesFor(live)).toEqual(['prep']);
    expect(stageKnowledge(live)).not.toContain('## ブレイズ');
  });
  it.each(['overworld', 'the_nether'])('does not infer the mob type from a generic spawner in %s', dimension => {
    expect(stagesFor({ body: { state: { dimension }, landmarks: ['スポナー 6m'], scan: ['スポナー 1'] } }))
      .toEqual([dimension === 'the_nether' ? 'nether' : 'prep']);
  });
  it('keeps blaze preparation available before arrival when the plan explicitly asks for it', () => {
    expect(stagesFor({ body: { state: { dimension: 'overworld' },
      planFacts: { now: { id: 'p3', kind: 'blaze' }, above: [], next: [] } } })).toEqual(['prep', 'blaze']);
  });
  it.each(['blaze #41 6m', 'ブレイズのスポナー 6m'])('keeps explicit observed blaze evidence: %s', fact => {
    expect(stagesFor({ body: { state: { dimension: 'the_nether' }, scan: [fact] } })).toEqual(['nether', 'blaze']);
  });
  it('includes a current blaze threat even when there was no new scan or landmark', () => {
    expect(stagesFor({ body: { state: { dimension: 'the_nether' }, threats: ['#41 blaze 6m'] } })).toEqual(['nether', 'blaze']);
    expect(stagesFor({ body: { state: { dimension: 'overworld' }, threats: ['#41 zombie 6m', '#42 skeleton 9m'] } })).toEqual(['prep']);
  });
});
