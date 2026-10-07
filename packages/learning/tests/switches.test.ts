import { describe, expect, it } from 'vitest';
import { cognitionLedgerSwitches, skillRoutingSwitches, switchedOn } from '../src/index.js';

describe('the switches of ADR-0008 stage 1', () => {
  it('are all on by default', () => {
    expect(cognitionLedgerSwitches({})).toEqual({
      stage1: true, predictionLedger: true, choiceLedger: true, rewardMood: true, valueFacts: true, decisionTraces: true,
    });
  });

  it('reads the same words for off as the other switches of the server', () => {
    for (const word of ['off', 'false', '0', 'disabled', 'no', 'none', ' OFF ', 'No']) expect(switchedOn(word)).toBe(false);
    for (const word of [undefined, '', 'on', 'true', '1', 'yes', 'anything']) expect(switchedOn(word)).toBe(true);
  });

  it('turns everything off with the master switch', () => {
    expect(Object.values(cognitionLedgerSwitches({ SHANNON_ADR8_STAGE1: 'off' })).every(value => value === false)).toBe(true);
  });

  it('turns the prediction ledger off with the prediction record of ADR-0006', () => {
    const switches = cognitionLedgerSwitches({ SHANNON_PREDICTION_SHADOW: 'off' });
    expect(switches.predictionLedger).toBe(false);
    expect(switches.choiceLedger).toBe(true);
    expect(switches.decisionTraces).toBe(true);
  });

  it('turns the reward mood and the value facts off with the choice ledger', () => {
    expect(cognitionLedgerSwitches({ SHANNON_CHOICE_LEDGER: 'off' })).toMatchObject({ choiceLedger: false, rewardMood: false, valueFacts: false, predictionLedger: true });
    expect(cognitionLedgerSwitches({ SHANNON_REWARD_MOOD: 'off' })).toMatchObject({ choiceLedger: true, rewardMood: false, valueFacts: true });
    expect(cognitionLedgerSwitches({ SHANNON_VALUE_FACTS: '0' })).toMatchObject({ choiceLedger: true, rewardMood: true, valueFacts: false });
    expect(cognitionLedgerSwitches({ SHANNON_DECISION_TRACES: 'no' })).toMatchObject({ decisionTraces: false, predictionLedger: true });
  });
});

describe('the switches of ADR-0008 stage 2', () => {
  it('are all on by default, except Sonnet routing', () => {
    expect(skillRoutingSwitches({})).toEqual({
      stage2: true, toolMenu: true, readTools: true, difficulty: true, turnVerify: true, skills: true, skillExport: true, treeRecall: true, sonnetRouting: false, conversationReward: true,
    });
  });

  it('turns Sonnet routing on only when it says so, and only with the difficulty policy', () => {
    for (const word of ['on', 'true', '1', 'yes', ' ON ']) expect(skillRoutingSwitches({ SHANNON_SONNET_ROUTING: word }).sonnetRouting).toBe(true);
    for (const word of [undefined, '', 'off', 'anything', 'enabled']) expect(skillRoutingSwitches({ SHANNON_SONNET_ROUTING: word }).sonnetRouting).toBe(false);
    expect(skillRoutingSwitches({ SHANNON_SONNET_ROUTING: 'on', SHANNON_DIFFICULTY: 'off' }).sonnetRouting).toBe(false);
  });

  it('turns everything off with the master switch, Sonnet routing included', () => {
    expect(Object.values(skillRoutingSwitches({ SHANNON_ADR8_STAGE2: 'off', SHANNON_SONNET_ROUTING: 'on' })).every(value => value === false)).toBe(true);
  });

  it('keeps each switch apart, except the export with the skills', () => {
    expect(skillRoutingSwitches({ SHANNON_SKILLS: 'off' })).toMatchObject({ skills: false, skillExport: false, treeRecall: true });
    expect(skillRoutingSwitches({ SHANNON_SKILL_EXPORT: 'off' })).toMatchObject({ skills: true, skillExport: false });
    expect(skillRoutingSwitches({ SHANNON_TOOL_MENU: 'off' })).toMatchObject({ toolMenu: false, readTools: true, difficulty: true });
    expect(skillRoutingSwitches({ SHANNON_READ_TOOLS: 'no' })).toMatchObject({ readTools: false, toolMenu: true });
    expect(skillRoutingSwitches({ SHANNON_TURN_VERIFY: '0' })).toMatchObject({ turnVerify: false, difficulty: true });
    expect(skillRoutingSwitches({ SHANNON_TREE_RECALL: 'none' })).toMatchObject({ treeRecall: false, skills: true });
    expect(skillRoutingSwitches({ SHANNON_CONVERSATION_REWARD: 'off' })).toMatchObject({ conversationReward: false, difficulty: true });
  });

  it('is independent of the stage-1 switches', () => {
    expect(skillRoutingSwitches({ SHANNON_ADR8_STAGE1: 'off' }).stage2).toBe(true);
    expect(cognitionLedgerSwitches({ SHANNON_ADR8_STAGE2: 'off' }).stage1).toBe(true);
  });
});
