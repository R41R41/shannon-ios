import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { CONVERSATION_TOOL_CALLS, CUT_OFF_CALL_NOTE, functionCallsOf, withToolRounds, type ShannonModelToolSession, type ToolCallOutcome } from '../src/chatModelTools.js';
import { asksForParallelCalls, parallelToolsEnabled } from '../src/chatModelToolStep.js';
import { chatTurnRequestBody } from '../src/chatModelTurn.js';
import type { HostFolderOperations, HostOperationRequest, HostRunOutcome } from '../src/hostFolderOperations.js';
import { ToolAudienceWatch } from '../src/mind/inhibition/shannonToolAudience.js';
import { ShannonToolRunner } from '../src/mind/tools/shannonToolRunner.js';
import { conversationTools } from '../src/mind/tools/shannonToolSession.js';
import { InMemoryToolTraces, ToolTurnLog } from '../src/mind/tools/shannonToolTurns.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import { TEXT_TURN_DEADLINE, TurnDeadline, type TurnDeadlinePlan } from '../src/turnDeadline.js';

/**
 * Syzygy ADR-0003 stage 4 (owner decision 2026-10-06): the calls of one response run together where that is safe.
 * Time is the test's clock (fake timers): "at once" is measured on it, never on the wall clock. The rule is shown with
 * tools whose time the test sets (`fakeTools`); the session, runner, gate, trace and her PC's queue are shown with the
 * real ones (`realTools`, `realQueue`).
 */
const AT = Date.parse('2026-10-06T03:00:00.000Z');
const TURN = JSON.stringify({ reply: '読みました。', threadSummary: null, taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null });
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const at = () => Date.now() - AT;
let ids = 0;
const call = (name: string, args: Record<string, unknown>) => {
  ids += 1;
  return { type: 'function_call', id: `fc-${ids}`, call_id: `call-${ids}`, name, arguments: JSON.stringify(args) };
};
/** For `fakeTools`: reads of two domains that are not one device's, and a write. */
const read = (id: string) => call(id.startsWith('m') ? 'minecraft_status' : 'study_read', { id });
const write = (id: string) => call('study_create', { id });
const folderRead = (path: string) => call('folder_read', { path });
const folderCreate = (path: string) => call('folder_create', { path, content: `${path} の中身` });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(AT); ids = 0; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

type Turn = Awaited<ReturnType<typeof turnOf>>;

/** One turn whose first response asks for `calls` (or is `first` itself); returns what the model was sent next. */
async function turnOf(tools: ShannonModelToolSession, plan: Readonly<TurnDeadlinePlan>, first: unknown, signal?: AbortSignal) {
  const bodies: Array<Record<string, unknown>> = [];
  const used: number[] = [];
  const done = withToolRounds({ input: [] }, tools, async body => {
    bodies.push(body);
    used.push(plan.totalMilliseconds - tools.deadline.left());
    return bodies.length === 1 ? (Array.isArray(first) ? { output: first } : first) : { output: [message(TURN)] };
  }, { isAnswer: envelope => !functionCallsOf(envelope).length, outOfTime: () => 'out', ...(signal ? { signal } : {}) });
  const settled = done.then(() => null, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(120_000);
  const error = await settled;
  const next = (bodies[1]?.input ?? []) as Array<Record<string, unknown>>;
  const outputs = next.filter(item => item.type === 'function_call_output');
  return {
    error, bodies, input: next, used,
    outputs: outputs.map(item => JSON.parse(String(item.output)) as { ok: boolean; text: string; failure?: string }),
    order: outputs.map(item => item.call_id),
  };
}

/** A session whose calls take `durations[id]` on the test's clock and end with a timeout when cancelled. */
function fakeTools(durations: Readonly<Record<string, number>>, plan: Readonly<TurnDeadlinePlan> = TEXT_TURN_DEADLINE) {
  const events: string[] = [];
  const reasons: string[] = [];
  const notes: string[] = [];
  let running = 0;
  let most = 0;
  const start = (name: string, args: string, signal?: AbortSignal): Promise<ToolCallOutcome> => {
    const id = String((JSON.parse(args) as { id?: unknown }).id);
    const label = `${name} ${id}`;
    events.push(`start ${label} @${at()}`);
    running += 1;
    most = Math.max(most, running);
    return new Promise(resolve => {
      const end = (output: Record<string, unknown>) => {
        running -= 1;
        events.push(`end ${label} @${at()}`);
        resolve({ output: JSON.stringify(output), note: () => { notes.push(label); } });
      };
      const timer = setTimeout(() => end({ ok: true, text: label, retryable: false }), durations[id] ?? 0);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reasons.push(String((signal.reason as { name?: unknown } | undefined)?.name));
        end({ ok: false, text: label, failure: 'timeout', retryable: true });
      }, { once: true });
    });
  };
  const tools: ShannonModelToolSession = {
    definitions: ['study.read', 'minecraft.status', 'study.create', 'study.update'].map(name => shannonTool(name)!),
    maximumCalls: CONVERSATION_TOOL_CALLS, deadline: new TurnDeadline(plan),
    start,
    async call(name, args, signal) { const outcome = await start(name, args, signal); outcome.note(); return outcome.output; },
  };
  return { tools, events, reasons, notes, most: () => most, turn: (first: unknown, signal?: AbortSignal) => turnOf(tools, plan, first, signal) };
}

