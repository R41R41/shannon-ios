import { afterEach, expect, it } from 'vitest';
import { ACTION_LIMITS } from '@shannon/mind';
import { OwnTimeActionRunner } from '../src/wiring/actionExecutionWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { FULL_PLAN, loopHarness } from './autonomyLoopHarness.js';

/**
 * Stabilization 2026-10-12, production state: an open own-time cycle whose own action (same cycle id) is `unknown`.
 * `begin` re-enqueues that cycle id, gets the unknown row back and can never claim it, so the loop waited forever.
 */
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()));
function fixture(sessions: boolean) {
  const clock = { at: '2026-10-07T01:00:00.000Z' }, h = actionHarness(() => clock.at), runner = new OwnTimeActionRunner(h.actions);
  const loop = loopHarness({ clock, actionSteps: runner, concurrentActions: true, sessions });
  cleanups.push(h.close, () => runner.close(), () => loop.store.close());
  return { ...h, ...loop, runner, actionStore: h.store };
}

it.each([false, true])('ends a cycle whose own action stayed unknown past the deadline, without replaying it (sessions=%s)', async sessions => {
  const h = fixture(sessions); h.model.plans = [FULL_PLAN];
  await h.loop.tick();
  h.reader.failure = 'connection lost';
  expect(await h.loop.tick()).toBe('stepped');
  const cycle = h.store.loop.openCycle('owner')!;
  const own = (await h.actions.list('owner')).find(action => action.kind === 'ownTime')!;
  expect(own).toMatchObject({ state: 'unknown', sourceId: cycle.id, sent: true });
  expect(await h.loop.tick()).toBe('thread-wait');
  expect(await h.loop.tick()).toBe('thread-wait');

  // The reaper releases the action; the same cycle id still can never be claimed.
  h.advance(ACTION_LIMITS.unknownReleaseMs);
  expect(h.actionStore.transaction(() => h.actionStore.sweep(h.clock.at))).toBe(1);
  expect(await h.loop.tick()).toBe('cycle-ended');
  expect(h.store.loop.openCycle('owner')).toBeNull();
  if (sessions) expect(h.store.loop.sessions.get(cycle.id)).toMatchObject({ endCode: 'action_unknown' });
  expect(h.reader.reads).toHaveLength(1);
  expect(await h.actions.resume('owner', own.id)).toBe(false);

  // The next cycle starts with a fresh action and her own time goes on.
  h.reader.failure = null; h.model.plans = [FULL_PLAN];
  for (let n = 0; n < 6 && !h.store.loop.openCycle('owner'); n++) { h.advance(4 * 3_600_000); await h.loop.tick(); }
  const next = h.store.loop.openCycle('owner');
  expect(next).not.toBeNull();
  expect(next!.id).not.toBe(cycle.id);
  const fresh = (await h.actions.list('owner')).filter(action => action.kind === 'ownTime' && action.sourceId === next!.id);
  expect(fresh).toHaveLength(1);
  expect(fresh[0]!.state).not.toBe('unknown');
  expect(h.reader.reads).toHaveLength(1);
});

it('ends a cycle whose own action an expired lease cancelled before anything was sent, without running it again (ADR-0009 §9)', async () => {
  const h = fixture(true); h.model.plans = [FULL_PLAN];
  await h.loop.tick();
  const cycle = h.store.loop.openCycle('owner')!;
  // The runner stops renewing (a restart); the lease runs out while nothing outside was sent.
  h.runner.close();
  h.advance(ACTION_LIMITS.leaseMs + 1);
  h.actionStore.transaction(() => h.actionStore.sweep(h.clock.at));
  const own = (await h.actions.list('owner')).find(action => action.kind === 'ownTime' && action.sourceId === cycle.id)!;
  expect(own).toMatchObject({ state: 'cancelled', result: 'lease_expired', sent: false });
  expect(await h.runner.abandoned('owner', cycle.id)).toBe(true);
  const reads = h.reader.reads.length;
  expect(await h.loop.tick()).toBe('cycle-ended');
  expect(h.store.loop.openCycle('owner')).toBeNull();
  expect(h.reader.reads).toHaveLength(reads);
  expect(await h.runner.abandoned('owner', 'another-cycle')).toBe(false);
});
