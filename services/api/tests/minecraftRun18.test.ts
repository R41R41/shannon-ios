import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { isSqliteBusy, retryWhileBusy, sqliteContention, unlessBusy } from '../src/infra/sqlite/sqliteBusy.js';
import { createOpsMinecraftLifecycle } from '../src/wiring/opsMinecraftLifecycleWiring.js';
import { fastBodyState, fastJudgment, type FastBodyState, type FastThreat } from '../src/mind/action/reflex/fastJudgment.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import { MILESTONE_DRIFT, followsMilestone, milestoneFollowMemory } from '../src/surfaces/minecraft/minecraftMilestoneFollow.js';
import { minecraftSituation, minecraftSkillContext, minecraftSkillPointers } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { SkillImporter } from '../src/mind/memory/skillImport.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';

/**
 * Minecraft run 18 (2026-10-20, 30 minutes, 49 decisions): the API exited on `database is locked` and the body stood 169 s; about a
 * second of every decision went to asking the lease; zombies behind a wall were fought twice for 15 s; the step 「食料と羊とベッド」 was
 * shown for 27 decisions and no sheep or village was looked for; and the wood ran short.
 */
const busy = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

describe('a busy database is waited out, never a reason to exit', () => {
  it('skips what can wait with a line naming it, and lets every other error through', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)); });
    try {
      expect(unlessBusy('ops.lifecycle.wake', () => { throw busy(); }, 'skipped')).toBe('skipped');
      expect(lines[0]).toMatch(/^Shannon sqlite busy op=ops\.lifecycle\.wake action=skipped waitedMs=\d+$/u);
      expect(() => unlessBusy('x', () => { throw new Error('SQLITE_CONSTRAINT'); }, null)).toThrow('SQLITE_CONSTRAINT');
      expect(unlessBusy('x', () => 7, 0)).toBe(7);
      expect(isSqliteBusy(Object.assign(new Error('x'), { errcode: 517 }))).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('tries a start-up again while busy and gives up after its attempts with the last error', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      let calls = 0;
      expect(retryWhileBusy('world.start', () => { calls += 1; if (calls < 3) throw busy(); return 'ready'; }, { startAttempts: 5, startDelayMs: 1 })).toBe('ready');
      expect(calls).toBe(3);
      calls = 0;
      expect(() => retryWhileBusy('world.start', () => { calls += 1; throw busy(); }, { startAttempts: 2, startDelayMs: 1 })).toThrow('database is locked');
      expect(calls).toBe(2);
    } finally { spy.mockRestore(); }
  });

  it('leaves a line for a write lock waited for or held a second or more, with where it was taken', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)); });
    try {
      sqliteContention(new Error(), 10, 20);
      expect(lines).toEqual([]);
      function heldHere() { sqliteContention(new Error(), 1_200, 3); }
      heldHere();
      expect(lines[0]).toMatch(/^Shannon sqlite slow lock pid=\d+ op=\S*heldHere\S* waitedMs=1200 heldMs=3$/u);
    } finally { spy.mockRestore(); }
  });

  it('keeps the Ops timer alive when its pass finds the database locked (07:06:08 JST)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let locked = true;
    const ops = createOpsMinecraftLifecycle({ commands: { lifecycleAwaiting: () => { if (locked) throw busy(); return []; } } as never,
      actions: {} as never, service: { available: () => false } as never, scopeKey: 'owner', deviceId: 'device', now: () => '2026-10-20T00:00:00.000Z',
      enabled: () => true, ownerAlone: () => true });
    try {
      expect(() => ops.wake()).not.toThrow();
      locked = false;
      expect(() => ops.wake()).not.toThrow();
    } finally { await ops.close(); spy.mockRestore(); }
  });
});

