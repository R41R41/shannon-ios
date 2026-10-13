import { describe, expect, it } from 'vitest';
import { reportSwitches, withSwitches } from '../src/wiring/switchesWiring.js';
import { stage4Enabled } from '../src/infra/config/stage4.js';
import { stage5Enabled } from '../src/infra/config/stage5Config.js';
import { fcaSleepConfigured } from '../src/infra/config/fcaSwitches.js';

describe('the switch table at boot (ADR-0009 stage 1)', () => {
  it('logs each finding by code and name, never a value, and does not throw', () => {
    const lines: string[] = [];
    const warnings = reportSwitches({ SHANNON_FCA_RUNTIME: 'on', SHANNON_ADR8_STAGE5: 'secret-looking' }, line => lines.push(line));
    expect(lines).toEqual([
      'Shannon switches: unrecognized_value SHANNON_ADR8_STAGE5',
      'Shannon switches: requires_off SHANNON_FCA_RUNTIME needs=SHANNON_ADR8_STAGE4',
    ]);
    expect(withSwitches({ name: 'server' }, warnings)).toEqual({ name: 'server', switches: { warnings } });
    expect(withSwitches(null, warnings)).toBeNull();
  });

  it('keeps the readers it replaced: stage 4 explicit and behind the workspace, stage 5 and FCA sleep only on "on"', () => {
    expect(stage4Enabled({ SHANNON_ADR8_STAGE4: 'on' })).toBe(true);
    expect(stage4Enabled({ SHANNON_ADR8_STAGE4: 'on', SHANNON_WORKSPACE: 'off' })).toBe(false);
    expect(stage4Enabled({})).toBe(false);
    expect(stage5Enabled({ SHANNON_ADR8_STAGE5: 'on' })).toBe(true);
    expect(stage5Enabled({ SHANNON_ADR8_STAGE5: 'true' })).toBe(false);
    expect(fcaSleepConfigured({ SHANNON_FCA_RUNTIME: 'on' })).toBe(true);
    expect(fcaSleepConfigured({ SHANNON_FCA_SLEEP: 'on' })).toBe(false);
  });
});
