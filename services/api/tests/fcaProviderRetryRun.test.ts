import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { createFcaBodyRecovery } from '../src/wiring/fcaBodyRecovery.js';
import { fcaBudget } from '../src/wiring/fcaBudgetWiring.js';
import { PROVIDER_UNAVAILABLE_SUMMARY } from '../src/wiring/taskRuntimeUnavailable.js';
import { TaskBudgetStore } from '../src/mind/action/taskRuntime/store/taskBudgetStore.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';

/**
 * Minebot parity audit C-20 (2026-10-19): a provider error ended a run. Here the real runner, the real SQLite store, the real
 * Anthropic adapter and its history codec meet a scripted provider that answers 5xx, 429, resets and timeouts before it succeeds.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const call = (name: string, id: string, value: unknown = {}) => ({ type: 'tool_use', name, id, input: value });
const errorBody = (type: string) => JSON.stringify({ type: 'error', error: { type, message: 'synthetic' } });
const answered = (status: number, headers: Record<string, string> = {}) => new Response(errorBody(status === 429 ? 'rate_limit_error' : 'api_error'),
  { status, headers: { 'content-type': 'application/json', ...headers } });
type Answer = Response | Array<Record<string, unknown>> | 'ETIMEDOUT' | 'ECONNRESET' | 'ECONNREFUSED';
const repeat = (count: number, make: () => Answer): Answer[] => Array.from({ length: count }, make);

function fixture(script: Answer[], options: { body?: boolean; cap?: number; suggested?: number[]; delay?: number; bodyCooldown?: number } = {}) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const provider = scriptedAnthropic((_body, index) => {
    const answer = script[index] ?? [call('fca_complete', `complete-${index}`, { summary: '終わり' })];
    if (typeof answer === 'string') throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection failed'), { code: answer }) });
    return answer instanceof Response ? answer : message(answer, 'tool_use');
  });
  const usages: AnthropicFcaUsage[] = [];
  const now = () => '2026-10-19T09:00:00.000Z';
  const h = actionHarness(now);
  const budgetStore = new TaskBudgetStore(h.db);
  const budget = fcaBudget({ actions: h.actions, store: budgetStore, now, minecraftRequest: () => true, ...(options.cap ? { taskCapYen: () => options.cap! } : {}) });
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: provider.fetcher, recordUsage: usage => { usages.push(usage); budget.recordUsage(usage.estimatedCostUsd); } });
  let only = '';
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now, budget,
    canRunTask: (_runtime, id) => id === only, providerRetryDelayMs: () => options.delay ?? 0, bodyUnavailableCooldownMs: () => options.bodyCooldown ?? 0,
    ...(options.body ? { bodyRecovery: recoveryParts => createFcaBodyRecovery({ ...recoveryParts, passMs: 0,
      body: { bound: () => 'minecraft:world', connected: () => true, release: async () => ({ code: 'released', actionIds: [], detail: '' }) } }) } : {}),
    stepPorts: () => ({ history: { codec: anthropicFcaHistoryCodec },
      ...(options.suggested ? { decisionRetryDelayMs: (suggested: number) => { options.suggested!.push(suggested); return 0; } } : {}) }) });
  cleanups.push(async () => { await driver.close(); h.close(); });
  const root = driver.runtime.ensureRoot('owner');
  const parent = driver.runtime.createChild('owner', root.id, { title: 'conversation', goal: 'talk' }, 'request-parent');
  const child = driver.runtime.createChild('owner', parent.id, { title: '採掘', goal: '石を集める' }, 'request-child');
  only = child.id;
  const phase = () => driver.runtime.get('owner', child.id)?.phase;
  const rounds = () => (h.db.prepare('SELECT entries_json FROM fca_task_history WHERE task_id=? ORDER BY sequence').all(child.id) as Array<{ entries_json: string }>)
    .map(row => JSON.parse(row.entries_json) as unknown[]);
  const events = () => (h.db.prepare('SELECT event_type FROM agent_task_events WHERE task_id=? ORDER BY rowid').all(child.id) as Array<{ event_type: string }>).map(row => row.event_type);
  const logs = () => vi.mocked(console.log).mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('Shannon FCA step'));
  const warnings = () => vi.mocked(console.warn).mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('Shannon FCA decision'));
  const run = async (until: () => boolean = () => ['completed', 'failed', 'unknown', 'stopped'].includes(phase() ?? '')) => {
    for (let i = 0; i < 80 && !until(); i++) { await driver.tick(); await driver.drain(); }
  };
  return { h, driver, child, provider, usages, budgetStore, phase, rounds, events, logs, warnings, run };
}

describe('a decision is asked again inside its step after a provider error (C-20)', () => {
  it('completes after two server errors and a throttling in one step: one step, requests identical, one history round, nothing booked for the errors', async () => {
    const suggested: number[] = [];
    const f = fixture([answered(503), answered(529), answered(429, { 'retry-after': '9' }), [call('task_list', 'list-1')]], { suggested });
    await f.run();
    expect(f.phase()).toBe('completed');
    expect(f.provider.bodies).toHaveLength(5); // three failures, the tool step, the completing step
    // The same request is sent each time: a failed attempt changes nothing the next one carries.
    for (const body of f.provider.bodies.slice(1, 4)) expect(JSON.stringify(body)).toBe(JSON.stringify(f.provider.bodies[0]));
    // Exponential backoff (2 s, 4 s), and the provider's retry-after (9 s) when it asks for more than the backoff (8 s).
    expect(suggested).toHaveLength(3);
    expect(suggested[0]).toBeGreaterThanOrEqual(1_500);
    expect(suggested[0]).toBeLessThanOrEqual(2_500);
    expect(suggested[1]).toBeGreaterThanOrEqual(3_000);
    expect(suggested[1]).toBeLessThanOrEqual(5_000);
    expect(suggested[2]).toBeGreaterThanOrEqual(9_000);
    expect(suggested[2]).toBeLessThanOrEqual(10_000);
    expect(f.logs()).toEqual([]); // no step was closed and run again
    expect(f.warnings().filter(line => line.includes('decision retry'))).toHaveLength(3);
    // The failed attempts left no history: the tool step and the completing step are the only rounds, each non-empty.
    expect(f.rounds()).toHaveLength(2);
    expect(f.rounds().every(entries => entries.length > 0)).toBe(true);
    // An answered error is no decision and no charge: only the two answers that came back are booked, both complete.
    expect(f.usages).toHaveLength(2);
    expect(f.usages.every(usage => usage.usageComplete)).toBe(true);
  });

  it('completes after resets and a timeout, booking each request that the provider may have processed at a bound sized by the request', async () => {
    const f = fixture(['ECONNRESET', 'ETIMEDOUT', [call('task_list', 'list-1')]]);
    await f.run();
    expect(f.phase()).toBe('completed');
    expect(f.provider.bodies).toHaveLength(4);
    const unknown = f.usages.filter(usage => !usage.usageComplete);
    expect(unknown).toHaveLength(2);
    // Sized by the request (about nine thousand tokens), not a whole context: the whole context's bound is a dollar for this model.
    for (const usage of unknown) {
      expect(usage.estimatedCostUsd).toBeGreaterThan(0.001);
      expect(usage.estimatedCostUsd).toBeLessThan(0.05);
    }
    expect(f.rounds()).toHaveLength(2);
    expect(f.events()).not.toContain('fca_recovery_unknown');
  });

  it('books nothing for a request that never left this machine, however often it is asked again', async () => {
    const f = fixture(['ECONNREFUSED', 'ECONNREFUSED', 'ECONNREFUSED', 'ECONNREFUSED', [call('task_list', 'list-1')]]);
    await f.run();
    expect(f.phase()).toBe('completed');
    expect(f.usages.filter(usage => !usage.usageComplete)).toEqual([]);
    expect(f.provider.bodies).toHaveLength(6);
  });

  it('accounts a retried step in the task budget: the yen of the answers and of the requests that may have been charged, nothing for answered errors', async () => {
    const f = fixture([answered(503), 'ETIMEDOUT', [call('task_list', 'list-1')]]);
    await f.run();
    const spent = f.budgetStore.spent(f.child.id);
    const total = f.usages.reduce((sum, usage) => sum + usage.estimatedCostUsd, 0);
    expect(f.usages).toHaveLength(3); // the timeout, the tool step, the completing step
    expect(spent.yen).toBeGreaterThanOrEqual(Math.ceil(f.usages[1]!.estimatedCostUsd * 160));
    expect(spent.yen).toBeLessThanOrEqual(Math.ceil(total * 160) + 2);
    expect(spent.steps).toBe(2); // the tool step (with the timeout it retried) and the completing step
  });

  it('stops asking where the task\'s cap has no room for another request that may be charged, and the next step meets the cap', async () => {
    const f = fixture(['ETIMEDOUT', 'ETIMEDOUT', [call('task_list', 'list-1')]], { cap: 1 });
    await f.run();
    // The first timeout books more than the one yen the operator left this request: no second request is made.
    expect(f.provider.bodies).toHaveLength(1);
    expect(f.phase()).toBe('failed');
    expect(f.driver.runtime.get('owner', f.child.id)?.summary).toContain('上限');
    expect(f.budgetStore.spent(f.child.id).yen).toBeGreaterThanOrEqual(1);
  });
});

describe('a Minecraft request goes on through an outage of the provider and is paused, never failed', () => {
  it('runs five rounds of five attempts with a longer wait each time, then stops as paused with a summary and the closed reason', async () => {
    const f = fixture(repeat(40, () => answered(503)), { body: true });
    await f.run();
    expect(f.phase()).toBe('stopped');
    expect(f.driver.runtime.get('owner', f.child.id)).toMatchObject({ status: 'paused', pauseReason: 'fca_stopped', summary: PROVIDER_UNAVAILABLE_SUMMARY });
    expect(f.provider.bodies).toHaveLength(25); // five rounds
    expect(f.logs()).toEqual([...Array(4).fill(`Shannon FCA step retried task=${f.child.id} code=FCA_MODEL_HTTP_503`),
      `Shannon FCA step paused task=${f.child.id} code=FCA_MODEL_HTTP_503 reason=provider_unavailable`]);
    expect(f.events()).not.toContain('fca_recovery_unknown');
    expect(f.rounds()).toEqual([]); // nothing of it was stored: no round, no empty one
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
  });

  it('is resumed by the owner, runs again from a fresh decision when the provider is back, and the count starts afresh', async () => {
    const f = fixture([...repeat(25, () => answered(503)), [call('task_list', 'list-1')]], { body: true });
    await f.run();
    expect(f.phase()).toBe('stopped');
    expect(f.driver.runtime.resume('owner', f.child.id)).not.toBeNull();
    await f.run();
    expect(f.phase()).toBe('completed');
    expect(f.rounds()).toHaveLength(2);
    expect(f.driver.runtime.snapshot('owner', f.child.id)?.checkpoint).toMatchObject({ fcaProviderRetries: 0 });
  });

  it('does not pause while the provider comes back within the rounds: the count of rounds is reset by the decision that returns', async () => {
    const f = fixture([...repeat(10, () => answered(503)), [call('task_list', 'list-1')], ...repeat(10, () => answered(529)), [call('task_list', 'list-2')]], { body: true });
    await f.run();
    expect(f.phase()).toBe('completed');
    expect(f.logs()).toHaveLength(4); // two rounds of each outage, then a decision
  });

  it('leaves a step that is stopped while it waits to the stop: stopped, not unknown, and not asked again', async () => {
    const f = fixture(repeat(40, () => answered(503)), { body: true, delay: 5_000 });
    await f.driver.tick();
    for (let i = 0; i < 200 && f.provider.bodies.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 2));
    await f.driver.stop(f.child.id, 'owner_stop');
    await f.driver.drain();
    expect(f.provider.bodies).toHaveLength(1);
    expect(f.phase()).toBe('stopped');
    expect(f.events()).not.toContain('fca_recovery_unknown');
  });

  it('leaves a step that is stopped between two rounds to the stop as well', async () => {
    const f = fixture(repeat(40, () => answered(503)), { body: true, bodyCooldown: 5_000 });
    await f.driver.tick();
    for (let i = 0; i < 400 && f.provider.bodies.length < 5; i++) await new Promise(resolve => setTimeout(resolve, 2));
    await f.driver.stop(f.child.id, 'owner_stop');
    await f.driver.drain();
    expect(f.provider.bodies).toHaveLength(5);
    expect(f.phase()).toBe('stopped');
    expect(f.events()).not.toContain('fca_recovery_unknown');
  });
});

describe('a decision that got no answer does not leave a Minecraft request unknown (C-20: runs 12 and 13)', () => {
  it('runs rounds of resets and timeouts to the end of the outage without ever being unknown, and completes', async () => {
    const f = fixture([...repeat(3, () => 'ETIMEDOUT'), ...repeat(3, () => 'ECONNRESET'), ...repeat(2, () => 'ETIMEDOUT'), [call('task_list', 'list-1')]], { body: true });
    await f.run();
    expect(f.phase()).toBe('completed');
    expect(f.events()).not.toContain('fca_recovery_unknown');
    expect(f.logs().every(line => line.includes('retried'))).toBe(true);
    expect(f.rounds()).toHaveLength(2);
  });
});
