import { afterEach, describe, expect, it } from 'vitest';
import {
  ACT_DESCRIPTION, ACT_INPUT_SCHEMA, actExpectedMilliseconds, actMilliseconds, actProblem, MC_ACT_TOOL, readActResult,
  type ActHand, type ActHandLine, type ActInput, type ActResult, type FillCode, type FillResult,
} from '../src/contracts/minecraftActContract.js';
import { handFieldNames, handProblem } from '../src/contracts/minecraftActHandRules.js';
import { actToShort, expandShortAct, handToLine, lineToHand, SHORT_ACT_DESCRIPTION, shortToAct } from '../src/contracts/minecraftActShortContract.js';
import { fillProblem } from '../src/contracts/minecraftFillContract.js';
import { skillSchema, validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { actResultText, llmcInputProblem, llmcPrepare, llmcStoredResult } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { createLlmcEvents, tasks } from '../src/surfaces/minecraft/minecraftLlmcEvents.js';
import { FILL_CODE_WORDS, fillWords, handFacts } from '../src/surfaces/minecraft/minecraftLlmcResultWords.js';

const cell = (x = 0, y = 0, z = 0) => ({ x, y, z });
const hand: ActHand = { do: 'fill', groups: [{ stand: cell(), at: [cell(1, 1, 0)] }],
  block: 'cobblestone', retreatHp: 10, retreatTo: cell(), seconds: 30 };
const act = (change: Record<string, unknown> = {}): ActInput => ({ hands: [{ ...hand, ...change } as ActHand] });
const row = (fillChange: Partial<FillResult> = {}, change: Partial<ActHandLine> = {}): ActHandLine => ({
  i: 1, do: 'fill', status: 'stopped', line: 'まとめて置いた',
  fill: { status: 'partial', code: 'TIME_LIMIT', placed: 14, remaining: Array.from({ length: 6 }, (_, x) => cell(x, 1, 1)),
    skippedBy: { creature: 4, reach: 2, hazard: 3, other: 1 }, hpMin: 11, hpEnd: 12, elapsedMs: 15000,
    at: cell(), safe: true, ...fillChange }, ...change,
});
const result = (lines: ActHandLine[]): ActResult => ({ v: 1, ok: lines.every(line => line.status === 'done'),
  done: lines.filter(line => line.status === 'done').length, of: lines.length,
  at: cell(), hp: 12, food: 20, ms: 15000, lines });
const read = (line: ActHandLine): ActResult => readActResult(JSON.stringify(result([line])))!;

afterEach(() => tasks.clear());

describe('fill input contract', () => {
  it('adds only groups as the final hand field, and exposes the required shape', () => {
    const input = act();
    expect(skillSchema(ACT_INPUT_SCHEMA)).toBe(true);
    expect(validSkillInput(input, ACT_INPUT_SCHEMA)).toBe(true);
    expect(actProblem(input)).toBeNull();
    expect(llmcInputProblem(MC_ACT_TOOL, input)).toBeNull();
    expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: null });
    const fields = ACT_INPUT_SCHEMA.properties.hands.items.properties;
    expect(Object.keys(fields)).toHaveLength(57);
    expect(fields.do.enum).toContain('fill');
    expect(fields.groups).toMatchObject({ minItems: 1, maxItems: 12 });
    expect(fields.groups.items).toMatchObject({ additionalProperties: false, required: ['stand', 'at'] });
    expect(fields.groups.items.properties.at).toMatchObject({ minItems: 1, maxItems: 8 });
    expect(fields.groups.items.properties.stand.required).toEqual(['x', 'y', 'z']);
    expect(fields.groups.items.properties.at.items.additionalProperties).toBe(false);
    expect(JSON.stringify(ACT_INPUT_SCHEMA).length).toBeLessThan(16_000);
    expect(ACT_DESCRIPTION).toContain('全て必須');
    expect(ACT_DESCRIPTION).toContain('safe:false');
    expect(SHORT_ACT_DESCRIPTION).toContain('json {"do":"fill",...}');
    expect(handFieldNames('fill')).toEqual(['groups', 'block', 'retreatHp', 'retreatTo', 'seconds', 'note', 'onFail', 'dependsOn']);
  });

  it.each(['groups', 'block', 'retreatHp', 'retreatTo', 'seconds'] as const)('requires %s with its form, without defaulting it', key => {
    const incomplete = { ...hand };
    delete incomplete[key];
    const input: ActInput = { hands: [incomplete] };
    expect(handProblem(incomplete)).toContain(key + ' は');
    expect(actProblem(input)).toContain('が要る');
    expect(llmcInputProblem(MC_ACT_TOOL, input)).toContain(key + ' は');
    expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: expect.stringContaining(key + ' は') });
    expect(lineToHand(handToLine(incomplete))).toEqual(incomplete);
  });

  it.each([
    { seconds: 5, retreatHp: 1 }, { seconds: 60, retreatHp: 19 }, { seconds: 5.5 },
  ])('accepts boundary values %s and reserves the full return time', change => {
    const input = act(change);
    expect(actProblem(input)).toBeNull();
    expect(llmcInputProblem(MC_ACT_TOOL, input)).toBeNull();
    expect(actMilliseconds(input)).toBe(input.hands[0]!.seconds! * 1000 + 2000);
    expect(actExpectedMilliseconds(input)).toBeLessThanOrEqual(input.hands[0]!.seconds! * 1000);
  });

  const invalid: Array<[Record<string, unknown>, string]> = [
    ...[undefined, null, '', 'Cobblestone', 'minecraft:cobblestone', 'a'.repeat(41), 1]
      .map(block => [{ block }, 'block は'] as [Record<string, unknown>, string]),
    ...[undefined, null, 0, 20, 10.5, NaN, Infinity, '10']
      .map(retreatHp => [{ retreatHp }, 'retreatHp は 1〜19 の整数'] as [Record<string, unknown>, string]),
    ...[undefined, null, 4.99, 60.01, NaN, Infinity, '30']
      .map(seconds => [{ seconds }, 'seconds は 5〜60'] as [Record<string, unknown>, string]),
    ...[undefined, null, [], '0,0,0', { x: 0, y: 0 }, cell(NaN), cell(0, Infinity), { ...cell(), rel: true }]
      .map(retreatTo => [{ retreatTo }, 'retreatTo は {x,y,z}'] as [Record<string, unknown>, string]),
    ...[undefined, null, {}, [], Array(13).fill(hand.groups![0]), [null], [[]], [{}],
      [{ stand: cell() }], [{ at: [cell()] }], [{ stand: cell(), at: [] }], [{ stand: cell(), at: Array(9).fill(cell()) }],
      [{ stand: [cell()], at: [cell()] }], [{ stand: cell(Infinity), at: [cell()] }], [{ stand: { x: 0, z: 0 }, at: [cell()] }],
      [{ stand: cell(), at: cell() }], [{ stand: cell(), at: [null] }], [{ stand: cell(), at: [cell(NaN)] }],
      [{ stand: cell(), at: [{ x: '1', y: 0, z: 0 }] }], [{ stand: cell(), at: [{ ...cell(), rel: true }] }],
      [{ stand: cell(), at: [cell()], extra: true }]]
      .map(groups => [{ groups }, 'groups は [{stand:{x,y,z},at:[{x,y,z},…]}]'] as [Record<string, unknown>, string]),
  ];
  it.each(invalid)('refuses %s and shows the form (%s) before the broad schema', (change, form) => {
    const input = act(change);
    expect(handProblem(input.hands[0]!)).toContain(form);
    expect(actProblem(input)).toContain(form);
    expect(llmcInputProblem(MC_ACT_TOOL, input)).toContain(form);
    expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: expect.stringContaining(form) });
  });

  it('takes all 12 groups of 8 through the nested schema, with the time estimate bounded by seconds', () => {
    const input = act({ seconds: 5, groups: Array.from({ length: 12 }, () => ({ stand: cell(),
      at: Array.from({ length: 8 }, (_, x) => cell(x, 1, 1)) })) });
    expect(validSkillInput(input, ACT_INPUT_SCHEMA)).toBe(true);
    expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: null });
    expect(actMilliseconds(input)).toBe(7000);
    expect(actExpectedMilliseconds(input)).toBe(5000);
    expect(shortToAct(actToShort(input))).toEqual({ act: input, errors: [] });
  });

  it.each(['rel', 'at', 'to', 'target', 'style', 'count', 'face', 'range', 'canDig', 'canPlace', 'why', 'slot', 'extra'])(
    'refuses the unused field %s before normalization can hide it', key => {
      const input = act({ [key]: key === 'why' ? '置く' : true });
      expect(actProblem(input)).toContain(key + ' は使えない');
      expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: expect.stringContaining(key + ' は使えない') });
    },
  );
  it('refuses even rel:false and undefined extra fields, and keeps note/onFail/dependsOn available', () => {
    expect(llmcInputProblem(MC_ACT_TOOL, act({ rel: false }))).toContain('rel は使えない');
    expect(handProblem(act({ extra: undefined }).hands[0]!)).toContain('extra は使えない');
    expect(actProblem(act({ note: 'まとめて置く', onFail: 'stop', dependsOn: [] }))).toBeNull();
    expect(actProblem(act({ dependsOn: [1] }))).not.toBeNull();
    expect(llmcInputProblem(MC_ACT_TOOL, act({ onFail: 'retry' }))).not.toBeNull();
    expect(actProblem({ ...act(), repeat: 2 })).toContain('絶対座標');
    expect(actProblem({ hands: [{ do: 'place', block: 'cobblestone', at: [cell(1, 1, 0)] }] })).toBeNull();
    expect(fillProblem({ ...hand })).toBeNull();
  });

  it('refuses style=shield_rush on fill without asking for the attack audience', () => {
    const input = act({ style: 'shield_rush' });
    expect(actProblem(input)).toContain('style は使えない');
    expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: expect.stringContaining('style は使えない') });
    expect(input).not.toHaveProperty('accept');
  });

  it('does not assume a fill return succeeded when estimating a following walk', () => {
    const go: ActHand = { do: 'walk', to: cell(1) };
    expect(actMilliseconds({ hands: [hand, go] }, cell(100))).toBe(actMilliseconds(act()) + actMilliseconds({ hands: [go] }));
  });

  it('keeps input depth bounded even after allowing nested fill coordinates', () => {
    let value: unknown = 'leaf';
    let schema: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth < 9; depth++) {
      value = { child: value };
      schema = { type: 'object', additionalProperties: false, required: ['child'], properties: { child: schema } };
    }
    expect(skillSchema(schema)).toBe(false);
    expect(validSkillInput(value, schema)).toBe(false);
  });
});

