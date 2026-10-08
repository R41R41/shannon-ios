import { describe, expect, it } from 'vitest';
import { JevChoiceClient, JevChooser, JEV_QUESTION_SETS, type JevChoiceTrace, type JevQuestion } from '../src/infra/models/jev/jevChoice.js';
import { countedJevFetch } from '../src/infra/models/jev/jevClient.js';
import { checkedTrace } from '../src/contracts/decisionTraceContract.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { JevFcaToolSelector, type FcaToolSelectionRequest, type FcaToolSelector } from '../src/mind/selectors/selectorsPorts.js';
import { FCA_TOOL_SELECTION_LIMITS } from '../src/mind/selectors/fcaToolSelection.js';

const at = '2026-10-09T00:00:00.000Z';
const catalog = [
  { name: 'task.create', description: 'Create useful child work.' },
  { name: 'task.list', description: 'List current tasks.' },
  { name: 'task.get', description: 'Inspect one task.' },
  { name: 'task.send', description: 'Send a message to a task.' },
];
const request = (options: Partial<FcaToolSelectionRequest> = {}): FcaToolSelectionRequest => ({
  scopeKey: 'owner', goal: 'Finish the task', state: 'A child returned a result',
  recentResults: [{ name: 'task.get', ok: true, summary: 'Child has finished' }], tools: catalog,
  signal: new AbortController().signal, ...options,
});
const choices = (values: readonly string[]) => ({ answers: Object.fromEntries(values.map((choice, index) => [`tool_${index}`, { type: 'choice', choice }])) });
interface JevBody { model: string; state: { goal: string; state: string; recentResults: Array<{ name: string; ok: boolean; summary: string }> }; questions: Record<string, JevQuestion> }

function fixture(reply: unknown | ((body: JevBody) => unknown | Promise<unknown>)) {
  const bodies: JevBody[] = []; const traces: JevChoiceTrace[] = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as JevBody;
    bodies.push(body);
    const result = typeof reply === 'function' ? await reply(body) : reply;
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  const client = new JevChoiceClient({ apiKey: 'synthetic-key', model: 'jev-test', fetcher: countedJevFetch(fetcher) });
  const jev = new JevChooser(client, { usdPerCall: 0.001, now: () => at, salt: 'synthetic-salt', trace: (_scope, value) => { traces.push(value); } });
  const selector: FcaToolSelector = new JevFcaToolSelector(jev);
  return { bodies, traces, selector };
}

