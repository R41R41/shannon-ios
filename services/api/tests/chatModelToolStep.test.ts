import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { functionCallsOf, withToolRounds } from '../src/chatModelTools.js';
import { parallelToolsEnabled } from '../src/chatModelToolStep.js';
import { chatTurnRequestBody } from '../src/chatModelTurn.js';
import type { HostFolderOperations, HostOperationRequest, HostRunOutcome } from '../src/hostFolderOperations.js';
import { ToolAudienceWatch } from '../src/shannonToolAudience.js';
import { ShannonToolRunner } from '../src/shannonToolRunner.js';
import { conversationTools } from '../src/shannonToolSession.js';
import { InMemoryToolTraces, ToolTurnLog } from '../src/shannonToolTurns.js';
import { TEXT_TURN_DEADLINE, TurnDeadline, type TurnDeadlinePlan } from '../src/turnDeadline.js';

/**
 * Syzygy ADR-0003 stage 4 (owner decision 2026-10-06): the calls of one response run together where that is safe.
 * Everything below goes through the real session, runner, gate and folder executors; only her PC's device is a fake,
 * whose operations take the time the test gives them on the test's clock (fake timers), so "at once" is measured on
 * that clock and never on the wall clock.
 */
const AT = Date.parse('2026-10-06T03:00:00.000Z');
const TURN = JSON.stringify({ reply: '読みました。', threadSummary: null, taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null });
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
let ids = 0;
const call = (name: string, args: Record<string, unknown>) => {
  ids += 1;
  return { type: 'function_call', id: `fc-${ids}`, call_id: `call-${ids}`, name, arguments: JSON.stringify(args) };
};
const read = (path: string) => call('folder_read', { path });
const create = (path: string) => call('folder_create', { path, content: `${path} の中身` });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(AT); ids = 0; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

/** Her PC: each operation takes `durations[path]` on the test's clock, and stops when its call is cancelled. */
function fakeDevice(durations: Readonly<Record<string, number>>) {
  const events: string[] = [];
  const reasons: string[] = [];
  const running = new Set<string>();
  let most = 0;
  const device = {
    boundHosts: () => ['desk'],
    run(_scopeKey: string, request: HostOperationRequest, signal?: AbortSignal): Promise<HostRunOutcome> {
      const label = `${request.operation} ${request.relativePath}`;
      const at = () => Date.now() - AT;
      events.push(`start ${label} @${at()}`);
      running.add(label);
      most = Math.max(most, running.size);
      return new Promise(resolve => {
        const end = (outcome: HostRunOutcome) => { running.delete(label); events.push(`end ${label} @${at()}`); resolve(outcome); };
        const timer = setTimeout(() => end(request.operation === 'read'
          ? { kind: 'done', result: { content: `${request.relativePath} の中身`, offset: 0, nextOffset: null, totalBytes: 20, sha256: 'a'.repeat(64), modifiedAt: new Date(AT).toISOString() } }
          : { kind: 'done', result: {} }), durations[request.relativePath] ?? 0);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reasons.push(String((signal.reason as { name?: unknown } | undefined)?.name));
          end({ kind: 'timeout', handedOut: true });
        }, { once: true });
      });
    },
  };
  return { device: device as unknown as HostFolderOperations, events, reasons, most: () => most };
}

