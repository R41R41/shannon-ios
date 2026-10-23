import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACT_DESCRIPTION, ACT_MAX_HANDS, type ActHand, type ActInput } from '../src/contracts/minecraftActContract.js';
import {
  actToShort, expandShortAct, handToLine, lineToHand, SHORT_ACT_DESCRIPTION, SHORT_ACT_INPUT_SCHEMA, SHORT_HAND_ERROR_KEY, shortHandProblem,
  shortToAct,
} from '../src/contracts/minecraftActShortContract.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';

/**
 * mc.act の手の短い書き方（`minecraftActShortContract.ts`）。小さな手ごとの往復と読めない行、実走27〜34 の mc.act 497 件（重複を除いた物、
 * fixtures/act-short-recorded-v1.json）の往復、schema。
 */
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const cell = (x: number, y: number, z: number) => ({ x, y, z });
const roundTrip = (hand: ActHand): string => {
  const line = handToLine(hand), back = lineToHand(line);
  expect('error' in back).toBe(false);
  expect(same(back, hand)).toBe(true);
  return line;
};

describe('short hands: one hand, one line', () => {
  it('writes walk with one point or a path, sprint and range', () => {
    expect(roundTrip({ do: 'walk', to: cell(225, 57, 63) })).toBe('walk 225,57,63');
    expect(roundTrip({ do: 'walk', path: [cell(1, 2, 3), cell(4, 5, -6)], sprint: true, range: 2 })).toBe('walk 1,2,3 4,5,-6 sprint range=2');
  });
  it('writes dig, place, pillarUp, wait, sneak, jump, eat, equip, craft, pickup, look, attack and use', () => {
    expect(roundTrip({ do: 'dig', at: [cell(1, 2, 3), cell(1, 2, 4)], tool: 'diamond_pickaxe', exposeOk: true, takeOk: true, collect: false }))
      .toBe('dig 1,2,3 1,2,4 tool=diamond_pickaxe exposeOk takeOk collect=false');
    expect(roundTrip({ do: 'place', block: 'cobblestone', at: [cell(3, 4, 5)], face: 'down' })).toBe('place cobblestone 3,4,5 face=down');
    expect(roundTrip({ do: 'pillarUp', n: 3, block: 'dirt' })).toBe('pillarUp 3 dirt');
    expect(roundTrip({ do: 'pillarUp' })).toBe('pillarUp');
    expect(roundTrip({ do: 'wait', seconds: 2.5 })).toBe('wait 2.5');
    expect(roundTrip({ do: 'sneak', on: false })).toBe('sneak off');
    expect(roundTrip({ do: 'jump', n: 2 })).toBe('jump 2');
    expect(roundTrip({ do: 'eat' })).toBe('eat');
    expect(roundTrip({ do: 'eat', item: 'bread' })).toBe('eat bread');
    expect(roundTrip({ do: 'equip', item: 'iron_sword', slot: 'offhand' })).toBe('equip iron_sword offhand');
    expect(roundTrip({ do: 'craft', item: 'stick', count: 4 })).toBe('craft stick 4');
    expect(roundTrip({ do: 'pickup', range: 6, target: 'coal' })).toBe('pickup range=6 target=coal');
    expect(roundTrip({ do: 'look', to: cell(1, 2, 3) })).toBe('look 1,2,3');
    expect(roundTrip({ do: 'look', yaw: 90, pitch: -10 })).toBe('look yaw=90 pitch=-10');
    expect(roundTrip({ do: 'attack', target: '#12', hold: true, seconds: 25, untilDead: false })).toBe('attack #12 hold seconds=25 untilDead=false');
    expect(roundTrip({ do: 'use', item: 'ender_eye' })).toBe('use ender_eye');
    expect(roundTrip({ do: 'use', item: 'flint_and_steel', at: [cell(7, 8, 9)], face: 'up' })).toBe('use flint_and_steel 7,8,9 face=up');
  });
  it('writes rel, onFail and a note', () => {
    expect(roundTrip({ do: 'walk', to: cell(1, 0, 0), rel: true, onFail: 'continue' })).toBe('walk 1,0,0 rel onFail=continue');
    expect(roundTrip({ do: 'dig', at: [cell(1, 2, 3)], note: '頭の上を開ける' })).toBe('dig 1,2,3 note="頭の上を開ける"');
    expect(roundTrip({ do: 'wait', seconds: 1, note: '引用 " と \\ を含む', rel: true })).toContain('note="引用 \\" と \\\\ を含む"');
  });
  it('puts furnace, chest, drop and shoot, and a hand with fields the line cannot say, in a json line', () => {
    const hands: ActHand[] = [
      { do: 'furnace', at: [cell(1, 2, 3)], op: 'put', item: 'iron_ore', count: 8, fuel: 'coal', fuelCount: 2 },
      { do: 'chest', at: [cell(1, 2, 3)], op: 'take', items: [{ item: 'coal', count: 4 }] },
      { do: 'drop', items: [{ item: 'gold_ingot', count: 1 }], target: '#12' },
      { do: 'shoot', target: '#12', item: 'bow', charge: 1, n: 3 },
      { do: 'walk', to: cell(1, 2, 3), rel: false },
      { do: 'use', item: 'bucket', at: [cell(1, 2, 3), cell(1, 2, 4)] },
    ];
    for (const hand of hands) expect(roundTrip(hand).startsWith('json ')).toBe(true);
  });
});

