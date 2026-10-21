import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '../src/mind/tools/shannonTools.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { takeNeed } from '../src/surfaces/minecraft/minecraftFillers.js';
import { failureReview } from '../src/surfaces/minecraft/minecraftFailureReview.js';
import { forgetUnreachableWater } from '../src/surfaces/minecraft/minecraftProcedureWater.js';
import { purposeOfItem } from '../src/surfaces/minecraft/minecraftProcedureRepeat.js';
import { createRoutePlanning, forgetRoutes } from '../src/surfaces/minecraft/minecraftRoutePlanner.js';
import { routeWatcher } from '../src/surfaces/minecraft/minecraftRouteWatch.js';
import { createMinecraftTaskMetrics } from '../src/surfaces/minecraft/minecraftTaskMetrics.js';
import { SimBody, setup, type Input } from './support/minecraftProcedureSim.js';

/**
 * mb-r25 (head side of run 25, 2026-10-21): the milestones written when a frame shows them, the route asked about lateness between
 * decisions, the rock thrown in one drop, a procedure that goes round one purpose handed back to the decision with a review, and the
 * walk to a placed bed made to a place beside it.
 */
beforeEach(() => { forgetUnreachableWater(); forgetRoutes(); });

const kit = (body: SimBody, items: Record<string, number>) => { for (const [name, count] of Object.entries(items)) body.add(name, count); return body; };
const frame = (world: Record<string, unknown>, facts: Record<string, unknown> = {}) => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 'x', receivedAt: 'x',
  connected: true, state: { world }, facts }) as unknown as BodyObservation;

describe('the milestones, written when a frame shows them', () => {
  it('writes the iron pickaxe at the second it is seen, between decisions, and once', () => {
    const lines: string[] = [];
    let now = Date.parse('2026-10-21T12:04:18.000Z');
    const metrics = createMinecraftTaskMetrics({ taskId: 't25', createdAt: '2026-10-21T12:04:18.000Z', kept: undefined, now: () => now, log: line => lines.push(line) });
    now += 319_000;
    metrics.sample(frame({ dimension: 'overworld', time: '2400', inventory: ['iron_pickaxe×1'] }, { alive: true }));
    now += 226_000;
    metrics.sample(frame({ dimension: 'overworld', time: '2400', inventory: ['iron_pickaxe×1'] }, { alive: true }));
    metrics.context(frame({ dimension: 'overworld', time: '2400', inventory: ['iron_pickaxe×1'] }), null, {});
    expect(lines.filter(line => line.includes(' milestone ') && line.includes('name=iron_pickaxe'))).toEqual(['Shannon Minecraft milestone task=t25 name=iron_pickaxe t=319 tick=2400 d=1']);
  });

  it('does not count what a dead body shows', () => {
    const lines: string[] = [];
    const metrics = createMinecraftTaskMetrics({ taskId: 't25d', createdAt: '2026-10-21T12:04:18.000Z', kept: undefined, now: () => 0, log: line => lines.push(line) });
    metrics.sample(frame({ inventory: ['iron_pickaxe×1'] }, { alive: false }));
    expect(lines).toEqual([]);
  });
});

describe('the route, asked about lateness between decisions', () => {
  const kept = { legs: [{ milestone: 'バケツ', goal: '鉄でバケツ', where: '近く', targetSeconds: 300 }], plannedAtSeconds: 17, replans: 0, reason: 'start' };
  it('asks a late plan when the step now is late by 240 s, only when a route is held, and not again while one is out', async () => {
    const asked: string[] = [];
    const planning = createRoutePlanning({ kept, taskId: 'watch-1', log: line => { if (line.includes('route asked')) asked.push(line); }, planner: () => new Promise(() => {}) });
    planning.watch({}, 'バケツ', 200);
    expect(asked).toEqual([]);
    planning.watch({}, 'バケツ', 560);
    planning.watch({}, 'バケツ', 565);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('reason=late');
    const none = createRoutePlanning({ kept: undefined, taskId: 'watch-2', log: line => asked.push(line), planner: () => new Promise(() => {}) });
    none.watch({}, '木', 3);
    expect(asked).toHaveLength(1);
    await planning.close(true);
  });

  it('reads the step now from a frame every five seconds', () => {
    const seen: Array<[string | null, number]> = [];
    let now = Date.parse('2026-10-21T12:04:18.000Z');
    const watch = routeWatcher({ plan: { watch: (_world, milestone, seconds) => { seen.push([milestone, seconds]); } }, createdAt: '2026-10-21T12:04:18.000Z', now: () => now });
    const shown = frame({ dimension: 'overworld', inventory: [{ name: 'iron_pickaxe', count: 1 }] }, { alive: true });
    now += 10_000;
    watch(shown);
    now += 2_000;
    watch(shown);
    now += 4_000;
    watch(shown);
    expect(seen.map(([, seconds]) => seconds)).toEqual([10, 16]);
    expect(typeof seen[0]![0]).toBe('string');
  });
});

