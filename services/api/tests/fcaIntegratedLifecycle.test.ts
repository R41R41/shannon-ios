import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { fcaReadReceiptSources } from '../src/mind/action/fca/fcaConversationSources.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import type { ChatStreamLine } from '../src/contracts/contracts.js';
import { actionPermit } from '../src/infra/context/actionExecution.js';
import { chatSentenceStreamLines } from '../src/surfaces/text/chatSentenceStream.js';
import { integratedFcaHarness, latch, round, until } from './support/fcaIntegratedHarness.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const researchSpec = { title: '分光装置の調査', goal: '分光装置の公開資料を調べる', completionCriteria: '出典を確認して会話へ知らせる' };
async function createWork(f: ReturnType<typeof integratedFcaHarness>, research = true) {
  return f.talk('分光装置の資料を調べ、装置用の石を一つ採ってください。', async turn => {
    let researchId = '';
    if (research) {
      const result = await turn.call('task.create', researchSpec); expect(result.ok).toBe(true);
      researchId = (JSON.parse(result.text) as TaskView).id;
    }
    const result = await turn.call('minecraft.request', { goal: '分光装置用の石を一つ採る' });
    expect(result.ok, result.text).toBe(true);
    const gameId = f.driver.runtime.list('owner').find(task => f.bodyStore.body(task.id))!.id;
    expect(f.driver.runtime.readyTasks('owner'), 'source must bind before either child can run').toEqual([]);
    return { researchId, gameId };
  });
}
function rounds() {
  const counts = new Map<string, number>();
  return (input: FcaModelInput) => { const count = counts.get(input.task.id) ?? 0; counts.set(input.task.id, count + 1); return count; };
}

