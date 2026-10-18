import { describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { cacheFcaBodyRequest, breakpointCount } from '../src/infra/models/anthropic/anthropicFcaBodyCache.js';
import { FCA_TRANSIENT_BETAS, clearAtMessage, liveState, renderedRequest } from '../src/infra/models/anthropic/anthropicFcaTransient.js';
import { publicState, stateMessage, storedState as storedRow } from '../src/infra/models/anthropic/anthropicFcaStoredState.js';
import { cutToFit } from '../src/infra/models/anthropic/anthropicFcaStateCut.js';
import { estimatedAnthropicTokens } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { storedBodyResult } from '../src/surfaces/minecraft/minecraftStoredResult.js';
import { message, scriptedAnthropic, withoutCacheMarkers } from './support/anthropicFixtures.js';
import { anthropicRejection, anthropicRequestViolation } from './support/anthropicProviderRules.js';
import { definition, quiet, scenario, SUMMARY_POLICY, WIDE_POLICY } from './fcaCoreToolsHarness.js';

/** The stored state of a step, with its message (null when nothing is to be stated). */
function storedState(supplied: Record<string, unknown>, history: readonly unknown[], restate = false) {
  const state = storedRow(supplied, history as never, restate);
  return { ...state, message: stateMessage(state.row, state.full) };
}

type Body = Record<string, unknown>;
type Msg = { role: string; content: unknown; clear_at?: string };
const messagesOf = (body: Body) => withoutCacheMarkers(body.messages as Msg[]);
const clearAts = (body: Body) => messagesOf(body).filter(entry => entry.role === 'system' && entry.clear_at === 'next_user_message');
const stateTexts = (body: Body) => messagesOf(body).flatMap(entry => entry.role === 'user' && Array.isArray(entry.content)
  ? (entry.content as Array<{ type: string; text?: string }>).flatMap(block => block.type === 'text' && block.text?.startsWith('{"stateUpdate"') ? [block.text] : []) : []);
const live = (observation: number) => ({ observation: { marker: `OBS-MARK-${observation}` }, pace: { elapsedMinutes: observation } });

describe('transient turn shape (P3)', () => {
  it('ends every request with one turn-scoped system message, none on a cache marker, with the betas and the explicit thinking binding', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, body: live, appendOnly: true });
    expect(await run.settle()).toBe('completed');
    expect(run.violations).toEqual([]);
    expect(run.bodies).toHaveLength(30);
    run.bodies.forEach((body, index) => {
      const messages = body.messages as Msg[];
      expect(messages.at(-1)).toMatchObject({ role: 'system', clear_at: 'next_user_message' });
      expect(clearAts(body)).toHaveLength(index + 1);
      for (const entry of messages.filter(item => item.role === 'system')) expect(JSON.stringify(entry)).not.toContain('cache_control');
      expect(body.cache_control).toBeUndefined();
      expect(breakpointCount(body as never)).toBeLessThanOrEqual(4);
      expect(body.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    });
    expect(breakpointCount(run.bodies[5] as never)).toBe(3);
    for (const headers of run.headers) expect(headers['anthropic-beta']).toBe(FCA_TRANSIENT_BETAS);
    // The first turn is the stored state, then its live state; the first live state names the first observation only.
    const first = messagesOf(run.bodies[0]!);
    expect(first.map(entry => entry.role)).toEqual(['user', 'system']);
    expect(String(first[1]!.content)).toContain('OBS-MARK-1');
  }, 120_000);

  it('resends every earlier turn-scoped message byte for byte, each request extending the one before (30 rounds, append-only provider)', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, body: live, appendOnly: true, resultSize: 50 });
    await run.settle();
    expect(run.violations).toEqual([]);
    for (let index = 1; index < run.bodies.length; index++) {
      const before = clearAts(run.bodies[index - 1]!), now = clearAts(run.bodies[index]!);
      expect(JSON.stringify(now.slice(0, before.length))).toBe(JSON.stringify(before));
      expect(now.length).toBe(before.length + 1);
    }
    // Only the newest is rendered by the provider; the estimate of a request leaves the older ones out.
    const last = run.bodies.at(-1)!;
    expect(JSON.stringify(renderedRequest(last as { messages: unknown[] }).messages).split('OBS-MARK-').length - 1).toBe(1);
  }, 120_000);

  it('does not store the live state: each observation is in its own turn-scoped message and in no user message', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, body: live });
    await run.settle();
    const last = run.bodies.at(-1)!;
    for (const entry of messagesOf(last)) {
      if (entry.role === 'system') continue;
      expect(JSON.stringify(entry.content)).not.toContain('OBS-MARK-');
    }
    expect(clearAts(last).filter(entry => String(entry.content).includes('OBS-MARK-')).length).toBe(30);
    // The history's text of the task is stated once: the stored state changes only when the task state does.
    expect(stateTexts(last)).toHaveLength(1);
    expect(stateTexts(last)[0]).toContain('"stateUpdate":"full"');
  }, 120_000);

  it('states only what changed: a delta of the changed parts, none when nothing changed, new messages once', () => {
    const task = { id: 't', title: 'x', goal: 'g', completionCriteria: 'c', revision: 3, updatedAt: 'now', summary: '' };
    const supplied = { task, children: [], messages: [], progress: { conditions: [], verification: null, failures: [], replans: [] }, skillIndex: 'index' };
    const first = storedState(supplied, []);
    expect(first.parts).toEqual(['task', 'skillIndex', 'progress']);
    const stated = first.message!;
    expect(JSON.parse(((stated.content as Array<{ text: string }>)[0]!).text)).toMatchObject({ stateUpdate: 'full', task: { id: 't' } });
    expect(JSON.stringify(stated)).not.toContain('updatedAt');
    // The task's revision and clock move every step; the stored task does not.
    expect(storedState({ ...supplied, task: { ...task, revision: 9, updatedAt: 'later' } }, [stated]).message).toBeNull();
    const failed = { ...supplied, progress: { ...supplied.progress, failures: [{ operationId: 'o', name: 'mc.x', failure: 'failed', retryable: true }] } };
    const delta = storedState(failed, [stated]);
    expect(delta.parts).toEqual(['progress']);
    expect(JSON.parse(((delta.message!.content as Array<{ text: string }>)[0]!).text).stateUpdate).toBe('changed');
    const withMessage = storedState({ ...failed, messages: [{ id: 'm1', text: 'こんにちは', sourceTaskId: 'p' }] }, [stated, delta.message!]);
    expect(withMessage.parts).toEqual(['messages']);
    expect(storedState({ ...failed, messages: [{ id: 'm1', text: 'こんにちは', sourceTaskId: 'p' }] }, [stated, delta.message!, withMessage.message!]).message).toBeNull();
  });

  it('keeps the shared context by its revision: the same revision and outcomes are not stated again', () => {
    const context = (revision: number, text: string) => ({ affect: { revision, text }, recentOutcomes: [{ eventId: 'e1', appraisalRevision: 0, observation: 'observed' }] });
    const base = { task: { id: 't', title: 'x', goal: 'g', completionCriteria: 'c' } };
    const first = storedState({ ...base, sharedContext: context(1, 'a') }, []).message!;
    expect(storedState({ ...base, sharedContext: context(1, 'b') }, [first]).message).toBeNull();
    expect(storedState({ ...base, sharedContext: context(2, 'b') }, [first]).parts).toEqual(['sharedContext']);
  });

  it('puts the live state in the system message without the fixed rules', () => {
    const text = liveState({ ownerClock: { localTime: '2026-10-17 09:00', timeZone: 'Asia/Tokyo', rule: 'RULE' }, waiting: { n: 1, rule: 'WAIT' } }, { observation: { x: 1 } });
    expect(JSON.parse(text)).toEqual({ ownerClock: { localTime: '2026-10-17 09:00', timeZone: 'Asia/Tokyo' }, waiting: { n: 1 }, body: { observation: { x: 1 } } });
    expect(clearAtMessage(text)).toMatchObject({ role: 'system', clear_at: 'next_user_message' });
  });
});

