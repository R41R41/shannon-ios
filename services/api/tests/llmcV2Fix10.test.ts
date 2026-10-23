import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { handToLine, lineToHand, SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';
import { foreignToolNames } from '../src/contracts/minecraftLlmcToolWords.js';
import { PLAN_UPDATE_RULES_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import { anthropicFcaHistoryCodec, anthropicFcaHistoryCodecV2 } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { readableBootstrap } from '../src/infra/models/anthropic/anthropicFcaBootstrapText.js';
import { MINECRAFT_TRANSPORT, V2_CONTROL_WORDS } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import { llmcStoredResult } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { aroundLines } from '../src/surfaces/minecraft/minecraftLlmcAround.js';
import { createFoodTrend, minecraftLlmcLive, minecraftLlmcUrgentLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { rewriteLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';
import { BODY_RULES, mapView, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { candidateMenuTools, minecraftV2Hooks, progressWithPlain } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { minecraftV2System } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';

/**
 * SHANNON_MINECRAFT_LLMC_V2, the tenth round (mb-llmc-cand 10; the request of run 37 read as a person given only that request would): which hostiles
 * get a line and how each stands to her (C1), 「済む条件」 for the done-condition (C2), unknown cells said as unknown (C3), the last results without the
 * lines the history has (D1), what lies near by name (D2), and the words of the mode in one language with one topic in one place (D3).
 */
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });
const live = (world: Record<string, unknown>, v2 = true): Record<string, any> => minecraftLlmcLive({ elapsedMinutes: 3, trend: createFoodTrend(() => 0), events: [],
  observation: frame({ position: { x: 0, y: 0, z: 0 }, dimension: 'overworld', health: 20, food: 20, ...world }) }, 0, v2);
const hostile = (id: number, name: string, distance: number, at: [number, number, number], extra: Record<string, unknown> = {}) =>
  ({ id, name, kind: 'hostile', distance, position: { x: at[0], y: at[1], z: at[2] }, ...extra });
const rewritten = (body: Record<string, unknown>, plan: Record<string, unknown> = {}) => rewriteLlmcLive({ plan, body: { state: { at: '(0,0,0)' }, ...body } }).live as Record<string, any>;

describe('C1: a hostile gets a line when it matters now, with how it stands to her; the rest is one line', () => {
  const frameThreats = [
    hostile(1, 'zombie', 10.4, [8, 0, 6], { reach: 'in_sight', canSee: true, canReachMe: true }),
    hostile(2, 'skeleton', 20, [14, 0, 14], { reach: 'walled', canReachMe: false, canSee: false, shooter: true }),
    hostile(3, 'spider', 23, [20, 0, 10], { reach: 'path_no_sight', pathToMe: 'yes' }),
    hostile(4, 'zombie', 39.6, [20, 35, 30], { canReachMe: false }),
    hostile(5, 'creeper', 51.2, [40, -36, 30]),
  ];
  it('writes the frame\'s reach after each near hostile\'s place, in the words the instructions promise', () => {
    const body = live({ nearbyThreats: frameThreats }).threats as string[];
    expect(body[0]).toBe('#1 zombie 10.4m (8,0,6)・見える（射線の中）');
    expect(body[1]).toBe('#2 skeleton 20m (14,0,14)・壁の向こうで届かない・飛び道具');
    expect(body[2]).toBe('#3 spider 23m (20,0,10)・見えない・道はある（回って来る）');
  });
  it('folds the far hostiles into one line with the nearest one\'s distance, height and reach, and leaves the near ones as lines', () => {
    const out = rewritten(live({ nearbyThreats: frameThreats })).body;
    const lines = out.threats as string[];
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^#1 zombie 10\.4m \(8,0,6\) 東8・南6・見える（射線の中）$/u);
    expect(lines[1]).toContain('壁の向こうで届かない');
    expect(lines[2]).toContain('見えない・道はある（回って来る）');
    expect(lines[3]).toBe('ほか 2 体（zombie 1・creeper 1。いちばん近い: zombie 39.6m・上 35・壁の向こう）');
  });
  it('says nothing of reach where the frame says nothing (not made up), and keeps a far hostile that sees her or has a way', () => {
    const out = rewritten({ threats: ['#9 zombie 60m (0,40,0)', '#8 skeleton 44m (10,0,0)・見える（射線の中）'] });
    expect(out.body.threats).toEqual(['#8 skeleton 44m (10,0,0) 東10・見える（射線の中）・飛び道具', 'ほか 1 体（zombie 1。いちばん近い: zombie 60m・上 40）']);
  });
  it('keeps a line for a shooter up to 48 m and a creeper up to 32 m by name, marked, and counts the rest by kind in the one line', () => {
    const out = rewritten({ threats: ['#1 ghast 41m (0,10,0)', '#2 skeleton 30m (30,0,0)', '#3 creeper 31m (31,0,0)', '#4 creeper 33m (33,0,0)',
      '#5 zombie 40m (0,0,40)', '#6 skeleton 49m (49,0,0)', '#7 zombie 50m (50,0,0)'] }).body.threats as string[];
    expect(out.slice(0, 3)).toEqual(['#2 skeleton 30m (30,0,0) 東30・飛び道具', '#3 creeper 31m (31,0,0) 東31', '#1 ghast 41m (0,10,0) 上10・飛び道具']);
    expect(out[3]).toBe('ほか 4 体（creeper 1・zombie 2・skeleton（飛び道具） 1。いちばん近い: creeper 33m）');
  });
  it('says in the dictionary which hostiles get a line, and that a far one is not written', () => {
    expect(V2_ALWAYS).toContain('飛び道具の種類（スケルトン・ブレイズ・ガスト');
    expect(V2_ALWAYS).toContain('48m 内');
    expect(V2_ALWAYS).not.toContain('見える・道があるときだけ行になり');
  });
  it('keeps a hostile the urgent lines name, with the probe\'s own words of its reach (the frame\'s are not said twice)', () => {
    const out = rewritten({ urgent: ['blaze #5 30.0m・上 2・見える（射線の中）'], threats: ['#5 blaze 30m (5,2,0)・壁の向こうで届かない'] });
    expect(out.body.urgent).toHaveLength(1);
    expect(String(out.body.urgent[0])).toContain('見える（射線の中）');
    expect(String(out.body.urgent[0])).not.toContain('壁の向こう');
  });
  it('is written for the mode only: the old mode\'s lines are as they were', () => {
    expect(live({ nearbyThreats: frameThreats }, false).threats[0]).toBe('#1 zombie 10.4m (8,0,6)');
  });
  it('the urgent live state says it the same way', () => {
    const state = minecraftLlmcUrgentLive({ observation: frame({ position: { x: 0, y: 0, z: 0 }, nearbyThreats: frameThreats }), elapsedMinutes: 1, events: [],
      planNowTitle: null, answer: 'a', v2: true });
    expect((state.threats as string[])[0]).toContain('・見える（射線の中）');
  });
});

describe('C2: 「済む条件」, not 「済み」, for a node\'s done-condition', () => {
  const plan = { revision: 1, done: '1/3', next: ['p2.2 箱を開ける＠1,2,3', 'p2.4 食料＠1,2,3（済み: food>=40）'], now: 'p2.1 ベッド（済み: have:bed）', blocked: [] };
  it('reads 済む条件 in planNow and plan.next (and plan.now when it stays), never 「（済み:」', () => {
    const out = rewritten({ planNow: '[p2.1] ベッドを取る＠157,67,201（済み: have:bed）（道: 村を回る）' }, { ...plan, now: 'p9 別の節（済み: dim:the_nether）' });
    expect(out.body.planNow).toBe('[p2.1] ベッドを取る＠157,67,201（済む条件: have:bed）（道: 村を回る）');
    expect(out.plan.next[1]).toBe('p2.4 食料＠1,2,3（済む条件: food>=40）');
    expect(out.plan.now).toBe('p9 別の節（済む条件: dim:the_nether）');
    expect(JSON.stringify(out)).not.toContain('（済み:');
  });
  it('keeps the route\'s goal (it reads the planNow as the body wrote it)', () => {
    const map = ['地図 v1 足=(0,0,0) x=-1..1 z=-1..1 方式=layers 上=北', 'y=0', ' -1 # # #', '  0 # @ #', '  1 # # #'].join('\n');
    const out = rewritten({ planNow: '[p1] 行く＠1,0,0（済み: at:1,0,0~1）', map });
    expect(JSON.stringify(out.body.route)).toContain('(1,0,0)');
  });
  it('is the word of the plan tool and of the instructions as well', () => {
    const [, , , planTool] = candidateMenuTools([{ ...PLAN_UPDATE_RULES_DEFINITION } as never]);
    const description = candidateMenuTools([PLAN_UPDATE_RULES_DEFINITION]).find(tool => tool.name === 'plan.update')!.description;
    expect(planTool).toBeUndefined();
    expect(description).toContain('済む条件');
    expect(description).not.toContain('済み（r9）');
    expect(V2_ALWAYS).toContain('済む条件');
    expect(V2_ALWAYS).not.toContain('（済み:');
  });
});

describe('C3: an unknown cell is said as unknown, not as rock', () => {
  const MAP = ['地図 v1 足=(0,0,0) x=-3..3 z=-3..3 方式=layers 上=北'];
  const layer = (y: number, rows: string[]) => [`y=${y}`, ...rows.map((row, i) => `${String(i - 3).padStart(2)} ${row}`)];
  const grid = (feetRow: string, unknown = false) => ['# # # # # # #', '# # # # # # #', '# . . . . ? #', feetRow, '# . . . . # #', '# # # # # # #', '# # # # # # #']
    .map(row => unknown ? row : row.replace(/\?/gu, '.'));
  const text = (unknown: boolean) => [...MAP, ...layer(1, grid('# . . . . # #', unknown)), ...layer(0, grid('# . . @ . # #', unknown)), ...layer(-1, grid('# # # # # # #'.replace(/#/gu, '#'), unknown))].join('\n');
  it('lists the not loaded cells in a row of their own and does not call them walkable', () => {
    const view = mapView(readLayers(text(true), BODY_RULES)!);
    const lines = aroundLines(view, { x: 0, y: 0, z: 0 });
    expect(lines.some(line => /不明（未ロード/u.test(line))).toBe(true);
    expect(lines.filter(line => line.startsWith('y=0（足） 歩ける')).join(' ')).not.toContain('x=2');
    expect(lines.join('\n')).toMatch(/y=0（足） 不明（未ロード。歩けるかどうか分からない）: z=-1 x=2/u);
  });
  it('is the same as before when every cell is shown', () => {
    const view = mapView(readLayers(text(false), BODY_RULES)!);
    expect(aroundLines(view, { x: 0, y: 0, z: 0 }).join('\n')).not.toContain('不明（未ロード');
  });
  it('says what is not written, in the line before the cells and in the dictionary', () => {
    const lines = aroundLines(mapView(readLayers(text(false), BODY_RULES)!), { x: 0, y: 0, z: 0 });
    const head = lines.find(line => line.startsWith('足の周りの 1 歩より先'))!;
    expect(head).toContain('足も頭も固い岩か、地図の端で不明');
    expect(V2_ALWAYS).toContain('足も頭も固い岩（掘って通る所）と、足・頭・床のどれかが地図に無い所');
    expect(V2_ALWAYS).not.toContain('書いていない所は足も頭も固い岩か、地図に無い（不明）');
  });
});

describe('D1: the last results show only what the history line does not have', () => {
  const act = ['act 3/5 済みで止まった（failure）', '1 walk 済 (1,0,0) に着いた', '2 walk 止 一歩ではない: (2,0,0)',
    '  周り（上の層から、北が上・西が左）x=1..3 z=-1..1 y=1: ###/#.#/### y=0: ###/#@#/### y=-1: ###/###/###', '今 (1,0,0) 体力20 満腹20'].join('\n');
  it('an act: only the surroundings of the stopped hand (the history has the rest); the old mode shows the whole', () => {
    const v2 = llmcStoredResult('mc.act', act, true), old = llmcStoredResult('mc.act', act);
    expect(v2.shown).toBe(act.split('\n')[3]);
    expect(old.shown).toBe(act);
    expect(v2.stored).toBe(old.stored);
    expect(v2.stored).toContain('1 walk 済 (1,0,0) に着いた');
  });
  it('an act with nothing of the kind shows nothing', () => {
    expect(llmcStoredResult('mc.act', '行 1\n行 2', true)).toEqual({ stored: '行 1\n行 2', shown: null });
  });
  it('a long result: the history keeps the first line, the next decision shows the lines after it, once', () => {
    const view = `地図 v1 足=(0,0,0) x=0..1 z=0..1 方式=layers 上=北\n${'y=0\n 0 # #\n 1 # #\n'.repeat(40)}`;
    const v2 = llmcStoredResult('mc.view', view, true);
    expect(v2.stored.startsWith('地図 v1 足=(0,0,0) x=0..1 z=0..1 方式=layers 上=北…（続き ')).toBe(true);
    expect(v2.shown!.startsWith('y=0')).toBe(true);
    expect(v2.shown).not.toContain('地図 v1');
    expect(llmcStoredResult('mc.view', view).shown).toBe(view.slice(0, 6000));
  });
});

describe('D2: what lies near, by name, and only what is worth a line', () => {
  const entities = [
    { id: 1, name: 'item', kind: 'passive', distance: 0.7, position: { x: 0, y: 0, z: 1 }, itemName: 'minecraft:cobblestone', itemCount: 4 },
    { id: 2, name: 'item', kind: 'passive', distance: 1.1, position: { x: 1, y: 0, z: 1 }, itemName: 'cobblestone', itemCount: 64, droppedByMe: true },
    { id: 3, name: 'item', kind: 'passive', distance: 1.6, position: { x: 1, y: 0, z: 2 } },
    { id: 4, name: 'bat', kind: 'ambient', distance: 6, position: { x: 3, y: 3, z: 3 } },
    { id: 5, name: 'villager', kind: 'passive', distance: 30, position: { x: 30, y: 0, z: 0 } },
    { id: 6, name: 'villager', kind: 'passive', distance: 9, position: { x: 9, y: 0, z: 0 } },
    { id: 7, name: 'cow', kind: 'passive', distance: 14, position: { x: 14, y: 0, z: 0 } },
    hostile(8, 'zombie', 12, [12, 0, 0]),
  ];
  it('names an item with its count, leaves out the one she threw and the hostiles (the threats say them)', () => {
    const near = live({ nearbyEntities: entities }).near as string[];
    expect(near).toContain('#1 item cobblestone×4 0.7m (0,0,1)');
    expect(near).toContain('#3 item 1.6m (1,0,2)');
    expect(near.join('\n')).not.toContain('#2 ');
    expect(near.join('\n')).not.toContain('zombie');
  });
  it('drops the bat, the far villager and the cow unless the plan wants food; keeps the near villager', () => {
    const out = rewritten(live({ nearbyEntities: entities, inventory: [{ name: 'bread', count: 10 }] })).body;
    expect(out.near).toEqual(['#1 item cobblestone×4 0.7m (0,0,1)', '#3 item 1.6m (1,0,2)', '#6 villager 9m (9,0,0)']);
    const food = rewritten({ ...live({ nearbyEntities: entities, inventory: [{ name: 'bread', count: 10 }] }), planNow: '[p2.4] 食料を集める' }).body;
    expect(food.near).toContain('#7 cow 14m (14,0,0)');
    expect(JSON.stringify(food.near)).not.toContain('bat');
  });
  const fed = { inventory: [{ name: 'bread', count: 10 }], food: 20 };
  const sheepAndFolk = [...entities, { id: 9, name: 'sheep', kind: 'passive', distance: 10, position: { x: 10, y: 0, z: 1 } },
    { id: 10, name: 'villager', kind: 'passive', distance: 20, position: { x: 20, y: 0, z: 1 } }];
  const nearOf = (world: Record<string, unknown>, extra: Record<string, unknown> = {}, plan: Record<string, unknown> = {}) =>
    rewriteLlmcLive({ plan, body: { ...live({ nearbyEntities: sheepAndFolk, ...fed, ...world }), ...extra } }).live.body as Record<string, any>;
  it('shows food animals when she is fed only if the plan names food; hides them (and sheep, and a villager at 20 m) otherwise', () => {
    const quiet = nearOf({}).near.join('\n');
    for (const gone of ['cow', 'sheep', '#10 villager']) expect(quiet).not.toContain(gone);
  });
  it('shows food animals when her food is 14 or less, her points are under 40, the shortage names food or health does not come back', () => {
    expect(nearOf({ food: 14 }).near.join('\n')).toContain('cow');
    expect(nearOf({ inventory: [{ name: 'bread', count: 2 }] }).near.join('\n')).toContain('cow');
    expect(nearOf({}, { shortage: '食料が足りない' }).near.join('\n')).toContain('cow');
    expect(nearOf({}, { recovery: ['体力が戻らない'] }).near.join('\n')).toContain('cow');
  });
  it('shows the sheep when the plan or the shortage names a bed or wool, and the villager at 20 m when the plan trades or names a village', () => {
    expect(nearOf({}, { planNow: '[p3.1] 羊毛を取る' }).near.join('\n')).toContain('sheep');
    expect(nearOf({}, { planNow: '[p3.1] 羊毛を取る' }).near.join('\n')).not.toContain('cow');
    expect(nearOf({}, { shortage: 'ベッドが足りない' }).near.join('\n')).toContain('sheep');
    expect(nearOf({}, { planNow: '[p2.3] 村人と交易する' }).near.join('\n')).toContain('#10 villager');
    expect(nearOf({}, {}, { next: ['p2 村を回る'] }).near.join('\n')).toContain('#10 villager');
  });
  it('writes a stack the body did not name as just 「item」', () => {
    expect(live({ nearbyEntities: [{ id: 3, name: 'item', kind: 'passive', distance: 1, position: { x: 0, y: 0, z: 1 } }] }).near[0]).toBe('#3 item 1m (0,0,1)');
  });
  it('the old mode\'s near lines are as they were', () => {
    expect(live({ nearbyEntities: entities }, false).near[0]).toBe('#1 item 0.7m (0,0,1)');
  });
});

describe('D3: one language, one topic in one place, a dictionary of the live fields', () => {
  const system = minecraftV2System(V2_ALWAYS);
  const FIELDS = ['urgent', 'planNow', 'shortage', 'recovery', 'footing', 'around', 'route', 'liquid', 'obsidian', 'pack', 'repeat', 'look', 'investigation',
    'stops', 'landmarks', 'scan', 'state', 'food', 'inventory', 'threats', 'near', 'jobs', 'events', 'lastResults', 'map', 'answer'];
  it('writes the mode\'s system text in Japanese: no English header, protocol or reading', () => {
    for (const gone of ['# Minecraft body task', '## Each decision', '## Reading the request', 'Only the task directs you', 'You choose the next actions']) {
      expect(system).not.toContain(gone);
    }
    expect(system.startsWith('# Minecraft の体の課題')).toBe(true);
    // The shared transport block is the same for every body task and is left as it was.
    expect(MINECRAFT_TRANSPORT.startsWith('Request transport')).toBe(true);
  });
  it('has a line in the dictionary for every live field, plan.rules included, and none names a tool the mode does not offer', () => {
    for (const field of FIELDS) expect(V2_ALWAYS, field).toMatch(new RegExp(`^- ${field}: `, 'mu'));
    expect(V2_ALWAYS).toContain('rules（今の節と親の禁止・注意');
    expect(foreignToolNames(system)).toEqual([]);
  });
  it('gives a rule once and with its reason, and leaves out the stories of one run', () => {
    expect(system.split('同じ手を同じまま出さない').length - 1).toBe(1);
    expect(system).not.toMatch(/実走\d|run ?\d/u);
    expect(system).not.toContain('死の形');
    expect(system).not.toContain('collect=false');
    expect(system).not.toContain('rel: true');
    expect(system).not.toContain('place は空気');
  });
  it('puts the hand grammar in the mc_act description: the json fields of every hand, with walk\'s `to` or `path` (not `at`)', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('walk: to か path・sprint・range');
    expect(SHORT_ACT_DESCRIPTION).toContain('walk に at は使えない');
    expect(SHORT_ACT_DESCRIPTION).toContain('rel（座標を、その手を始める時の足のブロックからの差にする');
    expect(SHORT_ACT_DESCRIPTION).toContain('place は空気（. か *）で、6面のどれかが固いマスへ');
    for (const kind of ['dig', 'place', 'pillarUp', 'use', 'look', 'jump', 'sneak', 'equip', 'craft', 'attack', 'eat', 'pickup', 'wait', 'furnace', 'chest', 'drop', 'shoot']) {
      expect(SHORT_ACT_DESCRIPTION, kind).toMatch(new RegExp(`${kind}: `, 'u'));
    }
    expect(SHORT_ACT_DESCRIPTION).toContain('どの手にも rel・note・onFail');
  });
  it('says the two controls in Japanese in the mode\'s request and keeps the shared ones', async () => {
    const names = V2_CONTROL_WORDS.map(([name]) => name);
    expect(names).toEqual(['fca_wait', 'fca_complete']);
    const complete = V2_CONTROL_WORDS[1]!;
    expect(complete[1]).toContain('boss.verified');
    expect(complete[1]).not.toMatch(/[A-Za-z]{4,} [a-z]{3,} [a-z]{3,}/u);
  });
  it('writes a task\'s completion in one plain sentence beside the machine\'s conditions (the binding itself unchanged)', () => {
    const progress = { conditions: [], binding: { id: 'minecraft-dragon:x', conditions: [{ id: 'original-task' }, { id: 'witnessed-dragon', path: 'boss.verified' }] } };
    const out = progressWithPlain(progress) as { binding: Record<string, unknown> };
    expect(String(out.binding.plain)).toContain('エンドラの死を見届けた');
    expect(String(out.binding.plain)).toContain('boss.verified');
    expect(out.binding.conditions).toBe(progress.binding.conditions);
    expect(out.binding.id).toBe(progress.binding.id);
    expect(progressWithPlain({ conditions: [] })).toEqual({ conditions: [] });
    expect(minecraftV2Hooks().progress).toBe(progressWithPlain);
  });
});

describe('D3: the bootstrap of a new epoch as readable lines', () => {
  const rounds = [1, 2, 3].map(n => ({ sequence: n, stepId: `s${n}`, messages: [
    { id: `${n}:0`, role: 'tool_call', callId: `c${n}`, content: JSON.stringify({ name: 'mc_act', input: { hands: ['walk 1,2,3', 'wait 1'], why: '[p1] 行く' } }) },
    { id: `${n}:1`, role: 'tool_result', callId: `c${n}`, content: JSON.stringify({ ok: n !== 2, result: 'act 1/2 済み\n1 walk 済 着いた\n今 (1,2,3)' }) },
    { id: `${n}:2`, role: 'assistant', content: 'Committed task status after this round: queued. A requested completion is not proof of completion.' }] }));
  const stored = JSON.stringify({ kind: 'fca_public_history', summary: { 目的: ['エンドラを倒す'], 済み: ['木を取った'], 次: [] }, rounds });
  it('shows the calls and results as lines (real line breaks, no escapes) and the status sentence once', () => {
    const text = readableBootstrap(stored)!;
    expect(text).not.toContain('\\n');
    expect(text).not.toContain('\\"');
    expect(text).toContain('目的:\n- エンドラを倒す');
    expect(text).toContain('### 判断 2\n呼び出し mc_act\n  hands:\n    walk 1,2,3\n    wait 1\n  why: [p1] 行く\n結果（失敗）:\nact 1/2 済み\n1 walk 済 着いた');
    expect(text.split('Committed task status').length - 1).toBe(0);
    expect(text.split('各判断の後の課題の状態: queued').length - 1).toBe(1);
  });
  it('is a pure function of the stored text, and the mode\'s codec uses it where the shared one writes the text as it is', () => {
    expect(readableBootstrap(stored)).toBe(readableBootstrap(stored));
    expect(anthropicFcaHistoryCodecV2.bootstrap(stored)).toEqual([{ role: 'user', content: readableBootstrap(stored) }]);
    expect(anthropicFcaHistoryCodec.bootstrap(stored)).toEqual([{ role: 'user', content: stored }]);
    expect(anthropicFcaHistoryCodecV2.bootstrap('not json')).toEqual([{ role: 'user', content: 'not json' }]);
  });
  it('is shorter than the JSON it replaces', () => {
    expect(readableBootstrap(stored)!.length).toBeLessThan(stored.length);
  });
});

describe('the review of 10: words restored in the hand and dictionary', () => {
  it('says in mc.act that a bed works at night or in a thunderstorm only, and the units of stopIf', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('ベッドで寝る（夜か雷雨の時だけ。昼は寝られない');
    expect(SHORT_ACT_DESCRIPTION).toContain('hostileWithin は敵までの m、hpBelow は体力 0〜20');
  });
  it('gives the unit of health and says which thrown items are not shown', () => {
    expect(V2_ALWAYS).toContain('health（0〜20。ハート 1 個 = 2）');
    expect(V2_ALWAYS).toContain('自分が投げたと分かっている物（屑・予備のつるはし）は出ない');
    expect(V2_ALWAYS).not.toContain('（自分が投げた物は出ない）');
  });
});

describe('the bench of 10 (cd-fixes-20261024): craft, drop, reach, far endermen', () => {
  it('says exactly which crafts need a crafting table (2×2 recipes, flint and steel included, need none)', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('2×2 で作れる物（板・棒・作業台・松明・火打ち金など）は作業台が要らない');
    expect(SHORT_ACT_DESCRIPTION).toContain('3×3 の物（ツルハシ・剣・盾・かまど・バケツ・ハーフブロックなど）は作業台が5m内に要る');
    expect(SHORT_ACT_DESCRIPTION).not.toContain('craft 物 [個数]（作業台が5m内に要る）');
  });
  it('gives drop a line form again, round trips with the json form, and reads a target or a place', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('drop 物 [数] [target=#id か X,Y,Z]');
    expect(lineToHand('drop gold_ingot 1 target=#12')).toEqual({ do: 'drop', items: [{ item: 'gold_ingot', count: 1 }], target: '#12' });
    expect(lineToHand('drop cobblestone 64 1,2,3')).toEqual({ do: 'drop', items: [{ item: 'cobblestone', count: 64 }], at: [{ x: 1, y: 2, z: 3 }] });
    expect(lineToHand('drop cobblestone')).toEqual({ do: 'drop', items: [{ item: 'cobblestone' }] });
    expect(handToLine({ do: 'drop', items: [{ item: 'gold_ingot', count: 1 }], target: '#12' } as never)).toBe('drop gold_ingot 1 target=#12');
    expect(handToLine({ do: 'drop', items: [{ item: 'a' }, { item: 'b' }] } as never).startsWith('json ')).toBe(true);
  });
  it('restores the reach guidance where dig is explained: 5 m at a time, not 16 cells at once', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('届くのは目から5m以内のマス: トンネルや階段は5mずつ');
    expect(SHORT_ACT_DESCRIPTION).toContain('16マスを一度に掘ると、奥は手が届かず止まる');
  });
  it('keeps a far enderman (28.5 m) as a line, and a far zombie folded', () => {
    const out = rewritten({ threats: ['#1 enderman 28.5m (28,2,0)', '#2 zombie 28.5m (0,2,28)'] }).body.threats as string[];
    expect(out).toEqual(['#1 enderman 28.5m (28,2,0) 東28・上2', 'ほか 1 体（zombie 1。いちばん近い: zombie 28.5m・上 2）']);
  });
});
