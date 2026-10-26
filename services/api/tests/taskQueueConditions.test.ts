import { describe, expect, it } from 'vitest';
import { clauseText, conditionText, parseCondition, validCondition, type ActCondition } from '../src/contracts/minecraftActCondition.js';
import { conditionHolds, conditionWords } from '../src/surfaces/minecraft/minecraftConditions.js';
import { nodesSeenDone, parseDoneWhen, doneStatusWords, doneFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';

/** The task queue's conditions (design section 4): the text a model writes, the JSON the body reads, and what the head's frame can show of them. */
const parse = (text: string): ActCondition => {
  const parsed = parseCondition(text);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.condition;
};
function frame(world: Record<string, unknown>, facts: Record<string, string | number | boolean | null> = {}): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: '2026-10-26T00:00:00.000Z', receivedAt: '2026-10-26T00:00:00.000Z', connected: true,
    state: { world }, facts } as unknown as BodyObservation;
}
const WORLD = { position: { x: 10, y: 64, z: 10 }, dimension: 'overworld', health: 12, food: 15, timeOfDay: 6000,
  inventory: ['raw_iron×1', 'oak_log×4', 'bread×5'], worn: '頭: なし、胴: golden_chestplate(残り…)、脚: なし、足: なし' };

describe('the text of a condition', () => {
  it('reads every form into the JSON the body takes', () => {
    expect(parse('have:raw_iron>=3')).toEqual([[{ k: 'have', item: 'raw_iron', n: 3 }]]);
    expect(parse('have:log')).toEqual([[{ k: 'have', item: 'log', n: 1 }]]);
    expect(parse('have:bucket<1')).toEqual([[{ k: 'have', item: 'bucket', n: 1, op: '<' }]]);
    expect(parse('food>=20&hunger>=18&hp>=15&free>=6')).toEqual([[{ k: 'food', n: 20 }, { k: 'hunger', n: 18 }, { k: 'hp', n: 15 }, { k: 'free', n: 6 }]]);
    expect(parse('dim:nether|dim:end|dim:overworld')).toEqual([[{ k: 'dim', dim: 'the_nether' }], [{ k: 'dim', dim: 'the_end' }], [{ k: 'dim', dim: 'overworld' }]]);
    expect(parse('at:26,51,7')).toEqual([[{ k: 'at', x: 26, y: 51, z: 7, r: 4 }]]);
    expect(parse('at:(26,51,-7)~2@nether')).toEqual([[{ k: 'at', x: 26, y: 51, z: -7, r: 2, dim: 'the_nether' }]]);
    expect(parse('near:furnace')).toEqual([[{ k: 'near', block: 'furnace', r: 4 }]]);
    expect(parse('near:iron_ore~8')).toEqual([[{ k: 'near', block: 'iron_ore', r: 8 }]]);
    expect(parse('time:night&time:day')).toEqual([[{ k: 'time', t: 'night' }, { k: 'time', t: 'day' }]]);
    expect(parse('furnace:10,64,5')).toEqual([[{ k: 'furnace', x: 10, y: 64, z: 5 }]]);
    expect(parse('safe~12')).toEqual([[{ k: 'safe', r: 12 }]]);
    expect(parse(' HAVE:Raw_Iron >= 3 & near:furnace~5 | hp>=10 ')).toEqual([[{ k: 'have', item: 'raw_iron', n: 3 }, { k: 'near', block: 'furnace', r: 5 }], [{ k: 'hp', n: 10 }]]);
  });
  it('writes a condition back so that it reads the same', () => {
    for (const text of ['have:raw_iron>=3&near:furnace~5', 'have:log', 'have:bucket<1', 'hp>=15|hunger>=18&food>=20', 'dim:nether', 'at:26,51,7~2@end', 'free>=6',
      'time:night', 'furnace:10,64,5', 'safe~12', 'at:-1,2,-3~4']) {
      const condition = parse(text);
      expect(parse(conditionText(condition))).toEqual(condition);
    }
    expect(conditionText(parse('have:raw_iron>=1'))).toBe('have:raw_iron');
    expect(clauseText({ k: 'dim', dim: 'the_nether' })).toBe('dim:nether');
  });
  it('turns away what it cannot read in one line that names the part and the forms', () => {
    const odd = parseCondition('かまどが近い', 'pre');
    expect(odd).toMatchObject({ ok: false });
    expect(odd.ok ? '' : odd.problem).toMatch(/^pre の書き方の誤り: 『かまどが近い』は読めない。使える形: near:furnace~4/u);
    for (const text of ['', '   ', 'have:', 'have:log&', 'near:furnace~9', 'near:furnace~0', 'hp>=', 'dim:moon', 'at:1,2', 'time:noon', 'safe~', 'free>=99', 'have:Log!']) {
      const bad = parseCondition(text, 'done');
      expect(bad.ok, text).toBe(false);
      expect(bad.ok ? '' : bad.problem, text).toContain('done の書き方の誤り');
    }
    const key = parseCondition('hp>=banana');
    expect(key.ok ? '' : key.problem).toContain('hp>=15');
    const many = parseCondition('hp>=1|hp>=2|hp>=3|hp>=4|hp>=5');
    expect(many.ok ? '' : many.problem).toContain('多すぎる');
    const wide = parseCondition('hp>=1&hp>=2&hp>=3&hp>=4&hp>=5&hp>=6&hp>=7');
    expect(wide.ok).toBe(false);
  });
  it('checks the JSON shape as the body does (no unknown key, ranges)', () => {
    expect(validCondition([[{ k: 'have', item: 'log', n: 3 }]])).toBe(true);
    expect(validCondition([[{ k: 'have', item: 'log', n: 3, op: '<' }]])).toBe(true);
    for (const bad of [[], [[]], [[{ k: 'have', item: 'log' }]], [[{ k: 'have', item: 'Log', n: 1 }]], [[{ k: 'have', item: 'log', n: 1, extra: 1 }]],
      [[{ k: 'hp', n: 21 }]], [[{ k: 'near', block: 'furnace', r: 9 }]], [[{ k: 'free', n: 1.5 }]], [[{ k: 'what' }]], 'hp>=1', null, [[{ k: 'dim', dim: 'nether' }]],
      Array.from({ length: 5 }, () => [{ k: 'hp', n: 1 }]), [Array.from({ length: 7 }, () => ({ k: 'hp', n: 1 }))]]) {
      expect(validCondition(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('what the head\'s frame shows of a condition', () => {
  const at = frame(WORLD);
  it('counts the pack and the worn armour as a plan\'s doneWhen does, gold_armor included', () => {
    expect(conditionHolds(parse('have:raw_iron>=1'), at)).toBe(true);
    expect(conditionHolds(parse('have:raw_iron>=3'), at)).toBe(false);
    expect(conditionHolds(parse('have:log>=4'), at)).toBe(true);
    expect(conditionHolds(parse('have:gold_armor'), at)).toBe(true);
    expect(conditionHolds(parse('have:raw_iron<2'), at)).toBe(true);
    expect(conditionHolds(parse('have:raw_iron<1'), at)).toBe(false);
  });
  it('judges food, hunger, health, dimension, place and time', () => {
    expect(conditionHolds(parse('food>=10'), at)).toBe(true);
    expect(conditionHolds(parse('food>=1000'), at)).toBe(false);
    expect(conditionHolds(parse('hunger>=15'), at)).toBe(true);
    expect(conditionHolds(parse('hunger>=16'), at)).toBe(false);
    expect(conditionHolds(parse('hp>=12'), at)).toBe(true);
    expect(conditionHolds(parse('hp>=13'), at)).toBe(false);
    expect(conditionHolds(parse('dim:overworld'), at)).toBe(true);
    expect(conditionHolds(parse('dim:nether'), at)).toBe(false);
    expect(conditionHolds(parse('at:10,64,12~3'), at)).toBe(true);
    expect(conditionHolds(parse('at:10,64,30~3'), at)).toBe(false);
    expect(conditionHolds(parse('at:10,64,12~3@nether'), at)).toBe(false);
    expect(conditionHolds(parse('time:day'), at)).toBe(true);
    expect(conditionHolds(parse('time:night'), at)).toBe(false);
    expect(conditionHolds(parse('time:night'), frame({ ...WORLD, timeOfDay: 14000 }))).toBe(true);
    expect(conditionHolds(parse('time:night'), frame({ ...WORLD, timeOfDay: 6000, weather: 'thunder' }))).toBe(true);
  });
  it('says unknown (null) for what a frame cannot show, and never takes unknown for no', () => {
    expect(conditionHolds(parse('near:furnace~4'), at)).toBeNull();
    expect(conditionHolds(parse('furnace:1,2,3'), at)).toBeNull();
    expect(conditionHolds(parse('safe~10'), at)).toBeNull();
    expect(conditionHolds(parse('free>=6'), at)).toBeNull();
    expect(conditionHolds(parse('free>=6'), frame({ ...WORLD, freeSlots: 10 }))).toBe(true);
    expect(conditionHolds(parse('time:day'), frame({ ...WORLD, dimension: 'the_nether', timeOfDay: undefined }))).toBeNull();
    expect(conditionHolds(parse('hp>=5'), null)).toBeNull();
    expect(conditionHolds(parse('hp>=5'), frame({ position: WORLD.position, dimension: 'overworld' }))).toBeNull();
    // An alternative with an unknowable clause and nothing false is unknown; a false clause makes it false; a true alternative makes the whole true.
    expect(conditionHolds(parse('have:raw_iron>=1&near:furnace~4'), at)).toBeNull();
    expect(conditionHolds(parse('have:raw_iron>=3&near:furnace~4'), at)).toBe(false);
    expect(conditionHolds(parse('have:raw_iron>=3&near:furnace~4|hp>=1'), at)).toBe(true);
    expect(conditionHolds(parse('have:raw_iron>=3&near:furnace~4|hp>=20'), at)).toBe(false);
    expect(conditionHolds(parse('near:furnace~4|hp>=20'), at)).toBeNull();
  });
  it('says what is unmet in words', () => {
    expect(conditionWords(parse('have:raw_iron>=3'), at)).toBe('raw_iron 1/3');
    expect(conditionWords(parse('have:raw_iron>=3&hp>=15&near:furnace~4'), at)).toBe('raw_iron 1/3・体力 12/15');
    expect(conditionWords(parse('hunger>=18'), at)).toBe('満腹 15/18');
    expect(conditionWords(parse('dim:nether'), at)).toContain('the_nether');
    expect(conditionWords(parse('at:10,64,30~3'), at)).toContain('20m');
    expect(conditionWords(parse('time:night'), at)).toContain('昼');
    expect(conditionWords(parse('have:raw_iron<1'), at)).toContain('1 個');
    expect(conditionWords(parse('have:raw_iron>=1'), at)).toBeNull();
    expect(conditionWords(parse('near:furnace~4'), at)).toBeNull();
    expect(conditionWords(parse('hp>=5'), null)).toBeNull();
    // The alternative nearest to holding is the one spoken of.
    expect(conditionWords(parse('have:raw_iron>=3&hp>=20|hp>=10&have:raw_iron>=2'), at)).toBe('raw_iron 1/2');
  });
});

describe('a plan node\'s doneWhen takes the newer forms', () => {
  it('reads hp, hunger, free, time and have< beside the old forms, which read as they did', () => {
    expect(parseDoneWhen('hp>=15&hunger>=18')).toEqual([[{ kind: 'act', clause: { k: 'hp', n: 15 } }, { kind: 'act', clause: { k: 'hunger', n: 18 } }]]);
    expect(parseDoneWhen('time:night|free>=4')).toHaveLength(2);
    expect(parseDoneWhen('have:bucket<1')).toEqual([[{ kind: 'act', clause: { k: 'have', item: 'bucket', n: 1, op: '<' } }]]);
    expect(parseDoneWhen('have:stone_pickaxe&food>=40')).toEqual([[{ kind: 'have', item: 'stone_pickaxe', count: 1 }, { kind: 'food', points: 40 }]]);
    for (const words of ['hp>=', 'near:furnace', 'safe~5', 'furnace:1,2,3', 'time:noon']) expect(parseDoneWhen(words), words).toBeNull();
  });
  it('marks a node done when the frame shows the new fact, and says what is missing', () => {
    const tree = { nodes: [{ id: 'p1', parentId: null, title: 'heal', state: 'pending', doneWhen: 'hp>=15' }, { id: 'p2', parentId: null, title: 'sleep', state: 'pending', doneWhen: 'time:night' }],
      current: 'p1' } as never;
    const facts = doneFacts(frame(WORLD))!;
    expect(nodesSeenDone(tree, facts)).toEqual([]);
    expect(doneStatusWords('hp>=15', facts)).toBe('未: 体力 12/15');
    expect(nodesSeenDone(tree, doneFacts(frame({ ...WORLD, health: 18 }))!)).toEqual(['p1']);
    expect(doneStatusWords('time:night', doneFacts(frame({ ...WORLD, timeOfDay: 14000 }))!)).toBe('満たしている');
    // A frame without the fact leaves the node as it is.
    expect(nodesSeenDone(tree, doneFacts(frame({ position: WORLD.position, dimension: 'overworld' }))!)).toEqual([]);
  });
});
