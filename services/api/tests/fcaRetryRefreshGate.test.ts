import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { currentActionExecution } from '../src/infra/context/actionExecution.js';
import { FcaNoResponseError } from '../src/mind/action/fca/fcaNoResponse.js';
import { FCA_TRANSIENT_UNSUPPORTED } from '../src/mind/action/fca/fcaTransientFallback.js';
import type { FcaBodyLifecycle, FcaModelInput, FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaObservationLifecycle } from '../src/mind/action/fca/fcaObservation.js';
import { toolOk } from '../src/mind/tools/shannonTools.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { BASE_CATALOG } from './fcaCoreToolsHarness.js';

/**
 * Third round on the provider retry (re-review of bc52364): the request asked again after a long wait is rebuilt from the body's
 * present observation, which can take time (it waits for a reflex session); the step's whole gate must run again AFTER that, right
 * before the request is sent (M-A), and a transient task's fallback to the legacy shape must start from the request in hand, with the
 * observation its decision is judged against, not from the first one (M-B). Also what a rebuilt request carries (freshen).
 */
const at = '2026-10-19T09:00:00.000Z', closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });
const complete: FcaModelOutput = { decision: { kind: 'complete', summary: 'Done' }, history: [{ role: 'assistant', content: 'done' }] };

/** `unsupported_slow`: the attempt takes eleven seconds before it is refused for its betas; `no_response` takes as long before it fails. */
type Script = Array<'no_response' | 'unsupported' | 'unsupported_slow' | 'ok'>;
interface Live { revision: number; observation: number; progress: number; alone: boolean; sources: boolean; allowed: boolean; transientMark: number }

function fixture(script: Script, options: { transient?: boolean; onDecide?(call: number, live: Live): void; onGuard?(live: Live): void } = {}) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  let offset = 0;
  const real = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
  const h = actionHarness(() => at); migrateAgentTasks(h.db);
  const inputs: FcaModelInput[] = [], guards: number[] = [], observationGuards: number[] = [];
  const live: Live = { revision: 3, observation: 1, progress: 1, alone: true, sources: true, allowed: true, transientMark: 1 };
  let calls = 0, armed = false;
  const body: FcaBodyLifecycle = { start() {}, revision: () => live.revision, context: () => ({ revision: live.revision, observation: null }),
    async guard(revision: number) {
      guards.push(revision);
      if (armed) { armed = false; options.onGuard?.(live); }
      return revision === live.revision;
    },
    toolSignal: (_name, parent) => parent, async close() {}, transient: () => ({ mark: live.transientMark }) };
  const observation: FcaObservationLifecycle = { start() {}, revision: () => live.observation, context: () => ({ revision: live.observation, observation: null }),
    async guard(revision: number) { observationGuards.push(revision); return revision === live.observation; }, toolSignal: (_name, parent) => parent, async close() {} };
  const tools = { definitions: BASE_CATALOG, execute: async () => toolOk('{}'),
    progress: { context: () => ({ version: live.progress }), observed() {}, verifyCompletion: async () => ({ status: 'verified' }) } };
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => live.alone, now: () => at, providerRetryDelayMs: () => 0,
    model: { async decide(input: FcaModelInput) {
      inputs.push(input); calls += 1;
      const execution = currentActionExecution()!;
      execution.modelOutcome = 'unknown';
      const next = script[calls - 1] ?? 'ok';
      // A slow attempt takes eleven seconds; whatever the body did meanwhile is set by the test.
      if (next === 'no_response' || next === 'unsupported_slow') offset += 11_000;
      options.onDecide?.(calls, live);
      if (next === 'no_response') { armed = true; throw new FcaNoResponseError(); }
      if (next === 'unsupported' || next === 'unsupported_slow') { armed = true; throw new Error(FCA_TRANSIENT_UNSUPPORTED); }
      execution.modelOutcome = 'acknowledged';
      return complete;
    }, toolResults: results => ({ role: 'user', results }) },
    stepPorts: () => ({ body, observations: [observation], tools: tools as never, decisionRetryDelayMs: () => 0,
      sourcesVisible: () => live.sources, executionAllowed: () => live.allowed,
      ...(options.transient ? { selector: { async select(request: { tools: ReadonlyArray<{ name: string }> }) {
        return { names: request.tools.map(tool => tool.name).filter(name => /^(mc|minecraft)\./u.test(name)), source: 'jev' as const };
      } } as never, keepBodyTools: () => true, obsMode: 'transient' as const } : {}) }),
  });
  closes.push(() => driver.close(), () => h.close());
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '石', goal: '石を一つ集める' }, 'refresh-gate');
  const run = async () => { await driver.tick(); await driver.drain(); };
  return { driver, task, inputs, guards, observationGuards, live, run, calls: () => calls, phase: () => driver.runtime.get('owner', task.id)?.phase,
    warnings: () => vi.mocked(console.warn).mock.calls.map(([line]) => String(line)) };
}