describe('transient history: summaries, budgets, the codec', () => {
  it('summarizes rounds that hold turn-scoped messages and keeps going, append-only within each epoch', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: SUMMARY_POLICY, body: live, appendOnly: true });
    expect(await run.settle()).toBe('completed');
    expect(run.violations).toEqual([]);
    expect(run.summaries()).toBeGreaterThan(0);
    // A new epoch starts from the bootstrap text (which names no live state) and states the task in full again.
    const first = (body: Body) => JSON.stringify(messagesOf(body)[0]!.content);
    const startOfEpoch = run.bodies.filter((body, index) => first(body).startsWith('"{\\"kind\\":\\"fca_public_history\\"') && (index === 0 || first(run.bodies[index - 1]!) !== first(body)));
    expect(startOfEpoch.length).toBeGreaterThan(0);
    for (const body of startOfEpoch) {
      expect(first(body)).not.toContain('OBS-MARK-');
      expect(stateTexts(body)[0]).toContain('"stateUpdate":"full"');
      expect(clearAts(body)).toHaveLength(1);
    }
  }, 120_000);

  it('counts no stored turn-scoped message toward the budgets and projects none into a summary', () => {
    const old = clearAtMessage('x'.repeat(5_000));
    const round = { sequence: 1, stepId: 's', committedAt: 'now', status: 'executing' as const, sources: [], entries: [
      { role: 'user', content: [{ type: 'text', text: '{"stateUpdate":"full","task":{"id":"t"}}' }] }, old,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'mc_x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok', is_error: false }] }] };
    const projected = anthropicFcaHistoryCodec.project(round as never)!;
    expect(projected.map(item => item.role)).toEqual(['user', 'tool_call', 'tool_result']);
    expect(JSON.stringify(projected)).not.toContain('xxxx');
    expect(anthropicFcaHistoryCodec.rendered!(old)).toBe(false);
    expect(anthropicFcaHistoryCodec.rendered!(round.entries[0])).toBe(true);
    expect(anthropicFcaHistoryCodec.tokens!([old])).toBe(anthropicFcaHistoryCodec.tokens!([]));
    expect(anthropicFcaHistoryCodec.tokens!([old, round.entries[0]])).toBe(anthropicFcaHistoryCodec.tokens!([round.entries[0]]));
  });
});

