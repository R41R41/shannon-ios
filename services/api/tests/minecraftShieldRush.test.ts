import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import {
  ACT_INPUT_SCHEMA, actOutcomeOf, actProblem, MC_ACT_TOOL, readActResult,
  type ActHand, type ActHandLine, type ActInput, type ActResult, type ShieldRushCode, type ShieldRushStatus,
} from '../src/contracts/minecraftActContract.js';
import { handProblem } from '../src/contracts/minecraftActHandRules.js';
import { actToShort, expandShortAct, handToLine, lineToHand, shortToAct } from '../src/contracts/minecraftActShortContract.js';
import { skillSchema, validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { actResultText, llmcInputProblem, llmcPrepare, llmcStoredResult } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { deadlyGateHold } from '../src/surfaces/minecraft/minecraftLlmcDeadlyGates.js';
import { createLlmcEvents, tasks } from '../src/surfaces/minecraft/minecraftLlmcEvents.js';
import { handFacts, SHIELD_RUSH_CODE_WORDS, shieldRushWords } from '../src/surfaces/minecraft/minecraftLlmcResultWords.js';
import { forgetStalls, noteProgress, noteRan } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { typedFailureOf } from '../src/surfaces/minecraft/minecraftLlmcTypedFailure.js';
import { progressEvents } from '../src/surfaces/minecraft/minecraftProgressEvents.js';

const cell = (x: number, y: number, z: number) => ({ x, y, z });
const rush: ActHand = { do: 'attack', target: '#123', style: 'shield_rush', retreatTo: cell(1, 2, 3) };
const act = (change: Record<string, unknown> = {}): ActInput => ({ hands: [{ ...rush, ...change } as ActHand], accept: ['blaze'] });
const full: ActHand = { ...rush, seconds: 20, retreatHp: 12, shieldReserve: 36, onCrossfire: 'retreat', pickup: 'target_drops',
  area: { center: cell(4, 5, 6), radius: 4, maxDrop: 0 } };

const row = (change: Partial<ActHandLine> = {}): ActHandLine => ({ i: 1, do: 'attack', status: 'retreated', code: 'SHIELD_LOW',
  line: 'shield_rush #123', progress: { unit: 'blow', done: 3, left: null, hits: 3, rodsDelta: 0, hpMin: 9.5, hpEnd: 12,
    shieldBefore: 120, shieldAfter: 34, elapsedMs: 15000, at: cell(1, 2, 3), safe: true }, ...change });
const result = (lines: ActHandLine[]): ActResult => ({ v: 1, ok: lines.every(line => line.status === 'killed' || line.status === 'done'),
  done: lines.filter(line => line.status === 'killed' || line.status === 'done').length, of: lines.length,
  at: cell(1, 2, 3), hp: 12, food: 20, ms: 15000, lines });
const read = (line: ActHandLine): ActResult => readActResult(JSON.stringify(result([line])))!;
const frame = (items: Array<[string, number]> = [], world: Record<string, unknown> = {}): BodyObservation => ({
  schemaVersion: 1, bodyId: 'b', sequence: 1, connected: true, stateAt: '2026-11-03T00:00:00Z', receivedAt: '2026-11-03T00:00:00Z', facts: {},
  state: { world: { dimension: 'the_nether', position: cell(0, 2, 0), health: 20, food: 20,
    inventory: items.map(([name, count]) => ({ name, count })), worn: '', ...world } as never },
});

afterEach(() => { tasks.clear(); forgetStalls(); });

describe('shield_rush input contract', () => {
  it('accepts the required fields and all optional fields without filling the body defaults', () => {
    for (const input of [act(), { hands: [full], accept: ['blaze'] }]) {
      expect(validSkillInput(input, ACT_INPUT_SCHEMA)).toBe(true);
      expect(actProblem(input)).toBeNull();
      expect(llmcInputProblem(MC_ACT_TOOL, input)).toBeNull();
      expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: null });
    }
    expect(act().hands[0]).not.toHaveProperty('seconds');
    expect(act().hands[0]).not.toHaveProperty('area');
    // The added properties and nested center must still fit the catalog's bounded schema subset.
    expect(skillSchema(ACT_INPUT_SCHEMA)).toBe(true);
  });

  it.each([
    [{ seconds: 0.5, retreatHp: 1, shieldReserve: 0 }, 'lower bounds'],
    [{ seconds: 30, retreatHp: 19, shieldReserve: 336 }, 'upper bounds'],
    [{ onCrossfire: 'continue', pickup: 'none', area: { center: cell(-1, 0, 1), radius: 0.5, maxDrop: 1 } }, 'other choices'],
  ] as Array<[Record<string, unknown>, string]>)('accepts %s (%s)', change => {
    expect(llmcInputProblem(MC_ACT_TOOL, act(change))).toBeNull();
  });

  const badFields: Array<[Record<string, unknown>, string]> = [
    [{ style: 'rush' }, 'style=shield_rush'],
    [{ target: undefined }, 'target="#123"'], [{ target: 'blaze' }, 'target="#123"'],
    [{ target: 'minecraft:blaze' }, 'target="#123"'], [{ target: 123 }, 'target="#123"'],
    [{ target: '#-1' }, 'target="#123"'], [{ target: '#1.5' }, 'target="#123"'], [{ target: '#123 blaze' }, 'target="#123"'],
    [{ retreatTo: undefined }, 'retreatTo={x,y,z}'], [{ retreatTo: '1,2,3' }, 'retreatTo={x,y,z}'],
    [{ retreatTo: [cell(1, 2, 3)] }, 'retreatTo={x,y,z}'], [{ retreatTo: { x: 1, y: 2 } }, 'retreatTo={x,y,z}'],
    [{ retreatTo: cell(1, NaN, 3) }, 'retreatTo={x,y,z}'],
    [{ retreatTo: { ...cell(1, 2, 3), other: 1 } }, 'retreatTo={x,y,z}'],
    ...[0, 30.1, NaN, Infinity, '20'].map(value => [{ seconds: value }, 'seconds=20'] as [Record<string, unknown>, string]),
    ...[0, 20, 12.5, NaN, '12'].map(value => [{ retreatHp: value }, 'retreatHp=12'] as [Record<string, unknown>, string]),
    ...[-1, 337, 1.5, Infinity, '36'].map(value => [{ shieldReserve: value }, 'shieldReserve=36'] as [Record<string, unknown>, string]),
    [{ onCrossfire: 'ignore' }, 'onCrossfire=retreat|continue'], [{ pickup: 'all' }, 'pickup=target_drops|none'],
    ...[null, [], '4,5,6,4,0', {}, { center: cell(4, 5, 6), radius: 4 },
      { center: { x: 4, y: 5 }, radius: 4, maxDrop: 0 }, { center: cell(4, 5, 6), radius: 0, maxDrop: 0 },
      { center: cell(4, 5, 6), radius: -1, maxDrop: 0 }, { center: cell(4, 5, 6), radius: NaN, maxDrop: 0 },
      { center: cell(4, 5, 6), radius: 4, maxDrop: -1 }, { center: cell(4, 5, 6), radius: 4, maxDrop: 0.5 },
      { center: cell(4, 5, 6), radius: 4, maxDrop: 0, extra: true }]
      .map(value => [{ area: value }, 'area=cx,cy,cz,r,maxDrop'] as [Record<string, unknown>, string]),
  ];
  it.each(badFields)('refuses %s with a mend (%s)', (change, mend) => {
    expect(actProblem(act(change))).toContain(mend);
    expect(llmcInputProblem(MC_ACT_TOOL, act(change))).toContain(mend);
    expect(llmcPrepare(MC_ACT_TOOL, act(change)).problem).toContain(mend);
  });

  it.each([undefined, [], ['zombie'], ['blaze', 'zombie'], ['blaze', 'blaze'], ['minecraft:blaze'], 'blaze', ['blaze', 7]].map(accept => ({ accept })))(
    'refuses accept=$accept without repairing it, also in mixed/short hands', ({ accept }) => {
      const input = { hands: [{ do: 'eat' }, rush], accept };
      const prepared = llmcPrepare(MC_ACT_TOOL, input);
      expect(prepared.problem).toContain('accept は ["blaze"]');
      expect((prepared.input as { accept: unknown }).accept).toEqual(accept);
      expect(prepared.fixes).not.toContain('accept を配列にした');
      const short = expandShortAct({ hands: ['eat', handToLine(rush)], accept });
      expect(short.errors).toEqual([]);
      expect(llmcPrepare(MC_ACT_TOOL, short.input).problem).toContain('accept は ["blaze"]');
    },
  );

  it('keeps rush-only fields out of ordinary attacks and other hands', () => {
    for (const key of ['retreatTo', 'retreatHp', 'area', 'shieldReserve', 'onCrossfire', 'pickup'] as const) {
      expect(handProblem({ do: 'attack', target: '#123', [key]: full[key] })).toContain('style=shield_rush');
    }
    expect(handProblem({ do: 'fight', target: '#123', style: 'shield_rush' })).toContain('style は使えない');
    expect(actProblem({ hands: [{ do: 'attack', target: 'zombie', hold: true, seconds: 20, untilDead: false }] })).toBeNull();
    expect(actProblem({ hands: [{ do: 'fight', target: 'blaze', retreatHp: 12 }] })).toBeNull();
    expect(llmcPrepare(MC_ACT_TOOL, { hands: [{ do: 'attack', target: 123 }], accept: 'blaze' }).problem).toBeNull();
  });
});

