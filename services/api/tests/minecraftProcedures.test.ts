import { describe, expect, it } from 'vitest';
import { cutProcedureItem, procedureItem } from '../src/surfaces/minecraft/minecraftProcedureTool.js';
import { PROCEDURE_MILESTONES, procedureWords } from '../src/surfaces/minecraft/minecraftProcedures.js';
import { followsMilestone, milestoneSteps } from '../src/surfaces/minecraft/minecraftMilestoneFollow.js';
import { minecraftStopWhy } from '../src/surfaces/minecraft/minecraftProcedureUpkeep.js';
import { minecraftProcedureFacts } from '../src/surfaces/minecraft/minecraftProcedureFacts.js';
import type { ToolResult } from '../src/mind/tools/shannonTools.js';
import { AT, SimBody, setup, type Input } from './support/minecraftProcedureSim.js';

/** The simulated body these tests run on is in support/minecraftProcedureSim.ts (mb-arch; shared with the run 20 tests). */

describe('Minecraft procedures (mb-arch)', () => {
  it('offers one tool for a whole procedure, and keeps the words of each step in one place', () => {
    const { tools } = setup(new SimBody());
    const definition = tools.definitions.find(tool => tool.name === 'mc.run-procedure');
    expect(definition?.domain).toBe('minecraft_body');
    expect(PROCEDURE_MILESTONES).toEqual(['木', '木と石のツルハシ', '石の斧', '木材', '食料と羊とベッド', '鉄', 'バケツ', '鉄の全身の防具', 'ダイヤ', '黒曜石', 'ゲート']);
    expect(milestoneSteps('鉄', 3).slice(1)).toEqual([...procedureWords('鉄')]);
    expect(followsMilestone('バケツ', { name: 'mc.run-procedure', input: { milestone: '鉄', through: '鉄の全身の防具' } })).toBe(true);
    expect(followsMilestone('ダイヤ', { name: 'mc.run-procedure', input: { milestone: '鉄' } })).toBe(false);
  });

  it('goes from nothing to the Nether in a few calls on a simulated body, inside the owner\'s 30 minutes', async () => {
    const body = new SimBody();
    const { call } = setup(body);
    const results: ToolResult[] = [];
    const plan: Input[] = [{ milestone: '木', through: '食料と羊とベッド' }, { milestone: '鉄', through: '鉄の全身の防具' }, { milestone: 'ダイヤ', through: 'ゲート' }];
    for (const input of plan) results.push(await call(input));
    for (let again = 0; body.dimension === 'overworld' && again < 4; again += 1) results.push(await call({ milestone: 'ダイヤ', through: 'ゲート' }));
    const seconds = Math.round((body.clock - AT) / 1000);
    expect(body.dimension, results.map(result => result.text).join('\n---\n')).toBe('the_nether');
    expect(results.length).toBeLessThanOrEqual(5);
    expect(body.worn.sort()).toEqual(['iron_boots', 'iron_chestplate', 'iron_helmet', 'iron_leggings']);
    expect(seconds).toBeLessThan(1_800);
    console.info(`simulated: ${seconds}s, planner calls ${results.length}, body calls ${body.calls.length}, marks ${JSON.stringify([...body.marks])}`);
  });

  it('hands the turn back with the reason when nothing is in sight, and an arbiter cut stops only the running item', async () => {
    const body = new SimBody();
    body.add('stone_pickaxe', 1);
    body.add('oak_log', 4);
    body.tool_find_nearest_entity = () => ({ ok: true, text: 'sheepは見つかりませんでした', retryable: false });
    body.tool_attack_continuously = () => ({ ok: false, text: '', failure: 'failed', bodyFailure: 'target_not_found', retryable: true }) as ToolResult;
    const { call } = setup(body);
    const result = await call({ milestone: '食料と羊とベッド' });
    expect(result.text).toContain('ベッドも羊も近くに見えない（128m）');
    // A hand-back for a reason is the call working as meant.
    expect(result.ok).toBe(true);
    const slow = new SimBody();
    const { taskId, call: run } = setup(slow);
    let cut = false;
    slow.tool_mine_block = function (this: SimBody) {
      if (!cut) { cut = true; expect(procedureItem(taskId)?.name).toBe('mc.mine-block'); expect(cutProcedureItem(taskId)).toBe(true); }
      this.add('oak_log', 6);
      return { ok: true, text: 'ok', retryable: false };
    };
    const went = await run({ milestone: '木' });
    expect(went.text).toContain('最後まで着いた');
    expect(procedureItem(taskId)).toBeNull();
  });

  it('goes on when the body list changed under one of its calls (a failed call to make again, never an unknown step)', async () => {
    const body = new SimBody();
    const { call } = setup(body);
    let changed = true;
    const dig = body.tool_mine_block.bind(body);
    body.tool_mine_block = (input: Input) => {
      if (!changed) return dig(input);
      changed = false;
      return { ok: false, text: '体の道具の一覧が、この判断の後で変わった。', failure: 'unavailable', retryable: true };
    };
    const result = await call({ milestone: '木' });
    expect(result.text).toContain('最後まで着いた');
    expect(body.calls.filter(name => name === 'mc.mine-block')).toHaveLength(2);
  });
  it('casts the obsidian with the body\'s batch when its use-item-on-block takes a count (mb-body)', async () => {
    const body = new SimBody();
    for (const [name, count] of [['diamond_pickaxe', 1], ['water_bucket', 1]] as const) body.add(name, count);
    body.y = -58;
    const { call } = setup(body, { batch: true });
    const result = await call({ milestone: '黒曜石' });
    expect(result.text).toContain('最後まで着いた');
    expect(body.pack.get('obsidian')).toBe(10);
    expect(body.calls).toEqual(['mc.find-blocks', 'mc.move-to', 'mc.use-item-on-block']);
  });
  it('walks to the diamonds the body\'s map remembers when none are in sight, and looks again from there (mb-body map)', async () => {
    const body = new SimBody();
    for (const [name, count] of [['iron_pickaxe', 1], ['stick', 4], ['crafting_table', 1]] as const) body.add(name, count);
    body.y = -58;
    // The body's own words (mb-map places.ts): the ores by the map's names, a part each, split by ／.
    body.map = '鉱石: 石炭 1か所（12m 北 (5,-50,-12)）／ダイヤ 2か所（150m 東 (150,-58,3)、250m 西 (-250,-58,0)）\n溶岩の溜まり 1か所: 40m 南 (0,-58,40) 地下';
    let walked = false;
    const dig = body.tool_mine_block.bind(body);
    body.tool_mine_block = (input: Input) => walked ? dig(input) : { ok: false, text: '見つかりません', failure: 'failed', bodyFailure: 'target_not_found', retryable: true } as ToolResult;
    const walk = body.tool_move_to.bind(body);
    body.tool_move_to = (input?: Input) => {
      expect(input).toMatchObject({ x: 150, y: -58, z: 3 });
      walked = true;
      return walk();
    };
    const { call } = setup(body);
    const result = await call({ milestone: 'ダイヤ' });
    expect(result.text).toContain('最後まで着いた');
    expect(body.calls.filter(name => name === 'mc.mine-block')).toHaveLength(4);
  });
  it('walks down a cave entrance the map knows instead of digging down, for the iron (mb-map)', async () => {
    const body = new SimBody();
    for (const [name, count] of [['stone_pickaxe', 1], ['oak_log', 6], ['cobblestone', 20], ['crafting_table', 1]] as const) body.add(name, count);
    body.map = '洞窟の入口 2か所（地表から歩いて地下へ下りられる。鉄・ダイヤへの近道）: 20m 南 (0,64,20) → 底 (5,30,25) 鉄の多い深さ、70m 西 (-70,63,0) → 底 (-72,20,3)';
    const walks: Input[] = [];
    const walk = body.tool_move_to.bind(body);
    body.tool_move_to = (input?: Input) => { walks.push(input!); return walk(); };
    const { call } = setup(body);
    await call({ milestone: '鉄' });
    expect(walks.slice(0, 2)).toEqual([{ x: 0, y: 64, z: 20, goalType: 'near', range: 2 }, { x: 5, y: 30, z: 25, goalType: 'near', range: 3 }]);
    expect(body.calls.indexOf('mc.move-to')).toBeLessThan(body.calls.indexOf('mc.mine-block'));
  });

  it('takes a ruined portal\'s chest and frame before any lava, and its flint and steel before any gravel (mb-map)', async () => {
    const body = new SimBody();
    for (const [name, count] of [['diamond_pickaxe', 1], ['water_bucket', 1], ['iron_ingot', 1]] as const) body.add(name, count);
    body.y = -58;
    body.map = '構造物: 村: 300m 北 (0,70,-300)／荒廃したポータル: 40m 東 (40,64,0)（黒曜石14個・箱 (42,63,1): 火打石と打ち金・黒曜石が入ることがある）';
    body.chest = new Map([['flint_and_steel', 1], ['obsidian', 3]]);
    const { call } = setup(body);
    const result = await call({ milestone: '黒曜石' });
    expect(result.text).toContain('最後まで着いた');
    expect(body.pack.get('flint_and_steel')).toBe(1);
    expect(body.pack.get('obsidian')).toBe(10);
    expect(body.calls).not.toContain('mc.find-blocks');
    // Below, the way up is the stair first (mb-r20: the walk through rock to a portal on the surface takes two to eight seconds a metre).
    expect(body.calls.slice(0, 6)).toEqual(['mc.stair-mine', 'mc.move-to', 'mc.check-container', 'mc.withdraw-from-container', 'mc.withdraw-from-container', 'mc.move-to']);
  });
  it('refuses a milestone it has no procedure for, and a through before the start', async () => {
    const { call } = setup(new SimBody());
    expect((await call({ milestone: 'ネザー要塞' })).failure).toBe('invalid_input');
    expect((await call({ milestone: '鉄', through: '木' })).failure).toBe('invalid_input');
  });

  it('stops for the night and hunger only where the procedure cannot answer them itself, and for a missing frame', () => {
    const night = (pack: Record<string, number>, food = 20) => {
      const body = new SimBody();
      for (const [name, count] of Object.entries(pack)) body.add(name, count);
      body.food = food;
      const frame = body.observation();
      (frame.state as { world: { margin: unknown } }).world.margin = { lightInSeconds: 200 };
      return minecraftProcedureFacts(frame);
    };
    const parts = { now: () => AT, toldLate: new Set<string>() };
    expect(minecraftStopWhy(night({}), '木', parts)).toBe('夜になった（ベッドを持っていない）');
    expect(minecraftStopWhy(night({ white_wool: 3 }), '食料と羊とベッド', parts)).toBeNull();
    expect(minecraftStopWhy(night({ white_bed: 1 }), '木', parts)).toBeNull();
    expect(minecraftStopWhy(night({ white_bed: 1 }, 4), '鉄', parts)).toBe('空腹（4）で食べ物を持っていない');
    expect(minecraftStopWhy(night({ white_bed: 1 }, 4), '食料と羊とベッド', parts)).toBeNull();
    expect(minecraftStopWhy(minecraftProcedureFacts(null), '鉄', parts)).toBe('体の観測が届いていない');
    const late = { now: () => AT + 700_000, taskStartedAt: AT, toldLate: new Set<string>() };
    expect(minecraftStopWhy(night({ white_bed: 1 }), '鉄', late)).toBe('「鉄」の目安420秒を280秒過ぎた（いま700秒）');
    expect(minecraftStopWhy(night({ white_bed: 1 }), '鉄', late)).toBeNull();
    // The route's leg (mb-head's plan) before the owner's table.
    const routed = { ...late, toldLate: new Set<string>(), targetSeconds: (name: string) => name === '鉄' ? 650 : undefined };
    expect(minecraftStopWhy(night({ white_bed: 1 }), '鉄', routed)).toBeNull();
  });
});
