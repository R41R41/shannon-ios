import { describe, expect, it } from 'vitest';
import { MIND_SWITCH_NAMES, mindSwitches, switchedOn, switchedOnExplicitly } from '../src/index.js';

describe('the switches of ADR-0008 stage 3', () => {
  it('are all on by default, except the evidence decay (owner answer 4: off until he has seen the dry-run)', () => {
    expect(mindSwitches({})).toEqual({
      stage3: true, mindEvents: true, attention: true, workspace: true, dataFrames: true, proactiveGate: true, memoryOutbox: true,
      temporalFacts: true, evidenceDecay: false, identityTiers: true, trustLedger: true, structuredCompaction: true,
    });
  });

  it('reads the same words for off and on as the other switches of the server', () => {
    for (const word of ['off', 'false', '0', 'disabled', 'no', 'none', ' OFF ', 'No']) expect(switchedOn(word)).toBe(false);
    for (const word of [undefined, '', 'on', 'true', '1', 'yes', 'anything']) expect(switchedOn(word)).toBe(true);
    for (const word of ['on', 'true', '1', 'yes', ' ON ', 'Yes']) expect(switchedOnExplicitly(word)).toBe(true);
    for (const word of [undefined, '', 'off', 'anything', 'enabled']) expect(switchedOnExplicitly(word)).toBe(false);
  });

  it('turns the evidence decay on only when it is named on', () => {
    expect(mindSwitches({ SHANNON_EVIDENCE_DECAY: 'on' }).evidenceDecay).toBe(true);
    expect(mindSwitches({ SHANNON_EVIDENCE_DECAY: 'enabled' }).evidenceDecay).toBe(false);
    expect(mindSwitches({ SHANNON_EVIDENCE_DECAY: 'on', SHANNON_ADR8_STAGE3: 'off' }).evidenceDecay).toBe(false);
  });

  it('turns everything off with the master switch, whatever the others say', () => {
    const everything = Object.fromEntries(Object.values(MIND_SWITCH_NAMES).map(name => [name, 'on']));
    for (const values of [{ SHANNON_ADR8_STAGE3: 'off' }, { ...everything, SHANNON_ADR8_STAGE3: 'off' }]) {
      expect(Object.values(mindSwitches(values)).every(value => value === false)).toBe(true);
    }
  });

  it('turns attention and the workspace off with the events, and the workspace with attention', () => {
    expect(mindSwitches({ SHANNON_MIND_EVENTS: 'off' })).toMatchObject({ mindEvents: false, attention: false, workspace: false, dataFrames: true, proactiveGate: true });
    expect(mindSwitches({ SHANNON_ATTENTION: 'off' })).toMatchObject({ mindEvents: true, attention: false, workspace: false });
    expect(mindSwitches({ SHANNON_WORKSPACE: 'no' })).toMatchObject({ mindEvents: true, attention: true, workspace: false });
  });

  it('turns the temporal facts off with the outbox, and nothing else', () => {
    expect(mindSwitches({ SHANNON_MEMORY_OUTBOX: 'off' })).toMatchObject({ memoryOutbox: false, temporalFacts: false, identityTiers: true, trustLedger: true, structuredCompaction: true });
    expect(mindSwitches({ SHANNON_TEMPORAL_FACTS: '0' })).toMatchObject({ memoryOutbox: true, temporalFacts: false });
  });

  it('turns each of the independent switches off alone', () => {
    for (const key of ['dataFrames', 'proactiveGate', 'identityTiers', 'trustLedger', 'structuredCompaction'] as const) {
      const switches = mindSwitches({ [MIND_SWITCH_NAMES[key]]: 'off' });
      expect(switches[key], key).toBe(false);
      const others = Object.entries(switches).filter(([name]) => name !== key && name !== 'evidenceDecay');
      expect(others.every(([, value]) => value), key).toBe(true);
    }
  });

  it('names every switch once, with the SHANNON_ prefix', () => {
    const names = Object.values(MIND_SWITCH_NAMES);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(MIND_SWITCH_NAMES)).toEqual(Object.keys(mindSwitches({})));
    expect(names.every(name => /^SHANNON_[A-Z0-9_]+$/u.test(name))).toBe(true);
  });
});
