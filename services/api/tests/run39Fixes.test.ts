import { describe, expect, it } from 'vitest';
import type { PlanNode, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { actProblem, actMilliseconds, actRemainingMilliseconds, type ActHand, type ActInput } from '../src/contracts/minecraftActContract.js';
import { expandShortAct, handToLine, lineToHand } from '../src/contracts/minecraftActShortContract.js';
import { goBlocksProblem, goStop } from '../src/surfaces/minecraft/minecraftLlmcGoGuard.js';
import { WOOD_MARK, minecraftLlmcLive, createFoodTrend, planksHeld } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { doneFacts, nodesSeenDone } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { heldBeforeSend } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { queueWakeMs, QUEUE_T } from '../src/surfaces/minecraft/minecraftLlmcQueue.js';

/**
 * Run 39 (2026-10-26, rel55b, Sonnet): the `go` hand (the model decides where to, what may be dug and placed, what to avoid; the body walks the way), the
 * wood mark of the frame told only while wood is short, and the plan's parent that no longer closes a child whose gear is not made.
 */
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });
const pack = (...items: Array<[string, number]>) => items.map(([name, count]) => ({ name, count }));
const go = (fields: Record<string, unknown>): ActHand => ({ do: 'go', ...fields } as ActHand);
const act = (...hands: ActHand[]): ActInput => ({ hands });

describe('the go hand: the contract', () => {
  const to = { x: 120, y: 40, z: -30 };
  it('takes a destination or candidates (2–8), the blocks it may dig and place, and its limits', () => {
    expect(actProblem(act(go({ to })))).toBeNull();
    expect(actProblem(act(go({ to, canDig: ['stone', 'dirt'], canPlace: ['cobblestone'], maxDrop: 5, waterOk: true, seconds: 90, maxDig: 80, maxPlace: 30, range: 2, sprint: true })))).toBeNull();
    expect(actProblem(act(go({ goals: [to, { x: 5, y: 6, z: 7 }] })))).toBeNull();
  });
  it('refuses a go with no place, both kinds of place, one candidate, or a limit out of its range', () => {
    expect(actProblem(act(go({})))).toContain('to か goals が要る');
    expect(actProblem(act(go({ to, goals: [to, to] })))).toContain('to と goals は片方だけ');
    expect(actProblem(act(go({ goals: [to] })))).toContain('goals は 2〜8');
    expect(actProblem(act(go({ to, seconds: 3 })))).toContain('seconds は 5〜120');
    expect(actProblem(act(go({ to, seconds: 130 })))).toContain('seconds は 5〜120');
    expect(actProblem(act(go({ to, range: 6 })))).toContain('range は 0〜4');
    expect(actProblem(act(go({ to, canDig: ['Stone Brick'] })))).toContain('canDig・canPlace');
  });
  it('refuses a field a go does not take, and a relative go may repeat', () => {
    expect(actProblem(act(go({ to, tool: 'iron_pickaxe' })))).toContain('tool は使えない');
    expect(actProblem({ hands: [go({ to: { x: 5, y: 0, z: 0 }, rel: true })], repeat: 3 })).toBeNull();
    expect(actProblem({ hands: [go({ to })], repeat: 3 })).toContain('repeat の手は rel:true');
  });
  it('keeps the other hands\' limits: wait is 0.5–30 and an attack is 30 at the most', () => {
    expect(actProblem(act({ do: 'wait', seconds: 31 }))).toContain('seconds は 0.5〜30');
    expect(actProblem(act({ do: 'attack', target: 'zombie', seconds: 31 }))).toContain('seconds は 30 まで');
    expect(actProblem(act({ do: 'attack', target: 'zombie', seconds: 20 }))).toBeNull();
  });
});

