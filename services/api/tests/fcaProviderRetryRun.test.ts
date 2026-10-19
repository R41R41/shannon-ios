import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { createFcaBodyRecovery } from '../src/wiring/fcaBodyRecovery.js';
import { fcaBudget } from '../src/wiring/fcaBudgetWiring.js';
import { PROVIDER_UNAVAILABLE_SUMMARY } from '../src/wiring/taskRuntimeUnavailable.js';
import { TaskBudgetStore } from '../src/mind/action/taskRuntime/store/taskBudgetStore.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
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
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: provider.fetcher, recordUsage: usage => { usages.push(usage); budget.recordUsage(usage.estimatedCostUsd, !usage.usageComplete); } });
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
  const reports = () => (h.db.prepare("SELECT COUNT(*) AS n FROM agent_task_events WHERE task_id=? AND event_type='fca_progress_observed' AND json_extract(payload_json,'$.tool')='fca.result'")
    .get(child.id) as { n: number }).n;
  const logs = () => vi.mocked(console.log).mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('Shannon FCA step'));
  const warnings = () => vi.mocked(console.warn).mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('Shannon FCA decision'));
  const run = async (until: () => boolean = () => ['completed', 'failed', 'unknown', 'stopped'].includes(phase() ?? '')) => {
    for (let i = 0; i < 80 && !until(); i++) { await driver.tick(); await driver.drain(); }
  };
  return { h, driver, child, provider, usages, budgetStore, phase, rounds, events, reports, logs, warnings, run };
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
    // Honest accounting: the timeout is booked in full, but apart (an upper bound of a charge nobody confirmed), not as confirmed spend.
    expect(f.usages[0]!.usageComplete).toBe(false);
    expect(spent.estimatedYen).toBeGreaterThanOrEqual(Math.ceil(f.usages[0]!.estimatedCostUsd * 160));
    expect(spent.yen + spent.estimatedYen).toBeLessThanOrEqual(Math.ceil(total * 160) + 2);
    const answeredUsd = f.usages[1]!.estimatedCostUsd + f.usages[2]!.estimatedCostUsd;
    expect(spent.yen).toBeLessThanOrEqual(Math.ceil(answeredUsd * 160) + 1); // the confirmed part is the two answers only
    expect(spent.steps).toBe(2); // the tool step (with the timeout it retried) and the completing step
  });

  it('stops asking where the task has no room for one more request, and an estimate alone does not fail the task (M-4)', async () => {
    const f = fixture(['ETIMEDOUT', 'ETIMEDOUT', [call('task_list', 'list-1')]], { cap: 1 });
    await f.run();
    // The first timeout books more than the one yen the operator left this request: no second request in that step. A task that is not a
    // Minecraft request asks once more from a fresh step (its one further round), and fails with its report as any task does: not by the cap.
    expect(f.provider.bodies).toHaveLength(2);
    expect(f.phase()).toBe('failed');
    expect(f.driver.runtime.get('owner', f.child.id)?.summary).not.toContain('上限');
    const spent = f.budgetStore.spent(f.child.id);
    expect(spent.yen).toBe(0);
    expect(spent.estimatedYen).toBeGreaterThanOrEqual(1);
    expect(f.budgetStore.spent(f.child.id).cappedAt).toBeNull();
  });

  it('pauses (the owner may resume) rather than fails when only estimates would take the task over its cap, then goes on (M-4)', async () => {
    const f = fixture(['ETIMEDOUT', [call('task_list', 'list-1')]], { cap: 20 });
    f.budgetStore.add(f.child.id, 'owner', 'owner_request', 19, '2026-10-19T09:00:00.000Z'); // 19 of the 20 yen are confirmed
    await f.run();
    // The timeout's estimate (about 1 yen) cannot fail the task: it takes 19 to 20 of 20, so the next step pauses instead.
    expect(f.phase()).toBe('stopped');
    expect(f.driver.runtime.get('owner', f.child.id)).toMatchObject({ status: 'paused', pauseReason: 'fca_stopped' });
    expect(f.driver.runtime.get('owner', f.child.id)?.summary).toContain('見積り');
    expect(f.events()).not.toContain('fca_recovery_unknown');
    const paused = f.budgetStore.spent(f.child.id);
    expect(paused.cappedAt).toBeNull();
    expect(paused.estimatedYen).toBeGreaterThanOrEqual(1);
    expect(paused.openEstimatedYen).toBe(0); // reviewed: the owner was asked
    // M-2: the owner is told, as he was by the report of the failure this replaced: once, with the reason and that it can be resumed.
    const notice = f.driver.runtime.progress!('owner', f.child.id)?.report;
    expect(notice).toMatchObject({ text: f.driver.runtime.get('owner', f.child.id)!.summary });
    expect(notice?.text).toContain('再開できます');
    expect(notice?.id.startsWith('paused:')).toBe(true);
    for (let i = 0; i < 4; i++) { await f.driver.tick(); await f.driver.drain(); }
    expect(f.reports()).toBe(1);
    expect(f.driver.runtime.resume('owner', f.child.id)).not.toBeNull();
    // M-1: what the pause said is gone the moment the owner resumes it (summary and report).
    expect(f.driver.runtime.get('owner', f.child.id)?.summary).toBe('');
    expect(f.driver.runtime.progress!('owner', f.child.id)).toBeNull();
    await f.run();
    // Resumed, it asks again (the estimates are reviewed and no longer stop it); its one yen step then reaches the cap by confirmed spend,
    // and that is the cap's to end, as before.
    expect(f.provider.bodies).toHaveLength(2);
    expect(f.phase()).toBe('failed');
    expect(f.driver.runtime.get('owner', f.child.id)?.summary).toContain('上限');
    expect(f.budgetStore.spent(f.child.id).cappedAt).not.toBeNull();
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

  it('tells the owner once that it was paused (M-2), and takes the summary and the notice away when he resumes it, so the result is reported (M-1)', async () => {
    const f = fixture([...repeat(25, () => answered(503)), [call('task_list', 'list-1')]], { body: true });
    await f.run();
    expect(f.phase()).toBe('stopped');
    const notice = f.driver.runtime.progress!('owner', f.child.id);
    expect(notice).toMatchObject({ currentStep: 'fca.result', status: 'failed', report: { text: `「採掘」は、${PROVIDER_UNAVAILABLE_SUMMARY}` } });
    expect(notice?.report?.id.startsWith('paused:')).toBe(true);
    expect(notice?.report?.text).not.toContain('石を集める'); // the owner's title only, never his words
    for (let i = 0; i < 4; i++) { await f.driver.tick(); await f.driver.drain(); }
    expect(f.reports()).toBe(1); // once, however long it stays paused
    expect(f.driver.runtime.resume('owner', f.child.id)).not.toBeNull();
    expect(f.driver.runtime.get('owner', f.child.id)?.summary).toBe(''); // not "paused" any more, before any step runs
    expect(f.driver.runtime.progress!('owner', f.child.id)).toBeNull();
    await f.run();
    expect(f.phase()).toBe('completed');
    const result = f.driver.runtime.progress!('owner', f.child.id)?.report;
    expect(result?.id.startsWith('paused:')).toBe(false);
    expect(result?.text).toBe('終わり'); // the completion became the report: a pause report would have stood in for it
  });

  it('clears a pause summary left on a task that runs again at its next commit, even without a resume of the store (M-1)', async () => {
    const f = fixture([[call('task_list', 'list-1')]], { body: true });
    new SQLiteFcaTaskAuthority(f.h.db).event('owner', f.child.id, 'fca_note', '2026-10-19T09:00:00.000Z', { summary: PROVIDER_UNAVAILABLE_SUMMARY }, {});
    expect(f.driver.runtime.get('owner', f.child.id)?.summary).toBe(PROVIDER_UNAVAILABLE_SUMMARY);
    await f.run(() => f.provider.bodies.length >= 1 && f.rounds().length === 1);
    expect(f.phase()).not.toBe('completed');
    expect(f.driver.runtime.get('owner', f.child.id)?.summary).toBe(''); // the first step that committed
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