describe('fill uses one existing json short line', () => {
  it('round trips every group, permission and common field without defaults', () => {
    const complete: ActHand = { ...hand, groups: [{ stand: cell(), at: [cell(1), cell(1, 1)] },
      { stand: cell(-1), at: [cell(-1, 1)] }], note: 'まとめて置く', onFail: 'continue', dependsOn: [1] };
    const line = handToLine(complete);
    expect(line).toBe('json ' + JSON.stringify(complete));
    expect(lineToHand(line)).toEqual(complete);
    const input: ActInput = { hands: [{ do: 'eat' }, complete] };
    expect(shortToAct(actToShort(input))).toEqual({ act: input, errors: [] });
    const expanded = expandShortAct({ hands: ['eat', line] });
    expect(expanded.errors).toEqual([]);
    expect(llmcPrepare(MC_ACT_TOOL, expanded.input)).toEqual({ input, fixes: [], problem: null });
  });
  it('directs a non-JSON fill to the required form', () => {
    expect(lineToHand('fill cobblestone')).toMatchObject({ error: expect.stringContaining('json {"do":"fill",...}') });
  });
});

const CODES: Record<FillCode, string> = {
  HP_FLOOR: '体力が下限以下になった', TIME_LIMIT: '秒数の上限に達した', NO_STAND: '立つ足場が無かった',
  NO_BLOCKS: '置くブロックが足りなかった', RETREAT_BLOCKED: '退避先へ戻れなかった', REFLEX: '体の反射が手を止めた', DEAD: '死んだ',
};