describe('the go hand: the short line', () => {
  it('writes and reads one cell as to, several as goals, the blocks as dig= and place=', () => {
    const line = 'go 120,40,-30 dig=stone,dirt place=cobblestone,dirt seconds=45 maxDrop=2 waterOk';
    const hand = lineToHand(line);
    expect(hand).toEqual({ do: 'go', to: { x: 120, y: 40, z: -30 }, canDig: ['stone', 'dirt'], canPlace: ['cobblestone', 'dirt'], seconds: 45, maxDrop: 2, waterOk: true });
    expect(handToLine(hand as ActHand)).toBe(line);
    const many = lineToHand('go 1,2,3 4,5,6 7,8,9 range=2 rel');
    expect(many).toEqual({ do: 'go', goals: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, { x: 7, y: 8, z: 9 }], range: 2, rel: true });
    expect(handToLine(many as ActHand)).toBe('go 1,2,3 4,5,6 7,8,9 range=2 rel');
  });
  it('a go with both to and goals goes round as json, and an act of lines is expanded for the body', () => {
    const both = go({ to: { x: 1, y: 2, z: 3 }, goals: [{ x: 4, y: 5, z: 6 }, { x: 7, y: 8, z: 9 }] });
    expect(handToLine(both).startsWith('json ')).toBe(true);
    const { input, errors } = expandShortAct({ hands: ['go 10,5,10 dig=stone place=cobblestone seconds=30'], why: '[p3] 鉄へ' });
    expect(errors).toEqual([]);
    expect(input).toMatchObject({ hands: [{ do: 'go', to: { x: 10, y: 5, z: 10 }, canDig: ['stone'], canPlace: ['cobblestone'], seconds: 30 }] });
    expect(lineToHand('go')).toEqual({ error: 'go: 座標が無い' });
  });
});

describe('the go hand: its time', () => {
  it('is the straight way and a third more, within its seconds; the act\'s ceiling lies after the hand\'s own', () => {
    const near = act(go({ to: { x: 20, y: 0, z: 0 }, seconds: 60 }));
    const from = { x: 0, y: 0, z: 0 };
    // 20 m at 4.3 m/s is 4.65 s; 1 s and a third more: about 7 s.
    expect(Math.round(actRemainingMilliseconds(near, from, null, 0) / 1000)).toBe(7);
    expect(actMilliseconds(near, from)).toBe(62_000);
    const far = act(go({ to: { x: 300, y: 0, z: 0 }, seconds: 40 }));
    expect(actRemainingMilliseconds(far, from, null, 0)).toBe(40_000);
  });
  it('takes the nearest of the candidates', () => {
    const input = act(go({ goals: [{ x: 300, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }] }));
    expect(Math.round(actRemainingMilliseconds(input, { x: 0, y: 0, z: 0 }, null, 0) / 1000)).toBe(4);
  });
  it('is long enough to be called for in time: the head is asked when 5 s remain, so a go of 30 s has the decision in before it ends', () => {
    const wake = queueWakeMs('run39-no-decisions');
    expect(wake).toBe(QUEUE_T.defaultMs);
    const input = act(go({ to: { x: 100, y: 0, z: 0 }, seconds: 90 }));
    const total = actRemainingMilliseconds(input, { x: 0, y: 0, z: 0 }, null, 0);
    expect(total).toBeGreaterThan(25_000);
    // The wake comes at `total − wake` after the item starts; a decision of 4.4 s then ends with the item still running for a moment.
    expect(total - wake).toBeGreaterThan(20_000);
  });
});

describe('the go hand: the guards', () => {
  it('holds what canDig and canPlace may not name, with the reason', () => {
    expect(goBlocksProblem({ canDig: ['stone', 'dirt', 'wood'], canPlace: ['cobblestone', 'dirt'] })).toBeNull();
    expect(goBlocksProblem({ canDig: ['iron_ore'] })).toContain('「iron_ore」');
    expect(goBlocksProblem({ canDig: ['chest', 'bedrock'] })).toContain('dig の手で');
    expect(goBlocksProblem({ canPlace: ['gravel'] })).toContain('「gravel」');
    expect(goBlocksProblem({ canPlace: ['water_bucket'] })).toContain('go では置かない');
  });
  it('is a stop of the act as the other guards are: the hands before it go, and the hand itself is held', () => {
    const held = heldBeforeSend(false, { hands: [{ do: 'wait', seconds: 1 }, go({ to: { x: 5, y: 5, z: 5 }, canDig: ['iron_ore'] })] }, null, 'run39');
    expect(held?.tail).toContain('手 2 から先');
    expect(held?.tail).toContain('iron_ore');
    expect(held?.input).toMatchObject({ hands: [{ do: 'wait' }] });
  });
  const lavaMap = (): BodyObservation => {
    const rows = ['地図 v1 足=(10,10,10) x=3..17 z=3..17 方式=layers 上=北'];
    for (const dy of [1, 0, -1]) {
      rows.push(`y=${10 + dy}`);
      for (let z = 3; z <= 17; z += 1) {
        rows.push(` ${z} ${Array.from({ length: 15 }, (_, i) => dy === 0 && z === 10 && i + 3 === 14 ? 'L' : dy === 0 && z === 10 && i + 3 === 10 ? '@' : dy === 0 ? '.' : '#').join(' ')}`);
      }
    }
    return frame({ position: { x: 10.5, y: 10, z: 10.5 }, localMap: rows.join('\n'), health: 20 });
  };
  it('holds a destination the map shows as lava, and goes to one it does not show or that is ordinary', () => {
    expect(goStop({ hands: [go({ to: { x: 14, y: 10, z: 10 } })] }, lavaMap())?.line).toContain('溶岩・火');
    expect(goStop({ hands: [go({ to: { x: 12, y: 10, z: 10 } })] }, lavaMap())).toBeNull();
    expect(goStop({ hands: [go({ to: { x: 99, y: 10, z: 10 } })] }, lavaMap())).toBeNull();
    expect(goStop({ hands: [go({ goals: [{ x: 14, y: 10, z: 10 }, { x: 12, y: 10, z: 10 }] })] }, lavaMap())).toBeNull();
    expect(goStop({ hands: [go({ to: { x: 4, y: 0, z: 0 }, rel: true })] }, lavaMap())?.hand).toBe(1);
  });
  it('does not walk the way between: a go across rock the map shows is not held', () => {
    expect(heldBeforeSend(false, { hands: [go({ to: { x: 16, y: 10, z: 16 }, canDig: ['stone'] })] }, lavaMap(), 'run39')).toBeNull();
  });
});