describe('short hands: lines the model got wrong', () => {
  it('says what is wrong with an unknown hand, a missing cell and a missing number', () => {
    expect(lineToHand('fly 1,2,3')).toEqual({ error: 'fly: 知らない手' });
    expect(lineToHand('constructor 1,2,3')).toEqual({ error: 'constructor: 知らない手' });
    expect(lineToHand('walk')).toEqual({ error: 'walk: 座標が無い' });
    expect(lineToHand('dig stone')).toEqual({ error: 'dig: 座標が無い' });
    expect(lineToHand('place 1,2,3')).toEqual({ error: 'place: ブロック名と座標が要る' });
    expect(lineToHand('wait')).toEqual({ error: 'wait: 秒が要る' });
    expect(lineToHand('sneak maybe')).toEqual({ error: 'sneak: on か off' });
    expect(lineToHand('craft')).toEqual({ error: 'craft: 物の名前が要る' });
    expect(lineToHand('attack')).toEqual({ error: 'attack: 相手が要る' });
    expect(lineToHand('walk 1,2,3 do=dig')).toEqual({ error: 'walk: do= は書けない' });
    expect('error' in lineToHand('json {oops')).toBe(true);
    expect('error' in lineToHand('dig 1,2,3 note="開いたまま')).toBe(false);
  });
});

describe('short hands: a whole act', () => {
  const act: ActInput = {
    why: '[p1.2] 西へ掘る', accept: ['blaze'],
    stopIf: { hostileWithin: 8, hpBelow: 10, hungerBelow: 6, blockChanged: [cell(1, 2, 3), cell(4, 5, 6)] },
    hands: [{ do: 'dig', at: [cell(1, 2, 3)] }, { do: 'chest', at: [cell(1, 2, 3)], op: 'look' }],
  };
  it('writes stopIf as a string, with the cells to watch, and reads it back', () => {
    const short = actToShort(act);
    expect(short.stopIf).toBe('hostileWithin=8 hpBelow=10 hungerBelow=6 blockChanged=1,2,3/4,5,6');
    expect(short.hands[0]).toBe('dig 1,2,3');
    const { act: back, errors } = shortToAct(short);
    expect(errors).toEqual([]);
    expect(same(back, act)).toBe(true);
  });
  it('keeps an empty stopIf and a why that is empty', () => {
    const { act: back } = shortToAct(actToShort({ hands: [{ do: 'jump' }], stopIf: {}, why: '' }));
    expect(same(back, { hands: [{ do: 'jump' }], stopIf: {}, why: '' })).toBe(true);
  });
  it('names a stopIf it cannot read and a missing hands', () => {
    const { errors } = shortToAct({ hands: ['jump'], stopIf: 'hostileWithin=eight fear=3 blockChanged=1,2' });
    expect(errors).toEqual(['stopIf が読めない: hostileWithin=eight', 'stopIf が読めない: fear=3', 'stopIf が読めない: blockChanged=1,2']);
    expect(shortToAct({}).errors).toEqual(['hands が無い']);
  });
  it('turns the lines of a model into the act the body takes, and passes json hands through', () => {
    const lines = expandShortAct({ why: 'w', hands: ['walk 1,2,3', 'wait 1'], stopIf: 'hpBelow=8' });
    expect(lines.errors).toEqual([]);
    expect(lines.input).toEqual({ why: 'w', hands: [{ do: 'walk', to: cell(1, 2, 3) }, { do: 'wait', seconds: 1 }], stopIf: { hpBelow: 8 } });
    const json = { hands: [{ do: 'walk', to: cell(1, 2, 3) }], why: 'w' };
    expect(expandShortAct(json)).toEqual({ input: json, errors: [] });
    expect(expandShortAct(null)).toEqual({ input: null, errors: [] });
    const mixed = expandShortAct({ hands: ['jump 2', { do: 'wait', seconds: 1 }] });
    expect(mixed.input).toEqual({ hands: [{ do: 'jump', n: 2 }, { do: 'wait', seconds: 1 }] });
    expect((expandShortAct({ hands: 'walk 1,2,3\nwait 2' }).input as ActInput).hands).toHaveLength(2);
  });
  it('puts the unreadable lines in a field that shortHandProblem says in one line', () => {
    const bad = expandShortAct({ hands: ['walk 1,2,3', 'fly 4,5,6', 'dig'] });
    expect(bad.errors).toHaveLength(2);
    expect((bad.input as Record<string, unknown>)[SHORT_HAND_ERROR_KEY]).toBe('fly: 知らない手 / dig: 座標が無い');
    expect(shortHandProblem(bad.input)).toBe('手の書き方が読めない: fly: 知らない手 / dig: 座標が無い');
    expect(shortHandProblem({ hands: [] })).toBeNull();
    expect(shortHandProblem(null)).toBeNull();
  });
});

