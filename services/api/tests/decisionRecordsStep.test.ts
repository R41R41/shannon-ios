import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { fcaMinecraftTools } from '../src/wiring/fcaMinecraftTools.js';
import { llmcTools } from '../src/wiring/minecraftLlmcWiring.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { minecraftBodyVersion } from '../src/surfaces/minecraft/minecraftBodyVersion.js';
import { minecraftV2Hooks } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { llmcCoreKnowledge } from '../src/surfaces/minecraft/minecraftKnowledgeCore.js';
import { storedBodyResult } from '../src/surfaces/minecraft/minecraftStoredResult.js';
import { forgetActNodes } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import type { MinecraftControlPoll } from '../src/contracts/minecraftControlContract.js';
import { actionResource } from '../src/contracts/actionThreadContract.js';
import { DecisionRecorder } from '../src/infra/decisionRecords/decisionRecorder.js';
import { installDecisionRecorder } from '../src/infra/decisionRecords/decisionRecordNotes.js';
import { decisionDocument, readBlob, readRun, selectRequests } from '../src/infra/decisionRecords/decisionRecordRead.js';
import { renderDecisions } from '../src/infra/decisionRecords/decisionRecordMarkdown.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { queueBody, queueFor } from './support/llmcQueueHarness.js';
import lives from './fixtures/minecraft-v2-lives-v1.json' with { type: 'json' };

/**
 * Decision records through the real runner, the real decision model (a scripted provider), the real tools and the real control. No model is called.
 * The record is read back to the request the provider was sent, the answer, what the step did, the act as the model wrote it, as the tool had it and
 * as the body was sent it, and the reason one was not sent; and a decision stopped in flight still has its input.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  installDecisionRecorder(null);
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  forgetActNodes();
});
const at = () => '2026-10-23T00:00:00.000Z';
const live = (lives as Record<string, Record<string, any>>)['s09-r34-1536-bridge-repeat']!;

/** Rock around the feet (220,56,62) with a corridor along +x two cells long. */
function rock() {
  const lines = ['地図 v1 足=(220,56,62) x=213..227 z=55..69 方式=layers 上=北'];
  for (const dy of [1, 0, -1]) {
    lines.push(`y=${56 + dy}`);
    for (let z = 55; z <= 69; z += 1) {
      lines.push(` ${z} ${Array.from({ length: 15 }, (_, i) => {
        const x = 213 + i;
        if (z === 62 && x >= 220 && x <= 222 && dy >= 0) return x === 220 && dy === 0 ? '@' : '.';
        return '#';
      }).join(' ')}`);
    }
  }
  return { position: { x: 220.5, y: 56, z: 62.5 }, localMap: lines.join('\n'), health: 20 };
}
const ACT_DONE = JSON.stringify({ v: 1, ok: true, done: 2, of: 2, ms: 1000, at: { x: 222, y: 56, z: 62 }, hp: 20, food: 20,
  lines: [1, 2].map(i => ({ i, do: 'walk', status: 'done', line: `(22${i},56,62) に着いた` })) });

