import { describe, expect, it } from 'vitest';
import { reportSwitches, withSwitches } from '../src/wiring/switchesWiring.js';
import { stage4Enabled } from '../src/infra/config/stage4.js';
import { stage5Enabled } from '../src/infra/config/stage5Config.js';

describe('the switch table at boot (ADR-0009 stage 1)', () => {
  it('logs each finding by code and name, never a value, and does not throw', () => {
    const lines: string[] = [];
    const warnings = reportSwitches({ SHANNON_FCA_TOUCH: 'on', SHANNON_ADR8_STAGE5: 'secret-looking' }, line => lines.push(line));
    expect(lines).toEqual([
      'Shannon switches: unrecognized_value SHANNON_ADR8_STAGE5',
      'Shannon switches: requires_off SHANNON_FCA_TOUCH needs=SHANNON_ADR8_STAGE4',
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
  });
});

describe('the common runtime is always on (ADR-0009 S9)', () => {
  it('stops the API at start with what to set when Stage4 or the task model key is missing, naming names and never values', async () => {
    const { configuredServerFca } = await import('../src/wiring/serverFcaWiring.js');
    expect(() => configuredServerFca({}, {} as never)).toThrow(/^FCA_ACTION_THREADS_REQUIRED: .*SHANNON_ADR8_STAGE4=on$/u);
    expect(() => configuredServerFca({ SHANNON_ADR8_STAGE4: 'on', OPENAI_API_KEY: 'synthetic-secret' }, {} as never))
      .toThrow(/^FCA_PROVIDER_REQUIRED: no key for the task model claude-haiku-[^;]+; set SHANNON_HAIKU_API_KEY, SHANNON_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY$/u);
    expect(() => configuredServerFca({ SHANNON_ADR8_STAGE4: 'on', SHANNON_FCA_MODEL: 'gpt-5.5' }, {} as never)).toThrow(/set OPENAI_API_KEY$/u);
  });
});
