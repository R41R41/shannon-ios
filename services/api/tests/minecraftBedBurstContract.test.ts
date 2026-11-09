import { describe, expect, it } from 'vitest';
import { actMilliseconds, actProblem, ACT_INPUT_SCHEMA, type ActHand, type ActInput } from '../src/contracts/minecraftActContract.js';
import { expandShortAct, handToLine, shortHandProblem } from '../src/contracts/minecraftActShortContract.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { llmcInputProblem } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { PROBE_INPUT_SCHEMA } from '../src/contracts/minecraftProbeContract.js';
import { prepareProbeInput, probeLabel } from '../src/surfaces/minecraft/minecraftLlmcProbeInput.js';

const burst = (): ActHand => ({ do: 'bed_burst', at: [{ x: 0, y: 67, z: 2 }, { x: 0, y: 67, z: 3 }], target: '#12', count: 5, seconds: 20 });
const input = (hand = burst()): ActInput => ({ hands: [hand, { do: 'go', to: { x: 8, y: 64, z: 8 }, seconds: 10 }], accept: ['ender_dragon'] });

describe('the head can request a bounded burst and its own immediate retreat', () => {
  it('accepts the public schema without adding hand properties or replacing the following go', () => {
    const act = input();
    expect(validSkillInput(act, ACT_INPUT_SCHEMA)).toBe(true);
    expect(actProblem(act)).toBeNull();
    expect(Object.keys(ACT_INPUT_SCHEMA.properties.hands.items.properties)).toHaveLength(57);
    expect(act.hands[1]).toEqual({ do: 'go', to: { x: 8, y: 64, z: 8 }, seconds: 10 });
  });
  it('preserves every argument through the short LLMC JSON-line path', () => {
    const hand = burst(), line = handToLine(hand);
    expect(line.startsWith('json ')).toBe(true);
    const short = { hands: [line, 'go 8,64,8 seconds=10'], accept: ['ender_dragon'] };
    expect(shortHandProblem(short)).toBeNull();
    const expanded = expandShortAct(short);
    expect(expanded.errors).toEqual([]);
    expect((expanded.input as ActInput).hands[0]).toEqual(hand);
    expect(actProblem(expanded.input as ActInput)).toBeNull();
  });
  it('reserves the requested duration instead of the generic short-hand fallback', () => {
    const ms = actMilliseconds({ hands: [burst()] });
    expect(ms).toBeGreaterThanOrEqual(22_000);
    expect(ms).toBeLessThanOrEqual(24_000);
  });
  it.each([
    ['one cell', { at: [{ x: 0, y: 67, z: 2 }] }],
    ['different y', { at: [{ x: 0, y: 67, z: 2 }, { x: 0, y: 68, z: 3 }] }],
    ['diagonal', { at: [{ x: 0, y: 67, z: 2 }, { x: 1, y: 67, z: 3 }] }],
    ['same cell', { at: [{ x: 0, y: 67, z: 2 }, { x: 0, y: 67, z: 2 }] }],
    ['fractional cell', { at: [{ x: 0.5, y: 67, z: 2 }, { x: 0.5, y: 67, z: 3 }] }],
    ['relative', { rel: true }], ['target name', { target: 'ender_dragon' }], ['negative id', { target: '#-1' }], ['noncanonical id', { target: '#0012' }],
    ['unsafe id', { target: '#99999999999999999999' }],
    ['zero beds', { count: 0 }], ['too many beds', { count: 6 }], ['fractional beds', { count: 1.5 }],
    ['too short', { seconds: 0.5 }], ['too long', { seconds: 21 }], ['nonfinite seconds', { seconds: Infinity }],
    ['unrelated strategy permission', { canDig: ['end_stone'] }],
  ] as const)('refuses %s before the body sees it', (_name, delta) => {
    expect(actProblem(input({ ...burst(), ...delta } as ActHand))).not.toBeNull();
  });
  it.each(['at', 'target', 'count', 'seconds'] as const)('requires an explicit %s', key => {
    const hand = burst(); delete hand[key];
    expect(actProblem(input(hand))).not.toBeNull();
  });
  it('does not turn the selected approach into a repeated loop', () => {
    expect(actProblem({ ...input(), repeat: 2 })).toMatch(/repeat/);
    const expanded = expandShortAct({ hands: [handToLine(burst())], repeat: 2 });
    expect(expanded.errors).toEqual([]);
    expect(llmcInputProblem('mc.act', expanded.input)).toMatch(/repeat/);
  });
  it('requests only a read of the exact dragon layout before the head chooses construction', () => {
    const prepared = prepareProbeInput({ kind: 'bedsite', target: '#12' }, { feet: null, creatures: [] });
    expect(prepared).toEqual({ input: { kind: 'bedsite', target: '#12' }, fixes: [], problem: null });
    expect(validSkillInput(prepared.input, PROBE_INPUT_SCHEMA)).toBe(true);
    expect(probeLabel(prepared.input!)).toBe('bedsite→#12');
    for (const target of [undefined, 'ender_dragon', '#-1', '#99999999999999999999', { x: 0, y: 64, z: 0 }]) {
      expect(prepareProbeInput({ kind: 'bedsite', target }, { feet: null, creatures: [] }).input).toBeNull();
    }
  });
});