function harness(durations: Readonly<Record<string, number>> = {}, plan: Readonly<TurnDeadlinePlan> = TEXT_TURN_DEADLINE) {
  const now = () => new Date(Date.now()).toISOString();
  const pc = fakeDevice(durations);
  const records: Array<{ tool: string; outcome: string; reasonCode?: string }> = [];
  const runner = new ShannonToolRunner(new SQLiteAutonomyStore(':memory:'), pc.device, { recordConversationAction: (_scopeKey, report) => { records.push(report); } }, now);
  const traces = new InMemoryToolTraces();
  const server = {
    audience: new ToolAudienceWatch({ othersPresent: () => false }, now),
    secrets: () => ({ carries: (text: string) => text.includes('ないしょ') }),
    turns: new ToolTurnLog(traces, now),
  };
  const deadline = new TurnDeadline(plan);
  const tools = conversationTools({ tools: runner }, 'owner', 'text', true, server, 'talk\nファイルを読んで', deadline).tools!;
  /** One turn whose first response asks for `calls`; returns what the model was sent next, and the turn's time used. */
  const turn = async (calls: unknown[], signal?: AbortSignal) => {
    const bodies: Array<Record<string, unknown>> = [];
    const used: number[] = [];
    const done = withToolRounds({ input: [] }, tools, async body => {
      bodies.push(body);
      used.push(plan.totalMilliseconds - deadline.left());
      return bodies.length === 1 ? { output: calls } : { output: [message(TURN)] };
    }, { isAnswer: envelope => !functionCallsOf(envelope).length, outOfTime: () => 'out', ...(signal ? { signal } : {}) });
    const settled = done.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    const error = await settled;
    const next = (bodies[1]?.input ?? []) as Array<Record<string, unknown>>;
    return {
      error, bodies, input: next, used,
      outputs: next.filter(item => item.type === 'function_call_output').map(item => JSON.parse(String(item.output)) as { ok: boolean; text: string; failure?: string }),
      order: next.filter(item => item.type === 'function_call_output').map(item => item.call_id),
    };
  };
  const trace = () => traces.toolTraces('owner', 'talk', { since: '' }).flatMap(record => record.calls);
  return { turn, deadline, events: pc.events, reasons: pc.reasons, most: pc.most, records, trace, tools };
}

