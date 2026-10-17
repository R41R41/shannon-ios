import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createTaskRuntimeWiring, rejectedTaskReport } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';

/**
 * A step whose model call got an HTTP 5xx is closed as `continue` and run once more (`retryAfterServerError`). That commit used to
 * store an empty history round, which `anthropicFcaHistoryCodec.project` rejects: the step after the retry that ran a tool then
 * failed in `prepareFcaHistory` with FCA_HISTORY_INCOMPLETE_ROUND and the task ended `unknown`. Here the real runner, the real
 * SQLite store, the real Anthropic adapter and its history codec are used, with a scripted provider.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const call = (name: string, id: string, value: unknown = {}) => ({ type: 'tool_use', name, id, input: value });
const serverError = (status: number) => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'synthetic' } }),
  { status, headers: { 'content-type': 'application/json' } });

function fixture(answers: Array<Response | Array<Record<string, unknown>>>, onRequest: (index: number) => void = () => {}) {
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const provider = scriptedAnthropic((_body, index) => {
    onRequest(index);
    const answer = answers[index] ?? [call('fca_complete', `complete-${index}`, { summary: '終わり' })];
    return answer instanceof Response ? answer : message(answer, 'tool_use');
  });
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: provider.fetcher, recordUsage() {} });
  const now = () => '2026-10-17T09:00:00.000Z';
  const h = actionHarness(now);
  let only = '';
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now,
    canRunTask: (_runtime, id) => id === only, providerRetryDelayMs: () => 0,
    stepPorts: () => ({ history: { codec: anthropicFcaHistoryCodec } }) });
  cleanups.push(async () => { await driver.close(); h.close(); });
  const root = driver.runtime.ensureRoot('owner');
  const parent = driver.runtime.createChild('owner', root.id, { title: 'conversation', goal: 'talk' }, 'request-parent');
  const child = driver.runtime.createChild('owner', parent.id, { title: '天気', goal: '天気を調べる' }, 'request-child');
  only = child.id;
  const phase = () => driver.runtime.get('owner', child.id)?.phase;
  const rounds = () => (h.db.prepare('SELECT entries_json FROM fca_task_history WHERE task_id=? ORDER BY sequence').all(child.id) as Array<{ entries_json: string }>)
    .map(row => JSON.parse(row.entries_json) as unknown[]);
  const lines = () => vi.mocked(console.log).mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('Shannon FCA step'));
  const run = async () => { for (let i = 0; i < 50 && !['completed', 'failed', 'unknown'].includes(phase() ?? ''); i++) { await driver.tick(); await driver.drain(); } };
  return { db: h.db, provider, driver, child, phase, rounds, lines, run };
}

describe('a provider server error is retried without leaving a broken history round', () => {
  it('runs a tool step after one 500 and completes: no empty round is stored and the replay stays valid', async () => {
    const f = fixture([serverError(500), [call('task_list', 'list-1')]]);
    await f.run();
    expect(f.phase()).toBe('completed');
    expect(f.lines()).toEqual([`Shannon FCA step retried task=${f.child.id} code=FCA_MODEL_HTTP_500`]);
    expect(f.provider.bodies).toHaveLength(3); // 500, the tool step, the completing step: one resend only
    // The retried step committed nothing: only the tool step and the completing step are rounds, each one codec-projectable.
    const rounds = f.rounds();
    expect(rounds).toHaveLength(2);
    expect(rounds.every(entries => entries.length > 0)).toBe(true);
    // The third request replays the tool round byte for byte (append-only), and nothing before it.
    const replayed = (f.provider.bodies[2]!.messages as unknown[]).slice(0, rounds[0]!.length);
    expect(JSON.parse(JSON.stringify(replayed))).toMatchObject(JSON.parse(JSON.stringify(rounds[0])));
  });

  it('resumes a task whose history already holds empty rounds written by the old retry (production rows), without editing them', async () => {
    let seed: (stepId: string) => void = () => {};
    const f = fixture([[call('task_list', 'list-1')], [call('task_list', 'list-2')]], index => { if (index === 1) seed('old-retry-2'); });
    seed = stepId => { f.db.prepare(`INSERT INTO fca_task_history(task_id,step_id,entries_json,committed_at,committed_status,sources_json) VALUES(?,?,'[]',?,'queued','[]')`)
      .run(f.child.id, stepId, '2026-10-17T09:00:00.000Z'); };
    seed('old-retry-1'); // before the first real round, as a 5xx retry left it; a second one lands between two real rounds
    await f.run();
    expect(f.phase()).toBe('completed');
    expect(f.lines()).toEqual([]);
    // The legacy rows stay stored as they were (never edited); the three real rounds replay in order around them.
    const stored = f.rounds();
    expect(stored.filter(entries => entries.length === 0)).toHaveLength(2);
    expect(stored.filter(entries => entries.length > 0)).toHaveLength(3);
    const first = stored.find(entries => entries.length > 0)!;
    const replayed = (f.provider.bodies[2]!.messages as unknown[]).slice(0, first.length);
    expect(JSON.parse(JSON.stringify(replayed))).toMatchObject(JSON.parse(JSON.stringify(first)));
  });

  it('retries a 529 the same way', async () => {
    const f = fixture([serverError(529), [call('task_list', 'list-1')]]);
    await f.run();
    expect(f.phase()).toBe('completed');
    expect(f.rounds().every(entries => entries.length > 0)).toBe(true);
  });

  it('fails the task with its report after a second 500, as before, and never sends a third request', async () => {
    const f = fixture([serverError(500), serverError(500), [call('task_list', 'list-1')]]);
    await f.run();
    expect(f.phase()).toBe('failed');
    expect(f.driver.runtime.get('owner', f.child.id)).toMatchObject({ summary: rejectedTaskReport('天気') });
    expect(f.provider.bodies).toHaveLength(2);
    expect(f.lines()).toEqual([`Shannon FCA step retried task=${f.child.id} code=FCA_MODEL_HTTP_500`, `Shannon FCA step failed task=${f.child.id} code=FCA_MODEL_HTTP_500`]);
  });
});