describe('fill results are facts, never a next action', () => {
  it.each(['done', 'partial', 'retreated', 'failed', 'cut'] as FillResult['status'][])('reads fill.status=%s and all measurements', status => {
    const line = row({ status, code: null });
    const words = fillWords(line);
    expect(words).toHaveLength(2);
    expect(words[0]).toBe('fill: ' + status);
    for (const fact of ['置いた 14', '残り 6', '生き物に邪魔された 4', '届かない 2', '危険で飛ばした 3', 'その他 1',
      '体力最低 11', '終了体力 12', '経過 15000 ms', '終了地点 (0,0,0)', '退避先に着き、射手に見られていない']) expect(words[1]).toContain(fact);
    expect(handFacts(line)).toEqual(words.map(word => '  事実: ' + word));
    const parsed = read(line);
    expect(parsed.lines[0]!.fill).toEqual(line.fill);
    const text = actResultText(parsed);
    expect(text).toContain('fill: ' + status);
    expect(text.match(/fill:/gu)).toHaveLength(1);
    expect(llmcStoredResult(MC_ACT_TOOL, text).stored).toContain(words[1]);
    expect(words.join('\n')).not.toMatch(/置け|戻れ(?:[。！!]|$)|べき|次の手|出し直/u);
  });

  it.each(Object.entries(CODES) as Array<[FillCode, string]>)('reads fill.code=%s from the structured result (%s)', (code, fact) => {
    const line = row({ code }, { code: 'unrelated', line: '置け。戻れ。', progress: { unit: 'block', done: 99, left: 0 } });
    const words = fillWords(line);
    expect(words[0]).toContain('（' + code + '） ' + fact);
    expect(words.join('\n')).not.toMatch(/unrelated|99|置け。|戻れ。/u);
    expect(actResultText(read(line))).toContain(fact);
    expect(actResultText(read(line))).not.toContain('置け。戻れ。');
    expect(read(line).lines[0]!.fill?.code).toBe(code);
  });

  it('has exactly the seven codes and ignores status/code/progress without line.fill', () => {
    expect(Object.keys(FILL_CODE_WORDS).sort()).toEqual(Object.keys(CODES).sort());
    expect(fillWords(row({}, { fill: undefined, code: 'HP_FLOOR', progress: { unit: 'block', done: 1, left: 0 } }))).toEqual([]);
    expect(fillWords(row({}, { do: 'place' }))).toEqual([]);
  });

  it('keeps zero measurements and safe:false as facts, without inferring a return or completion', () => {
    const line = row({ status: 'done', code: null, placed: 0, remaining: [], skippedBy: { creature: 0, reach: 0, hazard: 0, other: 0 },
      hpMin: 0, hpEnd: 0, elapsedMs: 0, safe: false });
    const words = fillWords(line).join('\n');
    for (const fact of ['置いた 0', '残り 0', '生き物に邪魔された 0', '届かない 0', '危険で飛ばした 0', 'その他 0',
      '体力最低 0', '終了体力 0', '経過 0 ms', '退避先への到着と射手の視線は未確認']) expect(words).toContain(fact);
    expect(words).not.toMatch(/終了地点は安全|帰還した|退避先に着いた|全て置いた/u);
    expect(fillWords(row({ placed: NaN, hpMin: Infinity, at: cell(NaN) })).join('\n')).not.toMatch(/置いた|体力最低|終了地点 \(/u);
    const remaining = Array.from({ length: 40 }, (_, x) => cell(x, 1));
    expect(read(row({ remaining })).lines[0]!.fill?.remaining).toEqual(remaining);
    expect(fillWords(row({ remaining }))[1]).toContain('残り 40');
  });

  it('keeps each skippedBy counter independent; it is not subtracted from placed or remaining', () => {
    for (const [key, label] of [['creature', '生き物に邪魔された'], ['reach', '届かない'], ['hazard', '危険で飛ばした'], ['other', 'その他']] as const) {
      const words = fillWords(row({ skippedBy: { creature: 0, reach: 0, hazard: 0, other: 0, [key]: 9 } }))[1]!;
      expect(words).toContain(label + ' 9');
      expect(words).toContain('置いた 14・残り 6');
    }
  });

  it.each([
    { reached: true, seen: 2, fact: '退避先に着いたが射線が通っている（2 体）' },
    { reached: false, seen: 2, fact: '退避先に着いていない・見ている射手 2 体' },
    { reached: false, seen: 0, fact: '退避先に着いていない・見ている射手 0 体' },
    { reached: true, seen: 0, fact: '退避先に着いた・見ている射手 0 体' },
  ])('separates arrival and visibility: reached=$reached seen=$seen', ({ reached, seen, fact }) => {
    const line = row({ reached, seen, safe: false });
    expect(fillWords(line).join('\n')).toContain(fact);
    const parsed = read(line);
    expect(parsed.lines[0]!.fill).toMatchObject({ reached, seen, safe: false });
    const text = actResultText(parsed);
    expect(text).toContain(fact);
    expect(llmcStoredResult(MC_ACT_TOOL, text).stored).toContain(fact);
    const events = createLlmcEvents('fill-return');
    events.noteFailures(JSON.stringify(result([line])), null, act());
    expect(events.failureFacts(null).join('\n')).toContain(fact);
    expect(text).not.toContain('終了地点は安全');
  });

  it('reads safe as arrival without a shooter, and preserves absent or invalid optional measurements', () => {
    expect(fillWords(row({ reached: true, seen: 0, safe: true })).join('\n'))
      .toContain('退避先に着き、射手に見られていない・見ている射手 0 体');
    expect(read(row()).lines[0]!.fill).not.toHaveProperty('reached');
    expect(read(row()).lines[0]!.fill).not.toHaveProperty('seen');
    for (const seen of [undefined, -1, 0.5, NaN, Infinity]) {
      expect(fillWords(row({ seen, safe: false })).join('\n')).toContain('退避先への到着と射手の視線は未確認');
    }
    const visible = fillWords(row({ seen: 2, safe: false })).join('\n');
    expect(visible).toContain('見ている射手 2 体');
    expect(visible).not.toContain('着いた');
  });

  it('preserves the existing line axes independently of fill.status', () => {
    const parsed = read(row({ status: 'cut', code: 'REFLEX' }, { status: 'done', goal: 'already', end: 'finished' }));
    expect(parsed.lines[0]).toMatchObject({ status: 'done', goal: 'already', end: 'finished', fill: { status: 'cut', code: 'REFLEX' } });
  });

  it('also exposes facts for urgent/compressed input, then clears them at the next receipt', () => {
    const line = row({ safe: false });
    const events = createLlmcEvents('fill-contract');
    events.noteFailures(JSON.stringify(result([line])), null, act());
    expect(events.failureFacts(null)).toEqual(fillWords(line));
    events.noteFailures(JSON.stringify(result([{ i: 1, do: 'eat', status: 'done', line: '食べた' }])), null, { hands: [{ do: 'eat' }] });
    expect(events.failureFacts(null)).toEqual([]);
  });
});
