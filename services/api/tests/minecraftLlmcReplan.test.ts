import { afterEach, describe, expect, it } from 'vitest';
import { planFromSeeds, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { CURRENT_FIRST_PLAN_SCHEMA } from '../src/surfaces/minecraft/minecraftFirstPlanPrompts.js';
import {
  boundTo,
  forgetReplans,
  putReplan,
  readReplanLedger,
  REPLAN,
  REPLAN_SCHEMA,
  replanOf,
  replanVerdict,
  settledAttempt,
  withAttempt,
  withReplanInbox,
  type ReplanLedger,
} from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { nodeLine, nowLines, planLines, replanBrief, type BriefInput } from '../src/surfaces/minecraft/minecraftLlmcReplanBrief.js';
import { createReplanFlow, readWaiting, type ReplanSources } from '../src/surfaces/minecraft/minecraftLlmcReplanFlow.js';
import { pending } from '../src/surfaces/minecraft/minecraftLlmcOnceFacts.js';
import { llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { forgetStalls, noteProgress, type Stall } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { createStallWatch } from '../src/surfaces/minecraft/minecraftLlmcWatch.js';
import { createWaitLedger } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';

afterEach(() => {
  forgetReplans();
  forgetStalls();
});

const frame = (world: object): BodyObservation => ({ connected: true, state: { world }, facts: {} }) as unknown as BodyObservation;
const MIN = 60_000;
const empty: ReplanLedger = { v: 1, total: 0, recent: [], nodes: {}, last: [] };
const record = (at: number, node = 'p1') => ({ at, node, kind: 'node_stalled', outcome: 'changed' as const, why: 'x' });
const stall = (kind: Stall['kind'] = 'node_stalled', key = 'p1'): Stall => ({ kind, key, why: `節 ${key} が 130 秒、進みが無い` });
const tree = (): PlanTree => planFromSeeds([{ title: '木', kind: 'wood', doneWhen: 'have:log>=3' }, { title: '石', kind: 'stone_tools', doneWhen: 'have:stone_pickaxe' }])!;

it('shows replanned descendants by parent links, including generated ids, without taking a different branch by id prefix', () => {
  const original = tree();
  const replanned: PlanTree = { ...original, current: 'p1', nodes: [...original.nodes,
    { id: 'n1', parentId: 'p1', order: 0, title: '原木4本', kind: 'wood', state: 'continue' },
    { id: 'n2', parentId: 'n1', order: 0, title: '届く幹へ', kind: 'wood', state: 'continue' },
    { id: 'p1.unrelated', parentId: 'p2', order: 0, title: '別の枝の仕事', kind: 'other', state: 'continue' },
  ] };
  const brief = planLines(replanned).join('\n');
  expect(brief).toContain('n1 [wood] 原木4本');
  expect(brief).toContain('n2 [wood] 届く幹へ');
  expect(brief).not.toContain('p1.unrelated');
});

describe('the bounds of the plan made again', () => {
  it('lets one through at first, then waits 5 minutes, allows 6 in an hour, 30 in a run and 3 for one node', () => {
    expect(replanVerdict(empty, 'p1', 0)).toEqual({ ok: true });
    const one = withAttempt(empty, record(0));
    expect(replanVerdict(one, 'p2', 5 * MIN - 1)).toEqual({ ok: false, why: 'gap' });
    expect(replanVerdict(one, 'p2', 5 * MIN)).toEqual({ ok: true });
    let six = empty;
    for (let index = 0; index < REPLAN.perHour; index += 1) six = withAttempt(six, record(index * 10 * MIN, `n${index}`));
    expect(replanVerdict(six, 'p9', 50 * MIN + 10 * MIN - 1)).toEqual({ ok: false, why: 'hour' });
    expect(replanVerdict(six, 'p9', 60 * MIN)).toEqual({ ok: true });
    let nodes = empty;
    for (let index = 0; index < REPLAN.perNode; index += 1) nodes = withAttempt(nodes, record(index * 20 * MIN));
    expect(replanVerdict(nodes, 'p1', 90 * MIN)).toEqual({ ok: false, why: 'node' });
    expect(replanVerdict(nodes, 'p2', 90 * MIN)).toEqual({ ok: true });
    expect(replanVerdict({ ...empty, total: REPLAN.perRun }, 'p1', 0)).toEqual({ ok: false, why: 'run' });
  });

  it('counts an attempt when it is asked, keeps the newest three for the next brief, and reads a checkpoint with care', () => {
    let ledger = empty;
    for (let index = 0; index < 5; index += 1) ledger = withAttempt(ledger, { ...record(index * 11 * MIN, 'p1'), why: `w${index}` });
    expect(ledger.total).toBe(5);
    expect(ledger.last.map(item => item.why)).toEqual(['w2', 'w3', 'w4']);
    expect(settledAttempt(ledger, { ...record(1, 'p1'), outcome: 'refused', why: 'z' }).last.at(-1)).toMatchObject({ outcome: 'refused', why: 'z' });
    expect(readReplanLedger(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger);
    expect(readReplanLedger({ v: 2 })).toEqual(empty);
    expect(readReplanLedger(null)).toEqual(empty);
    expect(readReplanLedger({ v: 1, total: 'x' })).toEqual(empty);
    expect(readReplanLedger({ v: 1, total: 2, recent: [1, 'a'], nodes: { p1: 2, p2: 'x' }, last: [{ at: 1 }] })).toEqual({ v: 1, total: 2, recent: [1], nodes: { p1: 2 }, last: [] });
  });
});

describe('the strong model\'s answer', () => {
  it('reads ops of the plan\'s own kinds, an empty list as "nothing to change", and nothing else', () => {
    expect(replanOf({ ops: [{ op: 'set', id: 'p1', state: 'blocked', reason: 'x' }, { op: 'caution', text: 'y' }], current: 'p2', why: '割った' }))
      .toEqual({ update: { ops: [{ op: 'set', id: 'p1', state: 'blocked', reason: 'x' }, { op: 'caution', text: 'y' }], current: 'p2' }, why: '割った' });
    expect(replanOf({ ops: [], why: '待ちなので直さない' })).toEqual({ update: { ops: [] }, why: '待ちなので直さない' });
    expect(replanOf({ ops: [{ op: 'promise', item: 'x', count: 1, use: 'y' }], why: '' })).toBeNull();
    expect(replanOf({ ops: new Array(13).fill({ op: 'drop', id: 'p1' }), why: '' })).toBeNull();
    expect(replanOf({ why: 'x' })).toBeNull();
    expect(replanOf('x')).toBeNull();
  });

  /**
   * The API compiles a strict schema into a grammar and refused the answer's schema twice (2026-11-02, the first real replay): for more than 24
   * optional parameters (the plan tool's op has 37), then, with 20 and with 15, as "too complex" after 100 seconds. The optional fields of an op are what costs.
   */
  const optionalParameters = (schema: unknown, seen = new Set<object>()): number => {
    if (!schema || typeof schema !== 'object' || seen.has(schema)) return 0;
    seen.add(schema);
    const node = schema as { properties?: Record<string, unknown>; required?: string[]; items?: unknown; anyOf?: unknown[] };
    const required = new Set(node.required ?? []);
    const own = Object.keys(node.properties ?? {}).filter(key => !required.has(key)).length;
    const inner = Object.values(node.properties ?? {}).reduce<number>((sum, value) => sum + optionalParameters(value, seen), 0);
    return own + inner + optionalParameters(node.items, seen) + (node.anyOf ?? []).reduce<number>((sum, value) => sum + optionalParameters(value, seen), 0);
  };

  it('has a schema the API takes: a list of strings, one optional field, and the first plan\'s schema within the limit as well', () => {
    expect(optionalParameters(REPLAN_SCHEMA)).toBeLessThanOrEqual(2);
    expect(optionalParameters(CURRENT_FIRST_PLAN_SCHEMA)).toBeLessThanOrEqual(24);
    expect((REPLAN_SCHEMA.properties.ops as { items: unknown }).items).toEqual({ type: 'string' });
    expect(JSON.stringify(REPLAN_SCHEMA)).not.toContain('anyOf');
    expect(REPLAN_SCHEMA.required).toEqual(['ops', 'why']);
  });

  it('reads an op written as a string of JSON, and turns away a string that is not one, an op of a promise, and anything that is not an object', () => {
    const made = replanOf({ ops: ['{"op":"add","parent":"p10","title":"待ち場を探す","kind":"blaze","target":{"item":"blaze_rod","count":7}}',
      { op: 'set', id: 'p8', prep: { state: 'skipped', why: '食料が足りている' } }, '{"op":"split","id":"p9","into":[{"title":"歩く"}]}'], current: 'p10.1', why: '割った' });
    expect(made!.update.ops).toEqual([
      { op: 'add', parent: 'p10', title: '待ち場を探す', kind: 'blaze', target: { item: 'blaze_rod', count: 7 } },
      { op: 'set', id: 'p8', prep: { state: 'skipped', why: '食料が足りている' } },
      { op: 'split', id: 'p9', into: [{ title: '歩く' }] },
    ]);
    expect(made!.update.current).toBe('p10.1');
    expect(replanOf({ ops: ['{"op":"add"'], why: '' })).toBeNull();
    expect(replanOf({ ops: ['{"op":"promise","item":"x","count":1,"use":"y"}'], why: '' })).toBeNull();
    expect(replanOf({ ops: ['{"op":"release","id":1}'], why: '' })).toBeNull();
    expect(replanOf({ ops: ['"add"', '[1]', 'null', '7'], why: '' })).toBeNull();
  });

  it('is taken at the plan\'s next read, after the first plan, applied to the plan as it is then, and only once', () => {
    const first = { take: () => null };
    const inbox = withReplanInbox(first);
    const held = tree();
    putReplan('t', { ops: [{ op: 'set', id: 'p1', note: 'こう直す' }] }, '木を割った');
    const taken = inbox.take('t', held)!;
    expect(taken.tree.nodes.find(node => node.id === 'p1')!.note).toBe('こう直す');
    expect(taken.note).toBe('計画を立て直した（強いモデル）: 木を割った');
    expect(inbox.take('t', held)).toBeNull();
    // a plan that no longer fits is dropped, with a line
    const lines: string[] = [];
    putReplan('u', { ops: [{ op: 'drop', id: 'p9' }] }, 'x');
    expect(withReplanInbox(first, line => lines.push(line)).take('u', held)).toBeNull();
    expect(lines[0]).toContain('replan not taken task=u');
    // the first plan goes first
    putReplan('v', { ops: [{ op: 'set', id: 'p1', note: 'n' }] }, 'x');
    const firstPlan = { tree: held, note: '最初の計画' };
    expect(withReplanInbox({ take: () => firstPlan }).take('v', held)).toBe(firstPlan);
  });

  it('is taken only by a plan that has the nodes it names as they were when it was checked, and is checked again where it is taken', () => {
    const held = tree();
    const update = { ops: [{ op: 'set' as const, id: 'p1', note: 'こう直す' }] };
    expect(boundTo(held, update)).toEqual({ p1: '木|wood' });
    // the first plan came after the check: p1 now means pearls, and the update is not taken (it would have closed the wrong node)
    const other = planFromSeeds([{ title: 'パール', kind: 'pearl' }, { title: '石', kind: 'stone_tools' }])!;
    const lines: string[] = [];
    putReplan('w', update, 'x', boundTo(held, update));
    expect(withReplanInbox({ take: () => null }, line => lines.push(line)).take('w', other)).toBeNull();
    expect(lines[0]).toContain('node p1 is not what it was');
    // a node done meanwhile, or another node changed, does not matter
    putReplan('w', update, 'x', boundTo(held, update));
    const moved = { ...held, nodes: held.nodes.map(node => node.id === 'p2' ? { ...node, state: 'done' as const } : node) };
    expect(withReplanInbox({ take: () => null }).take('w', moved)).not.toBeNull();
    // the plan's own checks and the observation's, at the read that takes it
    putReplan('w', update, 'x', boundTo(held, update));
    const refusing = withReplanInbox({ take: () => null }, line => lines.push(line), () => '観測の条件を満たさない');
    expect(refusing.take('w', held)).toBeNull();
    expect(lines.at(-1)).toContain('観測の条件を満たさない');
  });
});

describe('the brief', () => {
  const dragon = seedPlan('エンドラを討伐して')!;
  const input = (extra: Partial<BriefInput> = {}): BriefInput => ({ goal: 'エンドラを討伐して', seconds: 4_000, stall: { kind: 'node_stalled', why: '節 p10.1 が 140 秒、進みが無い', node: 'p10.1' },
    tree: { ...dragon, current: 'p10.1', nodes: dragon.nodes.map(node => (/^p[1-9](?:\.|$)/u.test(node.id) ? { ...node, state: 'done' as const } : node)) }, doneStatus: '未: blaze_rod 3/7', now: ['場所: the_nether (10,70,20)・体力 20/20', '持ち物: stone_sword×1'], facts: ['足りない物: 食料'],
    results: ['go 止まった'], queue: ['・ wait'], earlier: [], sameNode: 0, knowledge: '## ブレイズ\n- 待ち打ち', ...extra });

  it('says the stall, the plan with the current subtree, the state and the knowledge, in order', () => {
    const text = replanBrief(input());
    const order = ['## 依頼', '## 止まり', '## 計画', '## 今の様子', '## 事実', '## 直近の結果', '## 体の列', '## この段の知識'].map(title => text.indexOf(title));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('止まった節: p10.1。その条件の今: 未: blaze_rod 3/7。');
    expect(text).toContain('▶p10.1 [blaze] mc_probe kind=camp で湧き場の足場を見つけ、go で着く');
    expect(text).toContain('済み: ');
  });

  it('stays within 8k tokens however much the task has to say, dropping the knowledge and shortening the facts first', () => {
    const long = (word: string) => Array.from({ length: 40 }, (_, index) => `${word}${index} ${'あ'.repeat(120)}`);
    const text = replanBrief(input({ facts: long('事実'), results: long('結果'), now: long('持ち物'), knowledge: 'あ'.repeat(20_000) }));
    expect(llmcTokens(text)).toBeLessThanOrEqual(REPLAN.briefTokens);
    expect(text).not.toContain('## この段の知識');
    expect(text).toContain('## 止まり');
    expect(replanBrief(input({ earlier: [{ at: 1, node: 'p10.1', kind: 'node_stalled', outcome: 'changed', why: '待ち場を割った' }] }))).toContain('節 p10.1（node_stalled）: 計画を直した。待ち場を割った');
  });

  it('writes a node with what shows it done, its target and its place, and a body with nothing seen', () => {
    const node = dragon.nodes.find(item => item.id === 'p10')!;
    expect(nodeLine(node, dragon)).toContain('ブレイズロッド7以上');
    expect(nodeLine(node, dragon)).toContain('目標: blaze_rod×7');
    expect(nodeLine(node, dragon)).toContain('済む条件: have:blaze_rod>=7');
    expect(planLines(dragon).some(line => line.startsWith('済み: '))).toBe(false);
    expect(nowLines(null)).toEqual(['体の観測が取れていない']);
    expect(nowLines(frame({ dimension: 'minecraft:the_nether', position: { x: 1.5, y: 70, z: -3.2 }, health: 18, food: 12, inventory: [{ name: 'stone_sword', count: 1 }] }))[0])
      .toContain('場所: the_nether (1,70,-4)・体力 18/20・満腹 12/20');
  });
});

describe('a death has its own ask (run62, 11/5)', () => {
  it('lets a death through the gap, the hour and the node, and not past the run', () => {
    const busy = { v: 1 as const, total: 5, recent: [0, 60_000, 120_000, 180_000, 240_000, 300_000], nodes: { p3: 3 }, last: [] };
    expect(replanVerdict(busy, 'p3', 310_000)).toMatchObject({ ok: false });
    expect(replanVerdict(busy, 'p3', 310_000, 'death')).toEqual({ ok: true });
    expect(replanVerdict({ ...busy, total: REPLAN.perRun }, 'p3', 310_000, 'death')).toEqual({ ok: false, why: 'run' });
  });
});

describe('the flow of one task', () => {
  const sources = (extra: Partial<ReplanSources> = {}): ReplanSources => ({ node: 'p1', goal: '木', seconds: 600, tree: tree(), doneStatus: null, now: [], facts: [], results: [], queue: [],
    knowledge: '', ...extra });
  const make = (reply: () => Promise<unknown>, over: { clock?: () => number; check?: () => string | null; src?: (stall: Stall) => ReplanSources | null; saved?: unknown;
    savedPending?: unknown } = {}) => {
    const asked: string[] = [];
    const lines: string[] = [];
    const flow = createReplanFlow({ taskId: 'flow', saved: over.saved, savedPending: over.savedPending, replanner: async (_system, brief) => {
      asked.push(brief);
      return reply();
    }, clock: over.clock ?? (() => 0), sources: over.src ?? (item => sources({ node: item.key })), check: over.check ?? (() => null), log: line => lines.push(line) });
    return { flow, asked, lines };
  };
  const signal = new AbortController().signal;

  it('asks once for a stall that a new plan answers and puts the answer in the inbox for the plan\'s next read', async () => {
    const { flow, asked, lines } = make(async () => ({ ops: [{ op: 'set', id: 'p1', note: '割った' }], why: '木の節を割った' }));
    flow.note(stall());
    await flow.run(signal);
    await flow.run(signal);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('節 p1 が 130 秒');
    const taken = withReplanInbox({ take: () => null }).take('flow', tree())!;
    expect(taken.tree.nodes.find(node => node.id === 'p1')!.note).toBe('割った');
    expect(flow.ledger()).toMatchObject({ total: 1, nodes: { p1: 1 } });
    expect(flow.ledger().last[0]).toMatchObject({ outcome: 'changed', why: '木の節を割った' });
    expect(lines.some(line => line.includes('replan task=flow node=p1 kind=node_stalled outcome=changed ops=1'))).toBe(true);
    expect(flow.checkpoint().minecraftReplans).toEqual(flow.ledger());
  });

  it('asks for no stall that is not about the plan (a failure of the writing), but starts the count again', async () => {
    const { flow, asked } = make(async () => ({ ops: [], why: '' }));
    noteProgress('flow', { node: 'p1', state: 'continue', milestone: null, items: 0 }, 0);
    flow.note(stall('decide_error', 'check_refused'));
    await flow.run(signal);
    expect(asked).toHaveLength(0);
  });

  it('records an answer of no change, one the plan would not take, and one that did not come; each counts', async () => {
    const none = make(async () => ({ ops: [], why: '夜待ちで進行中' }));
    none.flow.note(stall());
    await none.flow.run(signal);
    expect(none.flow.ledger().last[0]).toMatchObject({ outcome: 'unchanged', why: '夜待ちで進行中' });
    expect(withReplanInbox({ take: () => null }).take('flow', tree())).toBeNull();

    const refused = make(async () => ({ ops: [{ op: 'drop', id: 'p1' }], why: 'x' }), { check: () => '目標と条件が不一致' });
    refused.flow.note(stall());
    await refused.flow.run(signal);
    expect(refused.flow.ledger().last[0]).toMatchObject({ outcome: 'refused' });
    expect(refused.flow.ledger().last[0]!.why).toContain('目標と条件が不一致');
    expect(withReplanInbox({ take: () => null }).take('flow', tree())).toBeNull();

    const failed = make(async () => { throw new Error('timeout'); });
    failed.flow.note(stall('wait_loop', '3'));
    await failed.flow.run(signal);
    expect(failed.flow.ledger()).toMatchObject({ total: 1, last: [{ outcome: 'failed' }] });
    expect(failed.lines.some(line => line.includes('replan failed task=flow'))).toBe(true);

    const unreadable = make(async () => 'not an answer');
    unreadable.flow.note(stall());
    await unreadable.flow.run(signal);
    expect(unreadable.flow.ledger().last[0]).toMatchObject({ outcome: 'refused' });
  });

  it('waits 5 minutes between two, and tells the decision once when one node did not move after three new plans', async () => {
    const replanLines = (all: string[]) => all.filter(line => !line.includes('stall record'));
    let now = 0;
    const { flow, asked, lines } = make(async () => ({ ops: [], why: 'そのまま' }), { clock: () => now });
    for (let index = 0; index < REPLAN.perNode; index += 1) {
      flow.note(stall());
      await flow.run(signal);
      now += 11 * MIN;
    }
    expect(asked).toHaveLength(3);
    flow.note(stall('node_stalled', 'p1'));
    await flow.run(signal);
    expect(asked).toHaveLength(3);
    expect(replanLines(lines).at(-1)).toContain('replan skipped task=flow node=p1 kind=node_stalled why=node');
    expect(pending('flow').some(fact => fact.key === 'replan_node:p1' && fact.text.includes('3 回立て直しても進まなかった'))).toBe(true);
    now += 1;
    flow.note(stall('node_stalled', 'p2'));
    flow.note(stall('node_stalled', 'p2'));
    await flow.run(signal);
    expect(replanLines(lines).at(-1)).toContain('replan task=flow node=p2');
    const nearly = make(async () => ({ ops: [], why: '' }), { clock: () => 0 });
    nearly.flow.note(stall());
    await nearly.flow.run(signal);
    nearly.flow.note(stall('wait_loop', '3'));
    await nearly.flow.run(signal);
    expect(nearly.asked).toHaveLength(1);
    expect(replanLines(nearly.lines).at(-1)).toContain('why=gap');
  });

  it('keeps a stall found at the end of a step for the next step, and one the gap holds back until the gap has passed', async () => {
    const first = make(async () => ({ ops: [], why: '' }), { clock: () => 5 * MIN });
    first.flow.note(stall('death', '1-1'));
    const saved = JSON.parse(JSON.stringify(first.flow.checkpoint()));
    expect(saved.minecraftReplanPending).toMatchObject({ stall: { kind: 'death', key: '1-1' }, at: 5 * MIN });
    let now = 6 * MIN;
    const next = make(async () => ({ ops: [], why: '死んでも計画は変えない' }), { clock: () => now, saved: saved.minecraftReplans, savedPending: saved.minecraftReplanPending });
    await next.flow.run(signal);
    expect(next.asked).toHaveLength(1);
    expect(next.flow.checkpoint().minecraftReplanPending).toBeNull();
    // the gap holds a stall back: it waits, is told once, and is asked when the gap has passed
    next.flow.note(stall('wait_loop', '3'));
    now += 2 * MIN;
    await next.flow.run(signal);
    await next.flow.run(signal);
    expect(next.asked).toHaveLength(1);
    expect(next.lines.filter(line => line.includes('replan skipped'))).toHaveLength(1);
    expect(next.flow.checkpoint().minecraftReplanPending).not.toBeNull();
    now += 9 * MIN;
    await next.flow.run(signal);
    expect(next.asked).toHaveLength(2);
    // one that waited past its time is dropped (the look finds it again if it still stands); one that cannot be read is not kept
    next.flow.note(stall('death', '2-1'));
    now += REPLAN.pendingMs + 1;
    await next.flow.run(signal);
    expect(next.asked).toHaveLength(2);
    expect(next.flow.checkpoint().minecraftReplanPending).toBeNull();
    expect(readWaiting({ stall: { kind: 'decide_error', key: 'x', why: 'y' }, at: 1 })).toBeNull();
    expect(readWaiting({ stall: { kind: 'death', key: 'x' }, at: 1 })).toBeNull();
    expect(readWaiting(null)).toBeNull();
  });

  it('tells the next brief what the plans before it did, and never the attempt it is making', async () => {
    let now = 0;
    const { flow, asked } = make(async () => ({ ops: [{ op: 'set', id: 'p1', note: '割った' }], why: '最初の直し' }), { clock: () => now });
    flow.note(stall('node_stalled', 'p1'));
    await flow.run(signal);
    expect(asked[0]).not.toContain('## 前の立て直し');
    expect(asked[0]).toContain('この節で立て直しは 0 回目まで済み');
    now += 11 * MIN;
    flow.note(stall('node_stalled', 'p1'));
    await flow.run(signal);
    expect(asked[1]).toContain('節 p1（node_stalled）: 計画を直した。最初の直し');
    expect(asked[1]).toContain('この節で立て直しは 1 回目まで済み');
    expect(asked[1]).not.toContain('答えが来なかった');
  });

  it('asks nothing without a strong model, a plan or a body to read', async () => {
    const none = createReplanFlow({ taskId: 'x', saved: null, replanner: undefined, clock: () => 0, sources: () => sources(), check: () => null, log: () => undefined });
    none.note(stall());
    await none.run(signal);
    expect(none.ledger().total).toBe(0);
    const { flow, asked } = make(async () => ({ ops: [], why: '' }), { src: () => null });
    flow.note(stall());
    await flow.run(signal);
    expect(asked).toHaveLength(0);
  });
  it('puts the ask off while the body is in danger, and gives up a wait that sees a hostile come (the audit of 11/4, order 12)', async () => {
    let vitals = { hp: 20, hunger: 20, dimension: 'overworld', enemies16: 1 };
    const asked: string[] = [], lines: string[] = [];
    const flow = createReplanFlow({ taskId: 'danger', saved: null, replanner: async (_system, brief, wait) => {
      asked.push(brief);
      vitals = { ...vitals, enemies16: 2 };
      return new Promise((_resolve, reject) => wait.addEventListener('abort', () => reject(new Error('aborted'))));
    }, clock: () => 0, sources: item => sources({ node: item.key }), check: () => null, vitals: () => vitals, log: line => lines.push(line) });
    flow.note(stall());
    await flow.run(signal);
    await flow.run(signal);
    expect(asked).toHaveLength(0);
    expect(lines.filter(line => line.includes('put off') && line.includes('why=danger'))).toHaveLength(1);
    vitals = { ...vitals, enemies16: 0 };
    await flow.run(signal);
    expect(asked).toHaveLength(1);
    expect(flow.ledger().last.at(-1)).toMatchObject({ outcome: 'failed', why: '待つ間に敵が来た・体力が減った（打ち切った）' });
    expect(lines.some(line => line.includes('replan failed') && line.includes('why=danger'))).toBe(true);
  });
});

describe('the look of a task that is not held', () => {
  const dragon = seedPlan('エンドラを討伐して')!;
  const idle = frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'oak_log', count: 2 }] });
  const build = (raised: Stall[], clock: { now: number }) => createStallWatch({ taskId: 'watch', observe: () => idle, tree: () => ({ ...dragon, current: 'p1.1' }), running: () => null,
    activeClock: () => clock.now, waits: createWaitLedger(null), raise: item => raised.push(item), log: () => undefined });

  it('finds a node that does not move for 120 s of the running clock, once, and starts counting again from the next look', () => {
    const raised: Stall[] = [];
    const clock = { now: 0 };
    const watch = build(raised, clock);
    expect(watch.look()).toBe(false);
    clock.now = 119_000;
    expect(watch.look()).toBe(false);
    clock.now = 121_000;
    expect(watch.look()).toBe(true);
    expect(raised.map(item => item.kind)).toEqual(['node_stalled']);
    expect(raised[0]!.key).toBe('p1.1');
    // quiet until the flow starts it again (`resumeStalls`)
    clock.now = 400_000;
    expect(watch.look()).toBe(false);
  });

  it('counts what a child works for as its parent\'s: the rods collected under 「ブレイズロッド7」 keep the waiting at the spawner from being a stall', () => {
    const raised: Stall[] = [];
    const clock = { now: 0 };
    let rods = 1;
    const nether = seedPlan('エンドラを討伐して', 'the_nether')!;
    const world = () => frame({ dimension: 'the_nether', position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'blaze_rod', count: rods }] });
    const watch = createStallWatch({ taskId: 'watch3', observe: world, tree: () => ({ ...nether, current: 'p3.2' }), running: () => null, activeClock: () => clock.now,
      waits: createWaitLedger(null), raise: item => raised.push(item), log: () => undefined });
    watch.look();
    for (const step of [1, 2, 3]) {
      clock.now = step * 100_000;
      rods += 1;
      expect(watch.look()).toBe(false);
    }
    clock.now = 500_000;
    expect(watch.look()).toBe(true);
    expect(raised[0]!.key).toBe('p3.2');
  });

  it('does not count a move toward the node\'s purpose as a stall', () => {
    const raised: Stall[] = [];
    const clock = { now: 0 };
    const logs = createStallWatch({ taskId: 'watch2', observe: () => frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'oak_log', count: clock.now > 0 ? 5 : 2 }] }),
      tree: () => ({ ...dragon, current: 'p1.1' }), running: () => null, activeClock: () => clock.now, waits: createWaitLedger(null), raise: item => raised.push(item), log: () => undefined });
    logs.look();
    clock.now = 130_000;
    expect(logs.look()).toBe(false);
    expect(raised).toEqual([]);
    expect(logs.activeWait()).toBeUndefined();
  });
});
