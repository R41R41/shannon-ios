import { describe, expect, it } from 'vitest';
import { cognitionLedgerSwitches, switchedOn } from '../src/index.js';

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