describe('review follow-ups: removed parts, public projection, cap, recall', () => {
  const task = { id: 't', title: 'x', goal: 'g', completionCriteria: 'c' };
  const textOf = (message: { content: unknown }) => ((message.content as Array<{ text: string }>)[0]!).text;

  it('states a part that disappeared as removed, once, and states it again if it comes back', () => {
    const full = storedState({ task, skillIndex: 'index', progress: { conditions: [] } }, []).message!;
    const gone = storedState({ task }, [full]);
    expect(gone.parts).toEqual(['removed']);
    expect(JSON.parse(textOf(gone.message!))).toMatchObject({ stateUpdate: 'changed', removed: ['skillIndex', 'progress'] });
    expect(storedState({ task }, [full, gone.message!]).message).toBeNull();
    expect(storedState({ task, skillIndex: 'index' }, [full, gone.message!]).parts).toEqual(['skillIndex']);
  });

  it('reduces a stored state to its public projection in summaries and in the budget measure', () => {
    const text = JSON.stringify({ stateUpdate: 'full', task: { id: 't' }, catalog: [{ name: 'a' }], skillIndex: 'S'.repeat(5_000), sharedContext: { affect: {} }, progress: { x: 1 } });
    const entry = { role: 'user', content: [{ type: 'text', text }] };
    const measured = JSON.stringify(anthropicFcaHistoryCodec.measured!(entry));
    expect(measured.length).toBeLessThan(500);
    expect(measured).toContain('restatedEachEpoch');
    expect(measured).toContain('progress');
    const round = { sequence: 1, stepId: 's', committedAt: 'now', status: 'executing', sources: [], entries: [entry,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'mc_x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok', is_error: false }] }] };
    expect(JSON.stringify(anthropicFcaHistoryCodec.project(round as never))).not.toContain('SSSSS');
  });

  const context = (revision: number, text: string) => ({ affect: { revision, text }, recentOutcomes: [{ eventId: 'e1', appraisalRevision: 0, observation: 'observed' }] });
  /** A production-shaped catalog: 80 tools, descriptions of 300 to 1,090 characters (about 56,000). */
  const catalogOf = (change?: number) => Array.from({ length: 80 }, (_, index) => ({ name: `mc_tool_${index}`,
    description: `${'あ'.repeat(300 + (index * 10) % 800)}${index === change ? '変更' : ''}` }));
  const skillIndex = ['[ボクのスキル 25/25]', ...Array.from({ length: 25 }, (_, index) => `- skill-${index}: ${'あ'.repeat(60)}`)].join('\n');
  const costOf = (base: number) => (row: Record<string, unknown>, live: Record<string, unknown>) => base + estimatedAnthropicTokens(row) + estimatedAnthropicTokens(live);
  const fitsOf = (base: number, maximum = 95_000) => (row: Record<string, unknown>, live: Record<string, unknown>) => costOf(base)(row, live) <= maximum;

  it('states the catalog item by item: whole once, then only what was added, changed or removed', () => {
    const first = storedState({ task, catalog: catalogOf() }, []);
    expect((first.row.catalog as unknown[]).length).toBe(80);
    const message = (state: ReturnType<typeof storedState>, full: boolean) => stateMessage(state.row, full)!;
    const stated = [message(first, true)];
    expect(storedState({ task, catalog: catalogOf() }, stated).parts).toEqual([]);
    const changed = storedState({ task, catalog: catalogOf(3) }, stated);
    expect(changed.row).toEqual({ catalogChanges: { changed: [catalogOf(3)[3]] } });
    const added = [...catalogOf(), { name: 'mc_new', description: 'n' }].filter((_, index) => index !== 5);
    expect(storedState({ task, catalog: added }, stated).row).toEqual({ catalogChanges: { added: [{ name: 'mc_new', description: 'n' }], removed: ['mc_tool_5'] } });
    // The item-wise state survives one more round: a later change is read against the changes already stated.
    const second = [...stated, message(changed, false)];
    expect(storedState({ task, catalog: catalogOf(3) }, second).parts).toEqual([]);
    expect(storedState({ task, catalog: catalogOf() }, second).row).toEqual({ catalogChanges: { changed: [catalogOf()[3]] } });
  });

  it('cuts only when the whole request does not fit, descriptions first, never a name or the skill index (production shapes)', () => {
    const catalog = catalogOf(), row = storedState({ task, catalog, skillIndex, sharedContext: context(1, 'あ'.repeat(4_000)) }, []).row;
    const cost = costOf(20_000), big = { body: { observation: { text: 'あ'.repeat(30_000) } } }, small = { body: { observation: { text: 'x' } } };
    expect(cost(row, small)).toBeLessThan(95_000);
    expect(cutToFit(row, small, fitsOf(20_000)).cut).toBe(false);
    const fitted = cutToFit(row, big, fitsOf(20_000));
    expect(cost(row, big)).toBeGreaterThan(95_000);
    expect(fitted.cut).toBe(true);
    expect(fitted.over).toBe(false);
    expect(cost(fitted.row, fitted.live)).toBeLessThanOrEqual(95_000);
    // Descriptions went first; the live state and the other parts were not needed.
    expect(fitted.levels.catalog).not.toBeNull();
    expect(fitted.levels.live).toBeNull();
    expect(fitted.levels.state).toBeNull();
    expect((fitted.row.catalog as Array<{ name: string }>).map(item => item.name)).toEqual(catalog.map(item => item.name));
    expect(fitted.row.skillIndex).toBe(skillIndex);
    expect(Object.keys(fitted.row.cappedCatalog as object).length).toBeGreaterThan(0);
    expect(fitted.live).toEqual(big);
  });

  it('goes on to the other long texts, then the live state, then names only; and says so when even that does not fit', () => {
    const catalog = catalogOf(), row = storedState({ task, catalog, skillIndex, sharedContext: context(1, 'あ'.repeat(30_000)) }, []).row;
    const big = { body: { observation: { text: 'あ'.repeat(60_000) } } };
    const names = (value: Record<string, unknown>) => (value.catalog as Array<{ name: string }>).map(item => item.name);
    // The live state alone is far over what is left: it is cut after the catalog and the shared context are at their floors.
    const deep = cutToFit(row, big, fitsOf(20_000));
    expect(deep.over).toBe(false);
    expect(deep.levels.live).not.toBeNull();
    expect(names(deep.row)).toEqual(catalog.map(item => item.name));
    expect(deep.row.skillIndex).toBe(skillIndex);
    // A request that cannot fit even with nothing but names is sent as it is, flagged, with every name and the skill index.
    const hopeless = cutToFit(row, big, fitsOf(94_000));
    expect(hopeless.over).toBe(true);
    expect(names(hopeless.row)).toEqual(catalog.map(item => item.name));
    expect(hopeless.row.skillIndex).toBe(skillIndex);
    expect(hopeless.levels.catalog).toBe(0);
  });

  it('restates what was cut whole once the request fits, and not before', () => {
    const catalog = catalogOf(), supplied = { task, catalog, skillIndex, sharedContext: context(1, 'あ'.repeat(30_000)) };
    const first = storedState(supplied, []);
    const cut = cutToFit(first.row, { body: { observation: { text: 'あ'.repeat(60_000) } } }, fitsOf(20_000));
    const message = stateMessage(cut.row, true)!;
    expect(Object.keys(cut.row.capped as object)).toEqual(['sharedContext']);
    // Nothing changed, but parts are cut: asking to restate lists them whole (the caller decides if that fits).
    const none = storedState(supplied, [message]);
    expect(none.parts).toEqual([]);
    expect(none.hasCut).toBe(true);
    const whole = storedState(supplied, [message], true);
    expect(JSON.stringify(whole.row.sharedContext)).toBe(JSON.stringify(supplied.sharedContext));
    expect((whole.row.catalogChanges as { changed: Array<{ name: string; description: string }> }).changed.length)
      .toBe(Object.keys(cut.row.cappedCatalog as object).length);
    const restated = stateMessage(whole.row, false)!;
    expect(storedState(supplied, [message, restated], true).parts).toEqual([]);
    expect(storedState(supplied, [message, restated]).hasCut).toBe(false);
  });

  it('keeps the shared context body in the summary projection (L3)', () => {
    const text = JSON.stringify({ stateUpdate: 'full', task: { id: 't' }, catalog: [{ name: 'a' }], sharedContext: { affect: { feeling: 'KEEP-ME' } } });
    expect(publicState(text)).toContain('KEEP-ME');
    expect(publicState(text)).not.toContain('"name":"a"');
  });

  it('does not start, fetch or record any recall for a transient body task, and still does for a legacy one', async () => {
    quiet();
    const transient: string[] = [], legacy: string[] = [];
    const a = scenario({ mode: () => 'transient', policy: WIDE_POLICY, body: live, steps: 5, recallLog: transient });
    await a.settle();
    expect(transient).toEqual([]);
    const b = scenario({ mode: () => 'legacy', policy: WIDE_POLICY, steps: 5, recallLog: legacy });
    await b.settle();
    expect(legacy).toContain('packet');
    expect(legacy).toContain('observeMemory');
  }, 120_000);
});

