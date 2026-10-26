import { describe, expect, it } from 'vitest';
import {
  ACT_INPUT_SCHEMA, ACT_MAX_MS, actExpectedMilliseconds, actMilliseconds, actProblem, actRemainingMilliseconds, type ActInput,
} from '../src/contracts/minecraftActContract.js';
import {
  actToShort, expandShortAct, replaceOnly, SHORT_ACT_DESCRIPTION, SHORT_ACT_INPUT_SCHEMA, shortHandProblem, shortToAct,
} from '../src/contracts/minecraftActShortContract.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';

/** The task queue's fields of `mc.act` (design 2026-10-26): repeat, done, pre, replace; their time, their refusals and their short form. */
const cell = (x: number, y: number, z: number) => ({ x, y, z });
const tunnel: ActInput = { hands: [{ do: 'dig', at: [cell(1, 0, 0), cell(1, 1, 0)], rel: true, collect: false }, { do: 'walk', to: cell(1, 0, 0), rel: true }] };
const schema = ACT_INPUT_SCHEMA as unknown as Readonly<Record<string, unknown>>;

describe('the head\'s act schema takes the new fields', () => {
  it('accepts repeat, done, pre and replace, and nothing wider', () => {
    const done = [[{ k: 'have', item: 'log', n: 10 }]];
    expect(validSkillInput({ ...tunnel, repeat: 8, done, pre: [[{ k: 'near', block: 'furnace', r: 4 }]], replace: ['q15'] }, schema)).toBe(true);
    expect(validSkillInput({ ...tunnel, repeat: 1 }, schema)).toBe(false);
    expect(validSkillInput({ ...tunnel, repeat: 9 }, schema)).toBe(false);
    expect(validSkillInput({ ...tunnel, repeat: 2.5 }, schema)).toBe(false);
    expect(validSkillInput({ ...tunnel, done: [] }, schema)).toBe(false);
    expect(validSkillInput({ ...tunnel, done: [[]] }, schema)).toBe(false);
    expect(validSkillInput({ ...tunnel, replace: ['q1', 'q2', 'q3', 'q4'] }, schema)).toBe(false);
    expect(validSkillInput({ ...tunnel, extra: 1 }, schema)).toBe(false);
  });
});

describe('actProblem for the queue fields', () => {
  it('lets a relative or coordinate-less repeated hand through', () => {
    expect(actProblem({ ...tunnel, repeat: 8 })).toBeNull();
    expect(actProblem({ hands: [{ do: 'attack', target: 'cow' }, { do: 'pickup' }, { do: 'wait', seconds: 1 }, { do: 'eat' }, { do: 'craft', item: 'stick' }], repeat: 4 })).toBeNull();
    expect(actProblem({ ...tunnel, done: [[{ k: 'hp', n: 10 }]], pre: [[{ k: 'dim', dim: 'overworld' }]], replace: ['all'] })).toBeNull();
  });
  it('refuses a repeated hand with absolute cells, naming the hand and the fix', () => {
    const problem = actProblem({ hands: [{ do: 'jump' }, { do: 'dig', at: [cell(5, 40, 5)] }], repeat: 3 });
    expect(problem).toMatch(/^手2（dig）: repeat の手は rel:true で書く/u);
    expect(actProblem({ hands: [{ do: 'walk', path: [cell(1, 2, 3)] }], repeat: 2 })).toContain('rel:true');
    expect(actProblem({ hands: [{ do: 'walk', to: cell(1, 2, 3) }], repeat: 2 })).toContain('rel:true');
    expect(actProblem({ hands: [{ do: 'dig', at: [cell(5, 40, 5)] }] })).toBeNull();
  });
  it('refuses a repeat out of 2–8, a done or pre that is not a condition, a replace that names no item', () => {
    expect(actProblem({ ...tunnel, repeat: 1 })).toContain('repeat は 2〜8');
    expect(actProblem({ ...tunnel, repeat: 9 })).toContain('repeat は 2〜8');
    expect(actProblem({ ...tunnel, done: [[{ k: 'hp', n: 99 }]] })).toBe('done が条件の形ではない');
    expect(actProblem({ ...tunnel, pre: [] as never })).toBe('pre が条件の形ではない');
    expect(actProblem({ ...tunnel, replace: ['q15', 'later'] })).toBe('replace は列の項目（q15）か all');
  });
});

describe('the time of a repeated act', () => {
  const from = cell(0, 64, 0);
  it('multiplies the hands\' time by the passes, the ceiling within the bound, the expected time not capped', () => {
    const once = actMilliseconds(tunnel, from), twelve = actMilliseconds({ ...tunnel, repeat: 8 }, from);
    expect(twelve).toBeGreaterThan(once);
    expect(actMilliseconds({ ...tunnel, repeat: 8 }, from)).toBeLessThanOrEqual(ACT_MAX_MS);
    const long: ActInput = { hands: [{ do: 'wait', seconds: 30 }], repeat: 8 };
    expect(actMilliseconds(long)).toBe(ACT_MAX_MS);
    expect(actExpectedMilliseconds(long)).toBe(240_000);
    expect(Math.abs(actExpectedMilliseconds({ ...tunnel, repeat: 4 }, from) - 4 * actExpectedMilliseconds(tunnel, from))).toBeLessThanOrEqual(4);
  });
  it('is the old time with no repeat', () => {
    expect(actExpectedMilliseconds({ hands: [{ do: 'wait', seconds: 3 }, { do: 'eat' }] })).toBe(3_000 + 1_700);
    expect(actMilliseconds({ hands: [{ do: 'wait', seconds: 3 }] })).toBe(5_000);
  });
  it('says what is left from the body\'s progress, or from the time that has run', () => {
    const act: ActInput = { hands: [{ do: 'wait', seconds: 2 }, { do: 'wait', seconds: 3 }, { do: 'wait', seconds: 5 }], repeat: 4 };
    // 10 s a pass. At hand 2 of pass 1: hands 2 and 3 (8 s) and three more passes.
    expect(actRemainingMilliseconds(act, null, { hand: 2, iteration: 1 }, 0)).toBe(8_000 + 30_000);
    expect(actRemainingMilliseconds(act, null, { hand: 3, iteration: 4 }, 0)).toBe(5_000);
    expect(actRemainingMilliseconds(act, null, { hand: 1, iteration: 1 }, 0)).toBe(40_000);
    expect(actRemainingMilliseconds(act, null, null, 15_000)).toBe(25_000);
    expect(actRemainingMilliseconds(act, null, null, 100_000)).toBe(0);
    expect(actRemainingMilliseconds({ hands: [{ do: 'wait', seconds: 2 }] }, null, { hand: 1, iteration: 1 }, 0)).toBe(2_000);
  });
});