describe('the wood mark', () => {
  const world = (inventory: Array<[string, number]>) => ({ position: { x: 0.5, y: 64, z: 0.5 }, health: 20, food: 20, inventory: pack(...inventory),
    localMap: '地図 v1 足=(0,64,0) x=-1..1 z=-1..1 方式=layers 上=北\ny=64\n -1 . . .\n  0 . @ .\n  1 . . .',
    mapLandmarks: [`p ${WOOD_MARK} (30,60,5) 東30 板×12 柵×4`, 'F かまど (3,64,3)'] });
  const lines = (inventory: Array<[string, number]>) => (minecraftLlmcLive({ observation: frame(world(inventory)), elapsedMinutes: 1, trend: createFoodTrend(), events: [] }) as {
    landmarks: string[] }).landmarks;
  it('is told while she holds less than a table and a pickaxe and an axe need, with why', () => {
    const short = lines([['oak_planks', 2]]);
    expect(short.find(line => line.includes(WOOD_MARK))).toContain('板が足りない間だけ');
    expect(short).toHaveLength(2);
    expect(planksHeld(world([['oak_log', 1], ['spruce_planks', 3]]), {})).toBe(7);
  });
  it('is left out once she holds the wood (a log counts four)', () => {
    expect(lines([['oak_planks', 8], ['oak_log', 1]]).some(line => line.includes(WOOD_MARK))).toBe(false);
    expect(lines([['oak_log', 3]]).some(line => line.includes(WOOD_MARK))).toBe(false);
  });
});

describe('a parent seen done and a child whose gear is not made (run 39)', () => {
  type Row = readonly [id: string, parent: string | null, title: string, doneWhen?: string];
  const treeOf = (rows: readonly Row[], current: string | null): PlanTree => {
    const order = new Map<string | null, number>();
    const nodes: PlanNode[] = rows.map(([id, parent, title, doneWhen]) => {
      const next = order.get(parent) ?? 0;
      order.set(parent, next + 1);
      return { id, parentId: parent, order: next, title, state: 'continue', ...(doneWhen ? { doneWhen } : {}) };
    });
    return { schema: 'shannon.plan-tree.v1', revision: 1, current, nodes };
  };
  const facts = (...items: Array<[string, number]>) => doneFacts(frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: pack(...items) }))!;
  it('p3 (chestplate and pickaxe) waits for p3.4 (helmet, chestplate, leggings): the legs are made first', () => {
    const tree = treeOf([['p3', null, '鉄', 'have:iron_chestplate&have:iron_pickaxe'], ['p3.3', 'p3', '盾', 'have:shield'],
      ['p3.4', 'p3', '兜・胸・脚', 'have:iron_helmet&have:iron_chestplate&have:iron_leggings']], 'p3.3');
    expect(nodesSeenDone(tree, facts(['iron_chestplate', 1], ['iron_pickaxe', 1], ['iron_helmet', 1]), true)).toEqual([]);
    expect(nodesSeenDone(tree, facts(['iron_chestplate', 1], ['iron_pickaxe', 1], ['iron_helmet', 1], ['iron_leggings', 1], ['shield', 1]), true)).toEqual(['p3', 'p3.3', 'p3.4']);
  });
  it('the wood of the table, the pickaxe and the axe: a pickaxe alone does not end the logs', () => {
    const tree = treeOf([['p1', null, '原木', 'have:log>=8|have:planks>=24']], 'p1');
    expect(nodesSeenDone(tree, facts(['oak_log', 3], ['wooden_pickaxe', 1]), true)).toEqual([]);
    expect(nodesSeenDone(tree, facts(['oak_log', 1], ['wooden_pickaxe', 1], ['wooden_axe', 1]), true)).toEqual(['p1']);
    expect(nodesSeenDone(tree, facts(['oak_log', 8]), true)).toEqual(['p1']);
  });
});

