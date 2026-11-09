import { afterEach, describe, expect, it, vi } from 'vitest';
import { rigObservationPorts } from '../scripts/minecraftRigObservation.js';
import { quiet, scenario, WIDE_POLICY } from './fcaCoreToolsHarness.js';

afterEach(() => vi.restoreAllMocks());
describe('rig observation mode follows the normal server', () => {
  it.each([undefined, '', 'transient', 'unknown', 'legacy', ' LEGACY '])('uses the normal interpretation of %s', value => {
    const marker = () => true, ports = rigObservationPorts({ keepBodyTools: marker }, { SHANNON_FCA_OBS_MODE: value });
    expect(ports.obsMode).toBe(value?.trim().toLowerCase() === 'legacy' ? 'legacy' : 'transient');
    expect(ports.keepBodyTools).toBe(marker);
  });
  it.each([undefined, 'legacy'])('sends the real FCA request shape for %s through a fake provider', async value => {
    quiet();
    const ports = rigObservationPorts({}, { SHANNON_FCA_OBS_MODE: value });
    const run = scenario({ steps: 2, policy: WIDE_POLICY, mode: () => ports.obsMode, body: () => ({ state: { health: 20 }, scan: ['observed login row'] }) });
    expect(await run.settle()).toBe('completed'); expect(run.violations).toEqual([]);
    const messages = run.bodies[0]!.messages as Array<{ role: string; clear_at?: unknown; content: unknown }>;
    expect(messages.some(message => message.clear_at !== undefined)).toBe(value !== 'legacy');
    expect(JSON.stringify(messages).includes('stateUpdate')).toBe(value !== 'legacy');
    if (value !== 'legacy') expect(JSON.stringify(messages)).toContain('observed login row');
  });
});
