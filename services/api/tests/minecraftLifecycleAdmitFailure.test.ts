import { afterEach, describe, expect, it } from 'vitest';
import { ACTION_TERMINAL } from '@shannon/mind';
import type { ActionThreads } from '../src/contracts/actionThreadContract.js';
import { createLifecycleRunner } from '../src/wiring/minecraftLifecycleRunner.js';
import { actionHarness } from './support/actionThreadHarness.js';

// 2026-11-03 00:56: an operator `start` failed with a 500 while the API's event loop was stalled; its queued `minecraft` action (no holder, no
// deadline) stayed and refused every later request with `lease_conflict`. A failed claim withdraws the queued action.
const close: Array<() => void> = [];
afterEach(() => { for (const finish of close.splice(0)) finish(); });
const draft = { scopeKey: 'owner', kind: 'minecraft' as const, origin: 'owner_request' as const, sourceId: 'operator:b5489734-242e-4035-b3be-3e93b9f4cf4e', ownerInformed: true };
const live = async (h: ReturnType<typeof actionHarness>) => (await h.actions.list('owner')).filter(view => view.kind === 'minecraft' && !ACTION_TERMINAL.includes(view.state));

function runnerOver(h: ReturnType<typeof actionHarness>, failing: Partial<ActionThreads>) {
  close.push(h.close);
  return createLifecycleRunner({ actions: { ...h.actions, ...failing }, service: {} as never, deviceId: 'operator' })!;
}

describe('the lifecycle runner admits an operation', () => {
  it('leaves no queued action behind when the claim fails', async () => {
    const h = actionHarness(() => '2026-11-03T00:56:39.000Z');
    const runner = runnerOver(h, { claim: async () => { throw new Error('IPC deadline missed'); } });
    await expect(runner.admit(draft, true)).rejects.toThrow('IPC deadline missed');
    expect(await live(h)).toEqual([]);
    expect((await h.actions.list('owner')).find(view => view.sourceId === draft.sourceId)?.state).toBe('cancelled');
  });
  it('still throws the claim failure when the withdrawal itself fails', async () => {
    const h = actionHarness(() => '2026-11-03T00:56:39.000Z');
    const runner = runnerOver(h, { claim: async () => { throw new Error('IPC deadline missed'); }, stop: async () => { throw new Error('busy'); } });
    await expect(runner.admit(draft, true)).rejects.toThrow('IPC deadline missed');
  });
  it('admits as before when the slot is free', async () => {
    const h = actionHarness(() => '2026-11-03T00:56:39.000Z');
    const runner = runnerOver(h, {});
    const active = await runner.admit(draft, true);
    expect(active).not.toBeNull();
    active!.stop();
    expect((await live(h)).length).toBe(1);
  });
});
