import { describe, expect, it } from 'vitest';
import { armourWorn, classifyAct, countBy, readPlan, spliceFrom, worldOfLive, worldOfPlanUser, type PlanNodeRow } from '../scripts/minecraft-act-bench-1127c.js';

const act = (input: Record<string, unknown>, name = 'mc_act') => [{ type: 'thinking', text: 'x' }, { type: 'tool_use', name, input }];

describe('act bench 1127c: spliceFrom', () => {
  it('changes the whole text, a part of it once, and nothing when the old part is not in it or is in it twice', () => {
    expect(spliceFrom('abc', 'abc', 'xyz')).toBe('xyz');
    expect(spliceFrom('前。abc。後', 'abc', 'xyz')).toBe('前。xyz。後');
    expect(spliceFrom('前。abc。後', 'zzz', 'xyz')).toBeNull();
    expect(spliceFrom('abc abc', 'abc', 'xyz')).toBeNull();
    expect(spliceFrom('abc', null, 'xyz')).toBeNull();
    expect(spliceFrom('abc', '', 'xyz')).toBeNull();
    expect(spliceFrom('abc', 'abc', null)).toBeNull();
  });
  it('returns the text itself when the new part is the old one (a build in the base tree changes nothing)', () => {
    expect(spliceFrom('前。abc。後', 'abc', 'abc')).toBe('前。abc。後');
  });
});

describe('act bench 1127c: classifyAct', () => {
  it('reads the node the why names and the place the hands go to', () => {
    expect(classifyAct(act({ hands: [{ do: 'go', to: { x: 231, y: 63, z: -124 } }], why: '[p2.1] ベッドを足す' }))).toMatchObject({ klass: 'p2', node: 'p2.1', first: 'go', verdict: 'bad_checklist' });
    expect(classifyAct(act({ hands: [{ do: 'go', to: { x: 437, y: 63, z: 1311 } }], why: '[p1.1] 交点へ向かう' }))).toMatchObject({ klass: 'p1', node: 'p1.1', verdict: 'good_stronghold' });
    // a hand that goes to the crossing is p1 even when the why names no node
    expect(classifyAct(act({ hands: [{ do: 'go', at: [{ x: 440, y: 63, z: 1300 }] }], why: '南へ' }))).toMatchObject({ klass: 'p1', node: null });
  });
  it('reads the other tools, an idle act and an answer with no call', () => {
    expect(classifyAct(act({}, 'mc_probe'))).toMatchObject({ klass: 'probe', tool: 'mc_probe', verdict: 'neutral' });
    expect(classifyAct(act({}, 'plan_update'))).toMatchObject({ klass: 'plan_update' });
    expect(classifyAct(act({ hands: [{ do: 'sleep', seconds: 45 }], why: '夜に備える' }))).toMatchObject({ klass: 'wait', verdict: 'neutral' });
    expect(classifyAct([{ type: 'text', text: 'no call' }])).toMatchObject({ klass: 'none', tool: null });
    expect(classifyAct(undefined)).toMatchObject({ klass: 'none' });
  });
  it('reads a short fill from the pack (the armour) apart from the End checklist', () => {
    expect(classifyAct(act({ hands: [{ do: 'make' }], why: '[p2.3] 鉄のレギンスを作る' }))).toMatchObject({ klass: 'p2', verdict: 'good_fill' });
  });
});

describe('act bench 1127c: readPlan', () => {
  const row = (id: string, kind: string, doneWhen = ''): PlanNodeRow => ({ id, parent: '', title: id, kind, doneWhen });
  it('counts the stronghold place and what the code dropped from what the model wrote', () => {
    const written = [row('p1', 'stronghold', 'at:465,30,1484~200@overworld'), row('p2.2', 'obsidian'), row('p3', 'portal'), row('p4', 'end')];
    const kept = [written[0]!, written[3]!];
    expect(readPlan(written, kept)).toMatchObject({ strongholdRaw: 1, strongholdKept: 1, portalWritten: true, portalKept: false, obsidianWritten: true, obsidianKept: false, atWritten: true, firstKind: 'stronghold', nodes: 2 });
  });
  it('reads an opening plan: the order and no at: condition', () => {
    const rows = [row('p1', 'village'), row('p2', 'iron'), row('p3', 'nether'), row('p4', 'stronghold')];
    expect(readPlan(rows, rows)).toMatchObject({ atWritten: false, order: { village: 1, iron: 2, nether: 3, stronghold: 4 }, strongholdKept: 4 });
    expect(readPlan([], [])).toMatchObject({ strongholdRaw: null, firstKind: null });
  });
});

describe('act bench 1127c: the worlds read from a run\'s own lines', () => {
  it('reads the first plan\'s pack with its durabilities, and a live\'s body', () => {
    const user = '依頼: x\n位置: {"x":1,"y":64,"z":2}\nディメンション: overworld\nバイオーム: plains\n時刻: 10\n持ち物: ender_eye×11・diamond_pickaxe×1(耐久73/1561)\n着ている物: 頭: iron_helmet(残り1/2)、脚: なし';
    const world = worldOfPlanUser(user) as { inventory: Array<{ name: string; count: number; durability?: { left: number; max: number } }>; dimension: string; worn: string };
    expect(world.inventory).toEqual([{ name: 'ender_eye', count: 11 }, { name: 'diamond_pickaxe', count: 1, durability: { left: 73, max: 1561 } }]);
    expect(world.dimension).toBe('overworld');
    const live = worldOfLive({ inventory: ['coal×11', 'stone_axe×1(耐久11/131)'], state: { at: '(192,63,-116)', dimension: 'overworld', worn: '頭: iron_helmet(残り132/165)、脚: なし', health: 20, fullness: 19 } }) as { position: unknown; food: unknown; inventory: unknown[] };
    expect(live.position).toEqual({ x: 192, y: 63, z: -116 });
    expect(live.food).toBe(19);
    expect(live.inventory).toHaveLength(2);
  });
  it('tells the armour worn from the one missing', () => {
    expect(armourWorn('頭: iron_helmet(残り132/165)、胴: iron_chestplate(残り207/240)、脚: なし、足: なし')).toEqual({ helmet: true, chestplate: true, leggings: false, boots: false });
  });
  it('counts by a key', () => {
    expect(countBy(['a', 'b', 'a'], item => item)).toEqual({ a: 2, b: 1 });
  });
});
