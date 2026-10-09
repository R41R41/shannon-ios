import { fcaNowProjection } from '../src/infra/http/fcaNowProjection.js';
import { createFcaConversationBridge } from '../src/mind/action/fca/fcaConversation.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { actionHarness } from './support/actionThreadHarness.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { ShannonToolRunner } from '../src/mind/tools/toolRunnerPorts.js';
import type { HostFolderOperations } from '../src/mind/action/ownTime/hostFolderOperations.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { fcaResearchTools } from '../src/wiring/fcaResearchWiring.js';
import { createFcaReadSources } from '../src/wiring/fcaReadSources.js';
import { createFcaSourceGuard, fcaReadReceiptSources } from '../src/mind/action/fca/fcaConversationSources.js';
import type { FcaModelInput, FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import { SkillMemory } from '../src/mind/memory/memoryPorts.js';
import { skillTurnPorts } from '../src/wiring/skillMemoryWiring.js';
import { SkillImporter } from '../src/mind/memory/skillImport.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';

const at = '2026-10-09T00:00:00.000Z';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(decide: (input: FcaModelInput) => FcaModelOutput, folder?: HostFolderOperations) {
  const h = actionHarness(() => at); cleanup.push(h.close);
  const store = new SQLiteAutonomyStore(':memory:'); cleanup.push(() => store.close());
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const tools = new ShannonToolRunner(store, folder ?? { boundHosts: () => [] } as unknown as HostFolderOperations,
    { recordConversationAction() {} }, () => at);
  const memory = new SkillMemory({ database: h.db, createsSchema: true, defer: work => work() });
  const sources = Object.assign(conversations, { snapshot: state.snapshot.bind(state) });
  const skills = skillTurnPorts(memory, scope => state.snapshot(scope), sources);
  tools.useSkills(skills);
  let alone = true, connected = true;
  const ownerAlone = () => alone;
  const readSourceVisible = createFcaReadSources({ ownerScope: 'owner', ownerAlone, state, conversations, study: store.study,
    notionAvailable: () => connected, voyagerAvailable: () => connected, aetherAvailable: () => connected,
    folderAvailable: () => connected, skill: (scope, id, revision) => skills.readSource!(scope, id, revision) });
  let visible: ReturnType<typeof createFcaSourceGuard>;
  let checkpoints = 0;
  const actions = { ...h.actions, checkpoint: async (...args: Parameters<typeof h.actions.checkpoint>) => { checkpoints++; return h.actions.checkpoint(...args); } };
  const driver = createTaskRuntimeWiring({ db: h.db, actions, scopeKey: 'owner', ownerAlone, now: () => at,
    canRunTask: (_, id) => visible('owner', id), model: { async decide(input) { return decide(input); }, toolResults: results => ({ role: 'user', results }) },
    stepPorts: (runtime, step) => ({ sourcesVisible: () => visible.sources('owner', step.snapshot.task, step.snapshot.sources),
      tools: fcaResearchTools({ tools, state, conversations, scopeKey: 'owner', ownerAlone,
        task: { id: step.taskId, origin: step.snapshot.task.origin, leaseId: step.lease.id }, sourcesVisible: () => visible.sources('owner', step.snapshot.task, step.snapshot.sources),
        checkpoint: step.snapshot.checkpoint,
        observeRead(operationId, receipt) {
          const ids = fcaReadReceiptSources(receipt).readSourceIds ?? [];
          if (!ids.length) return true;
          if (ids.some(id => !readSourceVisible('owner', id, at))) return false;
          if (!runtime.observeSources(step, { observationId: `read:${operationId}`, recalledMemoryIds: [], readSourceIds: ids })) return false;
          step.snapshot.sources = runtime.taskSources('owner', step.taskId, step.messageIds);
          return visible.sources('owner', step.snapshot.task, step.snapshot.sources);
        } }),
    }),
  });
  cleanup.push(() => driver.close());
  visible = createFcaSourceGuard({ runtime: driver.runtime, state, conversations, ownerScope: 'owner', ownerAlone, readSourceVisible });
  const task = driver.runtime.createChild('owner', driver.runtime.ensureRoot('owner').id, { title: 'Requested work', goal: 'Use the requested tools', origin: 'owner_request' }, 'requested-work');
  return { ...h, driver, task, tools, store, state, conversations, memory, skills, readSourceVisible, visible,
    checkpoints: () => checkpoints, setAlone: (value: boolean) => { alone = value; }, setConnected: (value: boolean) => { connected = value; } };
}
const call = (name: string, input: unknown = {}): FcaModelOutput => ({ decision: { kind: 'tools', calls: [{ id: 'call', name, input }] }, history: [{ role: 'assistant', content: 'requested tool' }] });

describe('common FCA registry adapters under real task/action SQLite authority', () => {
  it('pins an actual local private skill read through task.send and withholds both Now report and conversation context after revocation', async () => {
    let round = 0, parent = '';
    const text = '限定した手順資料の本文を確認した。次の要点を整理する。';
    const f = fixture(() => round++ === 0 ? call('skill.read', { name: 'private-local-reference' }) : call('task.send', { id: parent, message: text }));
    f.driver.runtime.stop('owner', f.task.id, 'fixture_replaced');
    const added = f.memory.create('owner', { draft: { name: 'private-local-reference', description: '限定資料', steps: text, aids: '- 未確認なら保留', references: '- 元資料' }, evidence: [] }, { carries: () => false }, at);
    if ('rejected' in added) throw new Error(added.rejected);
    const bridge = createFcaConversationBridge({ runtime: f.driver.runtime, ownerScope: 'owner', visible: f.visible });
    // The same canonical conversation store and action authority used by the source guard.
    const conversations = f.conversations;
    const thread = conversations.threadId('owner');
    const action = (await f.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'private-admission' }))!;
    const lease = leaseOf(action); let childId = '';
    await inActionExecution({ lease, signal: new AbortController().signal, permit: () => f.actions.dispatch(lease) }, async () => {
      const turn = bridge.begin({ scopeKey: 'owner', threadId: thread, observedAt: at, recalledMemoryIds: [], ownerAlone: () => true })!;
      const child = turn.delegate!({ title: 'Read private reference', goal: 'Read private reference' }); childId = child.id; parent = child.parentId!;
      turn.commit(conversations.appendTurn('owner', thread, '資料を確認して', '調べてみるね', at).id);
    }); await f.actions.finish(lease, 'completed', 'responded');
    await f.driver.tick(); await f.driver.drain(); await f.driver.tick(); await f.driver.drain();
    const sources = f.driver.runtime.taskSources('owner', childId).flatMap(source => source.readSourceIds ?? []);
    expect(sources.some(source => source.startsWith('shannon-skill://'))).toBe(true);
    const now = () => fcaNowProjection(f.driver.runtime, 'owner', id => f.visible('owner', id), id => f.visible.progress?.('owner', id) ?? null);
    expect(now().tasks.find(task => task.id === childId)?.report?.text).toBe(text);
    const next = (await f.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'private-report' }))!; const nextLease = leaseOf(next);
    await inActionExecution({ lease: nextLease, signal: new AbortController().signal, permit: () => f.actions.dispatch(nextLease) }, async () => {
      const turn = bridge.begin({ scopeKey: 'owner', threadId: thread, observedAt: at, recalledMemoryIds: [], ownerAlone: () => true })!;
      expect(turn.context()).toContain(text);
      f.state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: added.skillId, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner' } });
      expect(now().tasks.some(task => task.id === childId)).toBe(false); expect(turn.context()).not.toContain(text); turn.abort();
    }); await f.actions.finish(nextLease, 'completed', 'responded');
  });
  it('loads an imported trial without fabricated experience or successes and rechecks revoked import ancestry on replay', async () => {
    const pack = standardSkillPack('standard10', 'draft-2')!, name = pack.skills[0]!.name;
    let captured: FcaModelInput | undefined;
    const f = fixture(input => { captured = input; return call('skill.read', { name }); });
    const importer = new SkillImporter({ memory: f.memory, ownerScopeKey: 'owner', check: () => ({ carries: () => false }), tools: () => [] });
    const imported = importer.apply('owner', pack, { planHash: importer.dryRun('owner', pack).planHash, approvalReference: 'owner-request-fixture' }, at);
    if ('rejected' in imported) throw new Error(imported.rejected);
    const id = imported.receipt.skills[0]!.skillId;
    const opened = f.skills.open('owner', name)!;
    expect(opened.provenance).toMatchObject({ origin: 'operator_authored', importReceiptId: imported.receipt.receiptId });
    expect(f.memory.store.get('owner', id)).toMatchObject({ sources: [`import:${imported.receipt.receiptId}`], uses: [], successes: 0 });
    await f.driver.tick(); await f.driver.drain();
    expect(captured!.skillIndex).toContain('（運用作成）');
    expect(f.driver.runtime.snapshot('owner', f.task.id)!.history).toHaveLength(2);
    expect(f.memory.store.get('owner', id)!.uses).toEqual([]);
    const source = f.driver.runtime.taskSources('owner', f.task.id).flatMap(item => item.readSourceIds ?? []).find(item => item.startsWith(`shannon-skill://${id}/revision/`))!;
    expect(f.readSourceVisible('owner', source, at)).toBe(true);
    f.state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: `import:${imported.receipt.receiptId}`, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner' } });
    expect(f.skills.open('owner', name)).toBeNull(); expect(f.skills.index('owner')).not.toContain(name);
    expect(f.readSourceVisible('owner', source, at)).toBe(false); expect(f.visible('owner', f.task.id)).toBe(false);
  });

  it('uses the shared catalog and skill revision receipts, preserves lineage on children, and does not count the index as a learned use', async () => {
    let captured: FcaModelInput | undefined;
    const f = fixture(input => { captured = input; return { decision: { kind: 'tools', calls: [
      { id: 'read', name: 'skill.read', input: { name: 'research-plan' } },
      { id: 'child', name: 'task.create', input: { title: 'Followup', goal: 'Continue from the loaded skill', completionCriteria: 'Verified source exists' } },
    ] }, history: [{ role: 'assistant', content: 'tools' }] }; });
    f.tools.useReads({ notion: async () => ({ text: '', sources: [], sourceIds: [] }), voyagerTasks: async () => ({ text: '', sourceIds: [] }),
      upcoming: () => ({ text: '', sourceIds: [] }), places: async () => 'Public places' });
    const added = f.memory.create('owner', { draft: { name: 'research-plan', description: '調査を進める時', steps: '1. 公開の情報を探す\n2. 実際の結果を確かめる', aids: '- 不明なら保留する', references: '- 手順の資料' }, evidence: [] }, { carries: () => false }, at);
    if ('rejected' in added) throw new Error(added.rejected);
    await f.driver.tick(); await f.driver.drain();
    const names = captured!.tools.map(tool => tool.name);
    for (const name of ['study.read', 'study.create', 'notion.read', 'voyager.tasks', 'schedule.upcoming', 'places.search', 'skill.read']) expect(names).toContain(name);
    expect(names).not.toContain('ownerDocs.read'); expect(names).not.toContain('workspace.apply');
    expect(captured!.skillIndex).toContain('research-plan');
    const revisionSource = `shannon-skill://${added.skillId}/revision/${encodeURIComponent(`${added.skillId}:v1`)}`;
    expect(f.driver.runtime.taskSources('owner', f.task.id).flatMap(source => source.readSourceIds ?? [])).toContain(revisionSource);
    const child = f.driver.runtime.list('owner', { parentId: f.task.id })[0]!;
    expect(f.driver.runtime.taskSources('owner', child.id).flatMap(source => source.readSourceIds ?? [])).toContain(revisionSource);
    expect(JSON.stringify(f.driver.runtime.snapshot('owner', f.task.id)!.history)).toContain('公開の情報を探す');
    expect(f.memory.store.get('owner', added.skillId)!.uses).toEqual([]);
    expect(f.checkpoints()).toBe(0); expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    f.state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: added.skillId, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner' } });
    expect(f.visible('owner', f.task.id)).toBe(false); expect(f.visible('owner', child.id)).toBe(false);
  });

  it('withholds a revoked asynchronous private read before native history commits and never automatically reruns the segment', async () => {
    let reads = 0;
    const f = fixture(() => call('notion.read', { query: 'shared reference' }));
    f.tools.useReads({ notion: async () => { reads++; f.setConnected(false); return { text: 'Revoked private page', sources: [], sourceIds: ['notion-page://0123456789abcdef0123456789abcdef'] }; } });
    await f.driver.tick(); await f.driver.drain();
    expect(reads).toBe(1); expect(f.driver.runtime.get('owner', f.task.id)!.phase).toBe('unknown');
    expect(f.driver.runtime.snapshot('owner', f.task.id)!.history).toEqual([]);
    f.setConnected(true); for (let i = 0; i < 2; i++) { await f.driver.tick(); await f.driver.drain(); }
    expect(reads).toBe(1);
  });

  it('holds a handed-out folder write with a lost receipt on the original action and does not acknowledge or replay it', async () => {
    let writes = 0;
    const folder = { boundHosts: () => ['owner-mac'], presence: () => 'present', run: async () => { writes++; return { kind: 'timeout', handedOut: true }; } } as unknown as HostFolderOperations;
    const f = fixture(() => call('folder.create', { path: 'requested-note.txt', content: 'A requested note' }), folder);
    for (let i = 0; i < 3; i++) { await f.driver.tick(); await f.driver.drain(); }
    expect(writes).toBe(1); expect(f.driver.runtime.get('owner', f.task.id)!.phase).toBe('unknown');
    expect(f.driver.runtime.snapshot('owner', f.task.id)!.history).toEqual([]); expect(f.checkpoints()).toBe(0);
    expect(f.store.control('owner').paused).toBe(false);
    expect((await f.actions.list('owner')).filter(action => action.sourceId.startsWith(`fca:${f.task.id}:`))).toHaveLength(1);
  });

  it('retains the original read digest across native segments and refuses an intervening folder edit without checkpointing paths', async () => {
    let reads = 0, updates = 0;
    const digest = 'a'.repeat(64);
    const folder = { boundHosts: () => ['owner-mac'], presence: () => 'present', run: async (_scope: string, request: { operation: string; args: { expectedSha256?: string } }) => {
      if (request.operation === 'read') { reads++; return { kind: 'done', result: { content: 'Original note', sha256: digest, totalBytes: 13, offset: 0, nextOffset: null } }; }
      updates++; expect(request.args.expectedSha256).toBe(digest);
      return { kind: 'refused', code: 'changed_since_read' };
    } } as unknown as HostFolderOperations;
    const f = fixture(input => input.history.length ? call('folder.update', { path: 'private-note.txt', content: 'Updated note' }) : call('folder.read', { path: 'private-note.txt' }), folder);
    await f.driver.tick(); await f.driver.drain();
    const saved = f.driver.runtime.snapshot('owner', f.task.id)!.checkpoint as { fcaFolderReadDigests: [string, string][] };
    expect(saved.fcaFolderReadDigests).toEqual([[expect.stringMatching(/^[a-f0-9]{64}$/u), digest]]);
    expect(JSON.stringify(saved)).not.toContain('private-note.txt'); expect(JSON.stringify(saved)).not.toContain('Original note');
    await f.driver.tick(); await f.driver.drain();
    expect(reads).toBe(1); expect(updates).toBe(1);
    expect(f.driver.runtime.get('owner', f.task.id)!.phase).toBe('ready');
    expect(f.driver.runtime.snapshot('owner', f.task.id)!.history.at(-1)).toMatchObject({ results: [{ ok: false }] });
  });

  it('keeps a stopped handed-out write unknown until its original outside receipt is reconciled', async () => {
    let writes = 0, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const folder = { boundHosts: () => ['owner-mac'], presence: () => 'present', run: async (_scope: string, _request: unknown, signal: AbortSignal) => {
      writes++; entered();
      return new Promise(resolve => signal.addEventListener('abort', () => resolve({ kind: 'timeout', handedOut: true }), { once: true }));
    } } as unknown as HostFolderOperations;
    const f = fixture(() => call('folder.create', { path: 'requested-note.txt', content: 'A requested note' }), folder);
    await f.driver.tick(); await started;
    await f.driver.stop(f.task.id, 'owner_stop'); await f.driver.drain();
    expect(writes).toBe(1); expect(f.driver.runtime.get('owner', f.task.id)!.phase).toBe('unknown');
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.driver.runtime.resume('owner', f.task.id)).toBeNull();
    await f.driver.tick(); await f.driver.drain(); expect(writes).toBe(1);
  });

  it('never offers conversational private tools to an autonomous task or accepts a different lease/scope', async () => {
    const f = fixture(() => ({ decision: { kind: 'wait', summary: 'waiting' }, history: [] }));
    const adapter = fcaResearchTools({ tools: f.tools, state: f.state, conversations: Object.assign(new InMemoryConversationStore(), {}),
      scopeKey: 'owner', ownerAlone: () => true, task: { id: f.task.id, origin: 'own_time', leaseId: 'unbound' }, observeRead: () => true });
    expect(adapter.definitions.some(tool => tool.name === 'skill.read' || tool.name === 'study.read')).toBe(false);
    await expect(adapter.execute({ scopeKey: 'other', taskId: f.task.id, operationId: 'op', name: 'study.read', input: { id: 'one' }, signal: new AbortController().signal })).rejects.toThrow('FCA_TOOL_NOT_OFFERED');
  });
});
