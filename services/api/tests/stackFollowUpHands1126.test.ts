import { describe, expect, it } from 'vitest';
import { handProblem } from '../src/contracts/minecraftActHandRules.js';
import { lineToHand, SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';
import { handContinuesOnFail } from '../src/contracts/minecraftActTypes.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/**
 * The Haiku end-dragon run (11/26): one hand per decision (318 rounds, 316 acts), 6 in 10 acts shorter than a decision, the body idle about 3 tenths of
 * the time. The act manual says, in its own section and with a reason, that a known follow-up goes in the same act, and says how a failure plays out.
 */
const section = SHORT_ACT_DESCRIPTION.split('## 続きの手は同じ act に積む')[1]!.split('## 列')[0]!;
const examples = [...section.matchAll(/\["[^\]]*"(?:, "[^\]]*")*\]/gu)].map(m => JSON.parse(m[0]) as string[]);

describe('the manual teaches stacking the follow-up hands', () => {
  it('has its own section with the reason, the examples, the failure rule and when not to stack', () => {
    expect(section).toContain('理由');
    expect(section).toContain('判断の回数と費用も減る');
    expect(section).toContain('後ろの手は動かず');
    expect(section).toContain('onFail=continue');
    expect(section).toContain('dependsOn=none');
    expect(section).toContain('積まない時');
  });
  it('gives make-equip, mine-furnace, attack-pickup and go-work examples', () => {
    expect(examples.length).toBeGreaterThanOrEqual(4);
    expect(examples.map(list => list[0]!.split(' ')[0])).toEqual(expect.arrayContaining(['make', 'mine', 'attack', 'go']));
    for (const list of examples) expect(list.length).toBeGreaterThanOrEqual(2);
  });
  it('writes every example hand in a form the parser and the hand rules accept', () => {
    for (const list of examples) for (const line of list) {
      const hand = lineToHand(line);
      expect('error' in hand, `${line} -> ${JSON.stringify(hand)}`).toBe(false);
      if (!('error' in hand)) expect(handProblem(hand), line).toBeNull();
    }
  });
  it('is true about the body: attack stops the act on failure unless onFail=continue, equip goes on by itself', () => {
    expect(handContinuesOnFail({ do: 'attack' })).toBe(false);
    expect(handContinuesOnFail({ do: 'attack', onFail: 'continue' })).toBe(true);
    expect(handContinuesOnFail({ do: 'equip' })).toBe(true);
    const pickup = lineToHand('pickup range=8 dependsOn=none');
    expect('error' in pickup).toBe(false);
    if (!('error' in pickup)) expect(pickup.dependsOn).toEqual([]);
  });
  it('keeps the decision rule in the always-on knowledge too, and the old buried sentence is gone from the queue lines', () => {
    expect(V2_ALWAYS).toContain('Stack the known follow-up in the same act');
    expect(SHORT_ACT_DESCRIPTION).not.toContain('1 回の act に 2〜3 手をまとめる（判断 1 回の間に');
  });
});
