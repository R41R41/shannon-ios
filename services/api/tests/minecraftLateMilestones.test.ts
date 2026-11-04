import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { DRAGON_MILESTONES } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { lateMilestonesShown, MILESTONE_NAMES } from '../src/surfaces/minecraft/minecraftMilestoneLog.js';
import { createMinecraftTaskMetrics } from '../src/surfaces/minecraft/minecraftTaskMetrics.js';
import { createDragonDefeatLog } from '../src/surfaces/minecraft/minecraftDragonDefeatLog.js';

afterEach(() => vi.restoreAllMocks());

const frame = (world: object): BodyObservation => ({ connected: true, state: { world }, facts: {} }) as unknown as BodyObservation;
const items = (counts: Record<string, number>) => Object.entries(counts).map(([name, count]) => ({ name, count }));
const fortress = ['N ネザー要塞 (10,64,0) 東10m レンガ×30'];
const portalRoom = ['E エンドポータルの枠 (20,32,10) 東20m ×12'];

describe('the journal measures the late road', () => {
  it('gives every late milestone a distinct closed journal name', () => {
    const late = DRAGON_MILESTONES.filter(item => item.late);
    expect(late).toHaveLength(8);
    expect(new Set(late.map(item => item.journal)).size).toBe(late.length);
    for (const milestone of late) {
      expect(milestone.journal).toMatch(/^[a-z0-9_]+$/u);
      expect(MILESTONE_NAMES).toContain(milestone.journal);
    }
  });

  it('uses the road thresholds for rods, pearls, eyes and the end preparation', () => {
    const shown = (counts: Record<string, number>) => lateMilestonesShown(frame({ inventory: items(counts) }));
    expect(shown({ blaze_rod: 1 })).not.toContain('blaze_rods_7');
    expect(shown({ blaze_rod: 6 })).not.toContain('blaze_rods_7');
    expect(shown({ blaze_rod: 7 })).toContain('blaze_rods_7');
    expect(shown({ ender_pearl: 13 })).not.toContain('ender_pearls_14');
    expect(shown({ ender_pearl: 14 })).toContain('ender_pearls_14');
    expect(shown({ ender_eye: 13 })).not.toContain('ender_eyes_14');
    expect(shown({ ender_eye: 14 })).toContain('ender_eyes_14');
    // A cooked beef is 20.8 food points: four make the End's 80, three do not.
    const pack = { white_bed: 8, obsidian: 8, water_bucket: 1, cooked_beef: 4 };
    expect(shown(pack)).toContain('end_preparation');
    expect(shown({ ...pack, white_bed: 7 })).not.toContain('end_preparation');
    expect(shown({ ...pack, cooked_beef: 3 })).not.toContain('end_preparation');
    // Conversion into eyes still counts for the road's rod and pearl conditions.
    expect(shown({ ender_eye: 14 })).toEqual(expect.arrayContaining(['blaze_rods_7', 'ender_pearls_14']));
  });

  it('requires a visible fortress or portal room, and never equates crystals gone with a kill', () => {
    expect(lateMilestonesShown(frame({ dimension: 'the_nether', mapLandmarks: [] }))).toEqual([]);
    expect(lateMilestonesShown(frame({ dimension: 'the_nether', mapLandmarks: fortress }))).toContain('nether_fortress');
    expect(lateMilestonesShown(frame({ mapLandmarks: portalRoom }))).toContain('end_portal_room');
    const end = frame({ dimension: 'minecraft:the_end', crystals: { remaining: 0 }, dragon: { health: 0 } });
    expect(lateMilestonesShown(end)).toContain('the_end');
    expect(lateMilestonesShown(end)).not.toContain('dragon_defeated');
    expect(lateMilestonesShown(null)).toEqual([]);
  });

  it('writes the existing milestone line at the first polled reach and retains it across steps and lost stock', () => {
    const taskId = 'late-poll';
    const lines: string[] = [];
    let now = 1_000_000;
    const make = (kept: unknown) => createMinecraftTaskMetrics({ taskId, createdAt: new Date(0).toISOString(), kept,
      now: () => now, log: line => lines.push(line) });
    const metrics = make(undefined);
    metrics.context(frame({ dimension: 'the_nether', inventory: items({ blaze_rod: 6 }), time: 100 }), null, {});
    now = 4_711_000;
    const reached = frame({ dimension: 'the_nether', inventory: items({ blaze_rod: 7 }), time: 200, mapLandmarks: fortress });
    metrics.sample(reached);
    expect(lines).toContain(`Shannon Minecraft milestone task=${taskId} name=blaze_rods_7 t=4711 tick=200 d=1`);
    expect(lines).toContain(`Shannon Minecraft milestone task=${taskId} name=nether_fortress t=4711 tick=200 d=1`);
    metrics.sample(frame({ dimension: 'the_nether', inventory: [] }));
    metrics.sample(reached);
    const saved = JSON.parse(JSON.stringify(metrics.checkpoint()));
    expect(saved.minecraftMetrics.reached).toContain('blaze_rods_7');
    const next = make(saved.minecraftMetrics);
    next.context(reached, null, {});
    next.sample(reached);
    expect(lines.filter(line => line.includes('name=blaze_rods_7 '))).toHaveLength(1);
    expect(lines.filter(line => line.includes('name=nether_fortress '))).toHaveLength(1);
  });
});

function task(taskId: string, checkpoint: unknown = null): TaskStep {
  return { taskId, scopeKey: 'owner', lease: { id: 'lease' }, snapshot: { checkpoint,
    task: { id: taskId, createdAt: new Date(0).toISOString(), goal: 'エンドラを討伐して', completionCriteria: 'native death' } } } as TaskStep;
}
function evidence(step: TaskStep, overrides: object = {}) {
  const { goal, completionCriteria } = step.snapshot.task;
  const contextKey = createHash('sha256').update(JSON.stringify([step.scopeKey, step.taskId, 'b', goal, completionCriteria])).digest('hex');
  return JSON.stringify({ contextKey, connected: true, boss: { verified: true }, ...overrides });
}

describe('the final milestone is a witnessed native kill', () => {
  it('writes the same line once, only for connected proof bound to this original task and body', () => {
    const step = task('late-kill');
    const lines: string[] = [];
    const tracker = createDragonDefeatLog(step, line => lines.push(line), () => 9_601_000);
    for (const value of [undefined, 'garbled', 'null', evidence(step, { connected: false }), evidence(step, { boss: { verified: false } }),
      evidence(step, { contextKey: 'another-task' })]) tracker.note('b', value);
    tracker.note('other-body', evidence(step));
    expect(lines).toEqual([]);
    tracker.note('b', evidence(step));
    tracker.note('b', evidence(step));
    expect(lines).toEqual(['Shannon Minecraft milestone task=late-kill name=dragon_defeated t=9601 tick=- d=1']);
    const saved = JSON.parse(JSON.stringify(tracker.checkpoint()));
    const next = createDragonDefeatLog(task('late-kill', saved), line => lines.push(line), () => 9_700_000);
    next.note('b', evidence(step));
    expect(lines).toHaveLength(1);
    expect(next.checkpoint()).toEqual({ minecraftDragonDefeatLogged: true });
  });

  // The verifier's path (goal.verify through the FCA progress tools) is left to a lab: its unit is the log above.

});
