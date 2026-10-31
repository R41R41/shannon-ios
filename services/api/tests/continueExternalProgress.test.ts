import { afterEach, expect, it } from 'vitest';
import { externalWorkMilestones, forgetStalls, noteProgress } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { setIncidentHoldPort } from '../src/wiring/minecraftIncidentHold.js';
import { benchC, until } from './helpers/benchC.js';

afterEach(forgetStalls);
const snapshot = (externalWork: string[] = []) => ({ node: 'gear', state: 'continue', milestone: 'obsidian', items: 492, externalWork });
it('credits external job phase changes once and still holds when collection never happens', () => {
  expect(noteProgress('t', snapshot(), 0)).toBeNull();
  expect(noteProgress('t', snapshot(['furnace:started']), 8_000)).toBeNull();
  expect(noteProgress('t', snapshot(['furnace:started', 'furnace:verification_due']), 98_000)).toBeNull();
  expect(noteProgress('t', snapshot(['furnace:started', 'furnace:verification_due']), 132_000)).toBeNull();
  expect(noteProgress('t', snapshot(['furnace:started', 'furnace:verification_due']), 218_000)?.kind).toBe('node_stalled');
});
const job = (over: Record<string, unknown> = {}) => ({ status: 'waiting_external', position: { x: 22, y: 5, z: 1 }, input: 'raw_iron', count: 9, remainingEstimateMs: 90_000, completionVerified: false, ...over });
const frame = (jobs: unknown) => ({ state: { world: { jobs } } }) as never;
const observed = (jobs: unknown) => snapshot(externalWorkMilestones(frame(jobs)));
it('uses observed phases, leaves completion unverified, and ignores malformed or unrelated jobs', () => {
  const started = externalWorkMilestones(frame([job()]));
  expect(started).toHaveLength(1);
  expect(externalWorkMilestones(frame([job({ remainingEstimateMs: 50_000 })]))).toEqual(started);
  const due = externalWorkMilestones(frame([job({ status: 'verification_due', remainingEstimateMs: 0 })]));
  expect(due).toHaveLength(2);
  expect(due).toContain(started[0]);
  expect(due.join()).not.toContain('completed');
  for (const v of [null, {}, [null], [job({ status: 'different_dimension' })], [job({ position: null })], [job({ count: null })], [job({ remainingEstimateMs: NaN })], [job({ status: 'verification_due' })]]) {
    expect(externalWorkMilestones(frame(v))).toEqual([]);
  }
});
it('does not renew the window from a stale/decreasing countdown or missing and returning rows', () => {
  noteProgress('t', observed([job()]), 0);
  expect(noteProgress('t', observed([job({ remainingEstimateMs: 30_000 })]), 60_000)).toBeNull();
  expect(noteProgress('t', observed(null), 110_000)).toBeNull();
  expect(noteProgress('t', observed([job()]), 120_000)?.kind).toBe('node_stalled');
});
it('does not renew from an already seen verification phase after an incomplete observation', () => {
  const due = job({ status: 'verification_due', remainingEstimateMs: 0 });
  noteProgress('t', observed([job()]), 0);
  expect(noteProgress('t', observed([due]), 90_000)).toBeNull();
  expect(noteProgress('t', observed(null), 150_000)).toBeNull();
  expect(noteProgress('t', observed([job()]), 170_000)).toBeNull();
  expect(noteProgress('t', observed([due]), 210_000)?.kind).toBe('node_stalled');
});

it('the real step reads furnace phases before deciding whether to hold the same node', async () => {
  let held = 0, offset = 0, jobs: unknown[] = [];
  setIncidentHoldPort({ holdRequested: () => true, heldMs: () => offset,
    hold: async () => { held++; return true; }, notHeld: () => undefined, bodyHeld: async () => true,
    resumePending: () => null, resumeChecked: () => undefined });
  const bench = benchC({ scene: 'external-progress', run: 'external-progress' });
  const observation = bench.body.observation.bind(bench.body);
  bench.body.observation = () => {
    const f = observation();
    return { ...f, state: { ...f.state, world: { ...(f.state.world as object), jobs } } } as typeof f;
  };
  try {
    await bench.begin();
    await bench.planUpdate('計画', { ops: [{ op: 'add', title: '防具', doneWhen: 'have:iron_leggings' }] });
    const life = bench.lifecycle(), stop = new AbortController();
    const look = async (seconds: number) => { offset = -seconds * 1_000; await bench.spin(); await life.beforeDecision!(stop.signal); };
    await look(0);
    jobs = [job()]; await look(8);
    jobs = [job({ status: 'verification_due', remainingEstimateMs: 0 })]; await look(98);
    await look(132);
    expect(held).toBe(0);
    await look(220);
    expect(await until(() => held === 1)).toBe(true);
    expect(bench.body.takes).toHaveLength(1);
  } finally { bench.close(); setIncidentHoldPort(null); }
}, 30_000);
