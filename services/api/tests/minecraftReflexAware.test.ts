import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { toolResultForModel } from '../src/mind/tools/shannonTools.js';
import { BODY_REFLEX_FAILURE, minecraftRetryHint, minecraftSkillResult } from '../src/surfaces/minecraft/minecraftOutcome.js';
import { MINECRAFT_OBSERVATION_SUMMARY_CHARACTERS, minecraftObservationSummary } from '../src/surfaces/minecraft/minecraftObservationSummary.js';
import { jobsLine, reflexesLine } from '../src/surfaces/minecraft/minecraftObservationReflexes.js';

const receipt = (fields: Record<string, unknown>) => ({ id: 'x', connectionId: 'c', outcome: 'failed', inputsReleased: true, observedAt: '2026-10-17T00:00:00.000Z', ...fields }) as never;

describe('interrupted_by_reflex (P8)', () => {
  it('is a retry_same, retryable, and carries the reflex marker the runner reads', () => {
    expect(BODY_REFLEX_FAILURE).toBe('interrupted_by_reflex');
    expect(minecraftRetryHint('interrupted_by_reflex')).toBe('retry_same');
    const result = minecraftSkillResult(receipt({ result: 'mine-block: interrupted。体の反射「食事」が先に動いたため中断', failureType: 'interrupted_by_reflex', recoverable: true }));
    expect(result).toMatchObject({ ok: false, retryable: true, bodyReflex: true });
    expect(result.text).toContain('体の反射「食事」');
    expect(result.text).toContain('［再試行の目安: retry_same｜そのままもう一度試せる］');
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('is the only failure marked so: the model\'s view of the result does not change', () => {
    for (const failureType of ['interrupted', 'timeout', 'no_path', 'material_missing', undefined]) {
      expect(minecraftSkillResult(receipt({ result: 'x', failureType }))).not.toHaveProperty('bodyReflex');
    }
    const reflex = minecraftSkillResult(receipt({ result: 'x', failureType: 'interrupted_by_reflex' }));
    const plain = minecraftSkillResult(receipt({ result: 'x', failureType: 'interrupted' }));
    expect(toolResultForModel(reflex)).toBe(toolResultForModel(plain));
    expect(minecraftSkillResult(receipt({ outcome: 'completed', result: 'ok', failureType: 'interrupted_by_reflex' }))).toMatchObject({ ok: true });
  });
});

const observation = (world: Record<string, unknown>, facts: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence: 1,
  stateAt: '2026-10-17T00:00:00.000Z', receivedAt: '2026-10-17T00:00:00.000Z', connected: true, state: { world }, facts: { alive: true, ...facts } } as unknown as BodyObservation);
const reflexes = { recent: [{ ageSec: 5, kind: 'shield', detail: '盾を構えた×3' }, { ageSec: 40, kind: 'eat', detail: '食事（bread）' }], counts: { eat: 1, shield: 3 } };
const jobs = [{ status: 'waiting_external', remainingEstimateMs: 80_400, input: 'raw_iron', count: 8, position: { x: 3, y: 64, z: -2 }, completionVerified: false },
  { status: 'verification_due', remainingEstimateMs: 0, input: 'beef', count: 4, position: { x: 7, y: 64, z: 1 }, unfueledInputCount: 2, completionVerified: false }];

describe('the observation summary says reflexes, jobs and the biome (legacy summary)', () => {
  it('reads each in a line a model can use, and keeps the biome as the scalar it is', () => {
    const summary = minecraftObservationSummary(observation({ health: 8, biome: 'forest', reflexes, jobs }));
    const world = (summary.state as { world: Record<string, unknown> }).world;
    expect(world.biome).toBe('forest');
    expect(world.reflexes).toBe('体の反射（新しい順）: 5秒前 盾を構えた×3／40秒前 食事（bread）｜接続以来 eat×1 shield×3');
    expect(world.jobs).toBe('炉（見込みで、完了の確認ではない）: raw_iron×8 残り約80秒 作業中 (3,64,-2)／beef×4 時間が来た（取り出して確かめる） (7,64,1) 燃料不足2個');
    expect(summary.state).not.toHaveProperty('omitted');
  });
  it('says nothing when the body sent none of them', () => {
    const world = (minecraftObservationSummary(observation({ health: 20 })).state as { world: Record<string, unknown> }).world;
    expect(world).not.toHaveProperty('reflexes'); expect(world).not.toHaveProperty('jobs');
  });
  it('keeps them when the frame is too big and the summary has to drop structured parts', () => {
    const crowd = Array.from({ length: 40 }, (_, i) => ({ name: `landmark${i}`, distance: i, position: { x: i, y: 64, z: i }, evidence: 'x'.repeat(200) }));
    const summary = minecraftObservationSummary(observation({ health: 8, reflexes, jobs, landmarks: crowd, rememberedPlaces: Object.fromEntries(crowd.map(item => [item.name, 'y'.repeat(300)])) }));
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(MINECRAFT_OBSERVATION_SUMMARY_CHARACTERS);
    const world = (summary.state as { world: Record<string, unknown> }).world;
    expect(world.reflexes).toContain('体の反射'); expect(world.jobs).toContain('炉');
  });
  it('falls back to the plain handling for a shape it does not know', () => {
    expect(reflexesLine({ recent: 'none' })).toBeNull(); expect(reflexesLine({ recent: [] })).toBeNull(); expect(reflexesLine({ recent: [{ detail: 1 }] })).toBeNull();
    expect(jobsLine([{ status: 'waiting_external' }])).toBeNull(); expect(jobsLine([])).toBeNull(); expect(jobsLine('x')).toBeNull();
    const world = (minecraftObservationSummary(observation({ reflexes: { odd: true }, jobs: [{ strange: 1 }] })).state as { world: Record<string, unknown> }).world;
    expect(world.reflexes).toEqual({ odd: true }); expect(world.jobs).toEqual([{ strange: 1 }]);
  });
  it('stays within a few hundred characters per line, even for twelve furnaces', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ status: 'waiting_external', remainingEstimateMs: 80_000, input: 'raw_iron', count: 8, position: { x: i, y: 64, z: i }, completionVerified: false }));
    expect(jobsLine(many)!.length).toBeLessThanOrEqual(320);
  });
});