describe('shield_rush short grammar', () => {
  const short = 'attack #123 style=shield_rush retreatTo=1,2,3';
  it('reads/writes the minimal hand without defaults', () => {
    expect(lineToHand(short)).toEqual(rush);
    expect(handToLine(rush)).toBe(short);
    expect(shortToAct({ hands: [short], accept: ['blaze'] })).toEqual({ act: act(), errors: [] });
    expect(shortToAct(actToShort(act()))).toEqual({ act: act(), errors: [] });
  });
  it('reads/writes every option and keeps common hand fields', () => {
    const hand: ActHand = { ...full, onCrossfire: 'continue', pickup: 'none', note: 'ブレイズ1体', dependsOn: [1], onFail: 'stop' };
    const line = handToLine(hand);
    expect(line).toBe(`${short} seconds=20 retreatHp=12 shieldReserve=36 onCrossfire=continue pickup=none area=4,5,6,4,0 onFail=stop dependsOn=1 note="ブレイズ1体"`);
    expect(lineToHand(line)).toEqual(hand);
    expect(lineToHand(handToLine(full))).toEqual(full);
    expect(lineToHand(`${short} hold seconds=20 untilDead=false`)).toMatchObject({ ...rush, hold: true, seconds: 20, untilDead: false });
  });
  it.each(['retreatTo=1,2', 'retreatTo=1,2,no', 'area=1,2,3,4', 'area=1,2,3,4,', 'area=1,2,3,no,0'])('refuses malformed %s with its form', field => {
    const line = `attack #123 style=shield_rush ${field.startsWith('area=') ? 'retreatTo=1,2,3 ' : ''}${field}`;
    expect(lineToHand(line)).toMatchObject({ error: expect.stringContaining(field.startsWith('area=') ? 'area=cx,cy,cz,r,maxDrop' : 'retreatTo=x,y,z') });
  });
  it('leaves missing/invalid rush fields to the same validation as JSON', () => {
    for (const line of ['attack #123 style=shield_rush', 'attack blaze style=shield_rush retreatTo=1,2,3',
      `${short} shieldReserve=337`, `${short} onCrossfire=ignore`, `${short} pickup=all`]) {
      expect(llmcInputProblem(MC_ACT_TOOL, expandShortAct({ hands: [line], accept: ['blaze'] }).input)).not.toBeNull();
    }
    expect(lineToHand(`${short} #124`)).toHaveProperty('error');
  });
});

