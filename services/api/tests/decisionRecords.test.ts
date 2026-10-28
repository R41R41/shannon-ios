import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordedClient } from '../src/infra/decisionRecords/decisionRecordClient.js';
import { decisionRecordsRoot, DecisionRecorder } from '../src/infra/decisionRecords/decisionRecorder.js';
import { installDecisionRecorder, noteBodyCommand, noteDecisionCall, noteDecisionOutcome } from '../src/infra/decisionRecords/decisionRecordNotes.js';
import { decisionDocument, listRuns, readBlob, readRun, selectRequests } from '../src/infra/decisionRecords/decisionRecordRead.js';
import { renderDecisions } from '../src/infra/decisionRecords/decisionRecordMarkdown.js';
import { beginDecisionRound, setDecisionStepIndex, withDecisionCall, withDecisionScope } from '../src/infra/decisionRecords/decisionRecordScope.js';
import { pruneRuns, runName, scrubSecrets, type DecisionRecordLimits } from '../src/infra/decisionRecords/decisionRecordStore.js';
import { headVersion } from '../src/infra/decisionRecords/decisionRecordVersion.js';
import type { MinecraftControlCommand } from '../src/contracts/minecraftControlContract.js';

const directories: string[] = [];
const fresh = () => {
  const directory = mkdtempSync(join(tmpdir(), 'decision-records-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  installDecisionRecorder(null);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
let clock = Date.parse('2026-10-28T03:00:00.000Z');
const HEAD = { revision: 'abc1234', source: 'DEPLOYED_REVISION' as const, node: 'v24.0.0' };
const LIMITS: DecisionRecordLimits = { maxRuns: 60, maxTotalBytes: 1024 ** 3, maxRunBytes: 64 * 1024 ** 2 };
function recorder(root = fresh(), limits = LIMITS) {
  const made = new DecisionRecorder({ root, limits, now: () => (clock += 1_000), head: HEAD, log: () => undefined });
  installDecisionRecorder(made);
  return { made, root };
}
const MESSAGE = (text: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null,
  content: [{ type: 'thinking', thinking: '考える', signature: 'S'.repeat(400) }, { type: 'tool_use', id: 'toolu_1', name: 'mc_act', input: { why: text, hands: ['walk 1,2,3'] } }],
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 9_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000 } } });
const BODY = (messages: unknown[]) => ({ model: 'claude-opus-5-5', max_tokens: 4_000, system: [{ type: 'text', text: 'あなたは体を動かす', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages, tools: [{ name: 'mc_act', description: '動く', input_schema: { type: 'object' } }], tool_choice: { type: 'auto' }, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
const fake = (handler: (body: never, options: never) => PromiseLike<unknown>) => ({ messages: { create: handler } });
const scope = (work: () => PromiseLike<unknown>, init: { taskId?: string; record?: boolean } = {}) =>
  Promise.resolve(withDecisionScope({ taskId: init.taskId ?? 'task-a', stepId: 'step-1', record: init.record ?? true }, work));

describe('decision records: what is kept of a request', () => {
  it('writes the whole request before it goes out, the answer after it, and each part that comes again once', async () => {
    const { root } = recorder();
    let asked = 0;
    const client = recordedClient(fake(async () => MESSAGE(`東へ ${asked += 1}`)), 'decision');
    const first = [{ role: 'user', content: '最初の状態' }];
    const second = [...first, { role: 'assistant', content: [{ type: 'text', text: '答え' }] }, { role: 'system', clear_at: 'x', content: '今の状態' }];
    await scope(async () => {
      setDecisionStepIndex(7);
      beginDecisionRound('step-1:decision', 1);
      await client.messages.create(BODY(first) as never, { headers: { 'anthropic-beta': 'inline-tools-2026-09-15' } } as never);
      beginDecisionRound('step-1:decision2', 2);
      await client.messages.create(BODY(second) as never, {} as never);
    });
    const run = readRun(join(root, 'task-a'));
    expect(run.events.map(event => event.ev)).toEqual(['run', 'request', 'response', 'request', 'response']);
    expect(run.run).toMatchObject({ taskId: 'task-a', head: HEAD });
    const [one, two] = run.events.filter(event => event.ev === 'request');
    expect(one).toMatchObject({ id: 'd0001', no: 1, kind: 'decision', stepIndex: 7, round: 1, operationId: 'step-1:decision', model: 'claude-opus-5-5',
      headers: { 'anthropic-beta': 'inline-tools-2026-09-15' }, config: { max_tokens: 4_000, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }, toolNames: ['mc_act'] });
    expect(two).toMatchObject({ id: 'd0002', no: 2, round: 2, operationId: 'step-1:decision2' });
    expect(two!.messages.slice(0, 1)).toEqual(one!.messages);
    expect(one!.version.prompt.system).toHaveLength(1);
    expect(one!.version.prompt.toolDefinitions).toHaveProperty('mc_act');
    // The same system and tools are one part each; the first message is one part; the second request adds two; two answers.
    expect(readdirSync(join(root, 'task-a', 'blobs'))).toHaveLength(1 + 1 + 3 + 2);
    expect(readBlob(join(root, 'task-a'), one!.messages[0])).toEqual(first[0]);
    const answer = run.events.find(event => event.ev === 'response' && event.id === 'd0001')!;
    expect(answer).toMatchObject({ outcome: 'ok', stopReason: 'tool_use', tokens: { input: 100, output: 50, cacheWrite: 1_000, cacheRead: 9_000 } });
    expect(answer.costUsd).toBeGreaterThan(0);
    expect((readBlob(join(root, 'task-a'), answer.content) as Array<{ type: string }>).map(block => block.type)).toEqual(['thinking', 'tool_use']);
  });

  it('keeps the input of a request that is aborted in flight, and says why the call ended', async () => {
    const { root } = recorder();
    const client = recordedClient(fake((_body, options) => new Promise((_resolve, reject) => {
      (options as { signal: AbortSignal }).signal.addEventListener('abort', () => reject(new Error('Request was aborted.')), { once: true });
    })), 'decision');
    const controller = new AbortController();
    const call = scope(async () => {
      beginDecisionRound('step-1:decision', 1);
      await client.messages.create(BODY([{ role: 'user', content: '状態' }]) as never, { signal: controller.signal } as never);
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    // Before anything is aborted the request is already on disk: a held or cancelled decision still has its input.
    expect(readRun(join(root, 'task-a')).events.map(event => event.ev)).toEqual(['run', 'request']);
    controller.abort(new Error('FCA_URGENT_INTERRUPT'));
    await expect(call).rejects.toThrow('aborted');
    const events = readRun(join(root, 'task-a')).events;
    expect(events.at(-1)).toMatchObject({ ev: 'response', id: 'd0001', outcome: 'aborted', reason: 'FCA_URGENT_INTERRUPT' });
    expect(readBlob(join(root, 'task-a'), events[1]!.messages[0])).toEqual({ role: 'user', content: '状態' });
  });

  it('records an error that is not an abort, and a call outside a recorded step not at all', async () => {
    const { root } = recorder();
    const failing = recordedClient(fake(async () => { throw Object.assign(new Error('overloaded'), { status: 529, name: 'APIError' }); }), 'summary');
    await scope(() => failing.messages.create(BODY([]) as never, {} as never).then(() => undefined, () => undefined));
    expect(readRun(join(root, 'task-a')).events.at(-1)).toMatchObject({ ev: 'response', id: 's0001', outcome: 'error', error: { status: 529, message: 'overloaded' } });
    let called = 0;
    const plain = recordedClient(fake(async () => { called += 1; return MESSAGE('x'); }), 'decision');
    await plain.messages.create(BODY([]) as never, {} as never);
    await scope(() => plain.messages.create(BODY([]) as never, {} as never), { taskId: 'task-b', record: false });
    expect(called).toBe(2);
    expect(existsSync(join(root, 'task-b'))).toBe(false);
  });

  it('keeps no key or token, in a part or in a line', async () => {
    const { root } = recorder();
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const client = recordedClient(fake(async () => MESSAGE(`token ${secret}`)), 'decision');
    await scope(async () => {
      await client.messages.create(BODY([{ role: 'user', content: `Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 ${secret}` }]) as never, {} as never);
      noteDecisionCall({ toolUseId: 't', name: 'x', input: { key: secret }, operationId: 'o', skipped: false, ms: 1, result: { ok: true, text: secret } });
    });
    expect(scrubSecrets(`a ${secret} b`)).toBe('a [redacted] b');
    const run = readRun(join(root, 'task-a'));
    const parts = run.events.flatMap(event => [event.system, event.tools, event.content, ...(event.messages ?? [])].filter(Boolean)).map(id => readBlob(join(root, 'task-a'), String(id)));
    const text = JSON.stringify([run.events, parts]);
    expect(parts.length).toBeGreaterThan(3);
    expect(text).not.toContain('ABCDEFGHIJKLMNOP');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(text).toContain('[redacted]');
  });

  it('goes on counting after a restart, writes nothing past its limit, and never throws', async () => {
    const root = fresh();
    recorder(root);
    const client = recordedClient(fake(async () => MESSAGE('a')), 'decision');
    await scope(() => client.messages.create(BODY([{ role: 'user', content: 'a' }]) as never, {} as never));
    recorder(root);
    await scope(() => client.messages.create(BODY([{ role: 'user', content: 'b' }]) as never, {} as never));
    expect(readRun(join(root, 'task-a')).events.filter(event => event.ev === 'request').map(event => event.id)).toEqual(['d0001', 'd0002']);
    const small = recorder(fresh(), { ...LIMITS, maxRunBytes: 3_000 });
    await scope(async () => {
      for (let index = 0; index < 5; index += 1) await client.messages.create(BODY([{ role: 'user', content: randomBytes(1_500).toString('hex') }]) as never, {} as never);
    }, { taskId: 'task-capped' });
    expect(readRun(join(small.root, 'task-capped')).events.filter(event => event.ev === 'capped')).toHaveLength(1);
    // A root that cannot be written to costs the decision nothing.
    installDecisionRecorder(new DecisionRecorder({ root: join(root, 'task-a', 'events.jsonl', 'nowhere'), head: HEAD, log: () => undefined }));
    await expect(scope(() => client.messages.create(BODY([]) as never, {} as never))).resolves.toBeDefined();
  });
});

const COMMAND = (id: string, taskId: string): MinecraftControlCommand => ({ schemaVersion: 1, id, serverId: 'world', connectionId: 'connection-1', kind: 'skill', skill: 'act',
  arguments: { why: '[p1.2] 東へ', hands: [{ do: 'walk', to: { x: 221, y: 56, z: 62 } }] }, deadlineAt: '2026-10-28T03:10:00.000Z',
  queue: { item: 'q15', after: null, node: 'p1.2', maxMs: 20_000, startBy: '2026-10-28T03:00:30.000Z' },
  context: { scopeKey: 'owner', taskId, taskRevision: 4, bodyId: 'minecraft:world', sessionId: 'step-1', generation: 2, goal: 'エンドラを討伐して', completionCondition: '',
    plan: { revision: 1, current: 'p1.2', nodes: [] } },
  lease: { id: 'lease-1', generation: 2 } as never });

describe('decision records: what a run keeps and how it is read back', () => {
  /** Two decisions of one step: the first sends an act (the head rewrote its hands), the second is turned back by a guard and sends nothing. */
  async function twoDecisions(root: string) {
    const answers = [MESSAGE('東へ'), { ...MESSAGE('西へ'), id: 'msg_2', content: [{ type: 'tool_use', id: 'toolu_2', name: 'mc_act', input: { why: '西へ', hands: ['walk 9,9,9'] } }] }];
    const client = recordedClient(fake(async () => answers.shift()), 'decision');
    await scope(async () => {
      setDecisionStepIndex(3);
      beginDecisionRound('step-1:decision', 1);
      await client.messages.create(BODY([{ role: 'user', content: '状態 1' }]) as never, {} as never);
      noteDecisionOutcome('applied', { decision: 'tools', stale: false, calls: [{ id: 'toolu_1', name: 'mc.act' }] });
      await withDecisionCall({ operationId: 'step-1:toolu_1', toolUseId: 'toolu_1', name: 'mc.act' }, async () => noteBodyCommand(COMMAND('skill:aaa', 'task-a')));
      noteDecisionCall({ toolUseId: 'toolu_1', name: 'mc.act', input: { why: '東へ', hands: [{ do: 'walk', to: { x: 221, y: 56, z: 62 } }] },
        operationId: 'step-1:toolu_1', skipped: false, ms: 12, result: { ok: true, text: '列に入れた q15' } });
      beginDecisionRound('step-1:decision2', 2);
      await client.messages.create(BODY([{ role: 'user', content: '状態 1' }, { role: 'assistant', content: 'x' }, { role: 'user', content: '状態 2' }]) as never, {} as never);
      noteDecisionOutcome('applied', { decision: 'tools', stale: false, calls: [{ id: 'toolu_2', name: 'mc.act' }] });
      noteDecisionCall({ toolUseId: 'toolu_2', name: 'mc.act', input: { why: '西へ', hands: [] }, operationId: 'step-1:toolu_2', skipped: false, ms: 3,
        result: { ok: false, failure: 'refused', retryable: true, text: '送らなかった: 前提 hp>=10 を今は満たさない。体には何も送っていない' } });
    });
    return readRun(join(root, 'task-a'));
  }

  it('finds a decision by its number, its step, its id, a time, or the queue item its act became', async () => {
    const { root } = recorder();
    const run = await twoDecisions(root);
    expect(selectRequests(run, { no: 2 }).map(event => event.id)).toEqual(['d0002']);
    expect(selectRequests(run, { step: 3 }).map(event => event.id)).toEqual(['d0001', 'd0002']);
    expect(selectRequests(run, { id: 'd0001' }).map(event => event.id)).toEqual(['d0001']);
    expect(selectRequests(run, { item: 'q15' }).map(event => event.id)).toEqual(['d0001']);
    const second = run.events.find(event => event.ev === 'request' && event.id === 'd0002')!;
    expect(selectRequests(run, { at: second.at }).map(event => event.id)).toEqual(['d0002']);
    expect(selectRequests(run, { at: '2000-01-01T00:00:00Z' }).map(event => event.id)).toEqual(['d0001']);
    expect(selectRequests(run, { no: 99 })).toEqual([]);
    expect(listRuns(root)).toMatchObject([{ name: 'task-a', taskId: 'task-a', decisions: 2, summaries: 0, sent: 1 }]);
  });

  it('puts one decision in one document: the input whole, the answer, what the step did, the act as the model wrote it and as it was sent', async () => {
    const { root } = recorder();
    const run = await twoDecisions(root);
    const [first, second] = ['d0001', 'd0002'].map(id => decisionDocument(run, run.events.find(event => event.ev === 'request' && event.id === id)!));
    expect(first!.request.messages.map(message => message.content)).toEqual([{ role: 'user', content: '状態 1' }]);
    expect(second!.request.messages).toHaveLength(3);
    expect(first!.request.system).toEqual(BODY([]).system);
    expect(first!.version.head).toEqual(HEAD);
    expect(first!.outcome).toMatchObject([{ ev: 'applied', decision: 'tools' }]);
    expect(first!.response!.content).toMatchObject([{ type: 'thinking', signature: '<signature 400 chars>' }, { type: 'tool_use', id: 'toolu_1' }]);
    expect(first!.calls).toHaveLength(1);
    expect(first!.calls[0]).toMatchObject({ toolUseId: 'toolu_1', modelInput: { why: '東へ', hands: ['walk 1,2,3'] }, sentToBody: true, notSentReason: null });
    expect(first!.calls[0]!.input).toMatchObject({ hands: [{ do: 'walk' }] });
    expect(first!.calls[0]!.sent[0]).toMatchObject({ commandId: 'skill:aaa', queue: { item: 'q15' }, arguments: { hands: [{ do: 'walk', to: { x: 221 } }] },
      context: { taskRevision: 4, generation: 2 }, leaseId: 'lease-1', decisionId: 'd0001', toolUseId: 'toolu_1' });
    expect(JSON.stringify(first!.calls[0]!.sent[0])).not.toContain('エンドラ');
    expect(second!.calls[0]).toMatchObject({ sentToBody: false, notSentReason: expect.stringContaining('送らなかった: 前提 hp>=10') });
    const kept = decisionDocument(run, run.events.find(event => event.ev === 'request' && event.id === 'd0001')!, { keepSignatures: true, lastMessages: 1 });
    expect(JSON.stringify(kept.response!.content)).toContain('S'.repeat(400));
    const text = renderDecisions([first!, second!]);
    expect(text).toContain('# 判断 d0001');
    expect(text).toContain('列 q15');
    expect(text).toContain('体へは送らなかった');
    expect(text).toContain('状態 2');
  });

  it('takes the oldest runs away, never one it is writing, and names runs and versions plainly', async () => {
    const root = fresh();
    for (const [index, name] of ['old-1', 'old-2', 'mid', 'new'].entries()) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'events.jsonl'), '{"ev":"run"}\n');
      utimesSync(join(root, name, 'events.jsonl'), new Date(2026, 9, 1 + index), new Date(2026, 9, 1 + index));
    }
    expect(await pruneRuns(root, { ...LIMITS, maxRuns: 2 }, new Set(['old-1']))).toEqual(['old-2', 'mid']);
    expect(readdirSync(root).sort()).toEqual(['new', 'old-1']);
    expect(await pruneRuns(root, { ...LIMITS, maxTotalBytes: 1 }, new Set(['new']))).toEqual(['old-1']);
    expect(runName('e7021389-8b0e')).toBe('e7021389-8b0e');
    expect(runName('../x')).toMatch(/^x[0-9a-f]{20}$/u);
    expect(decisionRecordsRoot('/var/shannon/data/shannon.sqlite')?.replace(/\\/gu, '/')).toBe('/var/shannon/data/decision-records');
    expect(decisionRecordsRoot(':memory:')).toBeNull();
    const deployed = fresh();
    writeFileSync(join(deployed, 'DEPLOYED_REVISION'), 'ef392c3 deployed\n');
    expect(headVersion(deployed)).toMatchObject({ revision: 'ef392c3', source: 'DEPLOYED_REVISION' });
    const checkout = fresh();
    mkdirSync(join(checkout, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(checkout, '.git', 'refs', 'heads', 'main'), `${'a1'.repeat(20)}\n`);
    expect(headVersion(checkout)).toMatchObject({ revision: 'a1'.repeat(20), source: 'git' });
  });
});
