import { describe, expect, it } from 'vitest';
import { fastBodyState, fastJudgment, type FastBodyState } from '../src/mind/action/reflex/fastJudgment.js';
import { createReflexGovernor } from '../src/mind/action/reflex/reflexGovernor.js';
import { createMinecraftFastJudgment } from '../src/surfaces/minecraft/minecraftFastJudgment.js';
import type { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

const NIGHT = 18_000;
const zombie = (distance: number) => ({ name: 'zombie', distance, canReachMe: true });
const calm = { ignited: false };
const frame = (sequence: number, at: number, world: Record<string, unknown>, facts: Record<string, unknown> = {},
  clocks: { skew?: number; receivedAgo?: number } = {}): BodyObservation => ({
  schemaVersion: 1, bodyId: 'minecraft:world', sequence, stateAt: new Date(at + (clocks.skew ?? 0)).toISOString(),
  receivedAt: new Date(at - (clocks.receivedAgo ?? 0)).toISOString(), connected: true,
  state: { world: { time: NIGHT, inventory: [{ name: 'stone_pickaxe', count: 1 }], ...world } }, facts: { alive: true, ...facts },
} as unknown as BodyObservation);
const state = (overrides: Partial<FastBodyState>): FastBodyState => ({ health: 20, threats: [], night: true, respawnedRecently: false,
  healthDropped: false, hasWeapon: false, floorActive: false, floorKnown: true, shelterFailed: false, ...overrides });
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
  let clock = 1_000_000, current: BodyObservation | null = null, arrived: number | null = 0, pendingChecks = 0, busyFor = 0, sequence = 0;
  const outcomes: string[] = [];
  const commands: Array<{ skill?: string; arguments?: unknown }> = [], lines: string[] = [], holds: string[] = [];
  const control = {
    arrivedAt: () => arrived, observe: () => current,
    frame: () => ({ poll: { skills: [{ name: 'attack-continuously' }, { name: 'dig-shelter' }, { name: 'flee-from' }] } }),
    store: { pending: () => (pendingChecks++ < busyFor ? [{ command: { id: 'fca-skill', kind: 'skill', context: { taskId: 'task' } } }] : []),
      command: (id: string) => commands.some(command => (command as { id?: string }).id === id) },
    async command(input: { id: string; skill?: string; arguments?: unknown }) { commands.push(input); return { id: input.id, outcome: outcomes.shift() ?? 'completed', inputsReleased: true }; },
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
    see(world: Record<string, unknown>, facts: Record<string, unknown> = {}, clocks: { skew?: number; receivedAgo?: number } = {}) {
      clock += 250;
      current = frame(++sequence, clock, world, facts, clocks);
      return judge.consider('minecraft:world', current, () => true, signal);
    },
    /** A newer frame that arrives while a job is in flight (nobody considers it yet). */
    arrive(world: Record<string, unknown>, facts: Record<string, unknown> = {}) { current = frame(++sequence, clock, world, facts); },
    judge, outcomes,
    running(name: string | undefined) { active = name; }, busy(polls: number) { busyFor = polls; pendingChecks = 0; },
    respawn() { arrived = clock; }, lose() { current = null; }, advance(ms: number) { clock += ms; },
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

describe('review findings on the fast judgment (F2, F3, F4, unknown floor)', () => {
  it('F2: judges a frame\'s age by the API\'s receive time, whatever the body\'s clock says', async () => {
    const lateBody = fakeBody();
    lateBody.running(undefined);
    // The body's clock runs 20 s behind (validation allows 30): its stateAt looks 20 s old, the frame is fresh.
    lateBody.see({ health: 15, nearbyThreats: [zombie(3)] }, {}, { skew: -20_000 });
    await lateBody.see({ health: 15, nearbyThreats: [zombie(3)] }, {}, { skew: -20_000 });
    expect(lateBody.commands.map(command => command.skill)).toEqual(['attack-continuously']);
    const aheadBody = fakeBody();
    // The body's clock runs 20 s ahead: stateAt looks fresh, but the API received the frame 4 s ago (limit 3 s).
    aheadBody.see({ health: 15, nearbyThreats: [zombie(3)] }, {}, { skew: 20_000 });
    await aheadBody.see({ health: 15, nearbyThreats: [zombie(3)] }, {}, { skew: 20_000, receivedAgo: 4_000 });
    expect(aheadBody.commands).toEqual([]);
    expect(aheadBody.judge.discarded().stale).toBe(1);
  });

  it('F3: an enemy flickering around the threshold cuts off her tool once per cooldown and sends nothing; every drop is counted', async () => {
    const body = fakeBody();
    body.advance(60_000);
    const flicker = async (round: number) => {
      body.running('mc.move-to');
      body.busy(2);
      let moved = false;
      // While her tool settles, the zombie steps back out of range: the answer judged before is stale.
      body.onBusy(() => { if (!moved) { moved = true; body.arrive({ health: 20, nearbyThreats: [zombie(9.5)] }); } });
      body.see({ health: 20, nearbyThreats: [zombie(5.5)] });
      await body.see({ health: 20, nearbyThreats: [zombie(5.5)] });
      expect(round).toBeGreaterThan(0);
    };
    await flicker(1);
    expect(body.interrupted).toBe(1);
    expect(body.commands).toEqual([]);
    expect(body.judge.discarded().stale).toBe(1);
    // The next four seconds of the same flicker: held by the governor's danger cooldown, nothing interrupted.
    for (let i = 0; i < 4; i++) { body.running('mc.move-to'); for (const distance of [5.5, 5.5, 9.5, 9.5]) body.see({ health: 20, nearbyThreats: [zombie(distance)] }); }
    expect(body.interrupted).toBe(1);
    expect(body.holds).toContain('reflex_cooldown');
    // After the cooldown it may try again, and is counted again.
    body.advance(6_000);
    await flicker(2);
    expect(body.interrupted).toBe(2);
    expect(body.judge.discarded().stale).toBe(2);
  });

  it('F3: an answer that is already stale cuts nothing off', async () => {
    const body = fakeBody();
    body.running('mc.move-to');
    body.see({ health: 20, nearbyThreats: [zombie(3)] });
    await body.see({ health: 20, nearbyThreats: [zombie(3)] }, {}, { receivedAgo: 4_000 });
    expect(body.interrupted).toBe(0);
    expect(body.commands).toEqual([]);
    expect(body.judge.discarded().stale).toBe(1);
  });

  it('run 12: a frame just under the 3 s limit is acted on, just over it is dropped', async () => {
    const under = fakeBody();
    under.see({ health: 15, nearbyThreats: [zombie(3)] }, {}, { receivedAgo: 2_900 });
    await under.see({ health: 15, nearbyThreats: [zombie(3)] }, {}, { receivedAgo: 2_900 });
    expect(under.commands.map(command => command.skill)).toEqual(['attack-continuously']);
    const over = fakeBody();
    over.see({ health: 15, nearbyThreats: [zombie(3)] }, {}, { receivedAgo: 3_100 });
    await over.see({ health: 15, nearbyThreats: [zombie(3)] }, {}, { receivedAgo: 3_100 });
    expect(over.commands).toEqual([]);
    expect(over.judge.discarded().stale).toBe(1);
  });

  it('run 12: when the latest frame calls for another kind, that kind is sent instead of dropping the fight', async () => {
    const body = fakeBody();
    body.advance(60_000);
    body.running('mc.move-to');
    body.busy(2);
    let changed = false;
    // While her tool settles, her health falls to 10: the latest frame says shelter, not fight.
    body.onBusy(() => { if (!changed) { changed = true; body.arrive({ health: 10, nearbyThreats: [zombie(3)] }); } });
    body.see({ health: 20, nearbyThreats: [zombie(3)] });
    await body.see({ health: 20, nearbyThreats: [zombie(3)] });
    expect(body.commands.map(command => command.skill)).toEqual(['dig-shelter']);
    expect(body.judge.discarded().stale).toBe(0);
    expect(body.lines.some(line => line.includes('kind=shelter rule=ambiguous_shelter skill=dig-shelter'))).toBe(true);
  });

  it('run 12: still dropped when the body arrived again, when there is no frame, or when the latest frame calls for nothing', async () => {
    const lost = fakeBody();
    lost.advance(60_000);
    lost.running('mc.move-to');
    lost.busy(2);
    let gone = false;
    lost.onBusy(() => { if (!gone) { gone = true; lost.lose(); } });
    lost.see({ health: 20, nearbyThreats: [zombie(3)] });
    await lost.see({ health: 20, nearbyThreats: [zombie(3)] });
    expect(lost.commands).toEqual([]);
    expect(lost.judge.discarded().stale).toBe(1);
    const quiet = fakeBody();
    quiet.advance(60_000);
    quiet.running('mc.move-to');
    quiet.busy(2);
    let left = false;
    quiet.onBusy(() => { if (!left) { left = true; quiet.arrive({ health: 20, nearbyThreats: [] }); } });
    quiet.see({ health: 20, nearbyThreats: [zombie(3)] });
    await quiet.see({ health: 20, nearbyThreats: [zombie(3)] });
    expect(quiet.commands).toEqual([]);
    expect(quiet.judge.discarded().stale).toBe(1);
  });

  it('run 12: a drop before anything is cut off or sent arms no cooldown; a drop after a cut-off and a real action still do', async () => {
    const early = fakeBody();
    early.advance(60_000);
    early.running('mc.move-to');
    early.see({ health: 20, nearbyThreats: [zombie(3)] });
    await early.see({ health: 20, nearbyThreats: [zombie(3)] }, {}, { receivedAgo: 4_000 });
    expect(early.interrupted).toBe(0);
    expect(early.judge.discarded().stale).toBe(1);
    // The very next frames judge again, with no `reflex_cooldown` in between.
    early.see({ health: 20, nearbyThreats: [zombie(3)] });
    await early.see({ health: 20, nearbyThreats: [zombie(3)] });
    expect(early.holds).not.toContain('reflex_cooldown');
    expect(early.commands.map(command => command.skill)).toEqual(['attack-continuously']);
    // A real action that failed waits the danger cooldown.
    const failed = fakeBody();
    failed.advance(60_000);
    failed.outcomes.push('failed');
    failed.see({ health: 20, nearbyThreats: [zombie(3)] });
    await failed.see({ health: 20, nearbyThreats: [zombie(3)] });
    failed.see({ health: 20, nearbyThreats: [zombie(3)] });
    expect(failed.see({ health: 20, nearbyThreats: [zombie(3)] })).toBeNull();
    expect(failed.holds).toContain('reflex_cooldown');
    expect(failed.commands.length).toBe(1);
  });

  it('F4: after her shelter failed, the next choice of the same danger episode is to flee, and a new episode starts fresh', async () => {
    expect(kind(fastJudgment(state({ shelterFailed: true, respawnedRecently: true, threats: [{ ...zombie(8), ...calm }] })))).toBe('flee:shelter_failed_flee');
    expect(kind(fastJudgment(state({ shelterFailed: true, threats: [0, 1, 2].map(i => ({ ...zombie(3 + i), ...calm })) })))).toBe('flee:shelter_failed_flee');
    expect(kind(fastJudgment(state({ shelterFailed: true, threats: [{ ...zombie(3), ...calm }] })))).toBe('fight:melee_fight');
    const body = fakeBody();
    body.advance(60_000);
    body.outcomes.push('failed');
    const hurt = { health: 10, nearbyThreats: [zombie(3)] };
    body.see(hurt); await body.see(hurt);
    body.advance(6_000); // past the danger cooldown; the zombie is still there
    body.see(hurt); await body.see(hurt);
    expect(body.commands.map(command => command.skill)).toEqual(['dig-shelter', 'flee-from']);
    // The danger passes, then comes back: a new episode, shelter again.
    body.see({ health: 10, nearbyThreats: [] });
    body.advance(6_000);
    body.see(hurt); await body.see(hurt);
    expect(body.commands.map(command => command.skill)).toEqual(['dig-shelter', 'flee-from', 'dig-shelter']);
  });

  it('re-review 2: a choice that flickers between kinds never reaches an interrupt; two frames of the same kind do', async () => {
    const body = fakeBody();
    body.advance(60_000);
    const frameOf = (health: number) => ({ health, nearbyThreats: [zombie(3)] });
    body.see(frameOf(10)); // shelter (ambiguous), frame 1
    body.see(frameOf(20)); // fight, frame 1 of a new kind
    body.see(frameOf(10)); // shelter again, frame 1
    expect(body.commands).toEqual([]);
    body.see(frameOf(20)); await body.see(frameOf(20));
    expect(body.commands.map(command => command.skill)).toEqual(['attack-continuously']);
  });

  it('re-review 3: a shelter cut off by an interrupt (cancelled) does not count as failed, so the next choice is shelter again', async () => {
    const body = fakeBody();
    body.advance(60_000);
    body.outcomes.push('cancelled');
    const hurt = { health: 10, nearbyThreats: [zombie(3)] };
    body.see(hurt); await body.see(hurt);
    body.advance(6_000);
    body.see(hurt); await body.see(hurt);
    expect(body.commands.map(command => command.skill)).toEqual(['dig-shelter', 'dig-shelter']);
  });

  it('F4: a new life starts a new episode', async () => {
    const body = fakeBody();
    body.advance(60_000);
    body.outcomes.push('failed');
    const hurt = { health: 10, nearbyThreats: [zombie(3)] };
    body.see(hurt); await body.see(hurt);
    body.advance(6_000);
    body.respawn();
    body.see(hurt); await body.see(hurt);
    expect(body.commands.map(command => command.skill)).toEqual(['dig-shelter', 'dig-shelter']);
  });

  it('unknown floor: a body that does not say holds only while its retreat could run; a known floor is unchanged', () => {
    const unknown = (threats: FastBodyState['threats'], overrides: Partial<FastBodyState> = {}) => kind(fastJudgment(state({ floorKnown: false, threats, ...overrides })));
    expect(unknown([{ ...zombie(3), ...calm }])).toBe('fight:melee_fight');
    expect(unknown([{ ...zombie(3), ...calm }], { respawnedRecently: true })).toBe('shelter:respawn_shelter');
    expect(unknown([{ name: 'creeper', distance: 4, canReachMe: true, ignited: false }])).toBe('hold:floor_unknown');
    expect(unknown([{ name: 'creeper', distance: 5.5, canReachMe: true, ignited: false }])).toBe('flee:creeper_flee');
    expect(unknown([{ name: 'skeleton', distance: 7, canReachMe: true, ignited: false }])).toBe('hold:floor_unknown');
    // Re-review 1: low health acts even when the floor is unknown (a skeleton in range, health 4: shelter, not hold).
    expect(unknown([{ name: 'skeleton', distance: 5, canReachMe: true, ignited: false }], { health: 4 })).toBe('flee:low_health_flee');
    expect(unknown([{ name: 'skeleton', distance: 2, canReachMe: true, ignited: false }], { health: 4 })).toBe('shelter:low_health_shelter');
    expect(unknown([{ name: 'skeleton', distance: 7, canReachMe: true, ignited: false }], { health: 7 })).toBe('hold:floor_unknown');
    expect(kind(fastJudgment(state({ floorKnown: true, threats: [{ name: 'skeleton', distance: 7, canReachMe: true, ignited: false }] })))).toBe('shelter:ranged_shelter');
    expect(fastBodyState(frame(1, 0, { health: 20 }), { earlierHealth: null, sinceArrivalMs: null })).toMatchObject({ floorKnown: false, floorActive: false });
    expect(fastBodyState(frame(1, 0, { health: 20 }, { floorActive: false }), { earlierHealth: null, sinceArrivalMs: null })).toMatchObject({ floorKnown: true });
  });
});
