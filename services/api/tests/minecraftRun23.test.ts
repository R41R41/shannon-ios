import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcedureMemory } from '@shannon/mind';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { FcaExternalTools } from '../src/mind/action/fca/fcaPorts.js';
import type { ToolResult } from '../src/mind/tools/shannonTools.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { FAILURE_HARD_LIMIT, FAILURE_REVIEW_AT, FAILURE_STALL_MS, FAILURE_STOP_AFTER, failureSinceCheckpoint, failureStops, nextFailureSince }
  from '../src/mind/action/fca/fcaFailureLadder.js';
import { fcaTransientHistory, onlyLost } from '../src/mind/action/fca/fcaCoreHistory.js';
import { pinFcaCoreTools } from '../src/mind/action/fca/fcaCoreTools.js';
import type { MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import { minecraftSkillResult, partialProgressOf, withoutGoldAdvice } from '../src/surfaces/minecraft/minecraftOutcome.js';
import { MOVED_BLOCKS, madeProgress, progressMark, withMinecraftProgress } from '../src/surfaces/minecraft/minecraftProgress.js';
import { failureReview, withFailureReview } from '../src/surfaces/minecraft/minecraftFailureReview.js';
import { minecraftProcedureFacts } from '../src/surfaces/minecraft/minecraftProcedureFacts.js';
import { ironMove, type ProcedureTaskStore } from '../src/surfaces/minecraft/minecraftProceduresIron.js';
import { bedAndFoodMove } from '../src/surfaces/minecraft/minecraftProceduresEarly.js';
import { FOOD_ENOUGH } from '../src/surfaces/minecraft/minecraftProcedureFood.js';
import { FOOD_STOCK, milestoneLines, milestoneNow } from '../src/surfaces/minecraft/minecraftStage.js';
import { BED_HEIGHT_REACH, minecraftFrameNeeds } from '../src/surfaces/minecraft/minecraftWorkingArbiter.js';
import { tidyContext, tidyPlaceRow, tidyWorldPart } from '../src/surfaces/minecraft/minecraftWorldTidy.js';
import { minecraftTransientObservation } from '../src/surfaces/minecraft/minecraftTransientObservation.js';
import { bedLead } from '../src/surfaces/minecraft/minecraftBedLead.js';
import { BED_DEFER, bedMayWait } from '../src/surfaces/minecraft/minecraftBedDefer.js';
import { afterCallWork, nextFiller } from '../src/surfaces/minecraft/minecraftFillers.js';
import { bedWaiting } from '../src/surfaces/minecraft/minecraftProcedureTool.js';
import { createBodyTaskRecall } from '../src/mind/recall/bodyTaskRecall.js';
import { createTaskMemory } from '../src/mind/memory/taskMemoryPorts.js';
import type { TaskMemory } from '../src/mind/memory/taskMemoryPorts.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { fcaDenseWorld } from './support/fcaDenseWorld.js';
import { BASE_CATALOG, definition } from './fcaCoreToolsHarness.js';
import { SimBody, setup, type Input } from './support/minecraftProcedureSim.js';

/**
 * mb-r23 (head side of Minecraft run 23, 2026-10-21): a failed call that made something is not a failed step and the task looks back before
 * it stops; the lava is walked to by "near"; one number for the food; 24 iron first; the bed waits when the sheep are far; a deep bed is no
 * "dig it to carry it"; the copper pickaxe is not named; a catalog that only lost tools keeps its epoch; the recall pool lists no lineage.
 */
const at = new Date().toISOString();
const frame = (world: Record<string, unknown>, sequence = 1, facts: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence,
  stateAt: at, receivedAt: at, connected: true, state: { world: { dimension: 'overworld', health: 20, food: 20, margin: { darkInSeconds: 300 }, position: { x: 0, y: 64, z: 0 },
    inventory: [], nearbyThreats: [], jobs: [], ...world } }, facts: { dimension: 'overworld', danger: false, ...facts } } as unknown as BodyObservation);
const pack = (items: Record<string, number>) => Object.entries(items).map(([name, count]) => ({ name, count }));
const factsOf = (world: Record<string, unknown>) => minecraftProcedureFacts(frame(world));
const kit = (body: SimBody, items: Record<string, number>) => { for (const [name, count] of Object.entries(items)) body.add(name, count); return body; };
const store = (): ProcedureTaskStore => ({ furnaces: [], visited: new Set() });
const move = (value: ReturnType<typeof ironMove>) => value.kind === 'do' ? value.item : null;
const sheepNeed = (distance: number, id = `s${distance}`) => ({ id, need: 'bed_wool', name: 'sheep', color: 'white', position: { x: distance, y: 64, z: 0 }, distance, canReach: true });

// -- 1. A failed call that made something is not a failed step; the task looks back before it stops ----------------------------------------------

