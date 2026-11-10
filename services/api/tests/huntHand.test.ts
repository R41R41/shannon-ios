import { describe, expect, it } from 'vitest';
import { HAND_KINDS, type ActHand, type ActInput } from '../src/contracts/minecraftActContract.js';
import { HAND_FIELDS, handProblem } from '../src/contracts/minecraftActHandRules.js';
import { handToLine, lineToHand, SHORT_ACT_DESCRIPTION, SHORT_ACT_MANUAL_FRAGMENTS, expandShortAct } from '../src/contracts/minecraftActShortContract.js';
import { actExpectedMilliseconds, actMilliseconds } from '../src/contracts/minecraftActTime.js';
import { createMinecraftContractBook } from '../src/contracts/minecraftContractBook.js';
import { FOOD_ACQUISITION_KNOWLEDGE, HUNT_FOOD_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftFoodAcquisition.js';
import { stageKnowledge } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { ownFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { actCalls, callTags } from '../src/surfaces/minecraft/minecraftAdoptionTags.js';
import { handEffect, nextGains } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { MOVING } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { RESERVE_TRAVEL_HANDS } from '../src/surfaces/minecraft/minecraftLlmcReserve.js';

/**
 * hunt (2026-11-11, owner request after run 5): the food animals around her, until none is left in range or count have fallen, with their drops.
 * Five cows took eight acts of one attack and one pickup each (three on ids already dead, one stopped on a cow behind a wall). The head writes the hand by kind.
 */
const hand = (fields: Record<string, unknown>) => ({ do: 'hunt', ...fields }) as unknown as ActHand;

describe('the hunt hand: fields and ranges', () => {
  it('is a kind of hand that takes a target and count, range, seconds', () => {
    expect(HAND_KINDS).toContain('hunt');
    expect(HAND_FIELDS.hunt).toEqual({ needs: [['target']], may: ['count', 'range', 'seconds'] });
    expect(handProblem(hand({ target: 'cow' }))).toBeNull();
    expect(handProblem(hand({ target: 'pig,cow', count: 6, range: 24, seconds: 40 }))).toBeNull();
  });
  it('refuses a missing kind, an id, other fields and out-of-range numbers, each with its reason', () => {
    expect(handProblem(hand({}))).toContain('target が要る');
    expect(handProblem(hand({ target: '#12' }))).toContain('id は attack');
    expect(handProblem(hand({ target: '12' }))).toContain('id は attack');
    expect(handProblem(hand({ target: 'cow', block: 'stone' }))).toContain('使えない');
    expect(handProblem(hand({ target: 'cow', seconds: 4 }))).toContain('seconds は 5〜120');
    expect(handProblem(hand({ target: 'cow', seconds: 121 }))).toContain('seconds は 5〜120');
    expect(handProblem(hand({ target: 'cow', count: 65 }))).toContain('count は 64 まで');
    expect(handProblem(hand({ target: 'cow', count: 0 }))).toContain('count は 1〜64');
    expect(handProblem(hand({ target: 'cow', range: 3 }))).toContain('range は 4〜48');
    expect(handProblem(hand({ target: 'cow', range: 49 }))).toContain('range は 4〜48');
  });
});

describe('the hunt hand: the short line', () => {
  it('reads `hunt cow count=6` and the lists of kinds, as words or with commas, and writes them back the same', () => {
    expect(lineToHand('hunt cow count=6')).toEqual({ do: 'hunt', target: 'cow', count: 6 });
    expect(lineToHand('hunt pig,cow range=24 seconds=40')).toEqual({ do: 'hunt', target: 'pig,cow', range: 24, seconds: 40 });
    expect(lineToHand('hunt cow pig')).toEqual({ do: 'hunt', target: 'cow,pig' });
    expect(lineToHand('hunt target=sheep count=3')).toEqual({ do: 'hunt', target: 'sheep', count: 3 });
    expect(lineToHand('hunt')).toEqual({ error: expect.stringContaining('食料の動物の種類が要る') });
    for (const line of ['hunt cow count=6', 'hunt pig,cow range=24 seconds=40', 'hunt sheep']) expect(handToLine(lineToHand(line) as ActHand)).toBe(line);
    // the common fields ride along
    expect(lineToHand('hunt cow count=2 onFail=continue note="朝の食料"')).toEqual({ do: 'hunt', target: 'cow', count: 2, onFail: 'continue', note: '朝の食料' });
  });
  it('falls to a json line for a hand that does not read back (a kind with a space in it)', () => {
    expect(handToLine(hand({ target: 'cow pig' }))).toMatch(/^json /u);
  });
  it('goes through an act whole and is checked on the way out', () => {
    const act = expandShortAct({ hands: ['hunt cow count=6', 'hunt cow seconds=500'] }) as { input?: ActInput; errors?: string[] } | ActInput;
    const text = JSON.stringify(act);
    expect(text).toContain('"do":"hunt"');
    expect(text).toContain('"count":6');
  });
});

describe('the hunt hand: the manual, the knowledge and the sets of hands', () => {
  it('has a page of its own, found from the inline text by name and by its fields', () => {
    expect(SHORT_ACT_MANUAL_FRAGMENTS.some(part => part.id === 'hunt' && !part.inline)).toBe(true);
    const book = createMinecraftContractBook({ catalogHash: 'a'.repeat(64) });
    const page = book.pages.find(entry => entry.title.startsWith('hunt'))!;
    expect(page.text).toContain('hunt 種類[,種類 ...] [count=N] [range=N] [seconds=N]');
    expect(page.text).toContain('子は倒さない');
    expect(page.text).toContain('no_target');
    expect(book.inline).toContain('hunt: target（種類。id は不可）・count・range・seconds');
    expect(book.inline).toContain('食料の動物を何体も狩るのは hunt');
    expect(SHORT_ACT_DESCRIPTION).toContain('hunt 種類');
  });
  it('is told in the prep stage\'s knowledge (when to write it, leather and wool, what to do on no_target) and not in the strategy', () => {
    const prep = stageKnowledge({ body: { state: { dimension: 'overworld' } } });
    expect(prep).toContain(FOOD_ACQUISITION_KNOWLEDGE);
    expect(prep).toContain(HUNT_FOOD_KNOWLEDGE);
    expect(HUNT_FOOD_KNOWLEDGE).toContain('hunt cow count=6');
    expect(HUNT_FOOD_KNOWLEDGE).toContain('hunt pig,cow');
    expect(HUNT_FOOD_KNOWLEDGE).toContain('革');
    expect(HUNT_FOOD_KNOWLEDGE).toContain('羊毛');
    expect(HUNT_FOOD_KNOWLEDGE).toContain('no_target');
    expect(ownFirstPlanSystem()).not.toContain('hunt cow');
  });
  it('moves her like a fight does: a work hand, a moving hand, a reserve travel hand, and ends her place unknown', () => {
    expect(MOVING.has('hunt')).toBe(true);
    expect(RESERVE_TRAVEL_HANDS.has('hunt')).toBe(true);
  });
  it('is described in a queue line and counted as a gain of food', () => {
    expect(handEffect(hand({ target: 'cow,pig', count: 6 }))).toBe('hunt cow,pig×6');
    expect(handEffect(hand({ target: 'cow' }))).toBe('hunt cow');
    const next = nextGains([{ hands: [hand({ target: 'cow' })] } as unknown as ActInput]);
    expect(next.join(' ')).toContain('hunt cow');
  });
  it('counts as the food hunt of the early-game tags, for a line and for a json hand, the kinds read one by one', () => {
    const calls = actCalls('mc_act', { hands: ['hunt cow,pig count=6', { do: 'hunt', target: 'sheep', count: 2 }] });
    expect(calls.map(call => call.name)).toEqual(['mc.attack-entity', 'mc.attack-entity']);
    expect(callTags(calls[0]!.name, calls[0]!.input)).toContain('food_hunt');
    expect(callTags(calls[1]!.name, calls[1]!.input)).toContain('food_hunt');
  });
});

describe('the hunt hand: its time', () => {
  const input = (fields: Record<string, unknown>): ActInput => ({ hands: [hand(fields)] }) as unknown as ActInput;
  it('may run for its seconds (60 when not written) and 2 s, and is expected to take 8 s a kill', () => {
    expect(actMilliseconds(input({ target: 'cow' }))).toBe(62_000);
    expect(actMilliseconds(input({ target: 'cow', seconds: 30 }))).toBe(32_000);
    expect(actExpectedMilliseconds(input({ target: 'cow', count: 5 }))).toBe(42_000);
    expect(actExpectedMilliseconds(input({ target: 'cow' }))).toBe(26_000);
    expect(actExpectedMilliseconds(input({ target: 'cow', count: 64, seconds: 20 }))).toBe(22_000);
  });
});
