import { describe, expect, it } from 'vitest';
import { fcaMinecraftHitWake, HIT_WAKE_MINIMUM_MILLISECONDS } from '../src/wiring/fcaMinecraftHitWake.js';

/** 11/24 (the night of 11/23, 22:44 to 22:45: three deaths with the task waiting and no decision): a waiting task is woken when its body is hit or hurt beside a hostile. */
function rig(initial: { health: number; near: number | null }) {
  let clock = 1_000_000;
  const world = { health: initial.health, nearbyThreats: initial.near === null ? [] : [{ name: 'zombie', distance: initial.near }] };
  const events: Array<{ taskId: string; text: string }> = [];
  const tasks = [{ id: 't1', phase: 'waiting', status: 'running', revision: 1 }, { id: 't2', phase: 'running', status: 'running', revision: 1 }];
  const control = { available: () => ['b1'], observe: () => ({ state: { world } }), store: { body: () => 'b1' } } as never;
  const runtime = { list: () => tasks, taskSources: () => [{ experienceId: 'e1', recalledMemoryIds: [] }],
    observeExternal: (_scope: string, taskId: string, event: { text: string }) => { events.push({ taskId, text: event.text }); } } as never;
  const wake = fcaMinecraftHitWake({ control, runtime, ownerScope: 's', now: () => clock, log: () => undefined });
  return { wake, world, events, advance: (ms: number) => { clock += ms; } };
}

describe('a waiting task is woken by a hit (fcaMinecraftHitWake)', () => {
  it('wakes only the waiting task, when health falls with a hostile near', () => {
    const { wake, world, events, advance } = rig({ health: 20, near: 5 });
    expect(wake.tick()).toBe(0);
    world.health = 17;
    advance(1000);
    expect(wake.tick()).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ taskId: 't1' });
  });
  it('wakes a hurt body with a hostile at her side, and not a calm or a distant one', () => {
    const hurt = rig({ health: 9, near: 6 });
    expect(hurt.wake.tick()).toBe(1);
    expect(rig({ health: 9, near: 30 }).wake.tick()).toBe(0);
    expect(rig({ health: 20, near: 3 }).wake.tick()).toBe(0);
    expect(rig({ health: 5, near: null }).wake.tick()).toBe(0);
  });
  it('wakes a task at most once in the minimum time, and again after it', () => {
    const { wake, advance } = rig({ health: 9, near: 6 });
    expect(wake.tick()).toBe(1);
    advance(HIT_WAKE_MINIMUM_MILLISECONDS - 1000);
    expect(wake.tick()).toBe(0);
    advance(2000);
    expect(wake.tick()).toBe(1);
  });
});