describe('short hands: the recorded acts of runs 27 to 34', () => {
  const acts = JSON.parse(readFileSync(new URL('./fixtures/act-short-recorded-v1.json', import.meta.url), 'utf8')) as Array<Record<string, unknown>>;
  const known = (act: Record<string, unknown>) => Object.fromEntries(Object.entries(act).filter(([key]) => ['hands', 'why', 'stopIf', 'accept'].includes(key)));
  it('has the acts', () => {
    expect(acts.length).toBeGreaterThan(450);
  });
  it('comes back the same through the short lines, hand by hand and as a whole act', () => {
    let short = 0, json = 0, unknownKeys = 0;
    for (const act of acts) {
      const back = shortToAct(actToShort(act as unknown as ActInput));
      expect(back.errors).toEqual([]);
      expect(same(back.act, known(act))).toBe(true);
      if (Object.keys(act).length !== Object.keys(known(act)).length) unknownKeys += 1;
      for (const line of actToShort(act as unknown as ActInput).hands) if (line.startsWith('json ')) json += 1; else short += 1;
    }
    expect(short).toBeGreaterThan(json * 10);
    expect(unknownKeys).toBeLessThan(5);
  });
  it('writes every hand of the recorded acts in lines the schema takes', () => {
    for (const act of acts) {
      const short = actToShort(act as unknown as ActInput);
      expect(validSkillInput(short, SHORT_ACT_INPUT_SCHEMA)).toBe(true);
    }
  });
});

describe('short hands: the tool', () => {
  it('takes an act of lines and refuses what the schema does not', () => {
    const schema = SHORT_ACT_INPUT_SCHEMA as unknown as Readonly<Record<string, unknown>>;
    expect(validSkillInput({ hands: ['walk 1,2,3'] }, schema)).toBe(true);
    expect(validSkillInput({ hands: ['walk 1,2,3'], why: 'w', stopIf: 'hpBelow=8', accept: ['blaze'] }, schema)).toBe(true);
    expect(validSkillInput({ hands: [] }, schema)).toBe(false);
    expect(validSkillInput({ hands: Array.from({ length: ACT_MAX_HANDS + 1 }, () => 'jump') }, schema)).toBe(false);
    expect(validSkillInput({ hands: [{ do: 'walk' }] }, schema)).toBe(false);
    expect(validSkillInput({ hands: ['jump'], stopIf: { hpBelow: 8 } }, schema)).toBe(false);
    expect(validSkillInput({ hands: ['jump'], extra: 1 }, schema)).toBe(false);
    expect(validSkillInput({ why: 'w' }, schema)).toBe(false);
  });
  it('is the act description with the hand lines said in place of the json hands, and holds the whole grammar (mb-llmc-cand 10: one topic in one place)', () => {
    expect(SHORT_ACT_DESCRIPTION).not.toContain('手（do）と引数');
    expect(SHORT_ACT_DESCRIPTION).not.toContain('at・path・items は 1 つでも配列 [ ] で書く');
    expect(SHORT_ACT_DESCRIPTION).toContain('walk X,Y,Z');
    expect(SHORT_ACT_DESCRIPTION).toContain('json {"do":"furnace"');
    // The cut-offs of the old text are still said, now in the description's own sections.
    for (const word of ['stopIf は文字列', 'accept は', 'onFail:', 'hpBelow は今の体力より低い値', '石1枚の向こうの水は、その石を dig してから use bucket',
      'chest は', '箱・樽だけ']) expect(SHORT_ACT_DESCRIPTION, word).toContain(word);
  });
});
