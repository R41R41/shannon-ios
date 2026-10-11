import { describe, expect, it } from 'vitest';
import { SWITCHES, switchOn, validateSwitches, type SwitchName } from '../src/index.js';

/** The production values of 2026-10-12 (ADR-0009 §9, `d2bb0a33`), as the loader hands them in (quotes stripped). */
const PRODUCTION: Readonly<Record<string, string>> = {
  SHANNON_ADR8_STAGE4: 'on', SHANNON_ADR8_STAGE5: 'on', SHANNON_SONNET_ROUTING: 'on', SHANNON_FCA_RUNTIME: 'on', SHANNON_FCA_SLEEP: 'on',
  SHANNON_FCA_TOUCH: 'on', SHANNON_FCA_MINECRAFT: 'on', SHANNON_TEMPORAL_KNOWLEDGE_RECALL: 'on', SHANNON_MINECRAFT_LIFECYCLE: 'on',
  SHANNON_EVIDENCE_DECAY: 'on', SHANNON_AUTONOMY_ENABLED: 'true',
};

describe('the switch table', () => {
  it('names every switch once and only requires switches it holds', () => {
    const names = SWITCHES.map(entry => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of SWITCHES) for (const required of entry.requires) expect(names).toContain(required);
    for (const entry of SWITCHES) expect(entry.default).toBe(entry.kind === 'default_on' ? 'on' : 'off');
  });

  it('reads each kind with the words of the reader it replaced', () => {
    const cases: Array<[SwitchName, string | undefined, boolean]> = [
      ['SHANNON_ADR8_STAGE3', undefined, true], ['SHANNON_ADR8_STAGE3', 'anything', true], ['SHANNON_ADR8_STAGE3', ' Off ', false],
      ['SHANNON_ADR8_STAGE4', undefined, false], ['SHANNON_ADR8_STAGE4', 'yes', true], ['SHANNON_ADR8_STAGE4', 'enabled', false],
      ['SHANNON_ADR8_STAGE5', 'on', true], ['SHANNON_ADR8_STAGE5', ' ON ', true], ['SHANNON_ADR8_STAGE5', 'true', false],
      ['SHANNON_FCA_RUNTIME', 'on', true], ['SHANNON_FCA_RUNTIME', '1', false], ['SHANNON_FCA_RUNTIME', undefined, false],
      ['SHANNON_AUTONOMY_ENABLED', 'true', true], ['SHANNON_AUTONOMY_ENABLED', ' true ', true], ['SHANNON_AUTONOMY_ENABLED', 'on', false],
      ['SHANNON_AUTONOMY_ENABLED', 'TRUE', false],
    ];
    for (const [name, value, expected] of cases) expect(switchOn({ [name]: value }, name), `${name}=${value}`).toBe(expected);
  });

  it('turns every production switch on, as before', () => {
    for (const name of Object.keys(PRODUCTION)) expect(switchOn(PRODUCTION, name as SwitchName), name).toBe(true);
  });
});

describe('validateSwitches', () => {
  it('finds nothing wrong with the production values or with nothing set', () => {
    expect(validateSwitches(PRODUCTION)).toEqual([]);
    expect(validateSwitches({})).toEqual([]);
  });

  it('warns, never throws, when a switch is on without what it needs', () => {
    expect(validateSwitches({ SHANNON_FCA_RUNTIME: 'on' })).toEqual([
      { name: 'SHANNON_FCA_RUNTIME', code: 'requires_off', needs: ['SHANNON_ADR8_STAGE4'] },
    ]);
    expect(validateSwitches({ SHANNON_FCA_SLEEP: 'on', SHANNON_ADR8_STAGE4: 'on' })).toEqual([
      { name: 'SHANNON_FCA_SLEEP', code: 'requires_off', needs: ['SHANNON_FCA_RUNTIME'] },
    ]);
  });

  it('names a value its kind does not know and a value that kept its quotes, without echoing it', () => {
    expect(validateSwitches({ SHANNON_ADR8_STAGE5: 'yes' })).toEqual([{ name: 'SHANNON_ADR8_STAGE5', code: 'unrecognized_value' }]);
    expect(validateSwitches({ SHANNON_TEMPORAL_KNOWLEDGE_RECALL: "'on'" })).toEqual([
      { name: 'SHANNON_TEMPORAL_KNOWLEDGE_RECALL', code: 'quoted_value' },
    ]);
  });
});