describe('the hands that take a range: obsidian, fight, mine, make, portal, smelt', () => {
  const cell = { x: 5, y: 40, z: -3 };
  it('take their fields and refuse the others, with their own ranges', () => {
    const ok = (hand: Record<string, unknown>) => actProblem(act(hand as unknown as ActHand));
    expect(ok({ do: 'obsidian', at: [cell], count: 3, seconds: 90, canPlace: ['cobblestone'], maxPlace: 6 })).toBeNull();
    expect(ok({ do: 'obsidian', at: [cell], tool: 'x' })).toContain('tool は使えない');
    expect(ok({ do: 'obsidian', at: [cell], count: 65 })).toContain('count は 64 まで');
    expect(ok({ do: 'obsidian', at: Array.from({ length: 9 }, () => cell) })).toContain('8 つまで');
    expect(ok({ do: 'fight', target: '#12', stance: 'flee', item: 'iron_sword', retreatHp: 8, range: 8, seconds: 30 })).toBeNull();
    expect(ok({ do: 'fight', target: '#12', seconds: 90 })).toContain('seconds は 5〜60');
    expect(ok({ do: 'fight', stance: 'flee' })).toContain('target が要る');
    expect(ok({ do: 'mine', block: 'iron_ore', at: [cell], count: 8, tool: 'stone_pickaxe', canDig: ['stone'], maxDig: 10, collect: false })).toBeNull();
    expect(ok({ do: 'mine', block: 'Iron Ore', at: [cell] })).toContain('block はブロックの id');
    expect(ok({ do: 'mine', at: [cell] })).toContain('block が要る');
    expect(ok({ do: 'make', item: 'wooden_pickaxe', count: 2 })).toBeNull();
    expect(ok({ do: 'portal', at: [cell], axis: 'x', block: 'obsidian', enter: false, canPlace: ['cobblestone'] })).toBeNull();
    expect(ok({ do: 'portal', at: [cell, cell], axis: 'z' })).toContain('at は枠の内側の左下のマス 1 つ');
    expect(ok({ do: 'portal', at: [cell] })).toContain('axis が要る');
    expect(ok({ do: 'smelt', items: [{ item: 'raw_iron', count: 16 }], fuel: 'coal', fuelCount: 2, furnaces: 2 })).toBeNull();
    expect(ok({ do: 'smelt', items: [{ item: 'raw_iron' }] })).toContain('個数が要る');
  });
  it('are written and read as one line, and several kinds of smelt as json', () => {
    const lines = ['obsidian 5,40,-3 6,40,-3 count=2 seconds=90 place=cobblestone,dirt maxPlace=6', 'fight #12 flee item=iron_sword retreatHp=8 range=8 seconds=30',
      'fight zombie retreatHp=6', 'mine iron_ore 5,40,-3 count=8 tool=stone_pickaxe dig=stone maxDig=10 collect=false seconds=45', 'make wooden_pickaxe 2',
      'portal 5,40,-3 z block=obsidian place=cobblestone maxPlace=6 seconds=45 noEnter', 'smelt raw_iron 16 fuel=coal fuelCount=2 furnaces=2 seconds=20 1,2,3'];
    for (const line of lines) {
      const hand = lineToHand(line);
      expect('error' in hand ? hand.error : null).toBeNull();
      expect(handToLine(hand as ActHand)).toBe(line);
    }
    expect(lineToHand('fight #12 flee')).toEqual({ do: 'fight', target: '#12', stance: 'flee' });
    expect(lineToHand('portal 5,40,-3 x noEnter')).toEqual({ do: 'portal', at: [cell], axis: 'x', enter: false });
    const two = { do: 'smelt', items: [{ item: 'raw_iron', count: 8 }, { item: 'raw_gold', count: 4 }] } as ActHand;
    expect(handToLine(two).startsWith('json ')).toBe(true);
    expect(lineToHand('portal 5,40,-3')).toHaveProperty('error');
    expect(lineToHand('smelt raw_iron')).toHaveProperty('error');
  });
  it('have a ceiling at their seconds and a typical time', () => {
    const from = { x: 0, y: 40, z: 0 };
    expect(actMilliseconds(act({ do: 'obsidian', at: [cell] } as ActHand), from)).toBe(92_000);
    expect(actMilliseconds(act({ do: 'fight', target: '#1' } as ActHand), from)).toBe(22_000);
    expect(actRemainingMilliseconds(act({ do: 'obsidian', at: [cell], count: 2 } as ActHand), from, null, 0)).toBe(36_000);
    expect(actRemainingMilliseconds(act({ do: 'make', item: 'stick', count: 4 } as ActHand), from, null, 0)).toBe(3_000);
    expect(actRemainingMilliseconds(act({ do: 'portal', at: [cell], axis: 'x' } as ActHand), from, null, 0)).toBe(25_000);
  });
});

