import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { currentActionExecution } from '../src/infra/context/actionExecution.js';
import { FcaNoResponseError } from '../src/mind/action/fca/fcaNoResponse.js';
import type { FcaBodyLifecycle, FcaModelInput, FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { actionHarness } from './support/actionThreadHarness.js';

/**
 * Minebot runs 12 and 13 (2026-10-16/17): a decision request failed with APIConnectionError / ETIMEDOUT, no answer came back, and the
 * step stayed unknown for three minutes until retired. A request that got no answer is now asked once more by the runner, after
 * 2-5 s and its own gate; a second failure, any other failure and a stop end as before.
 */
const at = '2026-10-17T09:00:00.000Z', closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });
const complete: FcaModelOutput = { decision: { kind: 'complete', summary: 'Done' }, history: [{ role: 'assistant', content: 'done' }] };

type Script = Array<'no_response' | 'unknown' | 'rejected' | 'http503' | 'ok'>;
function fixture(script: Script, options: { delay?: number; holdAfterFirst?: boolean; onDecide?(call: number): void } = {}) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = actionHarness(() => at); migrateAgentTasks(h.db);
  const inputs: FcaModelInput[] = [], bodyEvents: string[] = [];
  let calls = 0, holding = false, started = 0, closed = 0;
  const controller = new AbortController();
  const body: FcaBodyLifecycle = { start() { started += 1; bodyEvents.push('start'); }, revision: () => 0, context: () => ({ revision: 0, observation: null }),
    async guard() { return true; }, toolSignal: (_name, parent) => parent, async close() { closed += 1; bodyEvents.push('close'); } };
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => at, providerRetryDelayMs: () => 0,
    model: { async decide(input: FcaModelInput) {
      inputs.push(input); calls += 1; options.onDecide?.(calls);
      const execution = currentActionExecution()!;
      execution.modelOutcome = 'unknown'; // set by the adapter right before every send
      const step = script[calls - 1] ?? 'ok';
      if (step === 'no_response') { if (options.holdAfterFirst) holding = true; throw new FcaNoResponseError(); }
      if (step === 'unknown') throw new Error('FCA_MODEL_RESPONSE_UNKNOWN');
      if (step === 'http503') { execution.modelOutcome = 'acknowledged'; throw new Error('FCA_MODEL_HTTP_503'); }
      if (step === 'rejected') throw new Error('FCA_MODEL_TOOL_NOT_OFFERED');
      execution.modelOutcome = 'acknowledged';
      return complete;
    }, toolResults: results => ({ role: 'user', results }) },
    stepPorts: () => ({ body, decisionRetryDelayMs: () => options.delay ?? 0, executionAllowed: () => !holding }),
  });
  closes.push(() => driver.close(), () => h.close());
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '石', goal: '石を一つ集める' }, 'no-response');
  const events = () => (h.db.prepare('SELECT event_type FROM agent_task_events WHERE task_id=? ORDER BY rowid').all(task.id) as Array<{ event_type: string }>).map(row => row.event_type);
  return { h, driver, task, inputs, events, bodyEvents, controller, calls: () => calls, started: () => started, closed: () => closed,
    phase: () => driver.runtime.get('owner', task.id)?.phase, warnings: () => vi.mocked(console.warn).mock.calls.map(([line]) => String(line)) };
}

describe('a decision that got no answer is asked once more (Minebot runs 12 and 13)', () => {
  it('continues the same step when the second request is answered: one step, no unknown, one body monitor, the same input', async () => {
    const f = fixture(['no_response', 'ok']);
    await f.driver.tick(); await f.driver.drain();
    expect(f.calls()).toBe(2);
    expect(f.phase()).toBe('completed');
    expect(f.events()).not.toContain('fca_recovery_unknown');
    expect(f.inputs[1]).toBe(f.inputs[0]);
    expect(f.warnings().some(line => line.startsWith('Shannon FCA decision retried after no response task='))).toBe(true);
    expect(vi.mocked(console.log).mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('step unknown');
  });

  it('keeps the body monitor alive for the whole retry window: started once, not closed before the second request, closed only by the step\'s end', async () => {
    const seen: string[][] = [];
    const f = fixture(['no_response', 'ok'], { delay: 30, onDecide: () => { seen.push([...f.bodyEvents]); } });
    await f.driver.tick(); await f.driver.drain();
    expect(seen).toEqual([['start'], ['start']]);
    expect(f.started()).toBe(1);
    expect(f.bodyEvents.slice(0, 1)).toEqual(['start']);
    expect(f.closed()).toBeGreaterThanOrEqual(1);
    expect(f.calls()).toBe(2);
  });

  it('waits before asking again, and never asks a third time: a second failure ends as it did before (unknown)', async () => {
    const f = fixture(['no_response', 'no_response', 'ok'], { delay: 30 });
    const begun = Date.now();
    await f.driver.tick(); await f.driver.drain();
    expect(Date.now() - begun).toBeGreaterThanOrEqual(25);
    expect(f.calls()).toBe(2);
    expect(f.phase()).toBe('unknown');
    expect(f.events()).toContain('fca_recovery_unknown');
    expect(vi.mocked(console.log).mock.calls.map(([line]) => String(line))).toContain(`Shannon FCA step unknown task=${f.task.id} code=FCA_MODEL_RESPONSE_UNKNOWN`);
  });

  it.each([['an unclassified unknown failure', 'unknown'], ['a failure after an answer arrived (a decision refused)', 'rejected']] as const)('does not ask again after %s', async (_label, kind) => {
    const f = fixture([kind, 'ok']);
    await f.driver.tick(); await f.driver.drain();
    expect(f.calls()).toBe(1);
    expect(f.warnings().some(line => line.includes('decision retried'))).toBe(false);
    expect(f.phase()).not.toBe('completed');
  });

  it('leaves the 5xx path as it was: the step is closed as continue and run again under a new action, with no in-step retry', async () => {
    const f = fixture(['http503', 'ok']);
    await f.driver.tick(); await f.driver.drain();
    await f.driver.tick(); await f.driver.drain();
    expect(f.calls()).toBe(2);
    expect(f.phase()).toBe('completed');
    expect(f.warnings().some(line => line.includes('decision retried'))).toBe(false);
    expect(vi.mocked(console.log).mock.calls.map(([line]) => String(line))).toContain(`Shannon FCA step retried task=${f.task.id} code=FCA_MODEL_HTTP_503`);
    expect(f.started()).toBe(2);
  });

  it('does not ask again when its own gate no longer allows the step after the wait (the retry is rechecked like the first request)', async () => {
    const f = fixture(['no_response', 'ok'], { holdAfterFirst: true });
    await f.driver.tick(); await f.driver.drain();
    expect(f.calls()).toBe(1);
    expect(f.phase()).toBe('unknown');
  });

  it('does not ask again once the step is stopped during the wait', async () => {
    const f = fixture(['no_response', 'ok'], { delay: 200 });
    await f.driver.tick();
    for (let i = 0; i < 200 && f.calls() < 1; i++) await new Promise(resolve => setTimeout(resolve, 2));
    await f.driver.stop(f.task.id, 'owner_stop');
    await f.driver.drain();
    expect(f.calls()).toBe(1);
  });
});