describe('integrated common FCA lifecycle with the real SQLite, action, body, memory and affect paths', () => {
  it('runs the real text route and sentence stream while both background slots await external results', async () => {
    const searched = latch(), release = latch();
    const f = integratedFcaHarness({ web: async () => { searched.release(); await release.promise;
      return { status: 'results', text: '公開資料を確認しました。', sources: [] }; },
    decide: input => round({ kind: 'tools', calls: input.task.title === researchSpec.title
      ? [{ id: 'search', name: 'web.search', input: { query: '分光装置 公開仕様' } }]
      : [{ id: 'dig', name: 'mc.dig', input: { count: 1 } }] }) });
    cleanup.push(() => f.close(), release.release);
    let modelCalls = 0;
    const generate = async (request: ShannonChatModelRequest, delta?: (text: string) => void | Promise<void>) => {
      await actionPermit(); modelCalls++;
      if (modelCalls === 1) {
        for (const [name, input] of [['task_create', researchSpec], ['minecraft_request', { goal: '分光装置用の石を一つ採る' }]] as const) {
          const result = JSON.parse(await request.tools!.call(name, JSON.stringify(input))) as { ok: boolean; text: string };
          expect(result.ok, result.text).toBe(true);
        }
        expect(f.driver.runtime.readyTasks('owner')).toEqual([]);
      }
      await actionPermit();
      await delta?.('作業を進めています。'); await delta?.('会話も続けられます。');
      return { mode: 'local-stub' as const, model: 'foreground-fixture', reply: '作業を進めています。会話も続けられます。' };
    };
    const model: ShannonChatModel = { mode: 'local-stub', model: 'foreground-fixture', generate, generateStreaming: generate };
    const kernel = createLocalApiKernel(f.now, { stateStore: f.store, conversationStore: f.store, autonomy: f.autonomy,
      chatModel: model, fcaConversation: () => f.bridge });
    cleanup.push(() => kernel.waitForBackground('owner'));
    const lines: ChatStreamLine[] = [];
    const chat = (message: string) => f.foreground(() => kernel.dispatch({ method: 'POST', path: '/v1/chat',
      body: { scopeKey: 'owner', message, stream: 'sentences' }, chatSentences: { write: line => lines.push(line) } }));
    expect((await chat('分光装置の資料と石を並行して確認してください。')).status).toBe(200);
    const children = f.driver.runtime.list('owner').filter(task => !['root', 'conversation'].includes(task.kind));
    expect(children).toHaveLength(2);
    expect(children.every(task => f.driver.runtime.taskSources('owner', task.id).some(source => source.experienceId))).toBe(true);
    await f.driver.tick(); await searched.promise; const command = await f.command();
    lines.length = 0;
    const reply = await chat('作業中ですね。こちらでは会話を続けましょう。');
    expect(reply.status).toBe(200); expect(reply.sentenceStream).toEqual({ fallback: null });
    expect(lines.filter(line => line.type === 'sentence').map(line => line.text)).toEqual(['作業を進めています。']);
    expect(chatSentenceStreamLines(reply).filter(line => line.type === 'sentence').map(line => line.text))
      .toEqual(['作業を進めています。', '会話も続けられます。']);
    expect(modelCalls, 'one foreground model call per ordinary turn').toBe(2);
    expect(f.calls).toHaveLength(2);
    expect(children.every(task => f.driver.runtime.get('owner', task.id)?.phase === 'executing')).toBe(true);
    release.release(); f.acknowledge(command); await f.driver.drain();
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
  });

  it('keeps conversation available during parallel research/body work, delivers messages, and carries experience and feeling into the next decision under forgetting', async () => {
    const searchEntered = latch(), searchRelease = latch(), next = rounds();
    let conversationId = '';
    const f = integratedFcaHarness({ web: async () => {
      searchEntered.release(); await searchRelease.promise;
      return { status: 'results', text: '分光装置について公開資料を三件確認しました。', sources: [{ title: 'Source', url: 'https://example.com/spectrometer' }] };
    }, decide: input => {
      const n = next(input);
      if (input.task.title === researchSpec.title) {
        if (n === 0) return round({ kind: 'tools', calls: [{ id: 'search', name: 'web.search', input: { query: '分光装置 公開仕様' } }] });
        if (n === 1) return round({ kind: 'tools', calls: [{ id: 'report', name: 'task.send', input: { id: conversationId, message: '分光装置の公開資料を確認しました。' } }] });
        return round(n === 2 ? { kind: 'wait', summary: '次の会話からの確認待ち' } : { kind: 'complete', summary: '分光装置の資料を報告済み' });
      }
      if (input.task.goal === '分光装置用の石を一つ採る') {
        if (n === 0) return { ...round({ kind: 'tools', calls: [{ id: 'dig', name: 'mc.dig', input: { count: 1 } }] }),
          expectations: [{ callId: 'dig', source: 'tool_result', observable: { kind: 'json_pointer', path: '/stone' }, expected: 2, probability: 0.8, expectedValue: 0.2, withinMs: 1000 }] };
        const outcome = input.sharedContext!.recentOutcomes.find(event => event.name === 'mc.dig')!;
        return { ...round({ kind: 'complete', summary: '分光装置用の石を一つ確認しました。' }),
          appraisals: [{ eventId: outcome.eventId, revision: 1, value: 0.8, cause: '新しい観測で目的の石を確認できた', target: '採掘' }] };
      }
      return round({ kind: 'wait', summary: '共有された経験を読んで次の指示を待つ' });
    } });
    cleanup.push(() => f.close(), searchRelease.release);
    const initialValence = f.store.snapshot('owner').emotion.valence;
    const first = await createWork(f); conversationId = first.taskId;
    const { researchId, gameId } = first.value;
    expect(f.driver.runtime.get('owner', gameId)?.parentId).toBe(conversationId);
    expect(f.driver.runtime.get('owner', researchId)?.parentId).toBe(conversationId);
    expect(f.driver.runtime.taskSources('owner', gameId).some(source => source.experienceId === first.sourceId)).toBe(true);
    await f.driver.tick(); await searchEntered.promise;
    const command = await f.command();
    expect(command).toMatchObject({ kind: 'skill', skill: 'dig', arguments: { count: 1 }, context: { taskId: gameId } });
    expect(f.poll().commands, 'a delivered native operation is not offered twice').toEqual([]);
    expect(f.calls.filter(call => call.task.id === gameId)[0]!.tools.find(tool => tool.name === 'mc.dig')!.nativeInputSchema).toMatchObject({ required: ['count'] });
    expect(f.actions.store.list('owner').filter(action => action.kind === 'agentTask' && action.state === 'running')).toHaveLength(2);

    await f.talk('作業中でも、今の様子を教えてください。', async turn => {
      expect((await turn.call('task.get', { id: gameId })).text).toContain(gameId);
      expect((await turn.call('task.send', { id: researchId, message: '確認できた出典をこの会話へ知らせてください。' })).ok).toBe(true);
    });
    expect(f.foregroundCalls()).toBe(2);
    expect(f.driver.runtime.get('owner', gameId)?.phase).toBe('executing');
    expect(f.driver.runtime.get('owner', researchId)?.phase).toBe('executing');
    expect(f.searches()).toBe(1);
    searchRelease.release();
    expect(f.acknowledge(command).acknowledged).toEqual([command.id]);
    await f.driver.drain();
    expect(f.driver.runtime.get('owner', gameId)?.phase, 'transport success alone is not task completion').toBe('ready');
    expect(f.driver.runtime.get('owner', researchId)?.phase).toBe('ready');

    await f.tick(); await f.tick();
    expect(f.driver.runtime.get('owner', gameId)?.phase).toBe('completed');
    expect(f.driver.runtime.get('owner', researchId)?.phase).toBe('waiting');
    expect(f.actions.store.list('owner').filter(action => action.kind === 'agentTask' && action.state === 'running')).toEqual([]);
    const researchDecision = f.calls.filter(call => call.task.id === researchId)[1]!;
    expect(researchDecision.messages.some(message => message.text.includes('確認できた出典'))).toBe(true);
    const gameDecision = f.calls.filter(call => call.task.id === gameId)[1]!;
    expect(gameDecision.sharedContext!.recentOutcomes.find(event => event.name === 'mc.dig')!.comparison).toMatchObject({ status: 'mismatch', actual: 1 });
    expect(f.store.snapshot('owner').emotion.valence).toBeGreaterThan(initialValence);
    const affectRevision = f.store.snapshot('owner').version;
    f.shared.evidence!.flush(); f.shared.evidence!.flush();
    expect(f.store.snapshot('owner').version).toBe(affectRevision);

    await f.talk('報告を受け取りました。調査は完了してください。', async turn => {
      expect(turn.context).toContain('分光装置の公開資料を確認しました');
      expect(turn.context).toContain('分光装置用の石を一つ確認しました');
      expect((await turn.call('task.send', { id: researchId, message: '報告を受け取りました。完了してください。' })).ok).toBe(true);
    });
    expect(f.driver.runtime.get('owner', researchId)?.phase).toBe('ready');
    await f.tick(); expect(f.driver.runtime.get('owner', researchId)?.phase).toBe('completed');
    await f.writeMemory();
    const experiences = f.shared.memory.search('owner', '分光装置', OWNER_AUDIENCE).filter(item => item.id.startsWith('task:'));
    expect(experiences.length).toBeGreaterThan(0);
    const following = await f.talk('分光装置の経験を振り返ってください。', async turn => {
      const result = await turn.call('task.create', { title: '分光装置の経験', goal: '分光装置の調査と採掘の経験を振り返る', completionCriteria: '経験を確認する' });
      expect(result.ok).toBe(true); return (JSON.parse(result.text) as TaskView).id;
    });
    await f.tick();
    const remembered = f.calls.find(call => call.task.id === following.value)!;
    expect(remembered.recall?.items.some(item => item.id.startsWith('task:') && item.summary.includes('分光装置'))).toBe(true);
    expect(remembered.sharedContext!.affect.revision).toBeGreaterThanOrEqual(affectRevision);
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.actions.db.prepare('SELECT * FROM agent_task_commands').all()).toEqual([]);

    new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: first.sourceId, action: 'forget' });
    expect(f.visible('owner', following.value)).toBe(false);
    expect(f.shared.memory.read('owner', experiences.map(item => item.id), OWNER_AUDIENCE)).toEqual([]);
    const callCount = f.calls.length;
    await f.talk('忘れた内容には触れず、会話を続けてください。', async turn => {
      const listed = await turn.call('task.list', {}); expect(listed.ok).toBe(true);
      expect(listed.text).not.toContain(following.value);
      expect((await turn.call('task.get', { id: gameId })).ok).toBe(false);
      expect((await turn.call('task.send', { id: following.value, message: '続けて' })).ok).toBe(false);
    });
    await f.tick(); expect(f.calls).toHaveLength(callCount);
    expect(f.searches()).toBe(1);
  });

  it('holds a native unknown across DB reconnection and never reissues the operation while conversation continues', async () => {
    const f = integratedFcaHarness({ decide: () => round({ kind: 'tools', calls: [{ id: 'dig', name: 'mc.dig', input: { count: 1 } }] }) });
    cleanup.push(() => f.close());
    const first = await createWork(f, false), gameId = first.value.gameId;
    await f.driver.tick(); const command = await f.command();
    expect(f.acknowledge(command, 'unknown', false).acknowledged).toEqual([command.id]);
    await f.driver.drain();
    expect(f.driver.runtime.get('owner', gameId)?.phase).toBe('unknown');
    expect(f.bodyStore.safe(gameId)).toBe(false);
    expect(f.driver.runtime.snapshot('owner', gameId)?.history).toEqual([]);
    await f.restart();
    for (let n = 0; n < 3; n++) { await f.tick(); expect(f.poll().commands).toEqual([]); }
    expect(f.calls).toHaveLength(1);
    expect(f.actions.db.prepare('SELECT COUNT(*) AS n FROM fca_body_operations').get()).toEqual({ n: 1 });
    expect(f.driver.runtime.get('owner', gameId)?.phase).toBe('unknown');
    await f.talk('操作の結果が不明でも、話は続けましょう。');
    expect(f.foregroundCalls()).toBe(2);
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.actions.store.list('owner').find(action => action.kind === 'agentTask')?.state).toBe('unknown');
  });

  it('keeps common Minecraft status provenance readable when the same conversation forwards a message to research', async () => {
    const f = integratedFcaHarness({ decide: () => round({ kind: 'wait', summary: '確認待ち' }) });
    cleanup.push(() => f.close());
    const first = await createWork(f), { gameId, researchId } = first.value;
    await f.talk('採掘の状態を調査へ知らせてください。', async turn => {
      const status = await turn.call('minecraft.status', {});
      expect(status.text).toContain(gameId);
      expect(status).not.toHaveProperty('documents');
      expect((await turn.call('task.send', { id: researchId, message: '採掘の状態を確認しました。' })).ok).toBe(true);
    });
    expect(f.driver.runtime.taskSources('owner', researchId).flatMap(source => source.readSourceIds ?? []))
      .not.toContain('fca-unresolved://minecraft.status');
    expect(f.visible('owner', researchId)).toBe(true);
    await f.tick();
    expect(f.calls.find(call => call.task.id === researchId)?.messages.some(message => message.text.includes('採掘の状態'))).toBe(true);
    new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: first.sourceId, action: 'forget' });
    expect(f.visible('owner', researchId)).toBe(false);
    expect(fcaReadReceiptSources({ name: 'minecraft.status', ok: true })).toEqual({ readSourceIds: ['fca-unresolved://minecraft.status'] });
  });

  it('recovers only the original segment receipt after SQLite reconnection, with no replay of body, model or affect', async () => {
    const next = rounds();
    const f = integratedFcaHarness({ decide: input => {
      if (next(input) === 0) return round({ kind: 'tools', calls: [{ id: 'dig', name: 'mc.dig', input: { count: 1 } }] });
      const event = input.sharedContext!.recentOutcomes.find(outcome => outcome.name === 'mc.dig')!;
      return { ...round({ kind: 'wait', summary: '採掘結果を保持し、次の依頼を待つ' }),
        appraisals: [{ eventId: event.eventId, revision: 1, value: 0.8, cause: '石の観測結果を受け取れた', target: '採掘' }] };
    } });
    cleanup.push(() => f.close());
    const first = await createWork(f, false), gameId = first.value.gameId;
    const initialValence = f.store.snapshot('owner').emotion.valence;
    await f.driver.tick(); const command = await f.command(); f.acknowledge(command); await f.driver.drain();
    const finish = f.actions.actions.finish;
    f.actions.actions.finish = async (...args) => { if (args[2] === 'fca_segment_committed') throw new Error('worker_disconnected'); return finish(...args); };
    await f.tick();
    const [receipt] = f.driver.runtime.pendingReceipts('owner');
    expect(receipt).toMatchObject({ taskId: gameId, state: 'completed' });
    const history = f.driver.runtime.snapshot('owner', gameId)!.history;
    const outboxCount = f.rows().filter(row => row.kind === 'task.experience').length;
    const affectRevision = f.store.snapshot('owner').version;
    expect(f.store.snapshot('owner').emotion.valence).toBeGreaterThan(initialValence);
    expect(f.calls).toHaveLength(2);
    f.advance(31_000); f.actions.store.transaction(() => f.actions.store.sweep(f.now()));
    expect(f.actions.store.get(receipt!.lease.id)?.state).toBe('unknown');
    await f.restart(); await f.tick();
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.actions.store.get(receipt!.lease.id)).toMatchObject({ state: 'completed', result: 'fca_segment_committed' });
    expect(f.driver.runtime.snapshot('owner', gameId)).toMatchObject({ task: { phase: 'waiting' }, history });
    expect(f.calls).toHaveLength(2);
    expect(f.poll().commands).toEqual([]);
    f.shared.evidence!.flush(); await f.writeMemory();
    expect(f.rows().filter(row => row.kind === 'task.experience')).toHaveLength(outboxCount);
    expect(f.store.snapshot('owner').version).toBe(affectRevision);
    expect(f.actions.db.prepare('SELECT COUNT(*) AS n FROM fca_body_operations').get()).toEqual({ n: 1 });
  });

  it('cascades a parent stop while preserving the physical lease until the paired body confirms release', async () => {
    const f = integratedFcaHarness({ decide: () => round({ kind: 'tools', calls: [{ id: 'dig', name: 'mc.dig', input: { count: 1 } }] }) });
    cleanup.push(() => f.close());
    const first = await createWork(f, false), gameId = first.value.gameId;
    await f.driver.tick(); const command = await f.command();
    await f.driver.stop(first.taskId, 'owner_stop');
    expect(f.driver.runtime.get('owner', gameId)?.phase).toBe('stopping');
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.poll().cancel).toContain(command.id);
    expect(f.actions.store.get(command.lease.id)?.state).toBe('stopping');
    expect(f.acknowledge(command, 'cancelled').acknowledged).toEqual([command.id]);
    await f.driver.drain();
    await until(() => f.driver.runtime.get('owner', gameId)?.phase === 'stopped', 'stop must wait for native release');
    expect(f.driver.runtime.get('owner', first.taskId)?.phase).toBe('stopped');
    expect(f.actions.store.get(command.lease.id)).toMatchObject({ state: 'cancelled', result: 'fca_stop_acknowledged' });
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    await f.tick(); expect(f.calls).toHaveLength(1);
    expect(f.bodyStore.safe(gameId)).toBe(true);
    await f.talk('停止後も話を続けましょう。', async () => {
      expect(f.bridge.taskToolsAvailable('owner')).toBe(false);
    });
    expect(f.foregroundCalls()).toBe(2);
  });
});
