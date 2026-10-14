import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { heldBeforeAnyEffect } from '../src/wiring/taskRuntimeWiring.js';
import { currentActionExecution } from '../src/infra/context/actionExecution.js';
import type { FcaBodyLifecycle, FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaToolSelector } from '../src/mind/selectors/fcaToolSelection.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { actionHarness } from './support/actionThreadHarness.js';

/**
 * Minecraft run 8 (2026-10-14, task a25c070d): a step was held (FCA_EXECUTION_HELD) right after a compaction, before its decision,
 * with nothing sent to the body; the task was paused as unknown and retired. Such a step is now closed as `continue` and the task
 * goes on; a hold after the decision, or after anything reached the body, stays unknown as before.
 */
const at = '2026-10-14T09:49:17.000Z', closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });

type Hold = 'selection' | 'decision' | 'none';
function fixture(options: { holdAt: Hold; bodyActs?: boolean }) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = actionHarness(() => at); migrateAgentTasks(h.db);
  let holding = false, held = false, decisions = 0;
  // Held once, at that point of the first step.
  const hold = (where: Hold) => {
    if (options.holdAt !== where || held) return;
    held = true;
    holding = true;
  };
  const selector: FcaToolSelector = { async select(request) { hold('selection'); return { names: request.tools.map(tool => tool.name), source: 'catalog' }; } };
  const body = (): FcaBodyLifecycle => ({
    // As a reflex that started on its own and reached the body before the decision.
    start() { const execution = currentActionExecution(); if (execution && options.bodyActs) execution.stepOutcome = 'acknowledged'; },
    revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
    toolSignal: (_name, parent) => parent, async close() {},
  });
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => at,
    model: { async decide(_input: FcaModelInput) {
      decisions += 1; hold('decision');
      return { decision: { kind: 'complete', summary: 'Done' }, history: [{ role: 'assistant', content: 'done' }] };
    }, toolResults: results => ({ role: 'user', results }) },
    stepPorts: () => ({ selector, executionAllowed: () => !holding, ...(options.bodyActs !== undefined ? { body: body() } : {}) }),
  });
  closes.push(() => driver.close(), () => h.close());
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '石', goal: '石を一つ集める' }, 'held-step');
  const events = () => (h.db.prepare("SELECT event_type FROM agent_task_events WHERE task_id=? ORDER BY rowid").all(task.id) as Array<{ event_type: string }>)
    .map(row => row.event_type);
  return { h, driver, task, events, release: () => { holding = false; }, decisions: () => decisions };
}

describe('a step held before its decision with nothing sent outside (c)', () => {
  it('is closed as continue, the task goes on and completes on its next step', async () => {
    const f = fixture({ holdAt: 'selection' });
    await f.driver.tick(); await f.driver.drain();
    expect(f.decisions()).toBe(0);
    expect(f.events()).not.toContain('fca_recovery_unknown');
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('ready');
    expect(vi.mocked(console.log).mock.calls.map(([line]) => String(line))).toContain(`Shannon FCA step held_retried task=${f.task.id} code=FCA_EXECUTION_HELD`);
    f.release();
    await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)).toMatchObject({ phase: 'completed', summary: 'Done' });
  });

  it('stays unknown when something reached the body before the hold (a reflex)', async () => {
    const f = fixture({ holdAt: 'selection', bodyActs: true });
    await f.driver.tick(); await f.driver.drain();
    expect(f.events()).toContain('fca_recovery_unknown');
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('unknown');
  });

  it('stays unknown when the hold comes after the decision was asked for', async () => {
    const f = fixture({ holdAt: 'decision', bodyActs: false });
    await f.driver.tick(); await f.driver.drain();
    expect(f.decisions()).toBe(1);
    expect(f.events()).toContain('fca_recovery_unknown');
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('unknown');
  });
});

describe('heldBeforeAnyEffect', () => {
  it('admits only an execution hold before the decision with no executor, model call in doubt or write in flight', () => {
    expect(heldBeforeAnyEffect('FCA_EXECUTION_HELD', {})).toBe(true);
    expect(heldBeforeAnyEffect('FCA_HISTORY_HELD', { modelOutcome: 'acknowledged' })).toBe(true);
    expect(heldBeforeAnyEffect('FCA_SOURCE_WITHHELD', {})).toBe(false);
    expect(heldBeforeAnyEffect('FCA_MODEL_RESPONSE_UNKNOWN', {})).toBe(false);
    expect(heldBeforeAnyEffect('FCA_EXECUTION_HELD', { decisionRequested: true })).toBe(false);
    expect(heldBeforeAnyEffect('FCA_EXECUTION_HELD', { stepOutcome: 'acknowledged' })).toBe(false);
    expect(heldBeforeAnyEffect('FCA_EXECUTION_HELD', { stepOutcome: 'unknown' })).toBe(false);
    expect(heldBeforeAnyEffect('FCA_EXECUTION_HELD', { modelOutcome: 'unknown' })).toBe(false);
    expect(heldBeforeAnyEffect('FCA_EXECUTION_HELD', { writeInFlight: true })).toBe(false);
  });
});
