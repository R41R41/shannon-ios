import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import {
  ACT_DESCRIPTION, ACT_INPUT_SCHEMA, actMilliseconds, actOutcomeOf, actProblem, MC_ACT_TOOL, readActResult,
  type ActHand, type ActHandLine, type ActInput, type ActResult, type RushCode, type ShieldRushResult,
} from '../src/contracts/minecraftActContract.js';
import { handProblem } from '../src/contracts/minecraftActHandRules.js';
import { actToShort, expandShortAct, handToLine, lineToHand, SHORT_ACT_DESCRIPTION, shortToAct } from '../src/contracts/minecraftActShortContract.js';
import { skillSchema, validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { actResultText, llmcInputProblem, llmcPrepare, llmcStoredResult } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { deadlyGateHold } from '../src/surfaces/minecraft/minecraftLlmcDeadlyGates.js';
import { createLlmcEvents, tasks } from '../src/surfaces/minecraft/minecraftLlmcEvents.js';
import { handFacts, SHIELD_RUSH_CODE_WORDS, shieldRushWords } from '../src/surfaces/minecraft/minecraftLlmcResultWords.js';
import { forgetStalls, noteProgress, noteRan } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { typedFailureOf } from '../src/surfaces/minecraft/minecraftLlmcTypedFailure.js';
import { progressEvents } from '../src/surfaces/minecraft/minecraftProgressEvents.js';

const cell = (x: number, y: number, z: number) => ({ x, y, z });
const rush: ActHand = { do: 'attack', target: '#123', style: 'shield_rush', seconds: 20, retreatHp: 12,
  retreatTo: cell(1, 2, 3), area: { center: cell(4, 5, 6), radius: 4, maxDrop: 0 },
  shieldReserve: 36, onCrossfire: 'retreat', pickup: 'target_drops' };
const act = (change: Record<string, unknown> = {}): ActInput => ({ hands: [{ ...rush, ...change } as ActHand], accept: ['blaze'] });
const row = (rushChange: Partial<ShieldRushResult> = {}, change: Partial<ActHandLine> = {}): ActHandLine => ({
  i: 1, do: 'attack', status: 'stopped', line: '#123 の攻撃を終えた',
  shieldRush: { status: 'retreated', targetDead: false, code: 'SHIELD_LOW', hits: 3, rodsDelta: 0, hpMin: 9.5, hpEnd: 12,
    shieldBefore: 120, shieldAfter: 34, elapsedMs: 15000, at: cell(1, 2, 3), safe: true, pendingDrops: [], ...rushChange }, ...change,
});
const result = (lines: ActHandLine[]): ActResult => ({ v: 1, ok: lines.every(line => line.status === 'done'),
  done: lines.filter(line => line.status === 'done').length, of: lines.length,
  at: cell(1, 2, 3), hp: 12, food: 20, ms: 15000, lines });
const read = (line: ActHandLine): ActResult => readActResult(JSON.stringify(result([line])))!;
const frame = (items: Array<[string, number]> = [], world: Record<string, unknown> = {}): BodyObservation => ({
  schemaVersion: 1, bodyId: 'b', sequence: 1, connected: true, stateAt: '2026-11-03T00:00:00Z', receivedAt: '2026-11-03T00:00:00Z', facts: {},
  state: { world: { dimension: 'the_nether', position: cell(0, 2, 0), health: 20, food: 20,
    inventory: items.map(([name, count]) => ({ name, count })), worn: '', ...world } as never },
});

afterEach(() => { tasks.clear(); forgetStalls(); });

describe('shield_rush input contract', () => {
  it('accepts all required fields as written, exposes the schema and reserves the full return time', () => {
    const input = act();
    expect(validSkillInput(input, ACT_INPUT_SCHEMA)).toBe(true);
    expect(actProblem(input)).toBeNull();
    expect(llmcInputProblem(MC_ACT_TOOL, input)).toBeNull();
    expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: null });
    expect(skillSchema(ACT_INPUT_SCHEMA)).toBe(true);
    const fields = ACT_INPUT_SCHEMA.properties.hands.items.properties;
    expect(fields.style.enum).toContain('shield_rush');
    expect(fields.area.properties.radius).toMatchObject({ minimum: 1, maximum: 16 });
    expect(fields.area.properties.maxDrop).toMatchObject({ type: 'integer', minimum: 0, maximum: 3 });
    expect(fields.shieldReserve).toMatchObject({ type: 'number', minimum: 0, maximum: 335 });
    expect(ACT_DESCRIPTION).toContain('SHIELD_LOW');
    expect(ACT_DESCRIPTION).toContain('全て必須');
    expect(SHORT_ACT_DESCRIPTION).toContain('json {"do":"attack","style":"shield_rush",...}');
    expect(SHORT_ACT_DESCRIPTION).not.toContain('attack #id style=shield_rush retreatTo=');
    expect(actMilliseconds(act({ seconds: 60 }))).toBeGreaterThan(60_000);
  });

  it.each([
    [{ seconds: 5, retreatHp: 1, shieldReserve: 0, area: { center: cell(0, 0, 0), radius: 1, maxDrop: 0 } }, 'lower bounds'],
    [{ seconds: 60, retreatHp: 19, shieldReserve: 335, area: { center: cell(0, 0, 0), radius: 16, maxDrop: 3 } }, 'upper bounds'],
    [{ seconds: 5.5, shieldReserve: 0.5, onCrossfire: 'continue', pickup: 'none',
      area: { center: cell(-1, 0, 1), radius: 1.5, maxDrop: 1 } }, 'numbers and other choices'],
    [{ target: '#' + Number.MAX_SAFE_INTEGER }, 'safe entity id'],
  ] as Array<[Record<string, unknown>, string]>)('accepts %s (%s)', change => {
    expect(handProblem(act(change).hands[0]!)).toBeNull();
    expect(llmcInputProblem(MC_ACT_TOOL, act(change))).toBeNull();
  });

  it.each(['target', 'seconds', 'retreatHp', 'retreatTo', 'area', 'shieldReserve', 'onCrossfire', 'pickup'])(
    'requires %s and refuses its omission without adding a default', key => {
      const hand = { ...rush };
      delete (hand as unknown as Record<string, unknown>)[key];
      const input: ActInput = { hands: [hand], accept: ['blaze'] };
      expect(handProblem(hand)).toContain(key + ' は');
      expect(actProblem(input)).toContain('が要る');
      expect(llmcInputProblem(MC_ACT_TOOL, input)).toContain(key + ' は');
      const prepared = llmcPrepare(MC_ACT_TOOL, input);
      expect(prepared.problem).toContain(key + ' は');
      expect(prepared.input).toEqual(input);
      expect(prepared.fixes).toEqual([]);
      expect((prepared.input as ActInput).hands[0]).not.toHaveProperty(key);
    },
  );

  const badFields: Array<[Record<string, unknown>, string]> = [
    [{ style: 'rush' }, 'style=shield_rush'],
    ...[undefined, null, 'blaze', 'minecraft:blaze', 123, '#-1', '#1.5', '#123 blaze', '#9007199254740992']
      .map(value => [{ target: value }, 'target は'] as [Record<string, unknown>, string]),
    ...[undefined, null, '1,2,3', [cell(1, 2, 3)], { x: 1, y: 2 }, cell(1, NaN, 3), { ...cell(1, 2, 3), other: 1 }]
      .map(value => [{ retreatTo: value }, 'retreatTo は {x,y,z}'] as [Record<string, unknown>, string]),
    ...[undefined, null, 0, 4.99, 60.01, NaN, Infinity, '20'].map(value => [{ seconds: value }, 'seconds は 5〜60'] as [Record<string, unknown>, string]),
    ...[undefined, null, 0, 20, 12.5, NaN, '12'].map(value => [{ retreatHp: value }, 'retreatHp は 1〜19 の整数'] as [Record<string, unknown>, string]),
    ...[undefined, null, -1, 336, Infinity, NaN, '36'].map(value => [{ shieldReserve: value }, 'shieldReserve は 0〜335'] as [Record<string, unknown>, string]),
    ...[undefined, null, 'ignore'].map(value => [{ onCrossfire: value }, 'onCrossfire は "retreat" か "continue"'] as [Record<string, unknown>, string]),
    ...[undefined, null, 'all'].map(value => [{ pickup: value }, 'pickup は "target_drops" か "none"'] as [Record<string, unknown>, string]),
    ...[undefined, null, [], '4,5,6,4,0', {}, { center: cell(4, 5, 6), radius: 4 },
      { center: { x: 4, y: 5 }, radius: 4, maxDrop: 0 }, { center: { ...cell(4, 5, 6), rel: true }, radius: 4, maxDrop: 0 },
      { center: cell(4, 5, 6), radius: 0.99, maxDrop: 0 }, { center: cell(4, 5, 6), radius: 16.01, maxDrop: 0 },
      { center: cell(4, 5, 6), radius: NaN, maxDrop: 0 }, { center: cell(4, 5, 6), radius: 4, maxDrop: -1 },
      { center: cell(4, 5, 6), radius: 4, maxDrop: 4 }, { center: cell(4, 5, 6), radius: 4, maxDrop: 0.5 },
      { center: cell(4, 5, 6), radius: 4, maxDrop: 0, extra: true }]
      .map(value => [{ area: value }, 'area は {center:{x,y,z},radius:1〜16,maxDrop:0〜3の整数}'] as [Record<string, unknown>, string]),
  ];
  it.each(badFields)('refuses %s with its form (%s)', (change, form) => {
    const input = act(change);
    expect(actProblem(input)).toContain(form);
    expect(llmcInputProblem(MC_ACT_TOOL, input)).toContain(form);
    expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: expect.stringContaining(form) });
  });

  it.each(['hold', 'untilDead', 'rel', 'to', 'at', 'range', 'canDig', 'canPlace', 'why', 'slot', 'extra'])(
    'refuses the extra field %s before normalization can hide it', key => {
      const input = act({ [key]: key === 'why' ? '攻撃' : true });
      expect(handProblem(input.hands[0]!)).toContain(key + ' は使えない');
      expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: expect.stringContaining(key + ' は使えない') });
    },
  );
  it('refuses rel even when false and an extra field even when undefined', () => {
    expect(actProblem(act({ rel: false }))).toContain('rel は使えない');
    expect(actProblem(act({ extra: undefined }))).toContain('extra は使えない');
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

  it('keeps rush-only fields out of ordinary attacks and preserves ordinary attack/hold/fight', () => {
    for (const key of ['retreatTo', 'retreatHp', 'area', 'shieldReserve', 'onCrossfire', 'pickup'] as const) {
      expect(handProblem({ do: 'attack', target: '#123', [key]: rush[key] })).toContain('style=shield_rush');
    }
    expect(handProblem({ do: 'fight', target: '#123', style: 'shield_rush' })).toContain('style は使えない');
    expect(actProblem({ hands: [{ do: 'attack', target: 'zombie', hold: true, seconds: 20, untilDead: false }] })).toBeNull();
    expect(actProblem({ hands: [{ do: 'attack', target: '#123', seconds: 31 }] })).toContain('30 まで');
    expect(actProblem({ hands: [{ do: 'fight', target: 'blaze', retreatHp: 12 }] })).toBeNull();
    expect(llmcPrepare(MC_ACT_TOOL, { hands: [{ do: 'attack', target: 123 }], accept: 'blaze' }).problem).toBeNull();
  });
});

