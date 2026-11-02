import { expect, it } from 'vitest';
import { createWorksiteMemory } from '../src/surfaces/minecraft/minecraftWorksiteMemory.js';
import { prepareProbeInput } from '../src/surfaces/minecraft/minecraftLlmcProbeInput.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
const at = '2026-11-02T06:00:00Z';
const frame = { bodyId: 'b', connected: true, sequence: 12, stateAt: at,
  state: { life: { life: 2, dimension: 'overworld', dimensionSince: at } } } as unknown as BodyObservation;
const point = { x: 2, y: 64, z: 1 };
const probe = { kind: 'worksite', evidence: { life: 2, dimension: 'overworld', observedAt: at },
  target: { at: point }, standCandidates: [{ at: { ...point, x: 1 } }], retreat: { to: { ...point, x: 0 }, status: 'verified_segment' } };
it('normalizes the resource, working position and return destination independently', () => {
  const prepared = prepareProbeInput({ kind: 'worksite', at: point, to: { ...point, x: 1 }, retreat: { ...point, x: 0 } }, { feet: point, creatures: [] });
  expect(prepared.problem).toBeNull();
  expect(prepared.input).toEqual({ kind: 'worksite', target: point, to: { ...point, x: 1 }, retreat: { ...point, x: 0 } });
});
it('persists the candidate, but never projects the old route as safe after excavation', () => {
  const memory = createWorksiteMemory(null);
  memory.remember(JSON.stringify(probe), frame);
  const restored = createWorksiteMemory(memory.checkpoint().minecraftWorksite);
  expect(restored.read(frame).join()).toContain('再確認が必要');
  expect(restored.read(frame).join()).not.toContain('verified_segment');
  const nextLife = { ...frame, state: { ...frame.state, life: { life: 3, dimension: 'overworld', dimensionSince: at } } };
  expect(restored.read(nextLife)).toEqual([]);
  expect(restored.checkpoint().minecraftWorksite).toBeNull();
});
it('does not save an old or foreign result', () => {
  const memory = createWorksiteMemory(null);
  memory.remember(JSON.stringify({ ...probe, evidence: { ...probe.evidence, life: 1 } }), frame);
  memory.remember(JSON.stringify({ ...probe, evidence: { ...probe.evidence, observedAt: '2026-11-01T00:00:00Z' } }), frame);
  expect(memory.checkpoint().minecraftWorksite).toBeNull();
});