/** A body task over the real control and tools, asking the given provider (a fetch); the records go to a temporary root. */
function harness(fetcher: typeof fetch) {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const root = mkdtempSync(join(tmpdir(), 'decision-records-step-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  installDecisionRecorder(new DecisionRecorder({ root, head: { revision: 'b55ecd5', source: 'git', node: process.version }, log: () => undefined }));
  const h = actionHarness(at), store = new MinecraftControlStore(h.db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world',
    onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const control = new MinecraftControl(store, configuration, { now: () => Date.parse(at()), ownerAlone: () => true, pollMilliseconds: 1,
    leaseValid: lease => !!h.store.check(lease, at())?.resources.includes(actionResource('minebot', 'minecraft-body')) });
  const loose = { type: 'object', properties: {}, required: [], additionalProperties: false };
  let sequence = 0;
  const poll = (receipts: MinecraftControlPoll['receipts'] = []) => control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, {
    schemaVersion: 1, serverId: 'world', connectionId: 'connection-7',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: at(), receivedAt: at(), connected: true,
      state: { world: rock() as never, build: { revision: 'b0dy123' } as never }, facts: {} as never },
    skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: loose }], candidates: [], receipts, activeOperationIds: [] } satisfies MinecraftControlPoll);
  poll();
  const plan = { revision: 3, current: 'p1.2', nodes: [{ id: 'p1', parentId: null, title: '出発の点検', state: 'continue' as const },
    { id: 'p1.2', parentId: 'p1', title: '西の幹へ', state: 'continue' as const }] };
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-opus-5-5', fetcher, recordUsage() {}, minecraftOwnPrompt: true,
    systemAppendix: llmcCoreKnowledge(), minecraftV2: minecraftV2Hooks() });
  const news: string[] = [];
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now: at,
    stepPorts: (_runtime, step) => {
      const queue = queueFor(control, step, plan);
      return { keepBodyTools: () => true, obsMode: 'transient' as const, history: { codec: anthropicFcaHistoryCodec },
        versions: () => minecraftBodyVersion(control, 'minecraft:world'),
        selector: { async select(request: { tools: Array<{ name: string }> }) { return { names: request.tools.map(tool => tool.name), source: 'catalog' as const }; } },
        body: { ...queueBody(queue, news), transient: () => live.body, storedResult: (item: { name: string }, text: string) => storedBodyResult(item.name, text) },
        tools: llmcTools(fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true, llmc: { plan: () => plan, queue } })) } as never;
    } });
  cleanups.push(async () => {
    try { await driver.close(); } catch { /* closed by the test already */ }
    try { h.close(); } catch { /* as above */ }
  });
  const top = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', top.id, { title: 'End', goal: 'エンドラを討伐して', completionCriteria: '東へ着いた' }, 'minecraft-request');
  store.bind(task.id, 'minecraft:world');
  // The body answers the one command it is sent.
  const answered = new Set<string>();
  const body = setInterval(() => {
    const sent = poll().commands[0];
    if (!sent || answered.has(sent.id)) return;
    answered.add(sent.id);
    poll([{ id: sent.id, connectionId: 'connection-7', outcome: 'completed', inputsReleased: true, observedAt: at(), result: ACT_DONE }]);
  }, 5);
  cleanups.push(() => clearInterval(body));
  return { root, driver, task, directory: join(root, task.id) };
}

