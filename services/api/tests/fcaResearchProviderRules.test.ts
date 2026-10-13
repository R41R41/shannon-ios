import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { requestStrictTools } from '../src/infra/models/anthropic/anthropicToolCapacity.js';
import { FCA_PROGRESS_TOOLS } from '../src/mind/action/fca/fcaProgressTools.js';
import type { FcaModel, FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { MEMORY_TOOLS } from '../src/mind/tools/memoryToolDefinitions.js';
import { offeredTools } from '../src/mind/tools/shannonTools.js';
import { TASK_TOOLS } from '../src/mind/tools/toolRunnerPorts.js';
import { createTaskRuntimeWiring, rejectedTaskReport } from '../src/wiring/taskRuntimeWiring.js';
import { retiredTaskReport } from '../src/mind/action/taskRuntime/store/taskRuntimeRecovery.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { anthropicRejection, anthropicRequestViolation } from './support/anthropicProviderRules.js';

/**
 * Production 2026-10-12: every FCA research task failed on its first decision. The decision request broke three provider
 * rules at once (inline tool changes as the first message, unsupported strict keywords in `fca_context`, more than 20 strict
 * tools), the API answered 400, no usage was recorded, the task sat in `fca_unknown` for 10 minutes and the owner heard nothing.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const excluded = ['task_runtime', 'memory_read', 'minecraft_body', 'vm_workspace', 'owner_documents_read'];
/** The common research catalog as `serverFcaWiring` offers it, with every optional read port present (a superset). */
const catalog = [...TASK_TOOLS, ...offeredTools('text', 'owner_alone').filter(tool => !excluded.includes(tool.domain)), ...MEMORY_TOOLS, ...FCA_PROGRESS_TOOLS];
/** The first decision of a research child: the fallback selector keeps every tool, shared evidence is wired. */
const researchInput = (history: readonly unknown[] = []): FcaModelInput => ({
  task: { id: 'research', title: '明日の天気', goal: '明日の東京の天気を調べる', completionCriteria: '天気の要点を一文で報告する' },
  messages: [{ id: 'context:research', text: '明日の東京の天気を調べて', sourceTaskId: 'conversation' }], children: [], history,
  tools: catalog, catalog: catalog.map(({ name, description }) => ({ name, description })),
  sharedContext: { affect: { version: 'fca_affect.v1', revision: 1, updatedAt: '2026-10-12T00:00:00Z',
    emotion: { valence: 0, arousal: 0.2, openness: 0.5 }, feeling: null, causes: [] }, recentOutcomes: [] },
  observations: [{ revision: 0, observation: null }],
});
const call = (name: string, id: string, value: unknown = {}) => ({ type: 'tool_use', name, id, input: value });
const signal = () => new AbortController().signal;

function providerModel(answers: Array<Record<string, unknown>[]>) {
  const usage: number[] = [];
  const fixture = scriptedAnthropic((body, index) => {
    const violation = anthropicRequestViolation(body);
    return violation ? anthropicRejection(violation) : message(answers[index] ?? [call('fca_wait', `wait-${index}`, { summary: 'Waiting' })], 'tool_use');
  });
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage: value => { usage.push(value.estimatedCostUsd); } });
  return { ...fixture, model, usage };
}

describe('FCA research decisions meet the provider request rules', () => {
  it('sends a first and a follow-up research decision the API accepts', async () => {
    const f = providerModel([[call('web_search', 'search-1', { query: '東京 明日 天気' })]]);
    const first = await f.model.decide(researchInput(), signal());
    expect(first.decision).toEqual({ kind: 'tools', calls: [{ id: 'search-1', name: 'web.search', input: { query: '東京 明日 天気' } }] });
    const body = f.bodies[0]!;
    expect(anthropicRequestViolation(body)).toBeNull();
    // The task context opens the conversation; its inline definitions follow it, and the history keeps the sent order.
    expect((body.messages as Array<{ role: string }>).map(entry => entry.role)).toEqual(['user', 'system']);
    expect(first.history.slice(0, 2)).toEqual(body.messages);
    // Only the fixed control schemas are strict; with strict catalog tools the live API refused the request even inside the
    // 20-tool budget ("The compiled grammar is too large"), a limit no schema count predicts.
    expect(requestStrictTools(body as never).map(tool => tool.name).sort()).toEqual(['fca_complete', 'fca_context', 'fca_wait', 'tool_open']);

    const history = [...first.history, f.model.toolResults([{ id: 'search-1', text: '晴れ', ok: true }])];
    const second = await f.model.decide(researchInput(history), signal());
    expect(anthropicRequestViolation(f.bodies[1]!)).toBeNull();
    expect((f.bodies[1]!.messages as unknown[]).slice(0, history.length)).toEqual(history);
    expect(second.decision.kind).toBe('wait');
    expect(f.usage).toHaveLength(2);
  });

  it('declares the catalog up front as non-strict schemas when no selector is wired', async () => {
    const f = providerModel([]);
    const input = researchInput(); delete input.catalog; delete input.sharedContext;
    await f.model.decide(input, signal());
    expect(anthropicRequestViolation(f.bodies[0]!)).toBeNull();
    expect(requestStrictTools(f.bodies[0] as never).map(tool => tool.name).sort()).toEqual(['fca_complete', 'fca_wait']);
  });
});