describe('the fast judgment and a hostile the body did not mark', () => {
  const state = (threats: FastThreat[], overrides: Partial<FastBodyState> = {}): FastBodyState => ({ health: 20, threats, night: true,
    respawnedRecently: false, healthDropped: false, hasWeapon: true, floorActive: false, floorKnown: true, shelterFailed: false,
    resting: new Set(), canCage: false, canTower: false, ...overrides });
  const rule = (value: FastBodyState) => { const verdict = fastJudgment(value); return 'decision' in verdict ? verdict.decision.rule : verdict.hold; };
  const zombie = (distance: number, canReachMe: boolean | null): FastThreat => ({ name: 'zombie', distance, canReachMe, ignited: false });

  it('reads a missing mark as unknown, not as reaching her', () => {
    const observation = { facts: { floorActive: false }, state: { world: { health: 20, nearbyThreats: [{ name: 'zombie', distance: 4 }] } } };
    expect(fastBodyState(observation, { earlierHealth: null, sinceArrivalMs: null }).threats[0]!.canReachMe).toBeNull();
  });
  it('does not fight one merely near that the body did not mark (07:23:23 and 07:23:46: behind a wall)', () => {
    expect(rule(state([zombie(4, null)]))).toBe('no_threat');
    expect(rule(state([zombie(4, false)]))).toBe('no_threat');
    expect(rule(state([zombie(4, true)]))).toBe('melee_fight');
  });
  it('still answers an unmarked one when health falls or she just arrived', () => {
    expect(rule(state([zombie(4, null)], { healthDropped: true, health: 16 }))).toBe('melee_fight');
    expect(rule(state([zombie(10, null)], { respawnedRecently: true }))).toBe('respawn_shelter');
  });
  it('flees an unmarked creeper all the same: its blast needs no path; and hides from an unmarked archer', () => {
    expect(rule(state([{ name: 'creeper', distance: 8, canReachMe: null, ignited: false }], { night: false }))).toBe('creeper_flee');
    expect(rule(state([{ name: 'skeleton', distance: 5, canReachMe: null, ignited: false }], { night: false }))).toBe('ranged_shelter');
    expect(rule(state([{ name: 'creeper', distance: 8, canReachMe: false, ignited: false }], { night: false }))).toBe('no_threat');
  });
});

describe('the lease asked once per outside call, not ten times a decision', () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });
  /** One step that calls `name` twice; how many times the lease was asked, and what the decision's metrics line says. */
  const asks = async (name: string, tools?: FcaStepPorts['tools']) => {
    const at = '2026-10-20T00:00:00.000Z', db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
    const actions = new SQLiteActionStore(db);
    const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at,
      leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
    const root = runtime.ensureRoot('owner');
    const task = runtime.createChild('owner', root.id, { title: 'Run 18', goal: 'Do the work', completionCriteria: 'Observed' }, 'run18');
    let permits = 0;
    const ports: FcaStepPorts = { runtime, ownerAlone: () => true, permit: async () => { permits += 1; return true; }, ...(tools ? { tools } : {}),
      model: { async decide() { return { decision: { kind: 'tools', calls: [{ id: 'a', name, input: {} }, { id: 'b', name, input: {} }] },
        history: [{ role: 'assistant', content: 'turn' }] }; },
      toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; } },
      selector: { async select() { return { names: [name], source: 'jev' }; } } };
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: 'run18', kind: 'agentTask', origin: 'owner_request' }, at).id, 'worker', at)!;
    const step = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); });
    try { await runFcaStep(step, ports, new AbortController().signal); } finally { spy.mockRestore(); }
    const metrics = lines.map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
      .find(line => line?.event === 'fca_decision_metrics');
    return { permits, reported: metrics?.permitAsks, progressMs: (metrics?.other as Record<string, unknown> | undefined)?.progressMs };
  };
  it('asks at the start, before the model and before each tool that does not ask it itself (run 18: about ten)', async () => {
    const counted = await asks('task.list');
    // The start, the model, the two tools; the checks between them reuse the start's grant, and the ones after the model and before
    // the commit ask nothing (the next outside call asks for itself, the commit checks the lease in its own transaction).
    expect(counted.permits).toBeGreaterThanOrEqual(4);
    expect(counted.permits).toBeLessThanOrEqual(8);
    expect(counted.reported).toBe(counted.permits);
    expect(typeof counted.progressMs).toBe('number');
  });
  it('leaves a body tool to ask the lease itself, just before its command', async () => {
    const definition = { name: 'mc.dig', description: 'dig', input: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const },
      domain: 'minecraft_body' as const, effect: 'write' as const, cost: 'none' as const, audiences: ['owner_alone' as const], surfaces: ['text' as const] };
    let executed = 0;
    const counted = await asks('mc.dig', { definitions: [definition], permitsItself: name => name.startsWith('mc.'),
      async execute() { executed += 1; return { ok: true, text: 'dug', retryable: false }; } });
    expect(executed).toBe(2);
    // The start and the model only (the two tools would have been two more).
    expect(counted.permits).toBeGreaterThanOrEqual(2);
    expect(counted.permits).toBeLessThanOrEqual(5);
  });
});
const observation = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1,
  stateAt: 'x', receivedAt: 'x', connected: true,
  state: { world: { dimension: 'overworld', health: 20, food: 20, time: '1000', margin: { darkInSeconds: 600 }, nearbyThreats: [], ...world,
    inventory: ((world.inventory as string[] | undefined) ?? []).map(item => { const [name, count] = item.split('×'); return { name, count: Number(count ?? 1) }; }) } },
  facts: { dimension: 'overworld' } }) as unknown as BodyObservation;