describe('cache plan of a transient request', () => {
  const base = (messages: Msg[]) => ({ model: 'claude-sonnet-5-5', max_tokens: 10, messages, system: [{ type: 'text', text: 'fixed', cache_control: { type: 'ephemeral', ttl: '1h' } }] }) as unknown as Parameters<typeof cacheFcaBodyRequest>[0];
  it('marks the protocol prefix, the instructions and the last stored block, never the system messages, and sets no top-level marker', () => {
    const request = cacheFcaBodyRequest(base([{ role: 'user', content: [{ type: 'text', text: 'state' }] }, clearAtMessage('live') as Msg,
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', content: 'r' }] },
      { role: 'system', content: [{ type: 'tool_addition' }] }, clearAtMessage('live2') as Msg])) as unknown as { messages: Msg[]; cache_control?: unknown };
    expect(breakpointCount(request as never)).toBe(3);
    expect(request.cache_control).toBeUndefined();
    expect(JSON.stringify(request.messages[3])).toContain('cache_control');
    expect(request.messages.filter(item => item.role === 'system').some(item => JSON.stringify(item).includes('cache_control'))).toBe(false);
  });
  it('refuses a top-level marker, a short TTL and more than four breakpoints', () => {
    expect(() => cacheFcaBodyRequest({ ...base([{ role: 'user', content: [{ type: 'text', text: 's' }] }]), cache_control: { type: 'ephemeral', ttl: '1h' } } as never)).toThrow();
    expect(() => cacheFcaBodyRequest(base([{ role: 'user', content: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 't' }] }]))).toThrow();
    // Two of the blocks carry a marker already; with the plan's own three that is five.
    const many = Array.from({ length: 3 }, () => ({ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }));
    expect(() => cacheFcaBodyRequest(base([{ role: 'user', content: many }]))).toThrow();
  });
});

