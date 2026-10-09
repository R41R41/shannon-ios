import { STORE_MEMORY_PARTS } from '../src/infra/sqlite/storeMemoryParts.js';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { memoryWorld } from './support/memoryWorld.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { taskExperienceDraft, taskExperienceId, type TaskExperienceRecord } from '../src/mind/memory/taskExperience.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { MemoryWithholding } from '../src/mind/memory/memoryVisibility.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { memoryWriterOf } from '../src/wiring/memoryOutboxWiring.js';
const worlds: ReturnType<typeof memoryWorld>[] = [];
afterEach(() => worlds.splice(0).forEach(world => world.close()));
function fixture() {
  const w = memoryWorld(); worlds.push(w); let owner = true;
  const memory = createTaskMemory({ state: w.store, conversations: w.store, ownerScope: 'owner', ownerAlone: () => owner, now: w.now });
  const record = (status: TaskExperienceRecord['status'] = 'success', sourceIds: string[] = []): TaskExperienceRecord => ({
    scopeKey: 'owner', taskId: 'task-one', outcomeId: `outcome-${status}`, observedAt: w.now(), status,
    goal: '望遠鏡の調査', context: '依頼された研究', action: '公開文献を調べた', prediction: '仕様が分かる',
    observedResult: status === 'unobserved' ? '' : '焦点距離を確認した', interpretation: '比較の材料になる', sourceIds,
  });
  return { ...w, memory, record, owner: (value: boolean) => { owner = value; } };
}
describe('task outcomes in the existing canonical memory writer', () => {
  it.each(['success', 'failure', 'cancelled', 'unobserved'] as const)('indexes %s once before any model and preserves structured provenance', async status => {
    const f = fixture(), record = f.record(status); f.ports.proposals.propose(taskExperienceDraft(record));
    expect(await f.writer().runOnce()).toBe('worked');
    const id = taskExperienceId('owner', record.taskId, record.outcomeId);
    expect(f.store.searchMemory('owner', '望遠鏡').map(hit => hit.id)).toContain(id);
    expect(f.store.experiencesById('owner', [id])[0]).toMatchObject({ id, recalledMemoryIds: [], disclosure: { speaker: 'unknown' } });
    expect(f.store.listThreads('owner')).toEqual([]); expect(f.calls).toEqual([]);
    f.ports.proposals.propose(taskExperienceDraft(record)); await f.writer().runOnce();
    expect(f.store.experienceCandidates('owner').filter(row => row.id === id)).toHaveLength(1);
    expect(f.rows()).toHaveLength(1);
    const event = f.store.events('owner').find(row => row.id === id)!;
    expect(event.payload).toMatchObject({ source: 'fca.task', task: { status, taskId: record.taskId, prediction: record.prediction } });
  });
  it('observes a previously unknown outcome by updating one episode while keeping its prior audit evidence', async () => {
    const f = fixture(), record = f.record('unobserved'), writer = f.writer();
    f.ports.proposals.propose(taskExperienceDraft(record)); await writer.runOnce(); f.advance(1000);
    f.ports.proposals.propose(taskExperienceDraft({ ...record, observedAt: f.now(), status: 'success', observedResult: '新しい分光データを確認' }));
    await writer.runOnce();
    const id = taskExperienceId('owner', record.taskId, record.outcomeId);
    expect(f.store.experienceCandidates('owner')).toHaveLength(1);
    expect(f.store.searchMemory('owner', '分光データ').map(hit => hit.id)).toContain(id);
    expect(f.store.events('owner').find(row => row.id === `${id}:prior`)?.type).toBe('task.outcome.prior');
  });
  it('preserves more than forty inherited sources and applies forgetting to the final source', async () => {
    const f = fixture(), ids: string[] = [];
    for (let index = 0; index < 55; index += 1) ids.push(f.store.appendTurn('owner', 'thread', `資料 ${index}`, '記録', f.now()).id);
    const record = f.record('success', ids); f.ports.proposals.propose(taskExperienceDraft(record)); await f.writer().runOnce();
    const id = taskExperienceId('owner', record.taskId, record.outcomeId);
    expect(f.store.experiencesById('owner', [id])[0]!.recalledMemoryIds).toEqual(ids);
    expect(f.memory.sources('owner', [id])).toEqual([id, ...ids]);
    expect(f.memory.read('owner', [id], OWNER_AUDIENCE)[0]!.provenance).toEqual({ kind: 'experience', sourceIds: [id, ...ids], readSourceIds: [] });
    f.advance(1000); new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: ids.at(-1)!, action: 'forget' });
    expect(f.memory.read('owner', [id], OWNER_AUDIENCE)).toEqual([]);
  });
  it('replays a queued outcome after reopening without creating a second episode', async () => {
    const f = fixture(), record = f.record(); f.ports.proposals.propose(taskExperienceDraft(record));
    const second = new SQLiteShannonStore({ path: f.path, now: f.now, memoryOutbox: true, memoryParts: STORE_MEMORY_PARTS, moodHistory: null });
    const writer = memoryWriterOf(second, { now: f.now, owner: 'restarted' })!;
    try { await writer.runOnce(); await writer.runOnce(); expect(second.experienceCandidates('owner')).toHaveLength(1); } finally { writer.releaseLease(); second.close(); }
  });
  it('checks forgetting again under the writer lock, including transitive episode sources', async () => {
    const f = fixture(), source = f.store.appendTurn('owner', 'thread', '望遠鏡の秘密', '了解', f.now());
    const first = f.record('success', [source.id]); f.ports.proposals.propose(taskExperienceDraft(first)); await f.writer().runOnce();
    const firstId = taskExperienceId('owner', first.taskId, first.outcomeId);
    f.advance(1000); const second = { ...f.record('failure', [firstId]), observedResult: '別の表現での結果' };
    f.ports.proposals.propose(taskExperienceDraft(second));
    await f.writer({ beforeLock: () => new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: source.id, action: 'forget' }) }).runOnce();
    expect(f.store.experiencesById('owner', [taskExperienceId('owner', second.taskId, second.outcomeId)])).toEqual([]);
    expect(new MemoryWithholding(f.store.snapshot('owner'), f.store, 'owner').withholdsReply({ text: '無関係な言い換え', observedAt: f.now(), recalledMemoryIds: [firstId] })).toBe(true);
    expect(f.memory.read('owner', [firstId], OWNER_AUDIENCE)).toEqual([]);
  });
});
describe('shared task memory reads', () => {
  it('does not expose old evidence after an owner correction and checks again after the observation sink', async () => {
    const f = fixture();
    f.store.apply('owner', { type: 'user-fact-upserted', fact: { id: 'user-fact-one', statement: '古い居住地', evidence: '秘密の旧住所', confidence: 1, observedAt: f.now() } });
    f.advance(1000); new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: 'user-fact-one', action: 'correct', text: '新しい居住地' }); f.advance(1000);
    expect(f.memory.read('owner', ['user-fact-one'], OWNER_AUDIENCE)[0]).toMatchObject({ summary: '新しい居住地', evidence: '' });
    const result = await f.memory.execute('memory.read', { id: 'user-fact-one' }, { scopeKey: 'owner', present: OWNER_AUDIENCE,
      observe: () => { new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: 'user-fact-one', action: 'forget' }); return true; } });
    expect(result.status).toBe('withheld'); expect(result.items).toEqual([]);
  });
  it('records exact successful IDs before releasing a bounded result, and enforces scope/audience/abort', async () => {
    const f = fixture(), source = f.store.appendTurn('owner', 'thread', '望遠鏡について', '反射式を選んだ', f.now());
    const seen: string[][] = [];
    const context = { scopeKey: 'owner', present: OWNER_AUDIENCE, observe: (ids: readonly string[]) => { seen.push([...ids]); return true; } };
    expect(await f.memory.execute('memory.read', { id: source.id }, context)).toMatchObject({ status: 'ready', sourceIds: [source.id] });
    expect(seen).toEqual([[source.id]]);
    expect((await f.memory.execute('memory.read', { id: source.id }, { ...context, observe: () => false })).items).toEqual([]);
    expect(f.memory.read('other', [source.id], OWNER_AUDIENCE)).toEqual([]);
    expect(f.memory.search('owner', '望遠鏡', { kind: 'group', groupKey: 'public' })).toEqual([]);
    const abort = new AbortController(); abort.abort(); expect((await f.memory.execute('memory.read', { id: source.id }, context, abort.signal)).status).toBe('cancelled');
    f.owner(false); expect((await f.memory.execute('memory.read', { id: source.id }, context)).status).toBe('withheld');
    expect(seen).toHaveLength(1);
  });
});