// Run 18 from D18 on: iron pickaxe and bucket, cooked food, no bed, a brown wool.
const IRON_NO_BED = ['iron_pickaxe', 'bucket', 'stone_axe', 'cooked_porkchop×5', 'cooked_mutton×1', 'brown_wool', 'acacia_planks', 'cobblestone×64'];

describe('the step followed, or its procedure put first', () => {
  const call = (name: string, input: Record<string, unknown> = {}) => ({ name, input });
  it('counts a sheep or village search, a hunt, a bed and cooking as following 「食料と羊とベッド」, and iron as not', () => {
    for (const followed of [call('mc.find-nearest-entity', { entityType: 'sheep' }), call('mc.explore-for-structure', { structureType: 'sheep', color: 'brown' }),
      call('mc.explore-for-structure', { structureType: 'village' }), call('mc.attack-continuously', { entityName: 'sheep' }),
      call('mc.craft-one', { itemName: 'brown_bed' }), call('mc.start-smelting', { inputItem: 'beef' })]) expect(followsMilestone('食料と羊とベッド', followed)).toBe(true);
    for (const elsewhere of [call('mc.mine-block', { blockName: 'iron_ore' }), call('mc.withdraw-from-furnace'), call('mc.stair-mine')]) {
      expect(followsMilestone('食料と羊とベッド', elsewhere)).toBe(false);
    }
    expect(followsMilestone('木材', call('mc.mine-block', { blockName: 'acacia_log' }))).toBe(true);
    expect(followsMilestone('鉄', call('mc.withdraw-from-furnace'))).toBe(true);
    // Making and setting the furnace or the table is part of the iron, not elsewhere (the review).
    expect(followsMilestone('鉄', call('mc.craft-one', { itemName: 'furnace' }))).toBe(true);
    expect(followsMilestone('鉄', call('mc.place-block-at', { blockName: 'furnace' }))).toBe(true);
    expect(followsMilestone('鉄', call('mc.place-block-at', { blockName: 'dirt' }))).toBe(false);
    expect(followsMilestone('ダイヤ', call('mc.mine-block', { blockName: 'diamond_ore' }))).toBe(false);
  });

  /** One step of hers: the context, its calls, and what it keeps. */
  const decide = (kept: unknown, milestone: string, calm: boolean, calls: Array<{ name: string; input: unknown }>) => {
    const memory = milestoneFollowMemory(kept);
    const shown = memory.context(milestone, calm);
    calls.forEach(item => memory.note(item));
    return { shown, kept: memory.checkpoint().minecraftMilestoneDrift };
  };
  it('puts the procedure first from the third daytime decision elsewhere on, until one follows it (run 18, D34-D44)', () => {
    const iron = [call('mc.mine-block', { blockName: 'iron_ore', count: 12 })];
    let kept: unknown = null;
    for (let decision = 1; decision <= MILESTONE_DRIFT.decisions; decision += 1) {
      const step = decide(kept, '食料と羊とベッド', true, iron);
      expect(step.shown).toEqual([]);
      kept = step.kept;
    }
    expect(kept).toEqual({ milestone: '食料と羊とベッド', decisions: 3 });
    const fourth = decide(kept, '食料と羊とベッド', true, iron);
    expect(fourth.shown[0]).toBe('今の節目「食料と羊とベッド」から3回続けて別のことをした。いまの作業の区切りで、まずこれを進める:');
    expect(fourth.shown[1]).toMatch(/^羊を探す: mc\.find-nearest-entity（entityType=sheep、maxDistance=128）/u);
    // Night, or a decision with no body call, keeps the count; a step that follows clears it; another step starts it again.
    expect(decide(fourth.kept, '食料と羊とベッド', false, iron).kept).toEqual({ milestone: '食料と羊とベッド', decisions: 4 });
    expect(decide(fourth.kept, '食料と羊とベッド', false, iron).shown).toEqual([]);
    expect(decide(fourth.kept, '食料と羊とベッド', true, [call('task.list')]).kept).toEqual({ milestone: '食料と羊とベッド', decisions: 4 });
    expect(decide(fourth.kept, '食料と羊とベッド', true, [call('mc.find-nearest-entity', { entityType: 'sheep', maxDistance: 128 })]).kept).toBeNull();
    expect(decide(fourth.kept, '鉄', true, [call('mc.dig-shelter')]).kept).toEqual({ milestone: '鉄', decisions: 1 });
    expect(decide({ milestone: 'ダイヤ', decisions: 9 }, 'ダイヤ', true, iron).shown).toEqual([]);
    // A daytime decision at a step without a procedure ends a count kept from an earlier step.
    expect(decide(fourth.kept, 'ダイヤ', true, iron).kept).toBeNull();
  });

  it('puts the procedure ahead of the pointers and their gists', () => {
    const situation = { ...minecraftSituation(observation({ inventory: IRON_NO_BED }), { failedStepsInARow: 0 }), milestoneSteps: ['手順'] };
    expect(situation.milestoneName).toBe('食料と羊とベッド');
    const fields = minecraftSkillContext(situation, new Set(['mc-food-and-bed']), () => new Map([['mc-food-and-bed', ['要点']]])).fields;
    expect(Object.keys(fields)[0]).toBe('milestoneSteps');
    expect(fields.skillGists?.map(gist => gist.skill)).toEqual(['mc-food-and-bed']);
  });
});

