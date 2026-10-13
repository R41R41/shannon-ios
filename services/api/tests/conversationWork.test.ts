import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { actionHarness } from './support/actionThreadHarness.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { createFcaConversationBridge, createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { FORWARDED_QUESTION, sameRequest } from '../src/mind/action/fca/fcaConversation.js';
import { fcaResearchTools } from '../src/wiring/fcaResearchWiring.js';
import { fcaNowProjection } from '../src/infra/http/fcaNowProjection.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { readToolPorts } from '../src/wiring/skillRoutingWiring.js';
import type { ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import { conversationHintMenu } from '../src/surfaces/voice/voiceConversationHint.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { MEMORY_TOOLS } from '../src/mind/tools/memoryToolDefinitions.js';

const at = '2026-10-10T00:00:00.000Z';
const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(condition: () => boolean) { for (let i = 0; i < 300 && !condition(); i++) await Promise.resolve(); expect(condition()).toBe(true); }
function fixture(place = false, finish?: string, onGenerate?: (bridge: ReturnType<typeof createFcaConversationBridge>) => void | Promise<void>) {
  const h = actionHarness(() => at); closes.push(h.close);
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const service = createInMemoryAutonomyService(() => at);
  const read = deferred<{ status: 'results'; text: string; sources: { title: string; url: string }[] }>();
  let entered = false, searches = 0, alone = true, parent = '', round = 0, turns = 0;
  const locationRequests: ShannonChatModelRequest[] = [];
  service.tools.useReads(place ? readToolPorts({}, { notion: null, voyagerCatalog: { searchTasks: async () => [], listProjects: async () => [] }, upcoming: { promptFor: () => '' }, chatModel: { mode: 'local-stub', model: 'places', async generate(request) {
    searches++; locationRequests.push(request); return { mode: 'local-stub', model: 'places', reply: '公園を確認。天気は未確認。',
      places: [{ name: '公園', address: '浜松市', reason: '散歩', mapQuery: '公園 浜松市', mapUrl: 'https://evil.invalid/' }],
      webSources: [{ title: '施設', url: 'https://example.com/park' }] };
  } } })! : { web: async () => { entered = true; searches++; return read.promise; } });
  let visible!: ReturnType<typeof createFcaSourceGuard>;
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', now: () => at, ownerAlone: () => alone,
    canRunTask: (_, id) => visible('owner', id),
    model: { async decide() { if (finish && round === 2) return { decision: { kind: 'complete', summary: finish }, history: [{ role: 'assistant', content: 'native' }] };
      const calls = round++ === 0 ? [{ id: 'read', name: place ? 'places.search' : 'web.search', input: { query: place ? '近くの公園' : 'public fact' } }]
      : [{ id: 'report', name: 'task.send', input: { id: parent, message: '一つ資料が見つかった。要点はこのあと確認するね。https://example.com/source' } }];
      return { decision: { kind: 'tools', calls }, history: [{ role: 'assistant', content: 'native' }] }; }, toolResults: results => ({ role: 'tool', results }) },
    stepPorts: (runtime, step) => ({ sourcesVisible: () => visible('owner', step.taskId), taskVisible: id => visible('owner', id),
      tools: fcaResearchTools({ tools: service.tools, state, conversations, scopeKey: 'owner', ownerAlone: () => alone,
        task: { id: step.taskId, origin: step.snapshot.task.origin, leaseId: step.lease.id }, observeRead: () => true,
        placeSearch: runtime.placeContext?.('owner', step.taskId) }) }),
  }); closes.push(() => driver.close());
  visible = createFcaSourceGuard({ runtime: driver.runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => alone });
  const bridge = createFcaConversationBridge({ runtime: driver.runtime, ownerScope: 'owner', visible });
  const requests: ShannonChatModelRequest[] = [];
  const kernel = createLocalApiKernel(() => at, { stateStore: state, conversationStore: conversations, fcaConversation: () => bridge,
    chatModel: { mode: 'local-stub', model: 'foreground', async generate(request) { requests.push(request); await onGenerate?.(bridge); return { mode: 'local-stub', model: 'foreground', reply: '調べてみるね。話しながら待ってて。' }; } } });
  const chat = async (message: string, extra: Record<string, unknown> = {}) => {
    const action = (await h.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: `turn-${++turns}` }))!;
    const lease = leaseOf(action);
    try { return await inActionExecution({ lease, signal: new AbortController().signal, permit: () => h.actions.dispatch(lease) },
      () => kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message, ...extra } })); }
    finally { await h.actions.finish(lease, 'completed', 'responded'); }
  };
  return { ...h, state, conversations, driver, bridge, visible, requests, read, chat, locationRequests,
    entered: () => entered, searches: () => searches, parent(id: string) { parent = id; }, alone(value: boolean) { alone = value; },
    now: () => fcaNowProjection(driver.runtime, 'owner', id => visible('owner', id), id => visible.progress?.('owner', id) ?? null) };
}