describe('a refused FCA decision fails the research task at once and tells the owner', () => {
  function runtime(model: FcaModel) {
    let time = Date.parse('2026-10-12T01:18:00.000Z');
    const now = () => new Date(time).toISOString();
    const h = actionHarness(now);
    let only = '';
    // Only the research child runs; its parent stands in for the conversation that delegated it.
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now, canRunTask: (_runtime, id) => id === only,
      providerRetryDelayMs: () => 0 });
    cleanups.push(async () => { await driver.close(); h.close(); });
    const root = driver.runtime.ensureRoot('owner');
    const parent = driver.runtime.createChild('owner', root.id, { title: 'conversation', goal: 'talk' }, 'request-parent');
    const child = driver.runtime.createChild('owner', parent.id, { title: '明日の天気', goal: '明日の東京の天気を調べる' }, 'request-child');
    only = child.id;
    return { h, driver, parent, child, advance(milliseconds: number) { time += milliseconds; h.store.transaction(() => h.store.sweep(now())); } };
  }
  async function settle(driver: ReturnType<typeof createTaskRuntimeWiring>, done: () => boolean) {
    for (let i = 0; i < 50 && !done(); i++) { await driver.tick(); await driver.drain(); }
  }

  it('commits the failure, reports it to the parent and the activity, and logs only the code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fixture = scriptedAnthropic(() => anthropicRejection("For 'array' type, property 'maxItems' is not supported"));
    const usage: number[] = [];
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage: value => { usage.push(value.estimatedCostUsd); } });
    const { driver, parent, child } = runtime(model);
    await settle(driver, () => driver.runtime.get('owner', child.id)?.phase === 'failed');

    expect(driver.runtime.get('owner', child.id)).toMatchObject({ phase: 'failed', status: 'failed', summary: rejectedTaskReport('明日の天気') });
    expect(fixture.bodies).toHaveLength(1); // Never resent.
    expect(usage).toEqual([]); // A refused request is not charged.
    const inbox = driver.runtime.snapshot('owner', parent.id)!.messages;
    expect(inbox).toEqual([expect.objectContaining({ sourceTaskId: child.id, text: rejectedTaskReport('明日の天気') })]);
    expect(driver.runtime.progress?.('owner', child.id)).toMatchObject({ status: 'failed', report: { text: rejectedTaskReport('明日の天気') } });
    expect(driver.runtime.pendingReceipts('owner')).toEqual([]);
    const lines = log.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('Shannon FCA step'));
    expect(lines).toEqual([`Shannon FCA step failed task=${child.id} code=FCA_MODEL_HTTP_400`]);
  });

  it('runs a step the provider answered with a server error once more, then fails it with its report, logging closed facts (2026-10-13)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = scriptedAnthropic(() => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'synthetic-private-error' } }),
      { status: 500, headers: { 'content-type': 'application/json' } }));
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
    const { driver, parent, child } = runtime(model);
    await settle(driver, () => driver.runtime.get('owner', child.id)?.phase === 'failed');
    expect(driver.runtime.get('owner', child.id)).toMatchObject({ phase: 'failed', summary: rejectedTaskReport('明日の天気') });
    expect(driver.runtime.snapshot('owner', parent.id)!.messages).toEqual([expect.objectContaining({ sourceTaskId: child.id })]);
    expect(fixture.bodies).toHaveLength(2); // one retry, never more
    const lines = log.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('Shannon FCA step'));
    expect(lines).toEqual([`Shannon FCA step retried task=${child.id} code=FCA_MODEL_HTTP_500`, `Shannon FCA step failed task=${child.id} code=FCA_MODEL_HTTP_500`]);
    const facts = warn.mock.calls.map(args => String(args[0])).filter(line => line.includes('anthropic_request_failed'));
    expect(facts.map(line => JSON.parse(line))).toEqual(Array(2).fill({ event: 'anthropic_request_failed', lane: 'fca', errorClass: 'InternalServerError', status: 500, type: 'api_error', cause: null }));
    expect(facts.join('\n')).not.toContain('synthetic-private-error');
  });

  it('completes a step after one passing server error: the retry runs the same decision and nothing else (2026-10-13)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const fixture = scriptedAnthropic(() => ++calls === 1
      ? new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }), { status: 529, headers: { 'content-type': 'application/json' } })
      : message([call('fca_complete', 'complete-1', { summary: '晴れ' })], 'tool_use'));
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
    const { driver, child } = runtime(model);
    await settle(driver, () => ['completed', 'failed', 'unknown'].includes(driver.runtime.get('owner', child.id)?.phase ?? ''));
    expect(driver.runtime.get('owner', child.id)).toMatchObject({ phase: 'completed', summary: '晴れ' });
    expect(fixture.bodies).toHaveLength(2);
    // The same decision asked again: only the task's revision moved; no history was added by the failed attempt.
    const sameDecision = (body: Record<string, unknown>) => JSON.stringify(body).replace(/\\"revision\\":\d+/gu, '');
    expect(sameDecision(fixture.bodies[1]!)).toBe(sameDecision(fixture.bodies[0]!));
  });

  it('keeps throttling and lost answers unknown, then reports the retired task to the owner', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fixture = scriptedAnthropic(() => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
      { status: 429, headers: { 'content-type': 'application/json' } }));
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
    const { driver, parent, child, advance } = runtime(model);
    await settle(driver, () => driver.runtime.get('owner', child.id)?.phase === 'unknown');
    expect(driver.runtime.get('owner', child.id)?.phase).toBe('unknown');
    expect(log.mock.calls.map(args => String(args[0]))).toContain(`Shannon FCA step unknown task=${child.id} code=FCA_MODEL_HTTP_429`);

    advance(11 * 60_000); await driver.tick(); await driver.drain();
    expect(driver.runtime.get('owner', child.id)?.phase).toBe('failed');
    expect(driver.runtime.snapshot('owner', parent.id)!.messages.map(entry => entry.id)).toContain(`result:retired:${child.id}`);
    expect(driver.runtime.progress?.('owner', child.id)).toMatchObject({ status: 'failed', report: { id: `retired:${child.id}`, text: retiredTaskReport('明日の天気') } });
    expect(fixture.bodies).toHaveLength(1);
  });
});
