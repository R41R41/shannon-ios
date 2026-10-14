import { describe, expect, it } from 'vitest';
import { fastBodyState, fastJudgment, type FastBodyState } from '../src/mind/action/reflex/fastJudgment.js';
import { createReflexGovernor } from '../src/mind/action/reflex/reflexGovernor.js';
import { createMinecraftFastJudgment } from '../src/surfaces/minecraft/minecraftFastJudgment.js';
import type { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

const NIGHT = 18_000;
const zombie = (distance: number) => ({ name: 'zombie', distance, canReachMe: true });
const frame = (sequence: number, at: number, world: Record<string, unknown>, facts: Record<string, unknown> = {}): BodyObservation => ({
  schemaVersion: 1, bodyId: 'minecraft:world', sequence, stateAt: new Date(at).toISOString(), receivedAt: new Date(at).toISOString(), connected: true,
  state: { world: { time: NIGHT, inventory: [{ name: 'stone_pickaxe', count: 1 }], ...world } }, facts: { alive: true, ...facts },
} as unknown as BodyObservation);
const state = (overrides: Partial<FastBodyState>): FastBodyState => ({ health: 20, threats: [], night: true, respawnedRecently: false,
  healthDropped: false, hasWeapon: false, floorActive: false, ...overrides });
const kind = (verdict: ReturnType<typeof fastJudgment>) => 'decision' in verdict ? `${verdict.decision.kind}:${verdict.decision.rule}` : `hold:${verdict.hold}`;

describe('the image-free fast judgment rules (ADR-0011 stage 2)', () => {
  it('fights one or two zombies when healthy, takes shelter outnumbered, low or just respawned, and flees creepers', () => {
    expect(kind(fastJudgment(state({ threats: [{ ...zombie(3), ignited: false }] })))).toBe('fight:melee_fight');
    expect(kind(fastJudgment(state({ threats: [0, 1, 2].map(i => ({ ...zombie(3 + i), ignited: false })) })))).toBe('shelter:outnumbered_shelter');
    expect(kind(fastJudgment(state({ health: 5, threats: [{ ...zombie(2), ignited: false }] })))).toBe('shelter:low_health_shelter');
    expect(kind(fastJudgment(state({ health: 5, threats: [{ ...zombie(5), ignited: false }] })))).toBe('flee:low_health_flee');
    expect(kind(fastJudgment(state({ respawnedRecently: true, threats: [{ ...zombie(12), ignited: false }] })))).toBe('shelter:respawn_shelter');
    expect(kind(fastJudgment(state({ threats: [{ name: 'creeper', distance: 5, canReachMe: true, ignited: false }] })))).toBe('flee:creeper_flee');
    expect(kind(fastJudgment(state({ threats: [{ name: 'skeleton', distance: 12, canReachMe: true, ignited: false }], night: false })))).toBe('hold:no_threat');
    expect(kind(fastJudgment(state({ threats: [{ name: 'skeleton', distance: 7, canReachMe: true, ignited: false }] })))).toBe('shelter:ranged_shelter');
    expect(kind(fastJudgment(state({ health: 10, threats: [{ ...zombie(3), ignited: false }] })))).toBe('shelter:ambiguous_shelter');
  });

  it('leaves the floor alone: its safety lease and an ignited creeper close by are the floor\'s', () => {
    expect(kind(fastJudgment(state({ floorActive: true, threats: [{ ...zombie(2), ignited: false }] })))).toBe('hold:floor_active');
    expect(kind(fastJudgment(state({ threats: [{ name: 'creeper', distance: 3, canReachMe: true, ignited: true }] })))).toBe('hold:floor_creeper');
  });

  it('reads health, its fall, night, a weapon and the threats from a frame', () => {
    const read = fastBodyState(frame(1, 0, { health: 11, nearbyThreats: [zombie(2)], inventory: [{ name: 'iron_sword', count: 1 }] }),
      { earlierHealth: 17, sinceArrivalMs: 40_000 });
    expect(read).toMatchObject({ health: 11, healthDropped: true, night: true, hasWeapon: true, respawnedRecently: false,
      threats: [{ name: 'zombie', distance: 2, canReachMe: true, ignited: false }] });
  });
});

/** A body as the fast judgment sees it: frames, arrivals, pending skill rows and the commands it was sent. */
function fakeBody() {
  let clock = 1_000_000, current: BodyObservation | null = null, arrived: number | null = 0, pendingChecks = 0, busyFor = 0;
  const commands: Array<{ skill?: string; arguments?: unknown }> = [], lines: string[] = [], holds: string[] = [];
  const control = {
    arrivedAt: () => arrived, observe: () => current,
    frame: () => ({ poll: { skills: [{ name: 'attack-continuously' }, { name: 'dig-shelter' }, { name: 'flee-from' }] } }),
    store: { pending: () => (pendingChecks++ < busyFor ? [{ command: { id: 'fca-skill', kind: 'skill', context: { taskId: 'task' } } }] : []),
      command: (id: string) => commands.some(command => (command as { id?: string }).id === id) },
    async command(input: { id: string; skill?: string; arguments?: unknown }) { commands.push(input); return { id: input.id, outcome: 'completed', inputsReleased: true }; },
  } as unknown as MinecraftControl;
  let active: string | undefined, interrupted = 0, touched = 0;
  const governor = createReflexGovernor();
  const step = { id: 'step', taskId: 'task', lease: { id: 'lease', holder: 'runner', generation: 1 } } as unknown as TaskStep;
  const judge = createMinecraftFastJudgment({ control, step, governor, now: () => clock,
    context: (bodyId, sessionId) => ({ scopeKey: 'owner', taskId: 'task', taskRevision: 1, bodyId, sessionId, generation: 1 }) as never,
    permit: async () => true, activeAction: () => active ? { name: active } : undefined, interrupt: () => { interrupted += 1; active = undefined; },
    touched: () => { touched += 1; }, stepOutcome: () => {}, unknown: () => {}, send: () => {}, hold: reason => { holds.push(reason); },
    log: line => { lines.push(line); } });
  const signal = new AbortController().signal;
  return { commands, lines, holds, get interrupted() { return interrupted; }, get touched() { return touched; },
    see(world: Record<string, unknown>, facts: Record<string, unknown> = {}) {
      clock += 250;
      current = frame(Math.floor(clock / 250), clock, world, facts);
      return judge.consider('minecraft:world', current, () => true, signal);
    },
    running(name: string | undefined) { active = name; }, busy(polls: number) { busyFor = polls; pendingChecks = 0; },
    respawn() { arrived = clock; }, advance(ms: number) { clock += ms; },
    onBusy(change: () => void) { const original = control.store.pending; (control.store as { pending: unknown }).pending = (...args: unknown[]) => { change(); return (original as (...a: unknown[]) => unknown)(...args); }; } };
}

describe('a deterministic replay of Minecraft run 11\'s death loop (task 7e4c437a, 2026-10-15 01:41–01:43 JST)', () => {
  it('keeps her fight running while it holds, takes shelter at the floor of her health, and never just stops', async () => {
    const body = fakeBody();
    body.advance(60_000);
    body.running('mc.attack-continuously');
    // 01:41:14.8–17.6: a zombie at 1–2 m, health 17 → 14 → 11 → 8 → 5 while she fights. The old danger reflex stopped the fight
    // here, could not get a picture, and she stood still until she died.
    for (const health of [17, 17, 14, 14, 11, 11, 8, 8]) expect(body.see({ health, nearbyThreats: [zombie(1.5)] })).toBeNull();
    expect(body.commands).toEqual([]);
    expect(body.interrupted).toBe(0);
    expect(body.holds).toContain('fca_defending');
    // Health 5: out of the fight, into the ground (the judgment had seen danger for many frames already).
    await body.see({ health: 5, nearbyThreats: [zombie(1.2)] });
    expect(body.interrupted).toBe(1);
    expect(body.commands.map(command => command.skill)).toEqual(['dig-shelter']);
    expect(body.lines.some(line => /kind=shelter rule=low_health_shelter skill=dig-shelter entryToDispatchMs=\d+ outcome=completed/u.test(line))).toBe(true);
  });

  it('takes shelter first after each respawn, before any decision of hers, inside the spawn grace', async () => {
    const body = fakeBody();
    for (let death = 0; death < 5; death++) {
      body.advance(40_000);
      body.respawn();
      // 01:42:10–01:43:28: back at the spawn point with zombies around, she died within 2–25 s each time.
      body.see({ health: 20, nearbyThreats: [zombie(7), zombie(10)] });
      await body.see({ health: 20, nearbyThreats: [zombie(6.5), zombie(9)] });
    }
    expect(body.commands.map(command => command.skill)).toEqual(Array(5).fill('dig-shelter'));
    expect(body.touched).toBe(5);
  });

  it('never sends a stale answer: a death while the old skill settles drops it (0 stale executions)', async () => {
    const body = fakeBody();
    body.advance(60_000);
    body.running('mc.move-to');
    body.busy(3);
    let changed = false;
    // While the cut-off skill settles, she dies and respawns: the answer judged before is from another life.
    body.onBusy(() => { if (!changed) { changed = true; body.respawn(); } });
    body.see({ health: 15, nearbyThreats: [zombie(3)] });
    await body.see({ health: 15, nearbyThreats: [zombie(3)] });
    expect(body.commands).toEqual([]);
    expect(body.holds).toContain('fast_stale');
    expect(body.lines.some(line => line.includes('reason=stale'))).toBe(true);
  });
});