/** Her PC's device for `realTools`: each operation takes `durations[path]` and stops when its call is cancelled. */
function fakeDevice(durations: Readonly<Record<string, number>>) {
  const events: string[] = [];
  const device = {
    boundHosts: () => ['desk'],
    run(_scopeKey: string, request: HostOperationRequest, signal?: AbortSignal): Promise<HostRunOutcome> {
      const label = `${request.operation} ${request.relativePath}`;
      events.push(`start ${label} @${at()}`);
      return new Promise(resolve => {
        const end = (outcome: HostRunOutcome) => { events.push(`end ${label} @${at()}`); resolve(outcome); };
        const timer = setTimeout(() => end(request.operation === 'read'
          ? { kind: 'done', result: { content: `${request.relativePath} の中身`, offset: 0, nextOffset: null, totalBytes: 20, sha256: 'a'.repeat(64), modifiedAt: new Date(AT).toISOString() } }
          : { kind: 'done', result: {} }), durations[request.relativePath] ?? 0);
        signal?.addEventListener('abort', () => { clearTimeout(timer); end({ kind: 'timeout', handedOut: true }); }, { once: true });
      });
    },
  };
  return { device: device as unknown as HostFolderOperations, events };
}

/** The real session, runner, gate and trace, with the device above. */
function realTools(durations: Readonly<Record<string, number>> = {}, plan: Readonly<TurnDeadlinePlan> = TEXT_TURN_DEADLINE) {
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
  const tools = conversationTools({ tools: runner }, 'owner', 'text', true, server, 'talk\nファイルを読んで', new TurnDeadline(plan)).tools!;
  const trace = () => traces.toolTraces('owner', 'talk', { since: '' }).flatMap(record => record.calls);
  return { tools, events: pc.events, records, trace, turn: (first: unknown, signal?: AbortSignal) => turnOf(tools, plan, first, signal) };
}