const CODES: Record<ShieldRushCode, string> = {
  TARGET_LOST: '相手を見失った', HEIGHT_UNREACHABLE: '高さの差で届かなかった', NO_ATTACK_WINDOW: '打てる機会が無かった',
  CROSSFIRE: '複数方向から射撃を受けた', SHIELD_LOW: '盾の耐久の残りが下限以下になった', RETREAT_BLOCKED: '退避先へ戻れなかった',
  PICKUP_UNSAFE: '安全に拾えなかった', TIME_LIMIT: '秒数の上限に達した', REFLEX: '体の反射が手を止めた', DEAD: '死んだ',
};

describe('shield_rush results are facts, never a next action', () => {
  it.each(['killed', 'retreated', 'failed', 'cut'] as ShieldRushStatus[])('reads status=%s and the body counts in one or two lines', status => {
    const line = row({ status, code: undefined });
    const words = shieldRushWords(line);
    expect(words).toHaveLength(2);
    expect(words[0]).toContain(`shield_rush #123: ${status}`);
    for (const fact of ['盾 120→34', '体力最低 9.5', '終了体力 12', '3 回打った', 'ロッド増減 +0', '経過 15000 ms', '終了地点 (1,2,3)', '終了地点は安全']) {
      expect(words[1]).toContain(fact);
    }
    expect(handFacts(line)).toEqual(words.map(word => `  事実: ${word}`));
    expect(words.join('\n')).not.toMatch(/退く|2枚目|出し直|作る|次の/u);
    const text = actResultText(read(line));
    expect(text).toContain(`shield_rush #123: ${status}`);
    expect(text.match(/shield_rush/g)).toHaveLength(1);
    expect(llmcStoredResult(MC_ACT_TOOL, text).stored).toContain(words[1]);
  });
  it.each(Object.entries(CODES) as Array<[ShieldRushCode, string]>)('reads %s as its fact', (code, fact) => {
    const line = row({ status: code === 'REFLEX' || code === 'TIME_LIMIT' ? 'cut' : code === 'DEAD' ? 'failed' : 'retreated', code });
    expect(shieldRushWords(line)[0]).toContain(`（${code}） ${fact}`);
    expect(actResultText(read(line))).toContain(fact);
    // Combat facts produce no typed-failure candidates or automatic retry instructions.
    expect(typedFailureOf(line, frame())).toBeNull();
  });
  it('has exactly the ten closed codes and tells killed without a code', () => {
    expect(Object.keys(SHIELD_RUSH_CODE_WORDS).sort()).toEqual(Object.keys(CODES).sort());
    expect(shieldRushWords(row({ status: 'killed', code: undefined, progress: undefined }))).toEqual(['shield_rush #123: killed 相手の死を観測した']);
    expect(shieldRushWords({ i: 1, do: 'attack', status: 'done', line: '#123 を打った' })).toEqual([]);
  });
  it('does not invent metrics, pickup, a return to retreatTo, or safety', () => {
    const absent = shieldRushWords(row({ progress: undefined })).join('\n');
    expect(absent).not.toMatch(/盾 \d|体力最低|回打った|ロッド増減|終了地点|退避先に着いた/u);
    const line = row({ progress: { unit: 'blow', done: 0, left: null, hits: 0, rodsDelta: -1, hpMin: 0, hpEnd: 0,
      shieldBefore: 0, shieldAfter: 0, elapsedMs: 0, safe: false } });
    expect(shieldRushWords(line)[1]).toContain('盾 0→0・体力最低 0・終了体力 0・0 回打った・ロッド増減 -1・経過 0 ms・終了地点は安全ではない');
    expect(shieldRushWords(row({ progress: { unit: 'blow', done: 0, left: null, hits: NaN, hpMin: Infinity } }))).toHaveLength(1);
  });
  it('keeps rush facts in urgent/compressed events and clears them on the next ordinary result', () => {
    const events = createLlmcEvents('rush');
    const line = row();
    events.noteFailures(JSON.stringify(result([line])), frame(), act());
    expect(events.failureFacts(frame())).toEqual(shieldRushWords(line));
    events.noteFailures(JSON.stringify(result([{ i: 1, do: 'eat', status: 'done', line: '食べた' }])), frame(), { hands: [{ do: 'eat' }] });
    expect(events.failureFacts(frame())).toEqual([]);
  });
});