describe('shield_rush uses the existing json line', () => {
  it('round trips all required fields without defaults', () => {
    const line = handToLine(rush);
    expect(line).toBe('json ' + JSON.stringify(rush));
    expect(lineToHand(line)).toEqual(rush);
    expect(shortToAct({ hands: [line], accept: ['blaze'] })).toEqual({ act: act(), errors: [] });
    expect(shortToAct(actToShort(act()))).toEqual({ act: act(), errors: [] });
  });
  it('keeps every common field and both crossfire/pickup choices', () => {
    const hand: ActHand = { ...rush, onCrossfire: 'continue', pickup: 'none', note: 'ブレイズ1体', dependsOn: [1], onFail: 'stop' };
    expect(handToLine(hand)).toMatch(/^json /u);
    expect(lineToHand(handToLine(hand))).toEqual(hand);
    expect(actProblem({ hands: [{ do: 'eat' }, hand], accept: ['blaze'] })).toBeNull();
  });
  it('preserves incomplete JSON for refusal and directs old syntax to JSON', () => {
    const incomplete: ActHand = { do: 'attack', target: '#123', style: 'shield_rush' };
    expect(lineToHand(handToLine(incomplete))).toEqual(incomplete);
    const input = expandShortAct({ hands: [handToLine(incomplete)], accept: ['blaze'] });
    expect(input.errors).toEqual([]);
    expect(llmcInputProblem(MC_ACT_TOOL, input.input)).toContain('seconds は');
    expect(lineToHand('attack #123 style=shield_rush retreatTo=1,2,3')).toMatchObject({ error: expect.stringContaining('json {') });
    expect(lineToHand('json {')).toHaveProperty('error');
    const ordinary: ActHand = { do: 'attack', target: '#123', hold: true, seconds: 20, untilDead: false };
    expect(handToLine(ordinary)).toBe('attack #123 hold seconds=20 untilDead=false');
    expect(lineToHand(handToLine(ordinary))).toEqual(ordinary);
  });
});