describe('stored results are cut for a transient body task', () => {
  it('cuts a body result to 2,000 characters with the omitted count, and any other tool\'s result not at all', () => {
    const long = '原木'.repeat(2_000);
    const cut = storedBodyResult('mc.mine-block', long);
    expect(cut.startsWith('原木'.repeat(1_000))).toBe(true);
    expect(cut).toBe(`${long.slice(0, 2_000)}…(${long.length - 2_000}文字省略)`);
    expect(storedBodyResult('mc.mine-block', 'short')).toBe('short');
    expect(storedBodyResult('task.get', long)).toBe(long);
  });
  it('stores minecraft.observe as its summary form', () => {
    const frame = { schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 'x', receivedAt: 'x', connected: true,
      state: { world: { health: 20, landmarks: Array.from({ length: 900 }, (_, index) => ({ name: `目印${index}`, note: 'あ'.repeat(30) })) } }, facts: { alive: true } };
    const text = JSON.stringify(frame), stored = storedBodyResult('minecraft.observe', text);
    expect(text.length).toBeGreaterThan(30_000);
    expect(stored.length).toBeLessThan(6_100);
    expect(stored).toMatch(/…\(\d+文字省略\)$/u);
    expect(stored).toContain('"health":20');
  });
  it('stores the cut text in the round of a transient task, and the whole text nowhere else', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, body: live, resultSize: 3_000, steps: 6 });
    await run.settle();
    const results = messagesOf(run.bodies.at(-1)!).flatMap(entry => Array.isArray(entry.content)
      ? (entry.content as Array<{ type: string; content: string }>).filter(block => block.type === 'tool_result').map(block => block.content) : []);
    const body = results.filter(text => text.includes('原木'));
    expect(body.length).toBeGreaterThan(0);
    for (const text of body) { expect(text.length).toBeLessThan(2_100); expect(text).toMatch(/…\(\d+文字省略\)$/u); }
  }, 120_000);
});