describe('the calls of one response (ADR-0003 stage 4)', () => {
  it('runs two independent reads at once: the step takes as long as the slower one, not their sum', async () => {
    const h = fakeTools({ a: 4_000, m: 3_000 });
    const { order, used, outputs }: Turn = await h.turn([read('a'), read('m')]);
    expect(h.events).toEqual(['start study_read a @0', 'start minecraft_status m @0', 'end minecraft_status m @3000', 'end study_read a @4000']);
    expect(h.most()).toBe(2);
    // The next round was asked when the slower read ended: 4 s of the turn, not 7.
    expect(used).toEqual([0, 4_000]);
    expect(order).toEqual(['call-1', 'call-2']);
    expect(outputs.map(output => output.text)).toEqual(['study_read a', 'minecraft_status m']);
  });

  it('runs them one after the other, as before, with SHANNON_PARALLEL_TOOLS=off', async () => {
    vi.stubEnv('SHANNON_PARALLEL_TOOLS', 'off');
    const h = fakeTools({ a: 4_000, m: 3_000 });
    const { used } = await h.turn([read('a'), read('m')]);
    expect(h.events).toEqual(['start study_read a @0', 'end study_read a @4000', 'start minecraft_status m @4000', 'end minecraft_status m @7000']);
    expect(used).toEqual([0, 7_000]);
    for (const value of ['off', 'OFF', ' false ', '0', 'disabled', 'no', 'none']) expect(parallelToolsEnabled({ SHANNON_PARALLEL_TOOLS: value })).toBe(false);
    expect(parallelToolsEnabled({})).toBe(true);
  });

  it('never runs a write beside another call: writes keep the model\'s order, and what follows a write starts after it', async () => {
    const h = fakeTools({ a: 1_000, m: 1_500, w1: 2_000, w2: 2_000, c: 1_000, m2: 500 });
    const { outputs, order } = await h.turn([read('a'), read('m'), write('w1'), write('w2'), read('c'), read('m2')]);
    expect(h.events).toEqual([
      'start study_read a @0', 'start minecraft_status m @0', 'end study_read a @1000', 'end minecraft_status m @1500',
      'start study_create w1 @1500', 'end study_create w1 @3500',
      'start study_create w2 @3500', 'end study_create w2 @5500',
      'start study_read c @5500', 'start minecraft_status m2 @5500', 'end minecraft_status m2 @6000', 'end study_read c @6500',
    ]);
    expect(order).toEqual(['call-1', 'call-2', 'call-3', 'call-4', 'call-5', 'call-6']);
    expect(outputs.every(output => output.ok)).toBe(true);
  });

  it('treats a name the turn does not offer as a barrier: the read after it starts when the reads before it ended', async () => {
    const h = fakeTools({ a: 2_000, b: 1_000 });
    const { outputs } = await h.turn([read('a'), call('shell_run', { id: 'x' }), read('b')]);
    expect(h.events).toEqual(['start study_read a @0', 'end study_read a @2000', 'start study_read b @2000', 'end study_read b @3000']);
    expect(outputs.map(output => output.failure ?? 'ok')).toEqual(['ok', 'not_offered', 'ok']);
  });

  it('runs at most six calls of one response; the rest are told the limit and the model answers without tools', async () => {
    const h = fakeTools({});
    const ids8 = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const { outputs, bodies } = await h.turn(ids8.map(id => read(id)));
    expect(h.events.filter(event => event.startsWith('start'))).toHaveLength(6);
    expect(outputs.map(output => output.failure ?? 'ok')).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'limit', 'limit']);
    expect(h.notes).toEqual(['study_read a', 'study_read b', 'study_read c', 'study_read d', 'study_read e', 'study_read f']);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ tool_choice: 'none' });
  });

  it('cancels the calls in flight at their time, and still answers inside the turn', async () => {
    // 4 s of the turn are left for steps: each call gets 4 s, and both are cancelled then.
    const plan = { totalMilliseconds: 16_000, answerReserveMilliseconds: 12_000, firstRoundMilliseconds: 30_000, laterRoundMilliseconds: 20_000 };
    const h = fakeTools({ a: 60_000, m: 60_000 }, plan);
    const { outputs, bodies, error } = await h.turn([read('a'), read('m')]);
    expect(error).toBeNull();
    expect(h.events).toEqual(['start study_read a @0', 'start minecraft_status m @0', 'end study_read a @4000', 'end minecraft_status m @4000']);
    expect(h.reasons).toEqual(['TimeoutError', 'TimeoutError']);
    expect(outputs.map(output => output.failure)).toEqual(['timeout', 'timeout']);
    expect(h.notes).toEqual(['study_read a', 'minecraft_status m']);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ tool_choice: 'none' });
  });

  it('when the owner stops the turn, ends the calls in flight at once, notes them, and starts nothing more', async () => {
    const h = fakeTools({ a: 60_000, m: 60_000, w: 1_000 });
    const owner = new AbortController();
    setTimeout(() => owner.abort(new DOMException('hung up', 'AbortError')), 1_000);
    const { error, bodies } = await h.turn([read('a'), read('m'), write('w')], owner.signal);
    expect((error as { name?: string }).name).toBe('AbortError');
    expect(h.events).toEqual(['start study_read a @0', 'start minecraft_status m @0', 'end study_read a @1000', 'end minecraft_status m @1000']);
    expect(h.reasons).toEqual(['AbortError', 'AbortError']);
    expect(h.notes).toEqual(['study_read a', 'minecraft_status m']);
    expect(bodies).toHaveLength(1);
  });
});