describe('decision records through a body task\'s steps', () => {
  it('keeps each decision\'s request exactly as sent, its answer, what the step did, the act in each of its forms, and why one was not sent', async () => {
    const call = (index: number, hands: string[]) => message([{ type: 'thinking', thinking: `考え ${index}`, signature: `signed-${index}-${'s'.repeat(200)}` },
      { type: 'tool_use', id: `toolu_${index}`, name: 'mc_act', input: { why: '[p1.2] 東へ', hands, stopIf: 'hpBelow=10' } }], 'tool_use');
    const fixture = scriptedAnthropic((_body, index) => index === 0 ? call(0, ['walk 224,56,62', 'walk 222,56,62'])
      : index === 1 ? call(1, ['walk 221,56,62', 'walk 222,56,62'])
        : message([{ type: 'tool_use', id: 'toolu_2', name: 'fca_complete', input: { summary: '東へ着いた' } }], 'tool_use'));
    const { driver, task, directory } = harness(fixture.fetcher);
    for (let i = 0; i < 400 && !['completed', 'failed', 'unknown'].includes(driver.runtime.get('owner', task.id)?.phase ?? ''); i += 1) {
      await driver.tick();
      await driver.drain();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(fixture.bodies).toHaveLength(3);

    const run = readRun(directory);
    const requests = run.events.filter(event => event.ev === 'request');
    expect(requests.map(event => [event.id, event.kind, event.no])).toEqual([['d0001', 'decision', 1], ['d0002', 'decision', 2], ['d0003', 'decision', 3]]);
    // The step's number (the `d` of the metrics line) and the round in it; the third is a round of the second's step or a step of its own.
    expect(requests.map(event => [event.stepIndex, event.round]).slice(0, 2)).toEqual([[1, 1], [2, 1]]);
    expect(requests[2]!.stepIndex).toBeGreaterThanOrEqual(2);
    expect(requests[0]).toMatchObject({ taskId: task.id, model: 'claude-opus-5-5', operationId: expect.stringMatching(/:decision$/u),
      headers: { 'anthropic-beta': expect.stringContaining('inline-tools') }, config: { thinking: { type: 'adaptive', block_binding: expect.anything() } } });
    expect(run.run).toMatchObject({ taskId: task.id, head: { revision: 'b55ecd5' } });

    // The record is the request the provider was sent: its model, settings, system, tools and every message, byte for byte.
    requests.forEach((request, index) => {
      const { system, tools, messages, ...rest } = fixture.bodies[index]!;
      const rebuilt = { ...request.config, system: readBlob(directory, request.system), tools: readBlob(directory, request.tools),
        messages: (request.messages as string[]).map(id => readBlob(directory, id)) };
      expect(JSON.parse(JSON.stringify(rebuilt))).toEqual({ ...rest, system, tools, messages });
    });
    // The version of the parts it ran on: the prompt's hashes and the body's connection, catalog and reported build.
    expect(requests[0]!.version.prompt.system.length).toBeGreaterThanOrEqual(2);
    expect(requests[0]!.version.prompt.toolDefinitions).toHaveProperty('mc_act');
    expect(requests[0]!.version.body).toMatchObject({ connected: true, connectionId: 'connection-7', serverId: 'world', skills: ['act'], reported: { 'state.build.revision': 'b0dy123' } });
    expect(requests[0]!.version.body.catalog).toMatch(/^[0-9a-f]{12}$/u);
    expect(requests[0]!.version.prompt.system).toEqual(requests[2]!.version.prompt.system);

    // The answers, with their usage; what the step did with each; the live state the decision read is in the last message.
    for (const request of requests) expect(run.events.find(event => event.ev === 'response' && event.id === request.id)).toMatchObject({ outcome: 'ok', tokens: { input: 120 } });
    expect(run.events.filter(event => ['applied', 'discarded', 'failed'].includes(event.ev)).map(event => [event.ev, event.id, event.decision])).toEqual([
      ['applied', 'd0001', 'tools'], ['applied', 'd0002', 'tools'], ['applied', 'd0003', 'complete']]);
    const last = readBlob(directory, requests[0]!.messages.at(-1)) as { content: string };
    expect(last.content).toContain('歪んだ幹');

    // The first act was turned back by a guard: nothing was sent, and the record says why. The second went to the body, rewritten into hands.
    const first = decisionDocument(run, requests[0]!), second = decisionDocument(run, requests[1]!);
    expect(first.calls[0]).toMatchObject({ name: 'mc.act', sentToBody: false, notSentReason: expect.stringContaining('体には何も送っていない'),
      modelInput: { hands: ['walk 224,56,62', 'walk 222,56,62'] } });
    expect(second.calls[0]).toMatchObject({ sentToBody: true, notSentReason: null, modelInput: { hands: ['walk 221,56,62', 'walk 222,56,62'] } });
    expect(second.calls[0]!.input).toMatchObject({ hands: [{ do: 'walk', to: { x: 221, y: 56, z: 62 } }, { do: 'walk', to: { x: 222, y: 56, z: 62 } }] });
    expect(second.calls[0]!.sent).toHaveLength(1);
    expect(second.calls[0]!.sent[0]).toMatchObject({ skill: 'act', decisionId: 'd0002', connectionId: 'connection-7', queue: { item: 'q1' },
      arguments: { hands: [{ do: 'walk', to: { x: 221, y: 56, z: 62 } }, { do: 'walk', to: { x: 222, y: 56, z: 62 } }], stopIf: { hpBelow: 10 } } });
    expect(run.events.filter(event => event.ev === 'sent')).toHaveLength(1);
    expect(selectRequests(run, { item: 'q1' }).map(event => event.id)).toEqual(['d0002']);
    expect(selectRequests(run, { step: 1 }).map(event => event.id)).toEqual(['d0001']);
    const text = renderDecisions([first, second]);
    expect(text).toContain('体へは送らなかった');
    expect(text).toContain('列 q1');
    expect(text).toContain('歪んだ幹');
  }, 60_000);

  it('keeps the input of a decision that is stopped while it is asked (the provider never answers)', async () => {
    const asked: string[] = [];
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) => {
      asked.push(String(init?.body).length > 1_000 ? 'big' : 'small');
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }) as typeof fetch;
    const { driver, task, directory } = harness(hanging);
    await driver.tick();
    for (let i = 0; i < 200 && !asked.length; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(asked).toEqual(['big']);
    // Nothing has come back, and the request is already on disk.
    expect(readRun(directory).events.map(event => event.ev)).toEqual(['run', 'request']);
    // The owner's stop: the step's signal is aborted while the provider has not answered.
    await driver.close();
    for (let i = 0; i < 1200 && !['failed', 'response'].every(name => readRun(directory).events.some(event => event.ev === name)); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    const run = readRun(directory);
    expect(run.events.find(event => event.ev === 'response')).toMatchObject({ id: 'd0001', outcome: 'aborted' });
    expect(run.events.find(event => event.ev === 'failed')).toMatchObject({ id: 'd0001' });
    const document = decisionDocument(run, run.events.find(event => event.ev === 'request')!);
    expect(document.request.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(document.request.messages.at(-1))).toContain('歪んだ幹');
    expect(document.response).toMatchObject({ outcome: 'aborted' });
  }, 60_000);
});