describe('shield_rush progress', () => {
  it.each([
    ['killed', 'done', 'finished'], ['retreated', 'failed', 'finished'], ['failed', 'failed', 'finished'], ['cut', 'partial', 'cut'],
  ] as const)('fills old/missing axes for %s without confusing retreat with a kill', (status, goal, end) => {
    const parsed = read(row({ status, code: undefined }));
    expect(parsed.lines[0]).toMatchObject({ status, goal, end });
    expect(actOutcomeOf(parsed)).toMatchObject({ goal, end });
    expect(actOutcomeOf(result([row({ status, code: undefined })]))).toMatchObject({ goal, end });
    expect(progressEvents([rush], parsed.lines)).toEqual(status === 'killed' ? ['kill'] : []);
  });
  it('counts a confirmed kill once by its hand index, even when the return was cut; unknown/not-run earns none', () => {
    const killed = row({ i: 2, status: 'killed', code: undefined, goal: 'partial', end: 'cut' });
    expect(progressEvents([{ do: 'eat' }, rush], [killed])).toEqual(['kill']);
    for (const end of ['unknown', 'not_run'] as const) expect(progressEvents([rush], [row({ status: 'killed', end })])).toEqual([]);
    expect(progressEvents([rush], [row({ status: 'killed', goal: 'not_started' })])).toEqual([]);
    expect(progressEvents([rush], [row({ status: 'done', goal: 'done', end: 'finished' })])).toEqual([]);
    expect(progressEvents([{ do: 'attack', target: 'enderman' }], [{ i: 1, do: 'attack', status: 'done', goal: 'done', end: 'finished', line: '' }])).toEqual(['kill']);
  });
  it('a killed rush resets the node stall window through the normal result reader', () => {
    const snapshot = { node: 'p9', state: 'doing', milestone: 'ブレイズロッド', items: 4, inventory: {}, purpose: {} };
    noteProgress('rush', snapshot, 0);
    expect(noteRan('rush', { hands: [rush], result: JSON.stringify(result([row({ status: 'killed', code: undefined })])), activeMs: 100000 })).toBeNull();
    expect(noteProgress('rush', snapshot, 219000)).toBeNull();
    expect(noteProgress('rush', snapshot, 220000)).toMatchObject({ kind: 'node_stalled' });
  });
});