describe('the calls of one response (ADR-0003 stage 4)', () => {
  it('runs two independent reads at once: the step takes as long as the slower one, not their sum', async () => {
    const h = harness({ 'a.md': 4_000, 'b.md': 3_000 });
    const { outputs, order, used } = await h.turn([read('a.md'), read('b.md')]);
    expect(h.events).toEqual(['start read a.md @0', 'start read b.md @0', 'end read b.md @3000', 'end read a.md @4000']);
    expect(h.most()).toBe(2);
    // The next round was asked when the slower read ended: 4 s of the turn, not 7.
    expect(used).toEqual([0, 4_000]);
    expect(order).toEqual(['call-1', 'call-2']);
    expect(outputs.map(output => output.text.split('\n')[0])).toEqual(['「a.md」（全20バイト。0バイト目から）', '「b.md」（全20バイト。0バイト目から）']);
  });

  it('runs them one after the other, as before, with SHANNON_PARALLEL_TOOLS=off, and a text turn asks for one call at a time', async () => {
    vi.stubEnv('SHANNON_PARALLEL_TOOLS', 'off');
    const h = harness({ 'a.md': 4_000, 'b.md': 3_000 });
    const { outputs, used } = await h.turn([read('a.md'), read('b.md')]);
    expect(h.events).toEqual(['start read a.md @0', 'end read a.md @4000', 'start read b.md @4000', 'end read b.md @7000']);
    expect(used).toEqual([0, 7_000]);
    expect(outputs.every(output => output.ok)).toBe(true);
    const request = { scopeKey: 'owner', systemPrompt: '[テスト]', history: [], message: 'x', tools: h.tools };
    expect(chatTurnRequestBody('gpt-5.6-luna', request, undefined)).toMatchObject({ parallel_tool_calls: false });
    vi.unstubAllEnvs();
    expect(chatTurnRequestBody('gpt-5.6-luna', request, undefined)).toMatchObject({ parallel_tool_calls: true });
    for (const value of ['off', 'OFF', ' false ', '0', 'disabled', 'no', 'none']) expect(parallelToolsEnabled({ SHANNON_PARALLEL_TOOLS: value })).toBe(false);
    expect(parallelToolsEnabled({})).toBe(true);
  });

  it('never runs a write beside another call: writes keep the model\'s order, and what follows a write starts after it', async () => {
    const h = harness({ 'a.md': 1_000, 'b.md': 1_500, 'w1.md': 2_000, 'w2.md': 2_000, 'c.md': 1_000, 'd.md': 500 });
    const { outputs, order } = await h.turn([read('a.md'), read('b.md'), create('w1.md'), create('w2.md'), read('c.md'), read('d.md')]);
    expect(h.events).toEqual([
      'start read a.md @0', 'start read b.md @0', 'end read a.md @1000', 'end read b.md @1500',
      'start create w1.md @1500', 'end create w1.md @3500',
      'start create w2.md @3500', 'end create w2.md @5500',
      'start read c.md @5500', 'start read d.md @5500', 'end read d.md @6000', 'end read c.md @6500',
    ]);
    expect(order).toEqual(['call-1', 'call-2', 'call-3', 'call-4', 'call-5', 'call-6']);
    expect(outputs.map(output => output.ok)).toEqual([true, true, true, true, true, true]);
  });

  it('gives the results back, and notes them in the trace, in the model\'s order, whichever ended first', async () => {
    const h = harness({ 'a.md': 3_000, 'b.md': 1_000, 'c.md': 2_000 });
    const { input } = await h.turn([read('a.md'), call('study_list', {}), read('b.md'), read('c.md')]);
    // Each call is followed by its own result, in the order the model wrote them.
    expect(input.map(item => `${String(item.type)} ${String(item.call_id)}`)).toEqual([
      'function_call call-1', 'function_call_output call-1', 'function_call call-2', 'function_call_output call-2',
      'function_call call-3', 'function_call_output call-3', 'function_call call-4', 'function_call_output call-4',
    ]);
    expect(h.trace().map(entry => [entry.tool, entry.target ?? null, entry.ok])).toEqual([
      ['folder.read', 'a.md', true], ['study.list', null, true], ['folder.read', 'b.md', true], ['folder.read', 'c.md', true],
    ]);
  });

  it('cancels the calls in flight at their time, records each outcome, and still answers inside the turn', async () => {
    // 4 s of the turn are left for steps: each call gets 4 s, and both are cancelled then.
    const plan = { totalMilliseconds: 16_000, answerReserveMilliseconds: 12_000, firstRoundMilliseconds: 30_000, laterRoundMilliseconds: 20_000 };
    const h = harness({ 'a.md': 60_000, 'b.md': 60_000 }, plan);
    const { outputs, bodies, error } = await h.turn([read('a.md'), read('b.md')]);
    expect(error).toBeNull();
    expect(h.events).toEqual(['start read a.md @0', 'start read b.md @0', 'end read a.md @4000', 'end read b.md @4000']);
    expect(h.reasons).toEqual(['TimeoutError', 'TimeoutError']);
    expect(outputs.map(output => output.failure)).toEqual(['timeout', 'timeout']);
    expect(h.trace().map(entry => [entry.target, entry.failure])).toEqual([['a.md', 'timeout'], ['b.md', 'timeout']]);
    // The answer came in the reserve, without tools.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ tool_choice: 'none' });
  });

  it('when the owner stops the turn, ends the calls in flight at once, notes them, and then stops', async () => {
    const h = harness({ 'a.md': 60_000, 'b.md': 60_000, 'w.md': 1_000 });
    const owner = new AbortController();
    setTimeout(() => owner.abort(new DOMException('hung up', 'AbortError')), 1_000);
    const { error, bodies } = await h.turn([read('a.md'), read('b.md'), create('w.md')], owner.signal);
    expect((error as { name?: string }).name).toBe('AbortError');
    expect(h.events).toEqual(['start read a.md @0', 'start read b.md @0', 'end read a.md @1000', 'end read b.md @1000']);
    expect(h.reasons).toEqual(['AbortError', 'AbortError']);
    expect(h.trace().map(entry => entry.target)).toEqual(['a.md', 'b.md']);
    expect(bodies).toHaveLength(1);
  });

  it('refuses at the gate exactly as one call at a time does: the same results, the same records, in the same order', async () => {
    const calls = () => [
      read('a.md'),
      call('study_read', {}),
      call('study.list', {}),
      call('study_create', { kind: 'note', title: 'メモ', body: 'これはないしょの話' }),
      call('folder_read', { path: '.shannon/x.md' }),
      call('shell_run', {}),
      read('b.md'),
    ];
    const run = async () => {
      ids = 0;
      const h = harness({ 'a.md': 2_000, 'b.md': 1_000 });
      const { outputs } = await h.turn(calls());
      return { outputs, records: h.records, trace: h.trace() };
    };
    const together = await run();
    vi.stubEnv('SHANNON_PARALLEL_TOOLS', 'off');
    const alone = await run();
    expect(together).toEqual(alone);
    expect(together.outputs.map(output => output.failure ?? 'ok')).toEqual(['ok', 'invalid_input', 'not_offered', 'refused', 'invalid_input', 'not_offered', 'ok']);
    expect(together.records.map(record => record.reasonCode)).toEqual(['invalid_input', 'not_offered', 'refused', 'invalid_input', 'not_offered']);
  });
});