describe('safety fallback and provider reports', () => {
  it('restarts a task whose very first decision is refused for the betas in the legacy shape, and logs it', async () => {
    quiet();
    const warn = vi.spyOn(console, 'warn');
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, body: live, steps: 6,
      refuse: (decision, body) => decision === 1 && JSON.stringify(body.messages).includes('clear_at')
        ? anthropicRejection('anthropic-beta: mid-conversation-system-clear-at-2026-08-21 is not enabled for this organization') : null });
    expect(await run.settle()).toBe('completed');
    expect(run.violations).toEqual([]);
    expect(run.allBodies[0]!.messages).toBeDefined();
    expect(run.headers[0]!['anthropic-beta']).toBe(FCA_TRANSIENT_BETAS);
    // Every request that was answered is the legacy shape: no turn-scoped message, no thinking binding, the legacy menu.
    for (const body of run.bodies) {
      expect(clearAts(body)).toHaveLength(0);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect((body.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(['tool_open', 'fca_wait', 'fca_complete']);
    }
    expect(warn.mock.calls.some(call => String(call[0]).includes('fca_obs_mode_fallback'))).toBe(true);
  }, 120_000);

  it('does not fall back after the first decision: a later refusal is an ordinary failure', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, body: live, steps: 6,
      refuse: decision => decision === 3 ? anthropicRejection('anthropic-beta: clear_at not enabled') : null });
    expect(await run.settle()).not.toBe('completed');
    for (const body of run.bodies) expect(clearAts(body).length).toBeGreaterThan(0);
  }, 120_000);

  it('counts the provider\'s input transformations (a dropped thinking block) in the log, content-free', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = scriptedAnthropic([message([{ type: 'tool_use', id: 'w', name: 'fca_wait', input: { summary: '待つ' } }], 'tool_use',
      { input_transformations: [{ type: 'thinking_dropped', path: 'messages.2.content.0', reason: 'prefix_binding_mismatch' }] })]);
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-sonnet-5-5', fetcher: fixture.fetcher, recordUsage() {} });
    const core = definition('mc.skill-1', 'minecraft_body');
    await model.decide({ task: { id: 't', title: 'x', goal: 'x', completionCriteria: 'x' }, messages: [], history: [], tools: [core], coreTools: [core],
      catalog: [], transient: live(1) } as never, new AbortController().signal);
    const line = warn.mock.calls.map(call => String(call[0])).find(text => text.includes('fca_input_transformations'))!;
    expect(JSON.parse(line)).toEqual({ event: 'fca_input_transformations', task: 't', count: 1, reasons: ['thinking_dropped:prefix_binding_mismatch'] });
    expect(anthropicRequestViolation(fixture.bodies[0]!)).toBeNull();
    vi.restoreAllMocks();
  });
});
