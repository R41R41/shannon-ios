import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIND_SWITCH_NAMES, mindSwitches } from '@shannon/mind';
import { capturedStage3Digests, STAGE3_SCENARIOS, type Stage3Capture } from './support/stage3Scenarios.js';
import { stage3Hooks } from './support/stage3Wiring.js';

/**
 * Syzygy ADR-0008 stage 3, the switched-off proof (`docs/mind-workspace-contract.md`): with `SHANNON_ADR8_STAGE3=off` every
 * provider and Jev request, every answer and prompt, and every table of every database of text, voice, a touch of her body, the
 * platform reply, her Minecraft body and her own reach-out are byte for byte what afb38c28 had. The digests
 * (`fixtures/stage3-switched-off-v1.json`) were recorded on afb38c28 itself, in a detached work tree, with the scenarios of
 * `support/stage3Scenarios.ts` (which use only APIs of that commit), and are never regenerated for a stage-3 change:
 * `SHANNON_WRITE_STAGE3_OFF=1` writes the file only where it does not exist.
 */
const fixture = new URL('./fixtures/stage3-switched-off-v1.json', import.meta.url);

export function recordedStage3(): Record<string, Stage3Capture> {
  return JSON.parse(readFileSync(fixture, 'utf8')).scenarios as Record<string, Stage3Capture>;
}

describe('stage 3 switched off: what afb38c28 sent, answered and kept', () => {
  it('sends the recorded requests, gives the recorded answers and prompts, and leaves the recorded state in every scenario', async () => {
    const current = await capturedStage3Digests({ expectStatus: (status, name) => expect(status, name).toBe(200) });
    if (process.env.SHANNON_WRITE_STAGE3_OFF === '1' && !existsSync(fixture)) {
      writeFileSync(fixture, `${JSON.stringify({ about: 'Digests of the requests, answers, prompts and state of afb38c28 (stage3SwitchedOff.test.ts). Never regenerated for a stage-3 change.', scenarios: current }, null, 1)}\n`);
    }
    const recorded = recordedStage3();
    expect(Object.keys(current)).toEqual([...STAGE3_SCENARIOS]);
    expect(Object.keys(recorded)).toEqual([...STAGE3_SCENARIOS]);
    for (const name of STAGE3_SCENARIOS) expect(current[name], name).toEqual(recorded[name]);
  });

  it('is not vacuous: every surface made the calls and kept the state it is about, and the scenarios differ', () => {
    const recorded = recordedStage3();
    for (const name of STAGE3_SCENARIOS) {
      expect(recorded[name]!.prompts.length, name).toBeGreaterThan(0);
      expect(recorded[name]!.state.length, name).toBeGreaterThan(5);
    }
    // Her own time calls a fake model (its prompts are digested); with a companion present the voice turn was answered without one.
    for (const name of STAGE3_SCENARIOS.filter(item => item !== 'reach-out' && item !== 'voice-companion')) expect(recorded[name]!.openai.length, name).toBeGreaterThan(0);
    // The voice router asks Jev in every voice turn; the stage-2 menu asks it in a text turn.
    for (const name of ['text-two-turns', 'voice-greeting', 'voice-name', 'voice-companion', 'tool-round']) expect(recorded[name]!.jev.length, name).toBeGreaterThan(0);
    expect(recorded['tool-round']!.openai.length).toBe(2);
    // The touch called the reflex's model twice and the chat once; the platform answered four messages, the game three.
    expect(recorded['body-touch']!.openai).toHaveLength(3);
    expect(recorded.platform!.openai).toHaveLength(4);
    expect(recorded.minecraft!.openai).toHaveLength(3);
    // Her own time: the prompts of her thoughts and her two messages, and the record of the four cycles.
    expect(recorded['reach-out']!.prompts.length).toBeGreaterThanOrEqual(6);
    expect(new Set(Object.values(recorded).flatMap(item => item.openai)).size).toBeGreaterThan(15);
    expect(new Set(STAGE3_SCENARIOS.map(name => recorded[name]!.state.join()))).toHaveProperty('size', STAGE3_SCENARIOS.length);
  });
});

describe('stage 3 switched off in the environment', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  /** Every switch of a part of stage 3 (all but the master). */
  const PART_SWITCHES = Object.values(MIND_SWITCH_NAMES).filter(name => name !== 'SHANNON_ADR8_STAGE3');

  async function digestsWith(environment: Record<string, string>): Promise<Record<string, Stage3Capture>> {
    vi.unstubAllEnvs();
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
    // The production wiring of stage 3, built from this environment, as the server and the worker build it.
    return capturedStage3Digests(stage3Hooks());
  }

  it('keeps every digest of afb38c28 with SHANNON_ADR8_STAGE3=off, and with every part switched off by its own switch', async () => {
    const recorded = recordedStage3();
    for (const environment of [{ SHANNON_ADR8_STAGE3: 'off' }, Object.fromEntries(PART_SWITCHES.map(name => [name, 'off']))]) {
      const current = await digestsWith(environment);
      for (const name of STAGE3_SCENARIOS) expect(current[name], `${JSON.stringify(environment)} ${name}`).toEqual(recorded[name]);
    }
    expect(Object.values(mindSwitches({ SHANNON_ADR8_STAGE3: 'off' })).some(Boolean)).toBe(false);
  });

  /**
   * Each part, switched on alone (with what it needs), reaches only the surfaces it is about: every other scenario keeps the
   * digests of afb38c28. Perception and attention alone change nothing anyone can see; the workspace changes the conversation's
   * prompts; the proactive gate changes only her own messages.
   */
  const CONVERSATION = STAGE3_SCENARIOS.filter(name => name !== 'reach-out');
  const ALONE: ReadonlyArray<{ part: string; on: readonly string[]; reaches: readonly string[] }> = [
    { part: 'perception', on: ['SHANNON_MIND_EVENTS'], reaches: [] },
    { part: 'attention', on: ['SHANNON_MIND_EVENTS', 'SHANNON_ATTENTION'], reaches: [] },
    { part: 'data frames', on: ['SHANNON_DATA_FRAMES'], reaches: [] },
    // The workspace keeps its journal in the conversation's database; her own time alone has no workspace to write to.
    { part: 'workspace', on: ['SHANNON_MIND_EVENTS', 'SHANNON_ATTENTION', 'SHANNON_WORKSPACE', 'SHANNON_DATA_FRAMES'], reaches: CONVERSATION },
  ];

  it('reaches, with one part switched on alone, only the surfaces that part is about', async () => {
    const recorded = recordedStage3();
    for (const { part, on, reaches } of ALONE) {
      const current = await digestsWith(Object.fromEntries(PART_SWITCHES.map(name => [name, on.includes(name) ? 'on' : 'off'])));
      for (const name of STAGE3_SCENARIOS.filter(item => !reaches.includes(item))) expect(current[name], `${part} alone: ${name}`).toEqual(recorded[name]);
      // Not vacuous: a part that reaches a surface changes what that surface keeps.
      for (const name of reaches) expect(current[name]!.state, `${part} alone: ${name}`).not.toEqual(recorded[name]!.state);
    }
  });
});
