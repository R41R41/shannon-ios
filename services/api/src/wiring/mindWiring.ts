import { mindSwitches, type MindPerceiver } from '../mind/perception/perceptionPorts.js';

/**
 * Wiring of Syzygy ADR-0008 stage 3's mind in the API process (`docs/mind-workspace-contract.md`). Null with
 * `SHANNON_ADR8_STAGE3=off` or `SHANNON_MIND_EVENTS=off`: then no surface perceives anything and every turn is afb38c28's.
 *
 * Step F2: every surface hands its turn to the mind through its normalizer (the audience copied); nothing holds the events yet.
 */
export function configuredMind(environment: Readonly<Record<string, string | undefined>>): { mind: MindPerceiver; close(): void } | null {
  if (!mindSwitches(environment).mindEvents) return null;
  return { mind: { perceive: () => null }, close: () => {} };
}