describe('her real tools in one response', () => {
  it('runs folder reads one after the other and a study read beside them; results and the trace keep the model\'s order', async () => {
    const h = realTools({ 'a.md': 3_000, 'b.md': 1_000, 'c.md': 2_000 });
    const { input, outputs } = await h.turn([folderRead('a.md'), call('study_list', {}), folderRead('b.md'), folderRead('c.md')]);
    // Her PC takes one conversation operation at a time: each read is queued when the one before it ended.
    expect(h.events).toEqual(['start read a.md @0', 'end read a.md @3000', 'start read b.md @3000', 'end read b.md @4000', 'start read c.md @4000', 'end read c.md @6000']);
    expect(outputs.every(output => output.ok)).toBe(true);
    expect(input.map(item => `${String(item.type)} ${String(item.call_id)}`)).toEqual([
      'function_call call-1', 'function_call_output call-1', 'function_call call-2', 'function_call_output call-2',
      'function_call call-3', 'function_call_output call-3', 'function_call call-4', 'function_call_output call-4',
    ]);
    // study.list ended first; it is noted in its place.
    expect(h.trace().map(entry => [entry.tool, entry.target ?? null, entry.ok])).toEqual([
      ['folder.read', 'a.md', true], ['study.list', null, true], ['folder.read', 'b.md', true], ['folder.read', 'c.md', true],
    ]);
  });

  it('gives a folder read its time when it starts: one the deadline leaves no time for is not run', async () => {
    const plan = { totalMilliseconds: 16_000, answerReserveMilliseconds: 12_000, firstRoundMilliseconds: 30_000, laterRoundMilliseconds: 20_000 };
    const h = realTools({ 'a.md': 60_000, 'b.md': 1_000 }, plan);
    const { outputs, bodies } = await h.turn([folderRead('a.md'), folderRead('b.md')]);
    expect(h.events).toEqual(['start read a.md @0', 'end read a.md @4000']);
    expect(outputs.map(output => [output.failure, output.text])).toEqual([['timeout', expect.stringContaining('時間内に返事が来なかった')], ['timeout', '時間が足りず実行しなかった（何もしていない）。']]);
    expect(h.trace().map(entry => [entry.target, entry.failure])).toEqual([['a.md', 'timeout']]);
    expect(bodies[1]).toMatchObject({ tool_choice: 'none' });
  });

  it('refuses at the gate exactly as one call at a time does: the same results, the same records, in the same order', async () => {
    const calls = () => [
      folderRead('a.md'),
      call('study_read', {}),
      call('study.list', {}),
      call('study_create', { kind: 'note', title: 'メモ', body: 'これはないしょの話' }),
      call('folder_read', { path: '.shannon/x.md' }),
      call('shell_run', {}),
      folderRead('b.md'),
    ];
    const run = async () => {
      ids = 0;
      const h = realTools({ 'a.md': 2_000, 'b.md': 1_000 });
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

  it('with her real PC queue and a device that takes one operation at a time, four folder reads of one response all succeed', async () => {
    const HOST = 'owner-windows';
    const DEVICE = '0123456789abcdef';
    const now = () => new Date(Date.now()).toISOString();
    const service = new ShannonAutonomyService({
      store: new SQLiteAutonomyStore(':memory:'), now,
      config: configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true', SHANNON_AUTONOMY_HOST_FOLDERS_JSON: JSON.stringify({ [HOST]: { deviceId: DEVICE } }) }),
    });
    // The device: claims, takes 3 s per operation, reports, and claims again; never two at once.
    const stop = new AbortController();
    const handled: string[] = [];
    const device = (async () => {
      while (!stop.signal.aborted) {
        const claimed = await service.folderOperations.claim('owner', HOST, DEVICE, { operations: ['list', 'read', 'search', 'create', 'update', 'move', 'delete'], waitSeconds: 25, localStop: false }, stop.signal);
        const step = claimed === 'HOST_NOT_BOUND' ? null : claimed.step;
        if (!step) continue;
        handled.push(`${String(step.relativePath)} @${at()}`);
        await new Promise(resolve => setTimeout(resolve, 3_000));
        service.folderOperations.report('owner', step.id, DEVICE, { outcome: 'done', result: {
          content: `${String(step.relativePath)} の中身`, offset: 0, nextOffset: null, totalBytes: 20, sha256: 'b'.repeat(64), modifiedAt: now(),
        } });
      }
    })();
    await vi.advanceTimersByTimeAsync(10);
    const server = { audience: new ToolAudienceWatch({ othersPresent: () => false }, now), secrets: () => ({ carries: () => false }), turns: new ToolTurnLog(new InMemoryToolTraces(), now) };
    const tools = conversationTools({ tools: service.tools }, 'owner', 'text', true, server, 'talk\n四つ読んで', new TurnDeadline(TEXT_TURN_DEADLINE)).tools!;
    const { outputs } = await turnOf(tools, TEXT_TURN_DEADLINE, ['1.md', '2.md', '3.md', '4.md'].map(path => folderRead(path)));
    stop.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    await device;
    expect(outputs.map(output => output.ok)).toEqual([true, true, true, true]);
    expect(outputs.map(output => output.text.split('\n')[0])).toEqual(['1.md', '2.md', '3.md', '4.md'].map(path => `「${path}」（全20バイト。0バイト目から）`));
    expect(handled.map(line => line.split(' ')[0])).toEqual(['1.md', '2.md', '3.md', '4.md']);
  });
});

describe('two writes and the output ceiling', () => {
  it('asks for several calls only while no write is offered, so two writes never meet the 2,200-token ceiling together', () => {
    const reads = ['study.list', 'study.read', 'folder.read'].map(name => shannonTool(name)!);
    const withWrite = [...reads, shannonTool('folder.create')!];
    const body = (definitions: typeof reads) => chatTurnRequestBody('gpt-5.6-luna', {
      scopeKey: 'owner', systemPrompt: '[テスト]', history: [], message: 'x',
      tools: { definitions, maximumCalls: CONVERSATION_TOOL_CALLS, deadline: new TurnDeadline(TEXT_TURN_DEADLINE), call: async () => '' },
    }, undefined);
    expect(body(reads)).toMatchObject({ parallel_tool_calls: true, max_output_tokens: 2_200 });
    expect(body(withWrite)).toMatchObject({ parallel_tool_calls: false, max_output_tokens: 2_200 });
    expect(asksForParallelCalls(reads)).toBe(true);
    expect(asksForParallelCalls(withWrite)).toBe(false);
    expect(asksForParallelCalls(reads, { SHANNON_PARALLEL_TOOLS: 'off' })).toBe(false);
    vi.stubEnv('SHANNON_PARALLEL_TOOLS', 'off');
    expect(body(reads)).toMatchObject({ parallel_tool_calls: false });
  });

  it('a response cut off at the ceiling while writing two files runs neither, is told once, and the model answers without tools', async () => {
    const h = realTools();
    const cutOff = {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [folderCreate('one.md'), { ...folderCreate('two.md'), arguments: '{"path":"two.md","content":"途中で' }],
    };
    const { bodies, input } = await h.turn(cutOff);
    expect(h.events).toEqual([]);
    expect(h.trace()).toEqual([]);
    expect(input).toEqual([{ role: 'developer', content: CUT_OFF_CALL_NOTE }]);
    expect(bodies[1]).toMatchObject({ tool_choice: 'none' });
  });
});