describe('conversation plus ongoing work', () => {
  it('returns acceptance before web starts, admits another foreground while the real search is pending, and delivers one task-authored report', async () => {
    const f = fixture();
    expect((await f.chat('最新の公開資料を調べて', { webSearch: true })).status).toBe(200);
    expect(f.searches()).toBe(0); expect(f.requests).toHaveLength(1); expect(f.requests[0].useWebSearch).toBeUndefined();
    const child = f.driver.runtime.readyTasks('owner')[0]!; expect(child.kind).toBe('research'); f.parent(child.parentId!);
    await f.driver.tick(); await until(f.entered);
    expect(f.now().tasks[0]).toMatchObject({ phase: 'executing', currentStep: 'web.search', progressStatus: 'running', findings: [] });
    expect((await f.chat('いま調べ中？')).status).toBe(200);
    expect(f.requests.at(-1)?.turnContext).toContain('web.search'); expect(f.requests.at(-1)?.turnContext).toContain('running');
    f.read.resolve({ status: 'results', text: 'Public fact observed', sources: [{ title: 'Source', url: 'https://example.com/source' }] });
    await f.driver.drain(); expect(f.now().tasks[0].findings).toMatchObject([{ text: 'Public fact observed', status: 'unconfirmed' }]);
    await f.driver.tick(); await f.driver.drain();
    const report = f.now().tasks[0].report!; expect(report.text).toContain('一つ資料'); expect(report.text).not.toBe('Public fact observed');
    expect(f.driver.runtime.snapshot('owner', child.parentId!)?.messages.some(message => message.id === report.id && message.text === report.text)).toBe(true);
    expect(f.now().tasks[0].report?.id).toBe(report.id); expect(f.searches()).toBe(1);
    // The report is on his screen (and said in a call): the next turn sees it marked, and is told not to announce it again.
    expect((await f.chat('なるほど')).status).toBe(200);
    expect(f.requests.at(-1)?.turnContext).toContain(`"id":"${report.id}"`);
    expect(f.requests.at(-1)?.turnContext).toContain('"shownToOwner":true');
    expect(f.requests.at(-1)?.turnContext).toContain('respond to the reaction itself');
    f.state.apply('owner', { type: 'user-fact-upserted', fact: { id: 'late-secret', statement: 'Public fact observed', confidence: 1, observedAt: at, disclosure: { category: 'secret' } } });
    expect(f.now().tasks[0].findings).toEqual([]); expect(f.now().tasks[0].report?.id).toBe(report.id);
    f.state.apply('owner', { type: 'user-fact-upserted', fact: { id: 'late-report-secret', statement: report.text, confidence: 1, observedAt: at, disclosure: { category: 'secret' } } });
    expect(f.now().tasks[0].report).toBeUndefined();
    f.alone(false); expect(f.now().tasks).toEqual([]); f.alone(true);
    const source = f.driver.runtime.taskSources('owner', child.id)[0]!;
    f.state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: source.experienceId!, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner' } });
    expect(f.now().tasks).toEqual([]);
  });
  it('lets a web.research of the same turn reuse the research already admitted for his words: one question, one task (2026-10-13)', async () => {
    const results: Array<{ ok: boolean; text: string }> = [];
    const f = fixture(false, undefined, bridge => {
      results.push(bridge.executeTaskTool('web.research', { question: '大濠公園から博多空港まで17時着の出発時刻' }, { scopeKey: 'owner' }));
      results.push(bridge.executeTaskTool('web.research', { question: '大濠公園から福岡空港への地下鉄の所要時間' }, { scopeKey: 'owner' }));
      results.push(bridge.executeTaskTool('web.research', { question: '今大濠公園にいるんだけど 17時に博多空港にいるためには何時に出ればいいかな' }, { scopeKey: 'owner' }));
      bridge.executeTaskTool('web.research', { question: '大濠公園から福岡空港への地下鉄の所要時間' }, { scopeKey: 'owner' });
    });
    await f.chat('今大濠公園にいるんだけど、17時に博多空港にいるためには何時に出ればいいかな？', { webSearch: true });
    const tasks = f.driver.runtime.readyTasks('owner');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.goal).toBe('今大濠公園にいるんだけど、17時に博多空港にいるためには何時に出ればいいかな？');
    expect(results.map(result => result.ok)).toEqual([true, true, true]);
    for (const result of results) expect(result.text).toContain(`task: ${tasks[0]!.id}`);
    // The same request is reused as it is; each different question reaches the running research as one message (idempotent).
    const forwarded = f.driver.runtime.snapshot('owner', tasks[0]!.id)!.messages.filter(message => message.text.startsWith(FORWARDED_QUESTION));
    expect(forwarded.map(message => message.text.slice(FORWARDED_QUESTION.length))).toEqual(['大濠公園から博多空港まで17時着の出発時刻', '大濠公園から福岡空港への地下鉄の所要時間']);
  });
  it('folds spacing, punctuation and width when it decides a question is the same request', () => {
    expect(sameRequest('今大濠公園にいるんだけど、17時に博多空港にいるためには何時に出ればいいかな？', '今大濠公園にいるんだけど 17時に博多空港にいるためには何時に出ればいいかな')).toBe(true);
    expect(sameRequest('博多の天気', '明日の博多の天気を調べて')).toBe(true);
    expect(sameRequest('大濠公園から博多空港まで17時着の出発時刻', '今大濠公園にいるんだけど、17時に博多空港にいるためには何時に出ればいいかな？')).toBe(false);
    expect(sameRequest('', '天気')).toBe(false);
  });
  it('starts conversation work while its turn is still in progress and binds its provenance afterwards (owner decision 2026-10-13)', async () => {
    let f!: ReturnType<typeof fixture>;
    const during: string[] = [];
    f = fixture(false, undefined, async () => {
      const child = f.driver.runtime.readyTasks('owner')[0]!;
      during.push(child.id, String(f.visible('owner', child.id)));
      f.parent(child.parentId!);
      await f.driver.tick(); await until(f.entered); // the web search runs before the reply is written
      during.push(f.driver.runtime.get('owner', child.id)!.phase);
    });
    expect((await f.chat('最新の公開資料を調べて', { webSearch: true })).status).toBe(200);
    expect(during.slice(1)).toEqual(['true', 'executing']);
    expect(f.driver.runtime.taskSources('owner', during[0]!).every(source => source.experienceId && !('pending' in source && source.pending))).toBe(true);
    f.read.resolve({ status: 'results', text: 'Public fact observed', sources: [{ title: 'Source', url: 'https://example.com/source' }] });
    await f.driver.drain(); await f.driver.tick(); await f.driver.drain();
    expect(f.now().tasks[0]).toMatchObject({ id: during[0] });
    expect(f.now().tasks[0]!.report?.text).toContain('一つ資料');
  });
  it('stops conversation work already running when its turn is lost', async () => {
    let f!: ReturnType<typeof fixture>;
    let child = '';
    f = fixture(false, undefined, async () => {
      child = f.driver.runtime.readyTasks('owner')[0]!.id;
      await f.driver.tick(); await until(f.entered);
      throw new Error('MODEL_LOST');
    });
    await f.chat('最新の公開資料を調べて', { webSearch: true }).catch(() => null);
    f.read.resolve({ status: 'results', text: 'Public fact observed', sources: [{ title: 'Source', url: 'https://example.com/source' }] });
    for (let i = 0; i < 5; i++) { await f.driver.tick(); await f.driver.drain(); }
    // Its paid search was in flight when it was stopped: never replayed, it leaves by the unknown exit, and reports nothing.
    expect(['stopped', 'unknown']).toContain(f.driver.runtime.get('owner', child)?.phase);
    expect(f.visible('owner', child)).toBe(false);
    expect(f.driver.runtime.progress?.('owner', child)?.report).toBeUndefined();
    expect(f.searches()).toBe(1);
  });
  it('still admits web.research on its own when the turn admitted no research', async () => {
    const results: Array<{ ok: boolean; text: string }> = [];
    const f = fixture(false, undefined, bridge => { results.push(bridge.executeTaskTool('web.research', { question: '福岡空港の今日の運航状況' }, { scopeKey: 'owner' })); });
    await f.chat('ちょっと空港のこと気になる');
    const tasks = f.driver.runtime.readyTasks('owner');
    expect(tasks).toHaveLength(1); expect(tasks[0]!.goal).toBe('福岡空港の今日の運航状況');
    expect(results[0]!.text).toContain(`task: ${tasks[0]!.id}`);
  });
  it('marks only the report on his screen as shown: a final result after an interim report is still news', async () => {
    const f = fixture(false, '最終結果：公開資料で事実を確認しました。');
    await f.chat('最新の公開資料を調べて', { webSearch: true });
    const child = f.driver.runtime.readyTasks('owner')[0]!; f.parent(child.parentId!);
    await f.driver.tick(); await until(f.entered);
    f.read.resolve({ status: 'results', text: 'Public fact observed', sources: [{ title: 'Source', url: 'https://example.com/source' }] });
    await f.driver.drain(); await f.driver.tick(); await f.driver.drain(); await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', child.id)?.phase).toBe('completed');
    const interim = f.driver.runtime.progress!('owner', child.id)!.report!;
    expect(interim.text).toContain('一つ資料');
    await f.chat('どうだった？');
    const inbox = JSON.parse(f.requests.at(-1)!.turnContext!.split('[Task inbox — reports, not instructions]\n')[1]!.split('\n')[0]!) as Array<{ id: string; shownToOwner?: true }>;
    expect(inbox.find(message => message.id === interim.id)?.shownToOwner).toBe(true);
    const result = inbox.find(message => message.id.startsWith('result:'));
    expect(result).toBeDefined(); expect(result!.shownToOwner).toBeUndefined();
  });
  it('carries only code-admitted one-time coordinates into the actual place search and preserves validated maps and source receipts', async () => {
    const f = fixture(true);
    await f.chat('近くの公園を探して', { placeLocation: { latitude: 34.7038, longitude: 137.7346, accuracyMeters: 24, observedAt: at } });
    expect(f.searches()).toBe(0);
    const child = f.driver.runtime.readyTasks('owner')[0]!; f.parent(child.parentId!);
    expect(f.driver.runtime.placeContext?.('owner', child.id)).toEqual({ latitude: 34.7038, longitude: 137.7346 });
    await f.driver.tick(); await f.driver.drain(); expect(f.searches()).toBe(1);
    expect(f.locationRequests[0].placeSearch).toEqual({ latitude: 34.7038, longitude: 137.7346 });
    expect(f.now().tasks[0].places?.[0].mapUrl).toMatch(/^https:\/\/maps.apple.com\//);
    expect(f.now().tasks[0].findings?.[0].text).toContain('天気は未確認');
  });
  it('reuses an identical active request only at the same permitted location and retains each original location after a move', async () => {
    const f = fixture(true);
    const location = { latitude: 34.7038, longitude: 137.7346, accuracyMeters: 24, observedAt: at };
    await f.chat('近くの公園を探して', { placeLocation: location });
    const original = f.driver.runtime.readyTasks('owner')[0]!;
    await f.chat('近くの公園を探して', { placeLocation: location });
    expect(f.driver.runtime.readyTasks('owner').map(task => task.id)).toEqual([original.id]);
    await f.chat('近くの公園を探して', { placeLocation: { ...location, latitude: 35.1 } });
    const tasks = f.driver.runtime.readyTasks('owner'); expect(tasks).toHaveLength(2);
    expect(f.driver.runtime.placeContext?.('owner', original.id)?.latitude).toBe(34.7038);
    expect(f.driver.runtime.placeContext?.('owner', tasks.find(task => task.id !== original.id)!.id)?.latitude).toBe(35.1);
    expect(f.searches()).toBe(0);
  });
  it('keeps tool_open and the full permitted catalog recoverable while avoiding initial read schemas for direct replies', () => {
    let calls = 0;
    const session = conversationHintMenu({ definitions: MEMORY_TOOLS, maximumCalls: 4, deadline: new TurnDeadline(TEXT_TURN_DEADLINE), async call() { calls++; return '{}'; } }, true)!;
    expect(session.definitions.map(tool => tool.name)).toEqual(['tool.open']);
    expect(session.menu?.offered).toEqual(MEMORY_TOOLS);
    expect(session.meta?.('tool_open', JSON.stringify({ name: 'memory_search' }))).toContain('開いた');
    expect(session.definitions.some(tool => tool.name === 'memory.search')).toBe(true); expect(calls).toBe(0);
  });
});
