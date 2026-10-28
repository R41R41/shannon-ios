import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACT_INPUT_SCHEMA, actExpectedMilliseconds, actMilliseconds, actProblem, actRemainingMilliseconds, HAND_KINDS, VERTICAL_MS_PER_STEP, verticalSteps,
  type ActHand, type ActInput,
} from '../src/contracts/minecraftActContract.js';
import { handProblem } from '../src/contracts/minecraftActHandRules.js';
import { VERTICAL_DEFAULT_SECONDS, VERTICAL_DEFAULTS, VERTICAL_SECONDS_RANGE } from '../src/contracts/minecraftActTime.js';
import {
  expandShortAct, handToLine, lineToHand, SHORT_ACT_DESCRIPTION, shortHandProblem,
} from '../src/contracts/minecraftActShortContract.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { skillSchema, validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { descentNote } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';

/**
 * 続ける力・契約 6 章 vertical の頭の側（`docs/continue-contracts.md`）：契約型、短い書き方の往復と送る前の断り（見本 vertical/short-hands.json）、手の規則、
 * 時間の見積もり、欄の数の上限、下りる前の警告。結果の文（stop-cases・counts-and-budget）は結果の型を作る担当の試験。
 */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/continue/vertical/${name}.json`, import.meta.url), 'utf8')) as {
  input: { lines: string[] }; expected: { hands: Array<Record<string, unknown>>; refused: Array<{ line: string; why: string }> };
};
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

const stairs: ActHand = { do: 'vertical', dir: 'down', shape: 'stairs', toward: 'south', toY: 10, canDig: ['stone', 'dirt'], liquid: 'stop' };
const shaft: ActHand = { do: 'vertical', dir: 'down', shape: 'shaft', toY: -50, canDig: ['stone', 'deepslate'], canPlace: ['cobblestone'], maxPlace: 30, liquid: 'seal' };
const pillar: ActHand = { do: 'vertical', dir: 'up', shape: 'pillar', toY: 63, canDig: ['stone', 'dirt'], canPlace: ['cobblestone'], maxPlace: 60, liquid: 'seal_water' };

describe('vertical: the contract type and the schema', () => {
  it('is a kind of hand, with the fields of contract 6 in the schema the body must take', () => {
    expect(HAND_KINDS).toContain('vertical');
    const hand = (ACT_INPUT_SCHEMA.properties.hands.items as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(hand.do!.enum).toContain('vertical');
    expect(hand.dir!.enum).toEqual(['down', 'up']);
    expect(hand.shape!.enum).toEqual(['stairs', 'shaft', 'pillar']);
    expect(hand.toward!.enum).toEqual(['north', 'east', 'south', 'west']);
    expect(hand.liquid!.enum).toEqual(['stop', 'seal', 'seal_water']);
    expect(hand.toY).toMatchObject({ type: 'integer', minimum: -64, maximum: 320 });
    // The shared fields stay one field each.
    for (const key of ['canDig', 'maxDig', 'canPlace', 'maxPlace', 'range', 'seconds']) expect(hand[key]).toBeDefined();
  });
  it('takes the hands of the fixture as an input of mc.act', () => {
    for (const hand of [stairs, shaft, pillar]) expect(validSkillInput({ hands: [hand] }, ACT_INPUT_SCHEMA)).toBe(true);
    expect(validSkillInput({ hands: [{ ...stairs, toY: 400 }] }, ACT_INPUT_SCHEMA)).toBe(false);
    expect(validSkillInput({ hands: [{ ...stairs, toY: 10.5 }] }, ACT_INPUT_SCHEMA)).toBe(false);
    expect(validSkillInput({ hands: [{ ...stairs, dir: 'sideways' }] }, ACT_INPUT_SCHEMA)).toBe(false);
    expect(validSkillInput({ hands: [{ ...stairs, liquid: 'ignore' }] }, ACT_INPUT_SCHEMA)).toBe(false);
  });
  it('keeps the hand within the schema limits: 56 properties (the body\'s 49 with dependsOn), 16,000 characters', () => {
    const properties = (ACT_INPUT_SCHEMA.properties.hands.items as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).length).toBe(49);
    expect(skillSchema(ACT_INPUT_SCHEMA)).toBe(true);
    const wide = (count: number) => ({ type: 'object', additionalProperties: false, required: [],
      properties: Object.fromEntries(Array.from({ length: count }, (_, index) => [`field${index}`, { type: 'string' }])) });
    expect(skillSchema(wide(56))).toBe(true);
    expect(skillSchema(wide(57))).toBe(false);
    expect(JSON.stringify(ACT_INPUT_SCHEMA).length).toBeLessThan(16_000);
  });
});

describe('vertical: the short line and the json hand are the same hand (fixture short-hands.json)', () => {
  const sheet = fixture('short-hands');
  // `dependsOn=1` is the continue contract 2's field (another hand's work); this test reads the line without it.
  const lines = sheet.input.lines.map(line => line.replace(/ dependsOn=\d+/u, ''));
  const hands = sheet.expected.hands.map(({ dependsOn: _skipped, ...rest }) => rest);
  it('reads each line into the hand of the fixture and writes the hand back into the same line', () => {
    expect(lines).toHaveLength(4);
    lines.forEach((line, index) => {
      const hand = lineToHand(line);
      expect('error' in hand).toBe(false);
      expect(same(hand, hands[index])).toBe(true);
      expect(handToLine(hands[index] as unknown as ActHand)).toBe(line);
      expect(handProblem(hand as ActHand)).toBeNull();
    });
  });
  it('writes the grammar of the contract: dir, form, toward for stairs, y=, dig=, maxDig, place=, maxPlace, liquid, range, seconds', () => {
    const full: ActHand = { do: 'vertical', dir: 'down', shape: 'stairs', toward: 'east', toY: -12, canDig: ['stone', 'dirt', 'gravel'], maxDig: 80, canPlace: ['cobblestone'],
      maxPlace: 20, liquid: 'seal', range: 2, seconds: 90, note: 'ネザーへ', onFail: 'continue' };
    const line = handToLine(full);
    expect(line).toBe('vertical down stairs east y=-12 dig=stone,dirt,gravel maxDig=80 place=cobblestone maxPlace=20 liquid=seal range=2 seconds=90 onFail=continue note="ネザーへ"');
    expect(same(lineToHand(line), full)).toBe(true);
  });
  it('reads the long field names too, and turns a hand the line cannot hold into a json line', () => {
    const read = lineToHand('vertical up pillar toY=70 canDig=stone canPlace=cobblestone liquid=stop');
    expect(read).toMatchObject({ dir: 'up', shape: 'pillar', toY: 70, canDig: ['stone'], canPlace: ['cobblestone'], liquid: 'stop' });
    // A form the line cannot say (an empty dig list) falls to json, never loses a field.
    const odd = { ...pillar, canDig: [] } as ActHand;
    expect(handToLine(odd).startsWith('json ')).toBe(true);
    expect(same(lineToHand(handToLine(odd)), odd)).toBe(true);
  });
  it('refuses the lines of the fixture before they are sent', () => {
    expect(sheet.expected.refused).toHaveLength(5);
    for (const { line, why } of sheet.expected.refused) {
      const result = expandShortAct({ hands: [line] });
      const reading = shortHandProblem(result.input);
      const problem = reading ?? actProblem(result.input as ActInput);
      expect([line, why, problem !== null]).toEqual([line, why, true]);
    }
  });
  it('says which rule each refusal broke', () => {
    const refusal = (line: string): string => {
      const result = expandShortAct({ hands: [line] });
      return shortHandProblem(result.input) ?? actProblem(result.input as ActInput) ?? '';
    };
    expect(refusal('vertical down stairs y=10 dig=stone liquid=stop')).toContain('stairs には toward');
    expect(refusal('vertical up shaft y=80 dig=stone liquid=stop')).toContain('shaft は down だけ');
    expect(refusal('vertical down pillar y=40 dig=stone place=cobblestone liquid=stop')).toContain('pillar は up だけ');
    expect(refusal('vertical up pillar y=63 place=cobblestone liquid=stop')).toContain('canDig が要る');
    expect(refusal('vertical stairs south y=10 dig=stone liquid=stop')).toContain('dir');
  });
});

describe('vertical: the rules of one hand (handProblem)', () => {
  const problem = (change: Record<string, unknown>, base: ActHand = stairs): string | null => {
    const hand: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(change)) { if (value === undefined) delete hand[key]; else hand[key] = value; }
    return handProblem(hand as unknown as ActHand);
  };
  it('takes the three forms as the contract writes them', () => {
    expect([stairs, shaft, pillar, { ...stairs, dir: 'up', toY: 70, canPlace: ['cobblestone'] } as ActHand].map(hand => handProblem(hand))).toEqual([null, null, null, null]);
    expect(problem({ dir: 'up', toY: 70 })).toBeNull();
  });
  it('refuses a form that does not fit its way, and the toward that does not fit its form', () => {
    expect(problem({ dir: 'up' }, shaft)).toContain('shaft は down だけ');
    expect(problem({ dir: 'down' }, pillar)).toContain('pillar は up だけ');
    expect(problem({ toward: undefined })).toContain('stairs には toward');
    expect(problem({ toward: 'north' }, shaft)).toContain('shaft に toward は使わない');
    expect(problem({ toward: 'south' }, pillar)).toContain('pillar に toward は使わない');
    expect(problem({ toward: 'up' })).toContain('toward は north・east・south・west');
  });
  it('needs dir, shape, toY, canDig and liquid', () => {
    for (const key of ['dir', 'shape', 'toY', 'canDig', 'liquid']) expect([key, problem({ [key]: undefined })?.split('（')[0]]).toEqual([key, `${key} が要る`]);
    expect(problem({ canDig: [] })).toContain('canDig が要る');
    expect(problem({ dir: 'sideways' })).toBe('dir は down か up');
    expect(problem({ shape: 'ladder' })).toBe('shape は stairs・shaft・pillar');
    expect(problem({ liquid: 'ignore' })).toContain('liquid は stop・seal・seal_water（liquid=stop|seal|seal_water のどれかを書く）');
  });
  it('keeps the ranges: toY -64..320, maxDig 0..200, maxPlace 0..100, range 1..2, seconds 5..120, block ids', () => {
    expect(problem({ toY: -64 })).toBeNull();
    expect(problem({ toY: 320, dir: 'up' })).toBeNull();
    expect(problem({ toY: -65 })).toContain('toY');
    expect(problem({ toY: 321 })).toContain('toY');
    expect(problem({ toY: 10.5 })).toContain('toY');
    expect(problem({ maxDig: 201 })).toContain('maxDig');
    expect(problem({ maxDig: 80.5 })).toContain('maxDig');
    expect(problem({ maxPlace: 101 })).toContain('maxPlace');
    expect(problem({ range: 3 })).toContain('range');
    expect(problem({ range: 2 })).toBeNull();
    expect(problem({ seconds: 4 })).toContain('seconds');
    expect(problem({ seconds: 121 })).toContain('seconds');
    expect(problem({ canDig: ['Stone Block'] })).toContain('canDig・canPlace');
    expect(problem({ canPlace: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).toContain('canPlace');
  });
  it('does not take a field of another hand, nor rel (toY is the feet\'s own y)', () => {
    expect(problem({ to: { x: 1, y: 2, z: 3 } })).toContain('to は使えない');
    expect(problem({ rel: true })).toContain('rel は使えない');
    expect(handProblem({ do: 'go', to: { x: 1, y: 2, z: 3 }, dir: 'down' } as ActHand)).toContain('dir は使えない');
  });
  it('is checked inside an act, with the hand\'s number', () => {
    expect(actProblem({ hands: [{ do: 'wait', seconds: 1 }, { ...shaft, dir: 'up' }] })).toBe('手2（vertical）: shaft は down だけ（上るなら pillar か stairs）');
    expect(actProblem({ hands: [stairs, shaft, pillar] })).toBeNull();
  });
  it('is described to the model in the tools text: the grammar line, the json fields', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('vertical down|up stairs|shaft|pillar [north|east|south|west] y=N dig=名,名 liquid=stop|seal|seal_water');
    expect(SHORT_ACT_DESCRIPTION).toContain('vertical: dir・shape・toward・toY・canDig・maxDig・canPlace・maxPlace・liquid・range・seconds');
  });
  it('shows the model the defaults and the range of the limits (amendment A-1 6: maxDig 200, maxPlace 100, seconds 60 within 5 to 120), the same as the body and the head check', () => {
    expect(VERTICAL_DEFAULTS).toEqual({ maxDig: 200, maxPlace: 100, seconds: 60, range: 1 });
    expect([...VERTICAL_SECONDS_RANGE]).toEqual([5, 120]);
    const line = SHORT_ACT_DESCRIPTION.split('\n').find(entry => entry.includes('上限（書かなければ既定）'))!;
    expect(line).toContain('seconds 5〜120（既定 60）・maxDig 既定 200・maxPlace 既定 100');
    expect(line).toContain('range は塞ぐ半径 1〜2、既定 1');
    // the head's check is the same range
    expect(handProblem({ ...stairs, seconds: 5 })).toBeNull();
    expect(handProblem({ ...stairs, seconds: 120 })).toBeNull();
    expect(handProblem({ ...stairs, seconds: 4 })).toBe('seconds は 5〜120');
    expect(handProblem({ ...stairs, seconds: 121 })).toBe('seconds は 5〜120');
    expect(handProblem({ ...stairs, maxDig: 200, maxPlace: 100 })).toBeNull();
    expect(handProblem({ ...stairs, maxDig: 201 })).toContain('maxDig は 0〜200 の整数（200 まで');
    expect(handProblem({ ...stairs, maxPlace: 101 })).toContain('maxPlace は 0〜100 の整数（100 まで');
  });
});

describe('vertical: the time of a hand (first guesses, then the body\'s msPerUnit)', () => {
  const feet = { x: 0, y: 40, z: 0 };
  it('counts the steps from the feet\'s y to toY', () => {
    expect(verticalSteps(stairs, 40)).toBe(30);
    expect(verticalSteps(pillar, 40.9)).toBe(23);
    expect(verticalSteps(shaft, null)).toBe(32);
  });
  it('estimates stairs about 1.6 s, shaft 1.0 s and pillar 0.9 s a step (a hypothesis), plus 1 s', () => {
    expect(VERTICAL_MS_PER_STEP).toEqual({ stairs: 1_600, shaft: 1_000, pillar: 900 });
    expect(actExpectedMilliseconds({ hands: [{ ...stairs, seconds: 120 }] }, feet)).toBe(1_000 + 30 * 1_600);
    expect(actExpectedMilliseconds({ hands: [{ ...shaft, toY: 20 }] }, feet)).toBe(1_000 + 20 * 1_000);
    expect(actExpectedMilliseconds({ hands: [{ ...pillar, toY: 50 }] }, feet)).toBe(1_000 + 10 * 900);
  });
  it('never expects more than the hand\'s seconds, and bounds the act by them and 2 s (default 60, amendment A-1 6)', () => {
    expect(actExpectedMilliseconds({ hands: [{ ...stairs, seconds: 20 }] }, feet)).toBe(20_000);
    expect(actMilliseconds({ hands: [{ ...stairs, seconds: 30 }] }, feet)).toBe(32_000);
    expect(actMilliseconds({ hands: [stairs] }, feet)).toBe(62_000);
    expect(actMilliseconds({ hands: [{ ...stairs, seconds: 120 }] }, feet)).toBe(122_000);
    expect(VERTICAL_DEFAULT_SECONDS).toBe(60);
  });
  it('starts the next hand where the vertical ended (the y asked for, one cell toward a step for stairs)', () => {
    const from = { x: 0, y: 10, z: 0 }, walk: ActHand = { do: 'walk', to: { x: 10, y: 0, z: 0 } };
    // Stairs east for ten steps end at (10,0,0): the walk there is 0 m (500 ms). A shaft ends at (0,0,0): 10 m at 4.3 m/s.
    const east: ActHand = { ...stairs, toY: 0, toward: 'east' };
    expect(actExpectedMilliseconds({ hands: [east, walk] }, from)).toBe(1_000 + 10 * 1_600 + 500);
    expect(actExpectedMilliseconds({ hands: [{ ...shaft, toY: 0 }, walk] }, from)).toBe(Math.round(1_000 + 10 * 1_000 + 500 + 1_000 * 10 / 4.3));
  });
  it('takes the body\'s msPerUnit in place of the first guess (a number it can use, else the guess stays)', () => {
    const input: ActInput = { hands: [{ ...stairs, seconds: 120 }] };
    expect(actExpectedMilliseconds(input, feet, { stairs: 2_000 })).toBe(1_000 + 30 * 2_000);
    expect(actExpectedMilliseconds(input, feet, { shaft: 400 })).toBe(1_000 + 30 * 1_600);
    expect(actExpectedMilliseconds(input, feet, { stairs: 0 })).toBe(1_000 + 30 * 1_600);
    expect(actExpectedMilliseconds(input, feet, { stairs: Number.NaN })).toBe(1_000 + 30 * 1_600);
    // The ceiling is the hand's seconds, whatever the measure says.
    expect(actMilliseconds(input, feet)).toBe(actMilliseconds(input, feet));
    expect(actRemainingMilliseconds(input, feet, null, 10_000, { stairs: 2_000 })).toBe(1_000 + 30 * 2_000 - 10_000);
    expect(actRemainingMilliseconds(input, feet, { hand: 1, iteration: 1 }, 0, { stairs: 2_000 })).toBe(1_000 + 30 * 2_000);
    expect(actRemainingMilliseconds(input, feet, { hand: 1, iteration: 1 }, 0)).toBe(1_000 + 30 * 1_600);
  });
});

describe('vertical: the warning before a descent (the same as for go)', () => {
  const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
    state: { world: world as never }, facts: {} });
  const pack = (...items: Array<[string, number]>) => items.map(([name, count]) => ({ name, count }));
  const surface = (items: Array<[string, number]>, extra: Record<string, unknown> = {}) =>
    frame({ dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory: pack(...items), ...extra });
  const go = { hands: [{ do: 'go', to: { x: 3, y: 36, z: 4 } }] };
  const down = { hands: [{ ...stairs, toY: 36 }] };
  it('says what go says for a vertical down of 10 or more with too little food and no table, as facts', () => {
    const world = surface([['cooked_beef', 1]], { nearbyEntities: [{ name: 'cow', distance: 14, id: 5 }] });
    const note = descentNote(down, world)!;
    expect(note).toBe(descentNote(go, world));
    expect(note).toContain('準備の状態（この act は地下 y=36 へ下りる手）: 未達 — 食料 20.8/40 点');
    expect(note).toContain('cow 14m');
    expect(note).not.toMatch(/しなさい|してください|すること|べき/u);
    for (const shape of [shaft, { ...stairs, toward: 'north' as const }]) expect(descentNote({ hands: [{ ...shape, toY: 36 }] }, world)).toBe(note);
  });
  it('counts the lowest y of all the hands, the vertical one among them', () => {
    const world = surface([['cooked_beef', 1]]);
    expect(descentNote({ hands: [{ do: 'wait', seconds: 1 }, { ...shaft, toY: 20 }] }, world)).toContain('地下 y=20 へ下りる手');
    expect(descentNote({ hands: [{ ...stairs, toY: 36 }, { ...shaft, toY: 20 }] }, world)).toContain('地下 y=20 へ下りる手');
  });
  it('is not said for a short step down, for an up, with enough food and a table, from underground or in the Nether', () => {
    const world = surface([['cooked_beef', 1]]);
    expect(descentNote({ hands: [{ ...stairs, toY: 65 }] }, world)).toBeNull();
    expect(descentNote({ hands: [{ ...pillar, toY: 120 }] }, world)).toBeNull();
    expect(descentNote({ hands: [{ ...pillar, dir: 'up', toY: 20 }] }, world)).toBeNull();
    expect(descentNote(down, surface([['cooked_beef', 2], ['crafting_table', 1]]))).toBeNull();
    expect(descentNote(down, frame({ dimension: 'the_nether', position: { x: 0, y: 70, z: 0 }, inventory: [] }))).toBeNull();
  });
  it('says the deeper descent of an underground vertical without a table, as go does', () => {
    const under = frame({ dimension: 'overworld', position: { x: 0, y: 14, z: 0 }, inventory: pack(['cooked_beef', 5]) });
    const deep = { hands: [{ ...shaft, toY: -56 }] };
    const note = descentNote(deep, under)!;
    expect(note).toContain('y=-56 へ下りる手を受け付けた');
    expect(note).toBe(descentNote({ hands: [{ do: 'go', to: { x: 0, y: -56, z: 0 } }] }, under));
  });
});
