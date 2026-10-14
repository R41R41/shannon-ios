import { describe, expect, it } from 'vitest';
import { MINECRAFT_SKILL_DEFAULT_MS, MINECRAFT_SKILL_MAX_MS, minecraftRetryHint, minecraftSkillMilliseconds, minecraftSkillResult } from '../src/surfaces/minecraft/minecraftOutcome.js';
import { minecraftMilestones, minecraftPace } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

/** The Minebot lane agreement of 2026-10-14 (failure kinds, per-skill duration) and the pace note (owner: 「40分のまま速くする」). */
describe('the body\'s failure kinds', () => {
  it('maps each agreed code to its hint, any other code to changing the situation, and none to nothing', () => {
    const expected: Record<string, string> = {
      interrupted: 'retry_same', timeout: 'retry_same', movement_incomplete: 'retry_same', position_verification_failed: 'retry_same',
      placement_unconfirmed: 'retry_same', not_ready: 'retry_same', BODY_DEADLINE: 'retry_same',
      no_path: 'change_situation', no_route_from_here: 'change_situation', target_not_found: 'change_situation', distance_too_far: 'change_situation',
      unsafe_lava: 'change_situation', threat_too_close: 'change_situation', inventory_full: 'change_situation', no_descent: 'change_situation',
      descent_too_high: 'change_situation', descent_blocked: 'change_situation', something_new: 'change_situation',
      material_missing: 'need_material', missing_item: 'need_material', missing_tool: 'need_material', wrong_tool: 'need_material',
      tool_durability_low: 'need_material', tool_broke: 'need_material',
      invalid_coordinates: 'invalid_input', unsupported_target: 'invalid_input', protected_target: 'invalid_input',
    };
    for (const [code, hint] of Object.entries(expected)) expect(minecraftRetryHint(code), code).toBe(hint);
    for (const absent of [undefined, null, '', 3]) expect(minecraftRetryHint(absent)).toBeNull();
  });
  it('makes retry_same and change_situation retryable, the others not, and leaves a failure without a code (BODY_* included) as it was', () => {
    const receipt = (extra: Record<string, unknown>) => ({ id: 'skill:x', connectionId: 'c', outcome: 'failed' as const, inputsReleased: true,
      observedAt: '2026-10-14T00:00:00.000Z', result: '失敗', ...extra });
    expect(minecraftSkillResult(receipt({ failureType: 'timeout' }))).toMatchObject({ ok: false, retryable: true });
    expect(minecraftSkillResult(receipt({ failureType: 'no_path' }))).toMatchObject({ ok: false, retryable: true });
    expect(minecraftSkillResult(receipt({ failureType: 'missing_item' }))).toMatchObject({ ok: false, retryable: false });
    expect(minecraftSkillResult(receipt({ failureType: 'invalid_count' }))).toMatchObject({ ok: false, retryable: false });
    expect(minecraftSkillResult(receipt({}))).toEqual({ ok: false, text: '失敗', failure: 'failed', retryable: false });
    expect(minecraftSkillResult(receipt({ result: 'BODY_CAPTURE_UNAVAILABLE' }))).toEqual({ ok: false, text: 'BODY_CAPTURE_UNAVAILABLE', failure: 'failed', retryable: false });
    expect(minecraftSkillResult({ ...receipt({}), outcome: 'completed', result: '掘った' })).toMatchObject({ ok: true, text: '掘った' });
  });
  it('bounds a skill\'s duration to ten minutes and falls back to 120 s', () => {
    expect(minecraftSkillMilliseconds({ maxDurationMs: 180_000 })).toBe(180_000);
    expect(minecraftSkillMilliseconds({ maxDurationMs: 3_600_000 })).toBe(MINECRAFT_SKILL_MAX_MS);
    for (const value of [undefined, 0, 500, -1, Number.NaN, Infinity]) expect(minecraftSkillMilliseconds({ maxDurationMs: value })).toBe(MINECRAFT_SKILL_DEFAULT_MS);
    expect(minecraftSkillMilliseconds(undefined)).toBe(MINECRAFT_SKILL_DEFAULT_MS);
  });
});

describe('the pace note', () => {
  it('gives the minutes since the task began, its latest results and its failed steps in a row, as closed numbers', () => {
    const step = { snapshot: { task: { createdAt: '2026-10-14T06:59:00.000Z' }, checkpoint: { consecutiveToolFailures: 3 } } } as unknown as TaskStep;
    expect(minecraftPace(step, [{ ok: true }, { ok: false }, { ok: false }], Date.parse('2026-10-14T07:11:30.000Z')))
      .toEqual({ elapsedMinutes: 12, recentResults: { worked: 1, failed: 2 }, failedStepsInARow: 3 });
    const milestones = minecraftMilestones(JSON.stringify({ milestones: { dimension: 'the_nether', visited: ['overworld', 'the_nether'], netherReached: true } }));
    expect(minecraftPace(step, [], Date.parse('2026-10-14T07:11:30.000Z'), milestones).milestones).toEqual({ dimension: 'the_nether', netherReached: true });
    const fresh = { snapshot: { task: { createdAt: 'never' }, checkpoint: null } } as unknown as TaskStep;
    expect(minecraftPace(fresh, [], 0)).toEqual({ elapsedMinutes: null, recentResults: { worked: 0, failed: 0 }, failedStepsInARow: 0 });
  });
});

describe('the milestones of mc.goal-evidence (review of d36252e8)', () => {
  it('reads them from the whole result, however long its visited list, and gives only the dimension and netherReached', () => {
    const visited = Array.from({ length: 400 }, (_, index) => `chunk_${index}`);
    const text = JSON.stringify({ ok: true, milestones: { dimension: 'the_nether', visited, netherReached: true, blazeRods: 2, blazePowder: null,
      enderPearls: 0, enderEyes: null } });
    expect(text.length).toBeGreaterThan(4_000);
    expect(minecraftMilestones(text)).toEqual({ dimension: 'the_nether', netherReached: true });
    // What a 1,000-character summary of it held: no milestones (the former reading).
    expect(minecraftMilestones(text.slice(0, 1000))).toBeNull();
    expect(minecraftMilestones(JSON.stringify({ milestones: { dimension: 'Not A Dimension!', netherReached: 'yes' } }))).toEqual({ dimension: null, netherReached: null });
    for (const none of ['', 'not json', '{}', JSON.stringify({ milestones: null }), JSON.stringify({ milestones: [] })]) expect(minecraftMilestones(none)).toBeNull();
  });
});