const CODES: Record<RushCode, string> = {
  TARGET_LOST: '相手を見失った', HEIGHT_UNREACHABLE: '高さの差で届かなかった', NO_ATTACK_WINDOW: '打てる機会が無かった',
  CROSSFIRE: '複数方向から射撃を受けた', SHIELD_LOW: '盾の耐久の残りが下限以下になった', RETREAT_BLOCKED: '退避先へ戻れなかった',
  PICKUP_UNSAFE: '安全に拾えなかった', TIME_LIMIT: '秒数の上限に達した', REFLEX: '体の反射が手を止めた', DEAD: '死んだ',
};

describe('shield_rush results are facts, never a next action', () => {
  it.each(['killed', 'retreated', 'failed', 'cut'] as ShieldRushResult['status'][])('reads shieldRush.status=%s and measurements', status => {
    const line = row({ status, code: null });
    const words = shieldRushWords(line);
    expect(words).toHaveLength(2);
    expect(words[0]).toContain('shield_rush #123: ' + status);
    for (const fact of ['盾 120→34', '体力最低 9.5', '終了体力 12', '3 回打った', 'ロッド増減 +0', '経過 15000 ms', '終了地点 (1,2,3)', '終了地点は安全']) {
      expect(words[1]).toContain(fact);
    }
    expect(handFacts(line)).toEqual(words.map(word => '  事実: ' + word));
    expect(words.join('\n')).not.toMatch(/退く|2枚目|出し直|作る|次の/u);
    const parsed = read(line);
    expect(parsed.lines[0]!.shieldRush).toEqual(line.shieldRush);
    const text = actResultText(parsed);
    expect(text).toContain('shield_rush #123: ' + status);
    expect(text.match(/shield_rush/g)).toHaveLength(1);
    expect(llmcStoredResult(MC_ACT_TOOL, text).stored).toContain(words[1]);
  });
  it.each(Object.entries(CODES) as Array<[RushCode, string]>)('reads shieldRush.code=%s as its fact', (code, fact) => {
    const line = row({ status: code === 'REFLEX' || code === 'TIME_LIMIT' ? 'cut' : code === 'DEAD' ? 'failed' : 'retreated', code },
      { code: 'unrelated' });
    expect(shieldRushWords(line)[0]).toContain('（' + code + '） ' + fact);
    expect(actResultText(read(line))).toContain(fact);
    expect(typedFailureOf(line, frame())).toBeNull();
  });
  it('keeps retreatHp returns retreated with code null, without inferring a kill', () => {
    const line = row({ code: null });
    expect(read(line).lines[0]!.shieldRush).toEqual(line.shieldRush);
    expect(shieldRushWords(line)[0]).toContain('retreated・相手の死は観測していない');
    expect(shieldRushWords(line)[0]).not.toContain('SHIELD_LOW');
    expect(progressEvents([rush], read(line).lines)).toEqual([]);
  });
  it('has ten closed codes, reports targetDead, and ignores line.code/progress without shieldRush', () => {
    expect(Object.keys(SHIELD_RUSH_CODE_WORDS).sort()).toEqual(Object.keys(CODES).sort());
    expect(shieldRushWords(row({ targetDead: true, status: 'cut', code: null }))[0]).toContain('相手の死を観測した');
    expect(shieldRushWords(row({ targetDead: null, code: 'TARGET_LOST' }))[0]).toContain('相手の生死は不明');
    expect(shieldRushWords(row({}, { shieldRush: undefined, code: 'SHIELD_LOW', line: 'shield_rush #123',
      progress: { unit: 'blow', done: 3, left: null } }))).toEqual([]);
    expect(shieldRushWords({ i: 1, do: 'attack', status: 'done', line: '#123 を打った' })).toEqual([]);
  });
  it('keeps zero measurements and unconfirmed safety as facts without inventing pickup or arrival', () => {
    const line = row({ hits: 0, rodsDelta: -1, hpMin: 0, hpEnd: 0, shieldBefore: 0, shieldAfter: 0, elapsedMs: 0, safe: false });
    expect(shieldRushWords(line)[1]).toContain('盾 0→0・体力最低 0・終了体力 0・0 回打った・ロッド増減 -1・経過 0 ms・終了地点 (1,2,3)・終了地点の安全は未確認');
    expect(shieldRushWords(line).join('\n')).not.toMatch(/拾った|退避先に着いた/u);
    expect(shieldRushWords(row({ hits: NaN, hpMin: Infinity }))[1]).not.toMatch(/回打った|体力最低/u);
  });
  it('adds one fact line for pendingDrops, including urgent and stored result paths', () => {
    const line = row({ pendingDrops: [{ id: 41, at: cell(4, 5, 6) }, { id: 42, at: cell(7, 8, 9) }] });
    expect(shieldRushWords(line)).toHaveLength(3);
    expect(shieldRushWords(line)[2]).toBe('拾い残し 2 個');
    expect(handFacts(line)).toContain('  事実: 拾い残し 2 個');
    const parsed = read(line);
    expect(parsed.lines[0]!.shieldRush?.pendingDrops).toEqual(line.shieldRush!.pendingDrops);
    expect(llmcStoredResult(MC_ACT_TOOL, actResultText(parsed)).stored).toContain('拾い残し 2 個');
    const events = createLlmcEvents('rush');
    events.noteFailures(JSON.stringify(result([line])), frame(), act());
    expect(events.failureFacts(frame())).toEqual(shieldRushWords(line));
    events.noteFailures(JSON.stringify(result([{ i: 1, do: 'eat', status: 'done', line: '食べた' }])), frame(), { hands: [{ do: 'eat' }] });
    expect(events.failureFacts(frame())).toEqual([]);
    expect(shieldRushWords(row()).join('\n')).not.toContain('拾い残し');
  });
});