describe('the model\'s short form of the queue fields', () => {
  it('reads pre and done into the body\'s JSON, repeat and replace as they are', () => {
    const { input, errors } = expandShortAct({ hands: ['dig 1,0,0 rel collect=false', 'walk 1,0,0 rel'], pre: 'have:iron_pickaxe&near:furnace~5', done: 'at:26,51,7~2|have:log>=10',
      repeat: 8, replace: ['q15'], why: '[p7] 鉄へ' });
    expect(errors).toEqual([]);
    expect(input).toMatchObject({ pre: [[{ k: 'have', item: 'iron_pickaxe', n: 1 }, { k: 'near', block: 'furnace', r: 5 }]],
      done: [[{ k: 'at', x: 26, y: 51, z: 7, r: 2 }], [{ k: 'have', item: 'log', n: 10 }]], repeat: 8, replace: ['q15'], why: '[p7] 鉄へ' });
    expect(actProblem(input as ActInput)).toBeNull();
  });
  it('round-trips the old fields as before and the new ones through text', () => {
    const act: ActInput = { ...tunnel, why: 'w', repeat: 3, pre: [[{ k: 'hp', n: 10 }]], done: [[{ k: 'have', item: 'log', n: 10 }]], replace: ['all'] };
    const short = actToShort(act);
    expect(short).toMatchObject({ repeat: 3, pre: 'hp>=10', done: 'have:log>=10', replace: ['all'] });
    expect(validSkillInput(short, SHORT_ACT_INPUT_SCHEMA)).toBe(true);
    expect(shortToAct(short).act).toEqual(act);
    expect(Object.keys(actToShort({ hands: [{ do: 'jump' }] }))).toEqual(['hands']);
  });
  it('turns away an unreadable condition with the forms, and a repeat that is not 2–8', () => {
    const bad = expandShortAct({ hands: ['jump'], pre: 'かまどが近い', done: 'have:' });
    expect(bad.errors).toHaveLength(2);
    expect(bad.errors[0]).toMatch(/^pre の書き方の誤り: 『かまどが近い』は読めない。使える形: near:furnace~4/u);
    expect(bad.errors[1]).toContain('done の書き方の誤り');
    expect(shortHandProblem(bad.input)).toMatch(/^pre の書き方の誤り/u);
    expect(expandShortAct({ hands: ['jump'], repeat: 12 }).errors).toEqual(['repeat の書き方の誤り: 2〜8 の整数で書く']);
    expect(shortHandProblem(expandShortAct({ hands: ['jump'], repeat: 12 }).input)).toBe('repeat の書き方の誤り: 2〜8 の整数で書く');
    expect(shortHandProblem(expandShortAct({ hands: ['fly 1,2,3'] }).input)).toContain('手の書き方が読めない');
  });
  it('reads the text of a condition in an input of json hands too', () => {
    const { input, errors } = expandShortAct({ hands: [{ do: 'jump' }], done: 'hp>=10' });
    expect(errors).toEqual([]);
    expect(input).toEqual({ hands: [{ do: 'jump' }], done: [[{ k: 'hp', n: 10 }]] });
  });
  it('takes a bare replace id, and a replace with no hands is the items to take off', () => {
    expect(shortToAct({ hands: ['jump'], replace: 'q3' }).act.replace).toEqual(['q3']);
    expect(shortToAct({ replace: ['q3'] }).errors).toEqual([]);
    expect(shortToAct({}).errors).toEqual(['hands が無い']);
    expect(replaceOnly({ replace: ['q3', 'q4'] })).toEqual(['q3', 'q4']);
    expect(replaceOnly({ hands: [], replace: 'all' })).toEqual(['all']);
    expect(replaceOnly({ hands: ['jump'], replace: ['q3'] })).toBeNull();
    expect(replaceOnly({ hands: ['jump'] })).toBeNull();
    expect(replaceOnly(null)).toBeNull();
  });
  it('is explained in the description', () => {
    for (const word of ['## 列（やることの列）と「〜まで続ける」', '欄 pre', '欄 done', '欄 repeat', '欄 replace', 'rel の手か、座標の無い手', '後ろの項目を動かさずに捨てる',
      '実行中を含めて 3 つまで', 'live の「列」', 'near:ブロック~r', 'have:物>=n', 'safe~r']) expect(SHORT_ACT_DESCRIPTION, word).toContain(word);
  });
});