describe('the rock dropped in one go', () => {
  const rocky = () => kit(new SimBody(), { iron_pickaxe: 1, stick: 4, crafting_table: 1, dirt: 73, diorite: 42, andesite: 30, coarse_dirt: 3, cobblestone: 225 });
  it('throws every kind in one drop, the biggest junk first and cobblestone last (run 25: eight drops of one kind, 25 s)', async () => {
    const body = rocky();
    body.y = -58;
    await setup(body).call({ milestone: 'ダイヤ' });
    expect(body.calls.filter(name => name === 'mc.drop-item')).toHaveLength(1);
    expect(body.inputs.get('mc.drop-item')![0]).toEqual({ itemName: 'dirt:73,diorite:42,andesite:30,coarse_dirt:3,cobblestone:97' });
    expect(body.pack.get('cobblestone')).toBe(128);
    expect(body.pack.get('dirt')).toBeUndefined();
  });

  it('stops dropping for the run once the body has had to take a drop back, whatever the counts then (run 25: the same dirt and diorite three times)', async () => {
    const body = rocky();
    body.y = -58;
    body.tool_drop_item = (): ToolResult => {
      body.take('dirt', 30);
      return { ok: false, text: '拾い直しました', failure: 'failed', bodyFailure: 'picked_up_again', retryable: true } as ToolResult;
    };
    await setup(body).call({ milestone: 'ダイヤ' });
    expect(body.calls.filter(name => name === 'mc.drop-item')).toHaveLength(1);
  });

  it('keeps the single-kind form for one kind', async () => {
    const body = kit(new SimBody(), { iron_pickaxe: 1, stick: 4, crafting_table: 1, tuff: 100, andesite: 10, cobblestone: 60 });
    body.y = -58;
    await setup(body).call({ milestone: 'ダイヤ' });
    expect(body.inputs.get('mc.drop-item')![0]).toEqual({ itemName: 'tuff', count: 42 });
  });
});

describe('a procedure that goes round one purpose', () => {
  const dry = (body: SimBody) => {
    body.tool_use_item_on_block = (input: Input): ToolResult => {
      body.inputs.set('scooped', [...(body.inputs.get('scooped') ?? []), input]);
      return { ok: false, text: '水源は見えているが、バケツが届く岸まで行けませんでした', failure: 'failed', bodyFailure: 'stuck', retryable: true } as ToolResult;
    };
    return body;
  };

  it('ends at the third failure to fill the bucket, and says which and what each was (run 25: seven tries, 483 s, inside one call)', async () => {
    const body = dry(kit(new SimBody(), { iron_pickaxe: 1, bucket: 1, stick: 4, crafting_table: 1 }));
    const result = await setup(body).call({ milestone: 'ダイヤ' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('同じ目的の手が続けて失敗した（水を汲むが3回: stuck・stuck・stuck）');
    expect(body.inputs.get('scooped')).toHaveLength(3);
  });

  it('lays out the water the map knows of: how far, how high or low, in the open or in rock', async () => {
    const body = dry(kit(new SimBody(), { iron_pickaxe: 1, bucket: 1, stick: 4, crafting_table: 1 }));
    body.map = '水源 2か所: 40m 東 (40,64,5)、12m 北 (10,40,5)';
    const result = await setup(body).call({ milestone: 'ダイヤ' });
    expect(result.text).toContain('水の候補（遠さ・高さの差・開けているか）: 40m (40,64,5) 高さの差+0・地上・開けている／12m (10,40,5) 高さの差-24・洞窟・地下（岸が岩の中）');
  });

  it('names a purpose only for the work that goes round, not for crafts or upkeep', () => {
    expect(purposeOfItem({ key: 'water:scoop:1,2,3' })).toBe('水を汲む');
    expect(purposeOfItem({ key: 'iron:0:3' })).toBe('鉄を掘る');
    expect(purposeOfItem({ key: 'craft:iron_pickaxe:0' })).toBeNull();
    expect(purposeOfItem({ key: 'eat:10:bread' })).toBeNull();
    // A look that found nothing is an answer, and a call that was cut is not the work failing.
    expect(purposeOfItem({ key: 'diamond:0:32:0' }, 'target_not_found')).toBeNull();
    expect(purposeOfItem({ key: 'water:walk:1,2,3' }, 'cut')).toBeNull();
  });

  it('gives the decision a review for that one call, though it is one failed step', () => {
    const summary = '手順 「バケツ」→「ゲート」\nできなかった: 同じ目的の手が続けて失敗した（水を汲むが3回: stuck・stuck・stuck）（12手・40秒）\nダイヤ: 水を探す';
    const review = failureReview(1, [{ name: 'mc.run-procedure', ok: false, summary }]);
    expect(review).toMatchObject({ failedStepsInARow: 1 });
    expect(String(review?.failureInsideProcedure)).toContain('水を汲むが3回: stuck・stuck・stuck');
    expect(String(review?.failureInsideProcedure)).not.toContain('12手');
    // Later calls that worked end it; a plain failed step is still no review.
    expect(failureReview(1, [{ name: 'mc.run-procedure', ok: false, summary }, { name: 'mc.craft-one', ok: true, summary: 'ok' }])).toBeNull();
    expect(failureReview(1, [{ name: 'mc.run-procedure', ok: false, summary: '手順 …\nできなかった: 失敗が6回になった' }])).toBeNull();
  });
});

describe('the placed bed', () => {
  it('is walked to a place beside it, not to its own cell (run 25: protected:blue_bed, twice, 14 s and a decision)', () => {
    const item = takeNeed({ id: 'bed@157,67,201', need: 'bed', name: 'blue_bed', distance: 20, canReach: true, at: 'x', data: { x: 157, y: 67, z: 201 } });
    expect(item?.tool).toBe('mc.move-to');
    expect(item?.input).toEqual({ x: 157, y: 67, z: 201, goalType: 'near', range: 2 });
    expect(item?.then?.('')?.tool).toBe('mc.dig-block-at');
  });
});