describe('one-stage FCA tool selection', () => {
  it('asks one include/exclude question per tool in one request and keeps multiple tools in catalog order', async () => {
    const f = fixture({ answers: { tool_3: { choice: 'include' }, tool_1: { choice: 'exclude' }, tool_0: { choice: 'include' }, tool_2: { choice: 'include' } } });
    expect(await f.selector.select(request())).toEqual({ names: ['task.create', 'task.get', 'task.send'], source: 'jev' });
    expect(f.bodies).toHaveLength(1);
    expect(Object.keys(f.bodies[0]!.questions)).toEqual(['tool_0', 'tool_1', 'tool_2', 'tool_3']);
    for (const [index, question] of Object.values(f.bodies[0]!.questions).entries()) {
      expect(question.type).toBe('choice');
      expect(Object.keys(question.criteria)).toEqual(['include', 'exclude']);
      expect(question.instructions).toContain(JSON.stringify(catalog[index]));
      expect(question.instructions).toContain('potentially relevant');
      expect(question.instructions).toContain('relevance is uncertain');
      expect(question.instructions).toContain('Do not choose only one winner');
    }
    expect(f.traces[0]).toMatchObject({ decision: 'tool_menu', outcome: 'ok', questions: 4, costUsd: 0.001,
      answers: { selector: 'fca', offered: 4, chosen: 3, qv: ['fca_tool_menu.v1'], 'a.tool_0': 'include', 'a.tool_1': 'exclude' } });
    expect(JEV_QUESTION_SETS.toolMenu).toBe('tool_menu.v2');
    expect(JEV_QUESTION_SETS.fcaToolMenu).toBe('fca_tool_menu.v1');
  });

  it('allows none, and does not spend a call for an empty catalog', async () => {
    const f = fixture(choices(['exclude', 'exclude', 'exclude', 'exclude']));
    expect(await f.selector.select(request())).toEqual({ names: [], source: 'jev' });
    expect(await f.selector.select(request({ tools: [] }))).toEqual({ names: [], source: 'fallback' });
    expect(f.bodies).toHaveLength(1);
    expect(f.traces).toHaveLength(1);
  });

  it('has no single-winner, per-group or catalog cap, on selection or fallback', async () => {
    const tools = Array.from({ length: 150 }, (_, index) => ({ name: `same_group.tool_${index}`, description: `Tool ${index}` }));
    const all = fixture((body: JevBody) => choices(Object.keys(body.questions).map(() => 'include')));
    expect(await all.selector.select(request({ tools }))).toEqual({ names: tools.map(tool => tool.name), source: 'jev' });
    expect(all.bodies).toHaveLength(1);
    expect(Object.keys(all.bodies[0]!.questions)).toHaveLength(150);
    const failed = fixture({ answers: {} });
    expect(await failed.selector.select(request({ tools }))).toEqual({ names: tools.map(tool => tool.name), source: 'fallback' });
  });

  it('passes only catalog name and description, with bounded goal, state and recent result projections', async () => {
    const tools = [{ name: 'task.get', description: 'PRIVATE_DESCRIPTION', input: { schema: 'SCHEMA_MUST_NOT_LEAVE' }, domain: 'DOMAIN_MUST_NOT_LEAVE' }];
    const recentResults = Array.from({ length: 20 }, (_, index) => ({ name: `tool-${index}-${'n'.repeat(500)}`, ok: index % 2 === 0,
      summary: `result-${index}-${'s'.repeat(3000)}`, private: 'EXTRA_RESULT_MUST_NOT_LEAVE' }));
    const f = fixture(choices(['include']));
    const original = JSON.stringify({ tools, recentResults });
    await f.selector.select(request({ tools, recentResults, goal: 'g'.repeat(5000), state: 's'.repeat(9000) }));
    const body = f.bodies[0]!;
    expect(body.state.goal).toHaveLength(FCA_TOOL_SELECTION_LIMITS.goal);
    expect(body.state.state).toHaveLength(FCA_TOOL_SELECTION_LIMITS.state);
    expect(body.state.recentResults).toHaveLength(FCA_TOOL_SELECTION_LIMITS.recentResults);
    expect(body.state.recentResults[0]!.summary).toMatch(/^result-12-/u);
    expect(body.state.recentResults.at(-1)!.summary).toMatch(/^result-19-/u);
    for (const result of body.state.recentResults) {
      expect(Object.keys(result)).toEqual(['name', 'ok', 'summary']);
      expect(result.summary).toHaveLength(FCA_TOOL_SELECTION_LIMITS.resultSummary);
      expect(result.name).toHaveLength(FCA_TOOL_SELECTION_LIMITS.resultName);
    }
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('PRIVATE_DESCRIPTION');
    expect(serialized).not.toContain('SCHEMA_MUST_NOT_LEAVE');
    expect(serialized).not.toContain('DOMAIN_MUST_NOT_LEAVE');
    expect(serialized).not.toContain('EXTRA_RESULT_MUST_NOT_LEAVE');
    expect(JSON.stringify({ tools, recentResults })).toBe(original);
  });
});