describe('the first day pointed while the wood is short', () => {
  it('keeps mc-first-day at stage 2 under twelve planks of wood (run 18: 2 logs and 3 planks)', () => {
    const at = (inventory: string[]) => minecraftSkillPointers(minecraftSituation(observation({ inventory }), { failedStepsInARow: 0 }), new Set(['mc-first-day']));
    expect(at(['stone_pickaxe', 'acacia_log×2', 'acacia_planks×3'])).toEqual(['mc-first-day（木材が板材12枚分に足りない）']);
    expect(at(['stone_pickaxe', 'acacia_log×3'])).toEqual([]);
    expect(at(['stone_pickaxe', 'acacia_planks×12'])).toEqual([]);
  });
});

describe('legacy-minecraft draft-10', () => {
  it('revises mc-first-day and mc-food-and-bed on draft-9, with no new skill', () => {
    const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => ({ carries: () => false }), tools: () => [] });
    const at = (minutes: number) => new Date(Date.parse('2026-10-20T00:00:00.000Z') + minutes * 60_000).toISOString();
    (['draft-1', 'draft-2', 'draft-3', 'draft-4', 'draft-6', 'draft-7', 'draft-8', 'draft-9'] as const).forEach((revision, index) => {
      const pack = standardSkillPack('legacy-minecraft', revision)!;
      importer.apply('owner', pack, { planHash: importer.dryRun('owner', pack).planHash, approvalReference: 'x' }, at(index));
    });
    const pack = standardSkillPack('legacy-minecraft', 'draft-10')!;
    expect(pack.skills.map(skill => skill.name)).toEqual(['mc-first-day', 'mc-food-and-bed']);
    const plan = importer.dryRun('owner', pack);
    expect(plan.problems).toEqual([]);
    expect(plan.capacity.added).toBe(0);
    expect(pack.skills.find(skill => skill.name === 'mc-food-and-bed')!.body).toContain('mc.find-nearest-entity（entityType=sheep、maxDistance=128）');
    expect(pack.skills.find(skill => skill.name === 'mc-first-day')!.body).toContain('count=10');
  });
});