describe('the guards of the hands that take a range', () => {
  const held = (hand: Record<string, unknown>, world: Record<string, unknown> = {}) =>
    heldBeforeSend(false, { hands: [hand] }, frame({ position: { x: 10.5, y: 10, z: 10.5 }, health: 20, ...world }), 'run39-range');
  const refused = (hand: Record<string, unknown>, world?: Record<string, unknown>) => held(hand, world)?.result?.text ?? '';
  it('hold a block that may not be dug or placed, a frame of something else, a target that is no enemy, a retreat that is already on', () => {
    expect(refused({ do: 'mine', block: 'chest', at: [{ x: 1, y: 2, z: 3 }] })).toContain('mine では掘らない');
    expect(refused({ do: 'mine', block: 'iron_ore', at: [{ x: 1, y: 2, z: 3 }], canDig: ['diamond_ore'] })).toContain('go では掘らない');
    expect(held({ do: 'mine', block: 'iron_ore', at: [{ x: 1, y: 2, z: 3 }], canDig: ['stone'] })).toBeNull();
    expect(refused({ do: 'portal', at: [{ x: 1, y: 2, z: 3 }], axis: 'x', block: 'stone' })).toContain('黒曜石');
    expect(refused({ do: 'portal', at: [{ x: 1, y: 2, z: 3 }], axis: 'x', canPlace: ['sand'] })).toContain('go では置かない');
    expect(refused({ do: 'fight', target: 'villager' })).toContain('敵ではない');
    expect(held({ do: 'fight', target: '#12' })).toBeNull();
    expect(refused({ do: 'fight', target: '#12', retreatHp: 12 }, { health: 8 })).toContain('始める前に退く');
    expect(held({ do: 'fight', target: '#12', retreatHp: 12, stance: 'flee' }, { health: 8 })).toBeNull();
    expect(refused({ do: 'smelt', items: [{ item: 'raw_iron', count: 8 }, { item: 'raw_gold', count: 4 }], furnaces: 1 })).toContain('種類数（2）以上');
  });
  it('hold an obsidian whose cell the map shows as no lava, and let one through that it shows as lava or does not show', () => {
    const rows = ['地図 v1 足=(10,10,10) x=3..17 z=3..17 方式=layers 上=北'];
    for (const dy of [1, 0, -1]) {
      rows.push(`y=${10 + dy}`);
      for (let z = 3; z <= 17; z += 1) rows.push(` ${z} ${Array.from({ length: 15 }, (_, i) => dy === 0 && z === 10 && i + 3 === 14 ? 'L' : dy === 0 && z === 10 && i + 3 === 10 ? '@' : dy === 0 ? '.' : '#').join(' ')}`);
    }
    const world = { localMap: rows.join('\n') };
    expect(refused({ do: 'obsidian', at: [{ x: 12, y: 10, z: 10 }] }, world)).toContain('溶岩のマスではない');
    expect(held({ do: 'obsidian', at: [{ x: 14, y: 10, z: 10 }] }, world)).toBeNull();
    expect(held({ do: 'obsidian', at: [{ x: 99, y: 10, z: 10 }] }, world)).toBeNull();
    expect(held({ do: 'obsidian', at: [{ x: 4, y: 0, z: 0 }], rel: true }, world)).toBeNull();
  });
});