describe('FCA selection failures and cancellation', () => {
  it.each([
    null, {}, { answers: [] }, { answers: {} }, choices(['include']),
    choices(['include', 'exclude', 'invalid', 'include']),
    { answers: { ...choices(['include', 'include', 'include', 'include']).answers, tool_4: { choice: 'include' } } },
    { answers: { ...choices(['include', 'include', 'include', 'include']).answers, tool_2: { type: 'noul', choice: 'include' } } },
    { answers: { ...choices(['include', 'include', 'include', 'include']).answers, tool_2: null } },
    { answers: { ...choices(['include', 'include', 'include', 'include']).answers, tool_2: [] } },
  ])('falls back to the whole catalog for an invalid or missing answer: %j', async reply => {
    const f = fixture(reply);
    expect(await f.selector.select(request())).toEqual({ names: catalog.map(tool => tool.name), source: 'fallback' });
    expect(f.bodies).toHaveLength(1);
    expect(f.traces[0]).toMatchObject({ outcome: 'fallback', questions: 4, costUsd: 0.001, answers: { chosen: 4 } });
  });

  it.each(['TimeoutError', 'Error'])('uses the existing probe and full fallback on %s without retrying', async name => {
    const f = fixture(() => { throw new DOMException('PRIVATE_PROVIDER_FAILURE', name); });
    expect(await f.selector.select(request())).toEqual({ names: catalog.map(tool => tool.name), source: 'fallback' });
    expect(f.bodies).toHaveLength(1);
    expect(f.traces[0]).toMatchObject({ outcome: name === 'TimeoutError' ? 'timeout' : 'error', costUsd: 0.001, questions: 4 });
    expect(f.traces[0]!.contextChars).toBeGreaterThan(0);
    expect(JSON.stringify(f.traces)).not.toContain('PRIVATE_PROVIDER_FAILURE');
  });

  it('refuses an already aborted step before a request, trace or fallback', async () => {
    const f = fixture(choices(['include', 'include', 'include', 'include']));
    const controller = new AbortController(); controller.abort();
    await expect(f.selector.select(request({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.bodies).toHaveLength(0);
    expect(f.traces).toHaveLength(0);
  });

  it.each([false, true])('does not return a late selection or fallback after abort (failure=%s)', async fails => {
    const controller = new AbortController();
    const f = fixture(() => {
      controller.abort();
      if (fails) throw new DOMException('timed out after stop', 'TimeoutError');
      return choices(['include', 'include', 'include', 'include']);
    });
    let used = false;
    await expect(f.selector.select(request({ signal: controller.signal })).then(() => { used = true; })).rejects.toMatchObject({ name: 'AbortError' });
    expect(used).toBe(false);
    expect(f.bodies).toHaveLength(1);
    expect(f.traces).toHaveLength(1);
    expect(f.traces[0]!.costUsd).toBe(0.001);
  });
});

describe('FCA selector observations and accounting', () => {
  it('uses the existing cache without another call and records safe traces and real jevt spans', async () => {
    const events: ObserverDraft[] = [];
    const restore = installObserverSink(event => { events.push(event); });
    const privateValues = ['PRIVATE_GOAL', 'PRIVATE_STATE', 'PRIVATE_RESULT', 'PRIVATE_DESCRIPTION', 'PRIVATE_TOOL_NAME'];
    const tools = [{ name: 'task.get', description: privateValues[3]! }, { name: privateValues[4]!, description: 'PRIVATE_OTHER_DESCRIPTION' }];
    const r = request({ goal: privateValues[0], state: privateValues[1], tools,
      recentResults: [{ name: privateValues[4]!, ok: true, summary: privateValues[2]! }] });
    const f = fixture(choices(['include', 'include']));
    try {
      await withObserverRun({ scopeKey: 'owner', surface: 'fca', runId: 'fca-selector-run' }, async () => {
        expect(await f.selector.select(r)).toEqual({ names: tools.map(tool => tool.name), source: 'jev' });
        expect(await f.selector.select(r)).toEqual({ names: tools.map(tool => tool.name), source: 'jev' });
      });
      expect(f.bodies).toHaveLength(1);
      expect(f.traces).toHaveLength(2);
      expect(f.traces[0]).toMatchObject({ costUsd: 0.001, answers: { cached: false, qv: ['fca_tool_menu.v1'] } });
      expect(f.traces[1]).toMatchObject({ costUsd: 0, answers: { cached: true, qv: ['fca_tool_menu.v1'] } });
      expect(f.traces[0]!.answers.qh).toBe(f.traces[1]!.answers.qh);
      expect(f.traces[0]!.answers.h).toBe(f.traces[1]!.answers.h);
      for (const trace of f.traces) expect(() => checkedTrace({ ...trace, decider: 'jev', fallbackDecider: null, relatedId: null })).not.toThrow();
      const jevt = events.filter(event => event.node === 'jevt' && event.kind === 'span.completed');
      expect(jevt.map(event => event.output)).toMatchObject([
        { cached: false, source: 'jev', selectedCount: 2, selectedTools: ['task.get', 'unknown'] },
        { cached: true, source: 'jev', selectedCount: 2, selectedTools: ['task.get', 'unknown'] },
      ]);
      expect(events.filter(event => event.node === 'llm' && event.kind === 'span.completed')).toHaveLength(1);
      expect(events.every(event => event.runId === 'fca-selector-run')).toBe(true);
      const saved = JSON.stringify({ traces: f.traces, events });
      for (const value of privateValues) expect(saved).not.toContain(value);
      expect(saved).not.toContain('PRIVATE_OTHER_DESCRIPTION');
      expect(saved).not.toContain('synthetic-key');
    } finally { restore(); }
  });
});