describe('shield_rush uses the existing blaze deadly gate', () => {
  const live = { threats: ['#123 blaze 30.0m (4,2,6)'] };
  const ready: Array<[string, number]> = [['shield', 1], ['cooked_beef', 20], ['iron_sword', 1]];
  it('holds rush/fight/attack on the same blaze id with the same prerequisites', () => {
    for (const hand of [rush, { do: 'fight', target: '#123' }, { do: 'attack', target: '#123' }, { do: 'attack', target: 'blaze' }]) {
      const held = deadlyGateHold({ hands: [hand] }, frame([], { ...live, health: 14, food: 12 }));
      expect(held).toMatchObject({ hand: 1, kind: 'fight' });
      for (const word of ['体力 14/20', '満腹度 12/18', '持ち物の食料', '盾 0/1']) expect(held!.line).toContain(word);
      expect(deadlyGateHold({ hands: [hand] }, frame(ready, live))).toBeNull();
    }
  });
  it('preserves the ongoing-fight exception and resolves ids from both live lists', () => {
    expect(deadlyGateHold(act(), frame([], { urgent: live.threats }))).toMatchObject({ hand: 1 });
    expect(deadlyGateHold(act(), frame([], { threats: ['#123 blaze 9.5m (4,2,6)'] }))).toBeNull();
    expect(deadlyGateHold(act(), frame([], { threats: ['#123 zombie 30.0m (4,2,6)'] }))).toBeNull();
  });
});
