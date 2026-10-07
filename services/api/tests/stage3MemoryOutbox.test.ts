import { describe, expect, it } from 'vitest';
import { capturedStage3Digests, STAGE3_SCENARIOS, type Stage3Capture } from './support/stage3Scenarios.js';
import { stage3MemoryHook } from './support/stage3MemoryHook.js';
import { readFileSync } from 'node:fs';

/**
 * Syzygy ADR-0008 stage 3, step F5, wired: the memory outbox built from the environment as the entries build it. Switched off
 * (the master switch, or `SHANNON_MEMORY_OUTBOX` alone) every scenario keeps afb38c28's digests. On, every scenario still sends
 * and answers what afb38c28 did: what a turn teaches reaches the next turn through the one writer.
 */
const recordedStage3 = () => JSON.parse(readFileSync(new URL('./fixtures/stage3-switched-off-v1.json', import.meta.url), 'utf8')).scenarios as Record<string, Stage3Capture>;

describe('the memory outbox in the stage-3 scenarios', () => {
  it('keeps afb38c28 byte for byte with SHANNON_ADR8_STAGE3=off and with SHANNON_MEMORY_OUTBOX=off', async () => {
    const recorded = recordedStage3();
    for (const environment of [{ SHANNON_ADR8_STAGE3: 'off' }, { SHANNON_MEMORY_OUTBOX: 'off' }]) {
      const memory = stage3MemoryHook(environment);
      expect(memory, JSON.stringify(environment)).toBeUndefined();
      const current = await capturedStage3Digests({ ...(memory ? { memory } : {}) });
      for (const name of STAGE3_SCENARIOS) expect(current[name], `${JSON.stringify(environment)} ${name}`).toEqual(recorded[name]);
    }
  });

  it('switched on: every request and answer is afb38c28\'s, and only the state shows the outbox', async () => {
    const recorded = recordedStage3();
    const memory = stage3MemoryHook({})!;
    const current = await capturedStage3Digests({ memory, expectStatus: (status, name) => expect(status, name).toBe(200) });
    for (const name of STAGE3_SCENARIOS) {
      expect(current[name]!.openai, name).toEqual(recorded[name]!.openai);
      expect(current[name]!.jev, name).toEqual(recorded[name]!.jev);
      expect(current[name]!.prompts, name).toEqual(recorded[name]!.prompts);
    }
    expect(current['text-name']!.state.some(table => table.startsWith('memory_outbox:'))).toBe(true);
  });
});