describe('shield_rush progress', () => {
  it.each([
    ['done', 'done', 'finished'], ['stopped', 'failed', 'finished'], ['failed', 'failed', 'finished'], ['skipped', 'not_started', 'not_run'],
  ] as const)('keeps the existing line.status=%s axes independent of shieldRush.status', (status, goal, end) => {
    const parsed = read(row({ status: 'cut', code: null }, { status }));
    expect(parsed.lines[0]).toMatchObject({ status, goal, end, shieldRush: { status: 'cut' } });
    expect(actOutcomeOf(parsed)).toMatchObject({ goal, end });
  });
  it('fills ordinary cut axes from stoppedBy and preserves explicit body axes', () => {
    const parsed = readActResult(JSON.stringify({ ...result([row({ code: null })]), stoppedBy: 'deadline' }))!;
    expect(parsed.lines[0]).toMatchObject({ status: 'stopped', goal: 'partial', end: 'cut', cutBy: 'deadline' });
    expect(actOutcomeOf(parsed)).toMatchObject({ goal: 'partial', end: 'cut' });
    expect(read(row({}, { goal: 'unknown', end: 'unknown' })).lines[0]).toMatchObject({ goal: 'unknown', end: 'unknown' });
  });
  it.each([
    ['killed', false, ['kill']], ['killed', null, ['kill']], ['retreated', true, ['kill']], ['failed', true, ['kill']],
    ['cut', true, ['kill']], ['retreated', false, []], ['failed', null, []], ['cut', false, []],
  ] as Array<[ShieldRushResult['status'], boolean | null, string[]]>)('counts status=%s targetDead=%s from shieldRush', (status, targetDead, expected) => {
    const parsed = read(row({ status, targetDead }, { goal: 'partial', end: 'cut' }));
    expect(progressEvents([rush], parsed.lines)).toEqual(expected);
    expect(progressEvents([], parsed.lines)).toEqual(expected);
  });
  it('counts once at the hand index, while unknown/not-run earns none and done alone proves no rush kill', () => {
    const killed = row({ status: 'cut', targetDead: true }, { i: 2, goal: 'partial', end: 'cut' });
    expect(progressEvents([{ do: 'eat' }, rush], [killed])).toEqual(['kill']);
    for (const end of ['unknown', 'not_run'] as const) expect(progressEvents([rush], [row({ status: 'killed' }, { end })])).toEqual([]);
    for (const goal of ['unknown', 'not_started'] as const) expect(progressEvents([rush], [row({ targetDead: true }, { goal })])).toEqual([]);
    expect(progressEvents([rush], [row({}, { status: 'done', goal: 'done', end: 'finished', shieldRush: undefined })])).toEqual([]);
    expect(progressEvents([rush], [row({ targetDead: false }, { status: 'done', goal: 'done', end: 'finished' })])).toEqual([]);
    expect(progressEvents([{ do: 'attack', target: 'enderman' }], [{ i: 1, do: 'attack', status: 'done', goal: 'done', end: 'finished', line: '' }])).toEqual(['kill']);
  });
  it.each(['killed', 'cut'] as const)('a confirmed kill with rush status=%s resets the node stall window', status => {
    const snapshot = { node: 'p9', state: 'doing', milestone: 'ブレイズロッド', items: 4, inventory: {}, purpose: {} };
    noteProgress('rush', snapshot, 0);
    expect(noteRan('rush', { hands: [rush], result: JSON.stringify(result([row({ status, targetDead: true, code: null })])), activeMs: 100000 })).toBeNull();
    expect(noteProgress('rush', snapshot, 219000)).toBeNull();
    expect(noteProgress('rush', snapshot, 220000)).toMatchObject({ kind: 'node_stalled' });
  });
});

describe('shield_rush uses the existing blaze deadly gate', () => {
  const live = { threats: ['#123 blaze 30.0m (4,2,6)'] };
  const ready: Array<[string, number]> = [['shield', 1], ['cooked_beef', 20], ['iron_sword', 1], ['iron_pickaxe', 1]];
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
    expect(deadlyGateHold(act(), frame(ready, { threats: ['#123 blaze 9.5m (4,2,6)'] }))).toBeNull();
    expect(deadlyGateHold(act(), frame([], { threats: ['#123 blaze 9.5m (4,2,6)'] }))?.line).toContain('ツルハシ 0');
    expect(deadlyGateHold(act(), frame([], { threats: ['#123 zombie 30.0m (4,2,6)'] }))).toBeNull();
  });
});