describe('the ladder of failed steps in a row (run 23: stopped at the fifth, with 9 of 10 obsidian and the body\'s next move unread)', () => {
  it('stops a body task only on a failure after the fifth was read, and when nothing has moved for a time or at ten in a row', () => {
    const base = { body: true, since: 1_000, now: 1_000 + FAILURE_STALL_MS - 1 };
    // The fifth failure brings the count to five: no decision has read its result yet, so the task goes on (it stopped here before).
    expect(failureStops({ ...base, failures: FAILURE_STOP_AFTER, priorFailures: FAILURE_STOP_AFTER - 1 })).toBe(false);
    // The sixth, made by a decision that read the fifth: stops only when nothing moved for the time, or at the hard limit.
    expect(failureStops({ ...base, failures: FAILURE_STOP_AFTER + 1, priorFailures: FAILURE_STOP_AFTER })).toBe(false);
    expect(failureStops({ ...base, now: 1_000 + FAILURE_STALL_MS, failures: FAILURE_STOP_AFTER + 1, priorFailures: FAILURE_STOP_AFTER })).toBe(true);
    expect(failureStops({ ...base, failures: FAILURE_HARD_LIMIT, priorFailures: FAILURE_HARD_LIMIT - 1 })).toBe(true);
    // Without a time of the first failure only the hard limit stops.
    expect(failureStops({ ...base, since: null, now: 9e12, failures: FAILURE_STOP_AFTER + 1, priorFailures: FAILURE_STOP_AFTER })).toBe(false);
    // Any other task keeps the old rule: the fifth failed step stops it.
    expect(failureStops({ body: false, failures: 5, priorFailures: 4, since: null, now: 0 })).toBe(true);
    expect(failureStops({ body: false, failures: 4, priorFailures: 3, since: null, now: 0 })).toBe(false);
    expect(FAILURE_REVIEW_AT).toBeLessThan(FAILURE_STOP_AFTER);
  });

  it('keeps the time the failures began while they go on, takes it from the step that began them, and clears it when they end', () => {
    expect(nextFailureSince(null, 0, 1, 500)).toBe(500);
    expect(nextFailureSince(500, 1, 2, 900)).toBe(500);
    expect(nextFailureSince(null, 3, 4, 900)).toBe(900);
    expect(nextFailureSince(500, 4, 0, 900)).toBeNull();
    expect(failureSinceCheckpoint(700, {})).toEqual({ fcaFailureSince: 700 });
    expect(failureSinceCheckpoint(null, { fcaFailureSince: 700 })).toEqual({ fcaFailureSince: null });
    expect(failureSinceCheckpoint(null, {})).toEqual({});
  });

  type Answer = 'fail' | 'progress' | 'ok';
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
  /** One round per answer, in a body task (`keepBodyTools`): the model calls `mc.use-item-on-block` and the body answers as told. `jumps`: ms the clock moves before a round. */
  async function rounds(answers: readonly Answer[], jumps: Record<number, number> = {}) {
    const harness = actionHarness(() => '2026-10-09T00:00:00.000Z');
    const calls: string[] = [];
    const driver0 = createTaskRuntimeWiring({ db: harness.db, actions: harness.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => '2026-10-09T00:00:00.000Z',
      model: { async decide() { return { decision: { kind: 'wait', summary: 'x' }, history: [] }; }, toolResults: results => ({ results }) } });
    const task = driver0.runtime.createChild('owner', driver0.runtime.ensureRoot('owner').id,
      { title: 'obsidian', goal: 'obsidian private goal', completionCriteria: 'receipt verified' }, 'request-ladder');
    cleanups.push(async () => harness.close());
    cleanups.push(() => driver0.close());
    let count = 0, offset = 0;
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
    const stops: string[] = [];
    const driver = createTaskRuntimeWiring({ db: harness.db, actions: harness.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => '2026-10-09T00:00:00.000Z',
      model: { async decide() {
        count++;
        calls.push(`d${count}`);
        return { decision: { kind: 'tools', calls: [{ id: `call-${count}`, name: 'mc.use-item-on-block', input: {} }] }, history: [{ role: 'assistant', native: 'x' }] };
      }, toolResults: results => ({ results }) },
      stepPorts: () => ({ keepBodyTools: () => true, tools: { definitions: [{ ...definition('mc.use-item-on-block', 'minecraft_body'),
        input: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      async execute(): Promise<ToolResult> {
        const answer = answers[count - 1]!;
        if (answer === 'ok') return { ok: true, text: 'done', retryable: false };
        return { ok: false, text: '黒曜石を6個作りました', failure: 'failed', retryable: true, ...(answer === 'progress' ? { progressed: true as const } : {}) };
      } } }) });
    const stop = driver.runtime.stop.bind(driver.runtime);
    driver.runtime.stop = (scopeKey, taskId, reason) => { stops.push(reason); return stop(scopeKey, taskId, reason); };
    cleanups.push(() => driver.close());
    for (let round = 0; round < answers.length; round++) {
      offset += jumps[round] ?? 0;
      await driver.tick(); await driver.drain();
    }
    return { count, stops, phase: driver.runtime.get('owner', task.id)?.phase, checkpoint: driver.runtime.snapshot('owner', task.id)?.checkpoint as Record<string, unknown> };
  }

  it('does not count a failed call that made something: twelve such calls in a row stop nothing and the count stays at none', async () => {
    const run = await rounds(Array.from({ length: 12 }, () => 'progress' as const));
    expect(run.count).toBe(12);
    expect(run.phase).not.toBe('stopped');
    expect(run.checkpoint).toMatchObject({ consecutiveToolFailures: 0 });
  });

  it('lets a progress call end the run of failures (the count goes back to none, the time of the first failure is cleared)', async () => {
    const run = await rounds(['fail', 'fail', 'fail', 'progress']);
    expect(run.checkpoint).toMatchObject({ consecutiveToolFailures: 0, fcaFailureSince: null });
    expect(run.phase).not.toBe('stopped');
  });

  it('goes on after the fifth failure (a decision reads its result first) and stops on the sixth only after nothing moved for the time', async () => {
    const five = await rounds(Array.from({ length: 5 }, () => 'fail' as const));
    expect(five.phase).not.toBe('stopped');
    expect(five.checkpoint).toMatchObject({ consecutiveToolFailures: 5 });
    expect(typeof five.checkpoint.fcaFailureSince).toBe('number');
    // A sixth within the time: still going on.
    const quick = await rounds(Array.from({ length: 6 }, () => 'fail' as const));
    expect(quick.phase).not.toBe('stopped');
    expect(quick.checkpoint).toMatchObject({ consecutiveToolFailures: 6 });
    // The sixth after the time has passed with nothing moved: the stop, with the old reason.
    const slow = await rounds(Array.from({ length: 6 }, () => 'fail' as const), { 5: FAILURE_STALL_MS + 1_000 });
    expect(slow.phase).toBe('stopped');
    expect(slow.stops).toEqual(['repeated_tool_failure']);
    expect(slow.count).toBe(6);
  });

  it('stops at ten in a row whatever the time', async () => {
    const ten = await rounds(Array.from({ length: 12 }, () => 'fail' as const));
    expect(ten.phase).toBe('stopped');
    expect(ten.count).toBe(FAILURE_HARD_LIMIT);
  });

  it('before it, from three failures in a row, tells the decision to look back: the numbers, the last results with their ends, the order of the review', () => {
    const long = `${'あ'.repeat(700)}先に use-item-on-block（water_bucket）で横の溶岩を固めてください`;
    const recent = [{ name: 'mc.dig-block-at', ok: false, summary: long }, { name: 'mc.use-item-on-block', ok: true, summary: 'ok' },
      { name: 'mc.use-item-on-block', ok: false, summary: '近くに溶岩がない' }, { name: 'mc.dig-block-at', ok: false, summary: long }];
    expect(failureReview(FAILURE_REVIEW_AT - 1, recent)).toBeNull();
    const review = failureReview(FAILURE_REVIEW_AT, recent)!;
    expect(review).toMatchObject({ failedStepsInARow: FAILURE_REVIEW_AT, failuresLeft: FAILURE_HARD_LIMIT - FAILURE_REVIEW_AT });
    expect(String(review.stops)).toContain(`${FAILURE_STOP_AFTER + 1}回以上`);
    const failures = review.recentFailures as Array<{ tool: string; result: string }>;
    expect(failures.map(item => item.tool)).toEqual(['mc.dig-block-at', 'mc.use-item-on-block', 'mc.dig-block-at']);
    // The body's advice stands at the end of its text: it survives the cut.
    expect(failures[0]!.result).toContain('先に use-item-on-block（water_bucket）で横の溶岩を固めてください');
    expect(failures[0]!.result.length).toBeLessThan(450);
    expect(String(review.review)).toContain('minecraft.observe');
    const pace = withFailureReview({ failedStepsInARow: 4, elapsedMinutes: 20 }, recent);
    expect(pace).toMatchObject({ failedStepsInARow: 4, failureReview: { failedStepsInARow: 4 } });
    expect(withFailureReview({ failedStepsInARow: 2 }, recent)).toEqual({ failedStepsInARow: 2 });
  });
});

describe('what a failed call made (run 23: six and three obsidian told "failed")', () => {
  const pick = (name: string) => ({ name, description: name, input: { type: 'object', properties: {}, required: [], additionalProperties: false }, domain: 'minecraft_body',
    effect: name === 'mc.find-blocks' ? 'read' : 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
  const failed: ToolResult = { ok: false, text: '黒曜石を6個作って掘りました。時間を使い切る前に区切りました\n［再試行の目安: retry_same｜そのままもう一度試せる］', failure: 'failed', retryable: true };

  it('reads a gain in the pack, a milestone, or a move of 16 m; the rock she throws away and the drops of a fight are none', () => {
    const before = progressMark(frame({ inventory: pack({ diamond_pickaxe: 1, cobblestone: 90 }) }));
    expect(madeProgress(before, progressMark(frame({ inventory: pack({ diamond_pickaxe: 1, cobblestone: 160, rotten_flesh: 3, bone: 1 }) })))).toBeNull();
    expect(madeProgress(before, progressMark(frame({ inventory: pack({ diamond_pickaxe: 1, cobblestone: 90, obsidian: 6 }) })))).toContain('obsidian+6');
    expect(madeProgress(progressMark(frame({ inventory: pack({ stone_pickaxe: 1 }) })), progressMark(frame({ inventory: pack({ stone_pickaxe: 1, iron_pickaxe: 1 }) }))))
      .toContain('節目 iron_pickaxe');
    // Thrown away (net nothing) and picked up again is no progress; what was lost does not count against a gain either.
    expect(madeProgress(before, progressMark(frame({ inventory: pack({ diamond_pickaxe: 1, cobblestone: 20 }) })))).toBeNull();
    const far = progressMark(frame({ inventory: pack({ diamond_pickaxe: 1, cobblestone: 90 }), position: { x: MOVED_BLOCKS + 1, y: 64, z: 0 } }));
    expect(madeProgress(before, far)).toContain('m 動いた');
    expect(madeProgress(before, progressMark(frame({ inventory: pack({ diamond_pickaxe: 1, cobblestone: 90 }), position: { x: 3, y: 64, z: 0 } })))).toBeNull();
    expect(madeProgress(null, far)).toBeNull();
  });

  it('takes the body\'s own word that a failed skill made part of what it was asked (`partial`), when it sends it', () => {
    const receipt = (extra: Record<string, unknown>) => ({ id: 'x', connectionId: 'c', outcome: 'failed', inputsReleased: true, observedAt: at,
      result: '黒曜石を6個作りました（残り4個）', failureType: 'timeout', ...extra } as unknown as MinecraftControlReceipt);
    expect(minecraftSkillResult(receipt({ partial: true }))).toMatchObject({ ok: false, progressed: true, failure: 'failed' });
    expect(minecraftSkillResult(receipt({ failureType: undefined, partial: true }))).toMatchObject({ ok: false, progressed: true });
    expect(minecraftSkillResult(receipt({})).progressed).toBeUndefined();
    expect(minecraftSkillResult({ ...receipt({ partial: true }), outcome: 'completed' } as MinecraftControlReceipt).progressed).toBeUndefined();
  });

  it('reads the body\'s partial_completion (agreed 2026-10-21): progress, retry_same, the last mark of the text, and none when nothing was made', () => {
    const receipt = (result: string) => ({ id: 'x', connectionId: 'c', outcome: 'failed', inputsReleased: true, observedAt: at, result, failureType: 'partial_completion' } as unknown as MinecraftControlReceipt);
    const text = '黒曜石を6個作って掘りました。［進み: obsidian 6/10］\n道具の補充: 銅の勧め。［進み: obsidian 7/10］ 溶岩が横にあったので先に潰しました。';
    expect(partialProgressOf(text)).toEqual({ item: 'obsidian', made: 7, goal: 10 });
    expect(partialProgressOf('進みなし')).toBeNull();
    const result = minecraftSkillResult(receipt(text));
    expect(result).toMatchObject({ ok: false, progressed: true, retryable: true, bodyFailure: 'partial_completion' });
    expect(result.text).toContain('retry_same');
    // A mark of none made (the body sends none of these) is no progress.
    expect(minecraftSkillResult(receipt('［進み: obsidian 0/10］')).progressed).toBeUndefined();
    // A mark that cannot be read leaves the body's word standing.
    expect(minecraftSkillResult(receipt('途中まで')).progressed).toBe(true);
  });

  it('counts a procedure item that made part of its work as done, so the run goes on and is not failed (the rest is asked next)', async () => {
    const body = kit(new SimBody(), { diamond_pickaxe: 1, water_bucket: 1 });
    body.y = -58;
    const batch = body.tool_use_item_on_block.bind(body);
    let first = true;
    body.tool_use_item_on_block = (input: Input) => {
      if (!first || Number(input.count ?? 1) < 2) return batch(input);
      first = false;
      body.add('obsidian', 6);
      return { ok: false, text: '黒曜石を6個作って掘りました［進み: obsidian 6/10］', failure: 'failed', bodyFailure: 'partial_completion', progressed: true, retryable: true } as ToolResult;
    };
    const result = await setup(body, { batch: true }).call({ milestone: '黒曜石' });
    expect(body.pack.get('obsidian')).toBeGreaterThanOrEqual(10);
    expect(result.text).not.toContain('できなかった');
  });

  /** The body's frames: `world` is the one the call leaves behind; each look is a new frame. */
  function wrapped(result: ToolResult, after: Record<string, unknown>, definitions = [pick('mc.use-item-on-block'), pick('mc.find-blocks')]) {
    let world: Record<string, unknown> = { inventory: pack({ diamond_pickaxe: 1, water_bucket: 1 }) }, sequence = 0;
    const inner = { definitions, async execute() { world = after; return result; } } as unknown as FcaExternalTools;
    const tools = withMinecraftProgress(inner, { observe: () => frame(world, (sequence += 1)), sleep: async () => {} });
    return (name: string) => tools.execute({ scopeKey: 'owner', taskId: 't', operationId: 'o', name, input: {}, signal: new AbortController().signal });
  }

  it('marks a failed write that gained and tells it in the text, before the retry hint; leaves the failure as it was', async () => {
    const result = await wrapped(failed, { inventory: pack({ diamond_pickaxe: 1, water_bucket: 1, obsidian: 6 }) })('mc.use-item-on-block');
    expect(result).toMatchObject({ ok: false, failure: 'failed', progressed: true });
    expect(result.text).toContain('進み（失敗には数えない）: obsidian+6');
    expect(result.text.indexOf('進み（失敗には数えない）')).toBeLessThan(result.text.indexOf('［再試行の目安'));
  });

  it('leaves alone: a failure that gained nothing, a call that worked, a read, a cut by the body\'s reflex', async () => {
    const same = { inventory: pack({ diamond_pickaxe: 1, water_bucket: 1 }) }, more = { inventory: pack({ diamond_pickaxe: 1, obsidian: 3 }) };
    expect((await wrapped(failed, same)('mc.use-item-on-block')).progressed).toBeUndefined();
    expect((await wrapped({ ok: true, text: 'ok', retryable: false }, more)('mc.use-item-on-block')).progressed).toBeUndefined();
    expect((await wrapped(failed, more)('mc.find-blocks')).progressed).toBeUndefined();
    expect((await wrapped({ ...failed, bodyReflex: true }, more)('mc.use-item-on-block')).progressed).toBeUndefined();
  });
});

// -- 2. The lava is walked to by "near" -------------------------------------------------------------------------------------------------------

describe('the walk to the lava (run 23: "block" stopped 2.6 m off with "no place to stand", 32 s and 23 s)', () => {
  it('asks the body to come within three blocks of the pool, not to a place from which the lava could be dug', async () => {
    const body = kit(new SimBody(), { diamond_pickaxe: 1, water_bucket: 1 });
    body.y = -58;
    await setup(body, { batch: true }).call({ milestone: '黒曜石' });
    const walk = body.inputs.get('mc.move-to')![0]!;
    expect(walk).toMatchObject({ goalType: 'near', range: 3 });
    expect(body.calls.indexOf('mc.move-to')).toBeLessThan(body.calls.indexOf('mc.use-item-on-block'));
  });
});

// -- 3. One number for the food ---------------------------------------------------------------------------------------------------------------

describe('the food of the opening: the milestone, the stage and the procedure say one number (run 23: 6 against 4, 18 s on a cow and chickens)', () => {
  it('is four everywhere, and the milestone says so', () => {
    expect(FOOD_STOCK).toBe(4);
    expect(FOOD_ENOUGH).toBe(FOOD_STOCK);
    const counts = new Map([['stone_pickaxe', 1], ['stone_axe', 1], ['oak_planks', 12]]);
    expect(milestoneLines({ counts, dimension: 'overworld', netherReached: false }).join('\n')).toContain(`ベッドと食べ物${FOOD_STOCK}個`);
  });

  it('offers no food animal among the needs while the pack holds the stock, and offers one below it', () => {
    const cow = { id: 'food:b:cow', need: 'food', name: 'cow', distance: 6, canReach: true };
    const needs = (inventory: Record<string, number>) => minecraftFrameNeeds(frame({ inventory: pack(inventory), nearbyNeeds: [cow, sheepNeed(10)] })).map(need => need.need);
    expect(needs({ mutton: 2, chicken: 1 })).toEqual(['food', 'bed_wool']);
    expect(needs({ mutton: 3, chicken: 1 })).toEqual(['bed_wool']);
  });

  it('takes `cooked_food` off the descent kit\'s missing list with the stock in the pack, and leaves it with less', () => {
    const margin = { darkInSeconds: 200, descentKit: { missing: ['armor', 'cooked_food'], gated: false } };
    const full = tidyContext({ inventory: pack({ mutton: 3, chicken: 1 }) }, null), less = tidyContext({ inventory: pack({ mutton: 2, chicken: 1 }) }, null);
    expect(tidyWorldPart('margin', margin, full)).toEqual({ darkInSeconds: 200, descentKit: { missing: ['armor'], gated: false } });
    expect(tidyWorldPart('margin', margin, less)).toBe(margin);
    const out = minecraftTransientObservation(frame({ inventory: pack({ mutton: 4 }), margin }));
    expect((out.margin as { descentKit: { missing: string[] } }).descentKit.missing).toEqual(['armor']);
  });
});

// -- 4. Iron: 24 first --------------------------------------------------------------------------------------------------------------------------

describe('the iron (run 23: 16 dug, then 19 at another place 155 s later; the last furnace lit at 798 s)', () => {
  const allOf = (extra: Record<string, number> = {}) => pack({ stone_pickaxe: 1, coal: 8, cobblestone: 20, oak_planks: 12, stick: 8, crafting_table: 1, ...extra });

  it('puts a dig of 24 into three furnaces, 8 each, not 12 and 10 and 2', () => {
    const first = move(ironMove(factsOf({ inventory: allOf({ raw_iron: 24, furnace: 1 }) }), new ProcedureMemory(), store()))!;
    expect(first.tool).toBe('mc.place-block-at');
    expect(first.then!('furnace を(12, 64, 2)に設置しました')).toMatchObject({ tool: 'mc.start-smelting', input: { inputItem: 'raw_iron', count: 8 } });
  });
});

// -- 5. The bed waits when the sheep are far ---------------------------------------------------------------------------------------------------

describe('the bed when the sheep are far (run 23: sheep at 34, 159 and 88 m; the bed at 330 s, the iron begun at 334 s)', () => {
  const far = (distance: number) => ({ ok: true, text: `sheepを発見: 座標(${distance}.5, 64, 3.2), 距離${distance}m`, retryable: false });

  it('leaves the bed in daylight when the nearest sheep is farther than 70 m, goes on to the iron, and does not hunt', async () => {
    const body = kit(new SimBody(), { stone_pickaxe: 1, porkchop: 4, oak_planks: 12, coal: 8, cobblestone: 20, stick: 8, crafting_table: 1 });
    body.tool_find_nearest_entity = () => far(150);
    const run = setup(body);
    const result = await run.call({ milestone: '食料と羊とベッド', through: '鉄' });
    // No walk to a sheep (range 6) and no hunt of one.
    expect((body.inputs.get('mc.move-to') ?? []).filter(input => input.range === 6)).toEqual([]);
    expect((body.inputs.get('mc.attack-continuously') ?? []).filter(input => input.entityName === 'sheep')).toEqual([]);
    expect(body.calls).toContain('mc.mine-block');
    expect(body.inputs.get('mc.mine-block')!.some(input => input.blockName === 'iron_ore' && input.count === 24)).toBe(true);
    expect(result.text).not.toContain('羊が出発点から');
    expect(bedWaiting(run.taskId)).toBe(true);
  });

  it('still goes to a sheep that is within 70 m, and at dusk the bed is wanted again', async () => {
    const near = kit(new SimBody(), { stone_pickaxe: 1, porkchop: 4, oak_planks: 12 });
    near.tool_find_nearest_entity = () => far(60);
    await setup(near).call({ milestone: '食料と羊とベッド' });
    expect(near.calls).toContain('mc.move-to');
    const dusk = kit(new SimBody(), { stone_pickaxe: 1, porkchop: 4, oak_planks: 12 });
    dusk.tool_find_nearest_entity = () => far(150);
    const look = dusk.observation.bind(dusk);
    dusk.observation = () => {
      const f = look();
      (f.state.world as { margin: unknown }).margin = { darkInSeconds: BED_DEFER.darkInSeconds - 40 };
      return f;
    };
    await setup(dusk).call({ milestone: '食料と羊とベッド' });
    expect(dusk.calls).toContain('mc.move-to');
  });

  it('makes the step 「食料と羊とベッド」 passed with the bed left for later and food in the pack, so the planner goes on to the iron', () => {
    const counts = new Map([['stone_pickaxe', 1], ['stone_axe', 1], ['oak_planks', 12], ['porkchop', 4]]);
    expect(milestoneNow({ counts, dimension: 'overworld', netherReached: false }).now.name).toBe('食料と羊とベッド');
    expect(milestoneNow({ counts, dimension: 'overworld', netherReached: false, bedDeferred: true }).now.name).toBe('鉄');
    // Passed by the iron pickaxe and still without the bed, it is not brought back while the bed waits.
    const iron = new Map([...counts, ['iron_pickaxe', 1]]);
    expect(milestoneNow({ counts: iron, dimension: 'overworld', netherReached: false, bedDeferred: true }).now.name).not.toBe('食料と羊とベッド');
    expect(milestoneNow({ counts: iron, dimension: 'overworld', netherReached: false }).now.name).toBe('食料と羊とベッド');
  });

  it('lets the bed wait only by day, and only when the procedure left it', () => {
    expect(bedMayWait(true, { margin: { darkInSeconds: BED_DEFER.darkInSeconds } })).toBe(true);
    expect(bedMayWait(true, { margin: { darkInSeconds: BED_DEFER.darkInSeconds - 1 } })).toBe(false);
    expect(bedMayWait(true, { margin: { lightInSeconds: 100 } })).toBe(false);
    expect(bedMayWait(true, { dimension: 'the_nether', margin: { darkInSeconds: 900 } })).toBe(false);
    expect(bedMayWait(false, { margin: { darkInSeconds: 900 } })).toBe(false);
    const memory = new ProcedureMemory(), waits = { furnaces: [], visited: new Set<string>(), bedWaits: true };
    const home = factsOf({ inventory: pack({ stone_pickaxe: 1, porkchop: 4 }) });
    expect(bedAndFoodMove(home, memory, waits).kind).toBe('done');
    const dusk = minecraftProcedureFacts(frame({ inventory: pack({ stone_pickaxe: 1, porkchop: 4 }), margin: { darkInSeconds: 100 } }));
    expect(bedAndFoodMove(dusk, memory, waits).kind).toBe('do');
    expect(waits.bedWaits).toBe(false);
  });

  it('takes a sheep up to 40 m off in a furnace\'s wait while no bed is carried, and 16 m with one', () => {
    const wait = (inventory: Record<string, number>, distance: number) => nextFiller(frame({ inventory: pack(inventory), nearbyNeeds: [sheepNeed(distance)] }),
      { remainingMs: 80_000, recent: new Set(), waitingCell: null });
    expect(wait({ stone_pickaxe: 1 }, 35)?.tool).toBe('mc.attack-continuously');
    expect(wait({ stone_pickaxe: 1 }, 45)).toBeNull();
    expect(wait({ stone_pickaxe: 1, white_bed: 1 }, 35)).toBeNull();
    expect(wait({ stone_pickaxe: 1, white_bed: 1 }, 18)).toBeNull();
    expect(wait({ stone_pickaxe: 1 }, 18)?.tool).toBe('mc.attack-continuously');
  });

  it('digs coal after the sheep, not before it (run 23: 3 coal for 26 s with the sheep at hand)', () => {
    const fuel = { id: 'fuel:b:1', need: 'fuel', name: 'coal_ore', position: { x: 4, y: 64, z: 0 }, distance: 4, canReach: true };
    const item = afterCallWork(frame({ inventory: pack({ stone_pickaxe: 1 }), nearbyNeeds: [fuel, sheepNeed(10)] }),
      { call: { name: 'mc.move-to', input: {} }, ok: true, recent: new Set() });
    expect(item?.item.input).toMatchObject({ entityName: 'sheep' });
    const coal = afterCallWork(frame({ inventory: pack({ stone_pickaxe: 1 }), nearbyNeeds: [fuel] }), { call: { name: 'mc.move-to', input: {} }, ok: true, recent: new Set() });
    expect(coal?.item.input).toMatchObject({ blockName: 'coal_ore' });
  });
});

// -- 6. A bed deep in rock is not "dig it to carry it" ------------------------------------------------------------------------------------------

describe('the remembered places (run 23: a bed 147 m away and 83 m below her read "掘れば持てる" and the move was turned down in 0 s)', () => {
  const ROW = '147m 南 (26,-23,60) 置かれたベッド: dig-block-at takeEquipment=true で掘れば持てる';
  const here = { x: 20, y: 60, z: -80 };

  it('takes the hint off a place far above or below her and says the height and what the way would cost; leaves a place at her own height as it is', () => {
    const deep = tidyPlaceRow(ROW, here);
    expect(deep).not.toContain('掘れば持てる');
    expect(deep).toContain('(26,-23,60)');
    expect(deep).toMatch(/高さ-83m・岩の中。歩いては行けない、掘り進むと約\d+秒/u);
    const igloo = '13m 北東 (69,66,4) ×2 掘れば持てる';
    expect(tidyPlaceRow(igloo, { x: 60, y: 64, z: 0 })).toBe(igloo);
    expect(tidyPlaceRow(igloo, { x: 60, y: 66 + BED_HEIGHT_REACH + 1, z: 0 })).not.toContain('掘れば持てる');
    expect(tidyPlaceRow(ROW, null)).toBe(ROW);
    expect(tidyPlaceRow('村: 約300m', here)).toBe('村: 約300m');
  });

  it('is applied to the observation the decision reads', () => {
    const out = minecraftTransientObservation(frame({ position: { x: 20, y: 60, z: -80 }, rememberedPlaces: { bed: ROW, furnace: '13m 北東 (68,66,4)' } }));
    const places = out.rememberedPlaces as Record<string, string>;
    expect(places.bed).not.toContain('掘れば持てる');
    expect(places.furnace).toBe('13m 北東 (68,66,4)');
  });

  it('leads to no bed that lies far below her, and to a bed at her height', () => {
    const world = (row: string) => ({ position: { x: 20, y: 60, z: -80 }, rememberedPlaces: { bed: row }, biome: 'plains' });
    expect(bedLead(world(ROW))).toBeNull();
    expect(bedLead(world('30m 東 (50,62,-80) 置かれたベッド'))).toContain('置かれたベッドが場所の記憶にある');
  });

  it('does not offer a placed bed far above or below her among the needs she can reach', () => {
    const bed = (y: number) => ({ id: `bed:${y}`, need: 'bed', name: 'red_bed', position: { x: 5, y, z: 0 }, distance: 30, canReach: true });
    const reach = (y: number) => minecraftFrameNeeds(frame({ position: { x: 0, y: 64, z: 0 }, nearbyNeeds: [bed(y)] })).map(need => need.canReach);
    expect(reach(66)).toEqual([true]);
    expect(reach(64 - BED_HEIGHT_REACH - 1)).toEqual([false]);
  });
});

// -- 7. The copper pickaxe is not named -----------------------------------------------------------------------------------------------------------

describe('the note of a cheaper tool (run 23: after the gold, copper_pickaxe)', () => {
  it('is not told when the cheaper tool is copper, as for gold; a stone one still is', () => {
    const copper = '道具の補充: deepslate を diamond_pickaxe で掘っています。より安く済む copper_pickaxe は材料が足りず作れません（不足: copper_ingot×3）。';
    expect(withoutGoldAdvice(`掘りました。${copper}`)).toBe('掘りました。');
    expect(withoutGoldAdvice(copper)).toBe('（道具の補充の知らせだけの結果）');
    const stone = '道具の補充: stoneをiron_pickaxeで掘っています。より安く済むstone_pickaxeは材料が足りず作れません（不足: stick×2）。';
    expect(withoutGoldAdvice(stone)).toBe(stone);
  });
});

// -- 8. A catalog that only lost tools keeps its epoch ------------------------------------------------------------------------------------------

describe('the core tools of an epoch (run 23: 83 at the first decision, 78 at the fifth: a summary of 6.2 s and 44.7k tokens written again)', () => {
  const ports = { obsMode: 'transient' as const, keepBodyTools: () => true, selector: {}, history: { codec: { tokens: () => 0 } as never } };
  const priorOf = (catalog: typeof BASE_CATALOG) => ({ fcaToolSelection: { obsMode: 'transient', core: pinFcaCoreTools(catalog) } });

  it('is not stale when the catalog only lost tools, and is when a tool changed or one was added', () => {
    const prior = priorOf(BASE_CATALOG);
    const lost = BASE_CATALOG.filter(tool => tool.name !== 'mc.skill-3' && tool.name !== 'mc.skill-4');
    expect(fcaTransientHistory(prior, lost, ports)!.stale).toBeNull();
    expect(onlyLost(pinFcaCoreTools(BASE_CATALOG), pinFcaCoreTools(lost))).toBe(true);
    const changed = BASE_CATALOG.map(tool => tool.name === 'mc.skill-2' ? { ...tool, description: `${tool.description}（変わった）` } : tool);
    expect(fcaTransientHistory(prior, changed, ports)!.stale).toBe('definitions_changed');
    const added = [...BASE_CATALOG, definition('mc.skill-9', 'minecraft_body')];
    expect(fcaTransientHistory(prior, added, ports)!.stale).toBe('definitions_changed');
    // Lost and changed at once is still a change.
    expect(fcaTransientHistory(prior, changed.filter(tool => tool.name !== 'mc.skill-3'), ports)!.stale).toBe('definitions_changed');
  });
});

// -- 9. The recall pool lists no lineage ---------------------------------------------------------------------------------------------------------

describe('the body task\'s recall pool (run 23: poolMs 3,029 at the first decision, the API\'s thread blocked 4,674 ms)', () => {
  it('searches without the provenance of its candidates (what it shows is read again with its sources)', async () => {
    const seen: Array<{ readOptions: unknown; kind: unknown }> = [];
    const memory: TaskMemory = {
      available: () => true,
      search(_scope, _query, _present, _limit, options, _shared, readOptions) { seen.push({ readOptions, kind: options?.kind }); return []; },
      read: () => [], sources: () => [], async execute() { throw new Error('unused'); },
    };
    const recall = createBodyTaskRecall({ memory, state: { snapshot: () => ({}) as never } });
    await recall.packet({ scopeKey: 'owner', taskId: 't', goal: 'エンドラを討伐してください', cues: { words: [], tags: [] }, present: OWNER_AUDIENCE });
    expect(seen).toHaveLength(3);
    for (const item of seen) expect(item).toEqual({ readOptions: { provenance: false }, kind: 'experience' });
  });

  it('finds the same records with or without provenance, and gives none of the lineage without it', async () => {
    const dense = fcaDenseWorld({ ordinary: 120, episodes: 30 });
    try {
      const memory = createTaskMemory({ state: dense.world.store, conversations: dense.world.store, ownerScope: 'owner', ownerAlone: () => true,
        now: () => dense.world.now(), readSourceVisible: dense.readSourceVisible });
      const snapshot = memory.readSnapshot!('owner');
      const query = 'タスク経験';
      const withProvenance = memory.search('owner', query, OWNER_AUDIENCE, 40, { kind: 'experience' }, snapshot);
      const without = memory.search('owner', query, OWNER_AUDIENCE, 40, { kind: 'experience' }, snapshot, { provenance: false });
      expect(without.length).toBeGreaterThan(0);
      expect(without.map(item => item.id)).toEqual(withProvenance.map(item => item.id));
      expect(without.every(item => item.provenance === undefined)).toBe(true);
      expect(withProvenance.some(item => item.provenance !== undefined)).toBe(true);
    } finally { await dense.close(); }
  }, 60_000);
});
