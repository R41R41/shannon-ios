import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginTurnSteps, flushTurnSteps, markModelStart, timedStep } from '../src/infra/observer/turnSteps.js';
import { installObserverSink, observedStep, observerHandoff, withObserverRun } from '../src/infra/observer/observerContext.js';

/** 2026-10-13: ~9 s of a text turn sat before its model call in gaps no span named; the steps line names them. */
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(close => close()); vi.restoreAllMocks(); });

describe('turn steps line', () => {
  it('sums each closed step, marks the model start once, and prints numbers only', () => {
    let now = 100; const lines: string[] = []; const clock = () => now;
    const runId = 'A8FA88B3-1111-2222-3333-444455556666';
    beginTurnSteps(runId, clock);
    timedStep(runId, 'orchestration', () => { now += 12; }, clock);
    timedStep(runId, 'deterministic', () => { now += 3_200; }, clock);
    timedStep(runId, 'orchestration', () => { now += 3; }, clock);
    now += 40; markModelStart(runId, clock); now += 10; markModelStart(runId, clock);
    flushTurnSteps(runId, 'text', 9_000.4, line => lines.push(line));
    flushTurnSteps(runId, 'text', 1, line => lines.push(line)); // Written once.
    expect(lines).toEqual(['Shannon turn steps surface=text id=a8fa88b3 orchestration=15ms deterministic=3200ms model=3255ms total=9000ms']);
  });

  it('writes nothing for a run that measured no step, and only runs the work outside a run', () => {
    const lines: string[] = [];
    beginTurnSteps('run-1'); flushTurnSteps('run-1', 'autonomy', 3, line => lines.push(line));
    expect(timedStep(null, 'replay', () => 7)).toBe(7);
    expect(lines).toEqual([]);
  });

  it('is written when an observed turn ends, with the model start from its native handoff', async () => {
    cleanups.push(installObserverSink(() => {}));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await withObserverRun({ scopeKey: 'owner', surface: 'text' }, async () => {
      observedStep('threadSummary', () => 1);
      await Promise.resolve();
      observerHandoff('context', 'native', { surface: 'text' });
    });
    const lines = info.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('Shannon turn steps'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Shannon turn steps surface=text id=[0-9a-f]{8} threadSummary=\d+ms model=\d+ms total=\d+ms$/u);
    expect(observedStep('replay', () => 'outside')).toBe('outside');
    info.mockClear();
    await withObserverRun({ scopeKey: 'owner', surface: 'text', audience: 'others' }, async () => {
      observedStep('replay', () => 1); observerHandoff('context', 'native', { surface: 'text' });
    });
    expect(info.mock.calls.map(([line]) => String(line)).find(line => line.startsWith('Shannon turn steps'))).toMatch(/ model=\d+ms /u);
  });
});

describe('turn steps on the observer event', () => {
  it('puts the closed step names and rounded numbers on the turn terminal event, and nothing for a run without steps', async () => {
    const events: Array<{ node: string; kind: string; output?: unknown }> = [];
    cleanups.push(installObserverSink(event => events.push(event)));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await withObserverRun({ scopeKey: 'owner', surface: 'text' }, async () => {
      observedStep('identity', () => 1); observedStep('fcaContext', () => 2);
      observerHandoff('context', 'native', { surface: 'text' });
    });
    const done = events.find(event => event.node === 'turn' && event.kind === 'run.completed')!;
    const output = done.output as { status: string; steps: Record<string, number>; modelStartMs: number };
    expect(output.status).toBe('completed');
    expect(Object.keys(output.steps)).toEqual(['identity', 'fcaContext']);
    for (const value of Object.values(output.steps)) expect(Number.isInteger(value)).toBe(true);
    expect(Number.isInteger(output.modelStartMs)).toBe(true);
    events.length = 0;
    await withObserverRun({ scopeKey: 'owner', surface: 'autonomy' }, async () => {});
    expect(events.find(event => event.kind === 'run.completed')!.output).toEqual({ status: 'completed' });
    events.length = 0;
    await expect(withObserverRun({ scopeKey: 'owner', surface: 'text' }, async () => { observedStep('replay', () => 1); throw new Error('boom'); })).rejects.toThrow('boom');
    const failed = events.find(event => event.kind === 'span.failed')!.output as { status: string; steps: Record<string, number>; modelStartMs: null };
    expect(failed).toMatchObject({ status: 'failed', modelStartMs: null }); expect(Object.keys(failed.steps)).toEqual(['replay']);
  });
});