describe('the whole gate runs again after the request is rebuilt, right before it is sent (M-A)', () => {
  it.each([
    ['the owner is no longer alone', (live: Live) => { live.alone = false; }, 'reason=owner_not_alone', undefined],
    ['internal execution is no longer allowed', (live: Live) => { live.allowed = false; }, 'reason=execution_disallowed', undefined],
    ['the pinned sources are no longer visible', (live: Live) => { live.sources = false; }, undefined, 'FCA_SOURCE_WITHHELD'],
  ] as const)('sends nothing when %s while the request is being rebuilt', async (_label, change, heldReason, withheld) => {
    const f = fixture(['no_response', 'ok'], { onGuard: change });
    await f.run();
    expect(f.calls()).toBe(1); // the second request was never sent
    expect(f.phase()).not.toBe('completed');
    if (heldReason) expect(f.warnings().some(line => line.includes('Shannon FCA execution held') && line.includes(heldReason))).toBe(true);
    if (withheld) expect(f.warnings().concat(vi.mocked(console.log).mock.calls.map(([line]) => String(line))).join('\n')).toContain(withheld);
    // The rebuilding itself did run (it is what the gate came after), and the refresh log was written before the gate refused.
    expect(f.guards.length).toBeGreaterThan(1);
    expect(f.warnings().some(line => line.includes('request refreshed'))).toBe(true);
  });

  it('still sends the request when nothing changed meanwhile', async () => {
    const f = fixture(['no_response', 'ok'], { onGuard: () => {} });
    await f.run();
    expect(f.calls()).toBe(2);
    expect(f.phase()).toBe('completed');
  });
});

describe('what a rebuilt request carries (freshen)', () => {
  it('takes the body\'s, the observations\', the progress\' and the transient state anew, keeps the rest, and judges the decision against the new revisions', async () => {
    const f = fixture(['no_response', 'ok'], { transient: true, onDecide: (call, live) => {
      if (call === 1) { live.revision = 7; live.observation = 5; live.progress = 2; live.transientMark = 9; }
    } });
    await f.run();
    expect(f.calls()).toBe(2);
    const [first, second] = f.inputs as [FcaModelInput, FcaModelInput];
    expect(first.body?.revision).toBe(3);
    expect(second.body?.revision).toBe(7);
    expect(first.observations?.[0]?.revision).toBe(1);
    expect(second.observations?.[0]?.revision).toBe(5);
    expect(first.progress).toEqual({ version: 1 });
    expect(second.progress).toEqual({ version: 2 });
    expect(first.transient).toEqual({ mark: 1 });
    expect(second.transient).toEqual({ mark: 9 });
    expect(second.coreTools).toBe(first.coreTools); // nothing but the live parts changed
    expect(second.history).toBe(first.history);
    expect(second.tools).toBe(first.tools);
    expect(second.task).toBe(first.task);
    // The body and the observation were settled again (guarded at their present revision) before the second request ...
    expect(f.guards).toContain(7);
    expect(f.observationGuards).toContain(5);
    // ... and the decision is judged against those revisions, not the first ones: it is not discarded as stale.
    expect(f.phase()).toBe('completed');
  });
});

describe('the fallback to the legacy shape starts from the request in hand (M-B)', () => {
  it('asks in the legacy shape with the observation the retry rebuilt, and the decision is judged against that observation', async () => {
    const f = fixture(['no_response', 'unsupported', 'ok'], { transient: true, onDecide: (call, live) => {
      if (call === 1) { live.revision = 7; live.observation = 5; live.progress = 2; }
    } });
    await f.run();
    expect(f.calls()).toBe(3);
    const legacy = f.inputs[2]!;
    expect(f.inputs[1]!.coreTools).toBeDefined(); // the retry was still the transient shape
    expect(legacy.coreTools).toBeUndefined();
    expect(legacy.transient).toBeUndefined();
    expect(legacy.replayTokenLimit).toBeUndefined();
    // Not the first request's observation (revision 3): the one the retry rebuilt, which the revisions the decision is judged by name.
    expect(legacy.body?.revision).toBe(7);
    expect(legacy.observations?.[0]?.revision).toBe(5);
    expect(legacy.progress).toEqual({ version: 2 });
    expect(f.phase()).toBe('completed');
    expect(f.warnings().some(line => line.includes('fca_obs_mode_fallback'))).toBe(true);
  });

  it('rebuilds it once more when the attempt that was refused took long, so the legacy request is not older than ten seconds', async () => {
    const f = fixture(['no_response', 'unsupported_slow', 'ok'], { transient: true, onDecide: (call, live) => {
      if (call === 1) live.revision = 7;
      if (call === 2) { live.revision = 9; live.observation = 6; } // the refused attempt took eleven seconds, and the body moved meanwhile
    } });
    await f.run();
    expect(f.calls()).toBe(3);
    expect(f.inputs[2]!.body?.revision).toBe(9);
    expect(f.inputs[2]!.observations?.[0]?.revision).toBe(6);
    expect(f.phase()).toBe('completed');
  });

  it('runs the gate before and after that second rebuilding, and sends nothing if it refuses', async () => {
    const f = fixture(['unsupported_slow', 'ok'], { transient: true, onGuard: live => { live.alone = false; } });
    await f.run();
    // The only request was refused for its betas; the fallback is rebuilt (the attempt took eleven seconds) and the gate then refuses.
    expect(f.calls()).toBe(1);
    expect(f.warnings().some(line => line.includes('Shannon FCA execution held') && line.includes('reason=owner_not_alone'))).toBe(true);
  });
});
