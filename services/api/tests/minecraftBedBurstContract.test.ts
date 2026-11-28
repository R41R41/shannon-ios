import { describe, expect, it } from 'vitest';
import { actMilliseconds, actProblem, ACT_DESCRIPTION, ACT_INPUT_SCHEMA, HAND_KINDS, type ActHand, type ActInput } from '../src/contracts/minecraftActContract.js';
import { expandShortAct, handToLine, shortHandProblem } from '../src/contracts/minecraftActShortContract.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { BED_BURST_DESCRIPTION, BED_STANDBY_DESCRIPTION } from '../src/contracts/minecraftBedBurstContract.js';
import { SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';
import { llmcInputProblem } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { PROBE_INPUT_SCHEMA } from '../src/contracts/minecraftProbeContract.js';
import { prepareProbeInput, probeLabel } from '../src/surfaces/minecraft/minecraftLlmcProbeInput.js';

const burst = (): ActHand => ({ do: 'bed_burst', at: [{ x: 0, y: 67, z: 2 }, { x: 0, y: 67, z: 3 }], target: '#12', count: 5, seconds: 20 });
const input = (hand = burst()): ActInput => ({ hands: [hand, { do: 'go', to: { x: 8, y: 64, z: 8 }, seconds: 10 }], accept: ['ender_dragon'] });

describe('the head is told when and how to use it (run 16: the text sat behind skill_read and was never read)', () => {
  it('accepts seconds up to 60 like the body, and refuses 61', () => {
    expect(actProblem(input({ ...burst(), seconds: 60 }))).toBeNull();
    expect(actProblem(input({ ...burst(), seconds: 61 }))).not.toBeNull();
  });
  it('passes the real head check for the act the text describes: go, place, bed_burst with 50 s, retreat go', () => {
    const expanded = expandShortAct({ hands: ['go 3,65,3 range=0.5 seconds=8', 'place obsidian at=3,65,2 4,65,2',
      'json {"do":"bed_burst","at":[{"x":4,"y":66,"z":0},{"x":4,"y":66,"z":1}],"target":"#13","count":5,"seconds":50,"onFail":"continue"}', 'go -6,66,10 seconds=10'], accept: ['ender_dragon'] });
    expect(expanded.errors).toEqual([]);
    expect(llmcInputProblem('mc.act', expanded.input as ActInput)).toBeNull();
  });
  it('puts the moment (phase 2, before the sit), the order of the hands and one example in the act body, not only behind the page', () => {
    expect(BED_BURST_DESCRIPTION.indexOf('phase 2')).toBeLessThan(BED_BURST_DESCRIPTION.indexOf('読んでいない置き場所'));
    expect(SHORT_ACT_DESCRIPTION).toContain('座るのを待たずにすぐ mc_probe kind=bedsite');
    expect(SHORT_ACT_DESCRIPTION).toContain('"do":"bed_burst"');
    expect(SHORT_ACT_DESCRIPTION).toContain('go（stand に range=0.5。体は stand から 1m 以内でないと始めない）→ place（黒曜石）→ bed_burst → 退避 go');
  });
  it('says range 0.5 for the stand, what landing_layout_unobserved means, and that phase 3 still accepts a ready read (11/28 run 18)', () => {
    expect(BED_BURST_DESCRIPTION).toContain('range は 0.5');
    expect(BED_BURST_DESCRIPTION).toContain('1m 以内');
    expect(BED_BURST_DESCRIPTION).toContain('「bedsite を読めていない」ではなく');
    expect(BED_BURST_DESCRIPTION).toContain('足場と遮蔽の黒曜石のマスを全部');
    expect(BED_BURST_DESCRIPTION).toContain('着陸中でも');
  });
  it('tells that the one call keeps firing at the seated dragon (not "unusable on a seated dragon") and recommends 50 s', () => {
    expect(BED_BURST_DESCRIPTION).toContain('座った竜（phase 5〜7）へ撃ち続け');
    expect(BED_BURST_DESCRIPTION).toContain('1〜60 秒の上限（50 を書く');
    expect(SHORT_ACT_DESCRIPTION).toContain('着地後も座った竜へ撃ち続ける');
    expect(SHORT_ACT_DESCRIPTION).toContain('"seconds":50}');
  });
});

describe('the head can request a bounded burst and its own immediate retreat', () => {
  it('accepts the public schema without adding hand properties or replacing the following go', () => {
    const act = input();
    expect(validSkillInput(act, ACT_INPUT_SCHEMA)).toBe(true);
    expect(actProblem(act)).toBeNull();
    expect(Object.keys(ACT_INPUT_SCHEMA.properties.hands.items.properties)).toHaveLength(60);
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
    ['too short', { seconds: 0.5 }], ['too long', { seconds: 61 }], ['nonfinite seconds', { seconds: Infinity }],
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

describe('bed_standby: the booking hand (11/28, run 21)', () => {
  const standby = (fields: Record<string, unknown> = { on: true }) => ({ do: 'bed_standby', ...fields }) as unknown as ActHand;
  const act = (hand: ActHand): ActInput => ({ hands: [hand], accept: ['ender_dragon'] });
  it('is a kind of hand that takes on, and count only when it books', () => {
    expect(HAND_KINDS).toContain('bed_standby');
    expect(actProblem(act(standby({ on: true })))).toBeNull();
    expect(actProblem(act(standby({ on: true, count: 3 })))).toBeNull();
    expect(actProblem(act(standby({ on: false })))).toBeNull();
    expect(validSkillInput(act(standby({ on: true, count: 5 })), ACT_INPUT_SCHEMA)).toBe(true);
  });
  it('refuses what it cannot take, saying which word is wrong', () => {
    expect(actProblem(act(standby({})))).toContain('on が要る');
    expect(actProblem(act(standby({ on: 'yes' })))).toContain('on');
    expect(actProblem(act(standby({ on: true, count: 6 })))).toContain('count は 1〜5');
    expect(actProblem(act(standby({ on: false, count: 2 })))).toContain('取り消し');
    expect(actProblem(act(standby({ on: true, at: [{ x: 0, y: 0, z: 0 }] })))).toContain('使えない');
    expect(actProblem(act(standby({ on: true, rel: true })))).toContain('rel');
    expect(actProblem({ hands: [standby({ on: true }), standby({ on: false })], repeat: 2 } as ActInput)).toContain('repeat');
  });
  it('is written as a json line and reaches the body as the same hand (a plain hand of the short grammar is not offered)', () => {
    const expanded = expandShortAct({ hands: ['json {"do":"bed_standby","on":true,"count":4}', 'wait 1'], accept: ['ender_dragon'] });
    expect(expanded.errors).toEqual([]);
    expect((expanded.input as ActInput).hands[0]).toEqual({ do: 'bed_standby', on: true, count: 4 });
    expect(llmcInputProblem('mc.act', expanded.input)).toBeNull();
    expect(handToLine(standby({ on: true }))).toMatch(/^json /u);
  });
  it('is explained before the old hand in the definition of act, with the reason and without the old jargon alone carrying it', () => {
    expect(ACT_DESCRIPTION.indexOf(BED_STANDBY_DESCRIPTION)).toBeLessThan(ACT_DESCRIPTION.indexOf(BED_BURST_DESCRIPTION));
    expect(BED_STANDBY_DESCRIPTION).toContain('11 秒かかった');
    expect(BED_STANDBY_DESCRIPTION).toContain('撃った');
    expect(BED_STANDBY_DESCRIPTION).toContain('見送った');
    expect(BED_BURST_DESCRIPTION).toContain('予約が使えない時の旧の手');
    expect(SHORT_ACT_DESCRIPTION).toContain('{"do":"bed_standby","on":true}');
    expect(actMilliseconds(act(standby({ on: true })))).toBeLessThanOrEqual(5_000);
  });
});
