import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { memoryWorld } from './support/memoryWorld.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { createTaskRecall } from '../src/mind/recall/taskRecall.js';
import { fcaRecallContext } from '../src/mind/action/fca/fcaRecallContext.js';
import type { EnrichedTurnContext, TurnMemoryRecall } from '../src/mind/recall/turnMemoryRecall.js';
import type { TurnCognitiveContext } from '../src/mind/workspace/contextPorts.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
const worlds: ReturnType<typeof memoryWorld>[] = [];
afterEach(() => worlds.splice(0).forEach(world => world.close()));
function fixture() {
  const w = memoryWorld(); worlds.push(w); let owner = true;
  const memory = createTaskMemory({ state: w.store, conversations: w.store, ownerScope: 'owner', ownerAlone: () => owner, now: w.now });
  const calls: Array<{ resolve(value: EnrichedTurnContext): void; reject(error: Error): void; context: TurnCognitiveContext; signal?: AbortSignal }> = [];
  const enrich: Pick<TurnMemoryRecall, 'enrich'> = { enrich: (context, input) => new Promise((resolve, reject) => calls.push({ resolve, reject, context, signal: input.signal })) };
  const recall = createTaskRecall({ state: w.store, conversations: w.store, memory, enrich, now: w.now });
  const input = { scopeKey: 'owner', taskId: 'task-one', contextVersion: 'goal-v1', cue: '望遠鏡', present: OWNER_AUDIENCE };
  const release = (index: number, id: string) => { const call = calls[index]!; call.resolve({ ...call.context,
    memories: [{ id, summary: '意味検索の補足', observedAt: w.now(), relevance: 1, reasons: [] }],
    frame: { ...call.context.frame, recalledMemoryIDs: [id] }, knowledgePrompt: '', memoryRecall: { status: 'used', modelCalls: 1, elapsedMilliseconds: 1 } }); };
  return { ...w, memory, recall, calls, input, release, owner: (value: boolean) => { owner = value; } };
}
describe('task recall decisions', () => {
  it('starts once alongside selection, returns immediately, and admits late enrichment only on the next boundary', async () => {
    const f = fixture();
    f.recall.start(f.input); expect(f.calls).toHaveLength(1);
    const first = await f.recall.packet(f.input); expect(first.status).toBe('searching'); expect(first.items).toEqual([]);
    const late = f.store.appendTurn('owner', 'thread', '遠い惑星の秘密', '意味的に近い観測', f.now());
    f.release(0, late.id); await Promise.resolve();
    expect(first.items).toEqual([]);
    const second = await f.recall.packet(f.input); expect(second.status).toBe('ready'); expect(second.sourceIds).toContain(late.id);
    await f.recall.packet(f.input); expect(f.calls).toHaveLength(1);
  });
  it('starts no enrichment for a decision that will not wait for it, and still gives the deterministic recall (2026-10-13)', async () => {
    const f = fixture(), known = f.store.appendTurn('owner', 'thread', '望遠鏡の話', '望遠鏡を見た', f.now());
    const input = { ...f.input, semantic: false };
    f.recall.start(input); expect(f.calls).toHaveLength(0);
    const packet = await f.recall.packet(input);
    expect(packet.status).toBe('ready'); expect(packet.sourceIds).toContain(known.id); expect(f.calls).toHaveLength(0);
    const inquiry = fcaRecallContext({ scopeKey: 'owner', taskId: 't', snapshot: { task: { goal: '望遠鏡について何を覚えてる？', completionCriteria: '', summary: '' }, messages: [] } } as never, {}, new AbortController().signal);
    expect(inquiry).toMatchObject({ waitMilliseconds: 1500, input: { semantic: true } });
    const research = fcaRecallContext({ scopeKey: 'owner', taskId: 't', snapshot: { task: { goal: '大濠公園から福岡空港までの所要時間', completionCriteria: '', summary: '' }, messages: [] } } as never, {}, new AbortController().signal);
    expect(research).toMatchObject({ waitMilliseconds: 0, input: { semantic: false } });
  });
  it('invalidates obsolete goals and cancelled work even if a provider resolves after abort', async () => {
    const f = fixture(), old = f.store.appendTurn('owner', 'thread', '古い目的の資料', '記録', f.now());
    f.recall.start(f.input); const next = { ...f.input, contextVersion: 'goal-v2', cue: '別の調査' };
    f.recall.start(next); expect(f.calls[0]!.signal?.aborted).toBe(true);
    f.release(0, old.id); await Promise.resolve(); expect((await f.recall.packet(next)).sourceIds).not.toContain(old.id);
    f.recall.cancel('owner', 'task-one'); expect(f.calls[1]!.signal?.aborted).toBe(true);
    const abort = new AbortController(); abort.abort(); expect((await f.recall.packet({ ...next, signal: abort.signal })).status).toBe('cancelled');
  });
  it('awaits semantic abort acknowledgement before releasing a segment while retaining obtained IDs without a second search', async () => {
    const f = fixture(), source = f.store.appendTurn('owner', 'thread', '望遠鏡の観測', '記録', f.now());
    f.recall.start(f.input); let finished = false;
    const finishing = f.recall.finishSegment('owner', 'task-one').then(() => { finished = true; });
    expect(f.calls[0]!.signal?.aborted).toBe(true); await Promise.resolve(); expect(finished).toBe(false);
    f.calls[0]!.reject(new Error('aborted provider unwound')); await finishing;
    const packet = await f.recall.packet(f.input);
    expect(packet.sourceIds).toContain(source.id); expect(packet.status).toBe('failed'); expect(f.calls).toHaveLength(1);
    f.recall.cancelAll();
  });
  it('keeps already completed enrichment across segment finish, and does not re-run the same context', async () => {
    const f = fixture(); f.recall.start(f.input);
    const late = f.store.appendTurn('owner', 'thread', '別の関連資料', '記録', f.now()); f.release(0, late.id); await Promise.resolve();
    await f.recall.finishSegment('owner', 'task-one');
    expect((await f.recall.packet(f.input)).sourceIds).toContain(late.id); expect(f.calls).toHaveLength(1);
  });
  it.each(['input', 'task', 'all', 'superseded'] as const)('still awaits the retired provider after %s invalidates its cache entry', async mode => {
    const f = fixture(), signal = new AbortController(); f.recall.start({ ...f.input, signal: signal.signal });
    let closing: Promise<void> | undefined;
    if (mode === 'input') signal.abort();
    if (mode === 'task') f.recall.cancel('owner', 'task-one');
    if (mode === 'all') closing = f.recall.cancelAll();
    if (mode === 'superseded') f.recall.start({ ...f.input, contextVersion: 'next-goal' });
    let done = false;
    const finishing = f.recall.finishSegment('owner', 'task-one').then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false); expect(f.calls[0]!.signal?.aborted).toBe(true);
    f.calls[0]!.reject(new Error('old provider acknowledged abort'));
    if (mode === 'superseded') { await Promise.resolve(); expect(done).toBe(false); f.calls[1]!.reject(new Error('new provider acknowledged abort')); }
    await finishing; await closing; expect(done).toBe(true);
  });
  it('cancels every in-flight enrichment on shutdown, and attaches cancellation when a task reuses cached context', async () => {
    const f = fixture(); f.recall.start(f.input); f.recall.start({ ...f.input, taskId: 'task-two' });
    f.recall.cancelAll(); expect(f.calls.every(call => call.signal?.aborted)).toBe(true);
    f.release(0, 'stale'); await Promise.resolve();
    f.recall.start(f.input); expect(f.calls).toHaveLength(3);
    const nextSegment = new AbortController(); f.recall.start({ ...f.input, signal: nextSegment.signal });
    nextSegment.abort(); expect(f.calls[2]!.signal?.aborted).toBe(true);
    f.recall.start(f.input); expect(f.calls).toHaveLength(4);
    expect((await f.recall.packet(f.input)).sourceIds).not.toContain('stale'); f.recall.cancelAll();
  });
  it('freshly checks forgetting and current audience when consuming cached enrichment', async () => {
    const f = fixture(); f.recall.start(f.input);
    const late = f.store.appendTurn('owner', 'thread', '古い秘密の資料', '資料', f.now()); f.release(0, late.id); await Promise.resolve();
    expect((await f.recall.packet(f.input)).sourceIds).toContain(late.id);
    f.advance(1000); new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: late.id, action: 'forget' });
    expect((await f.recall.packet(f.input)).sourceIds).not.toContain(late.id);
    f.owner(false); expect((await f.recall.packet(f.input)).status).toBe('withheld'); expect(f.calls).toHaveLength(1);
  });
  it('distinguishes failure from no match without discarding deterministic results', async () => {
    const f = fixture(); f.store.appendTurn('owner', 'thread', '望遠鏡を買った', '観測できる', f.now());
    f.recall.start(f.input); f.calls[0]!.reject(new Error('provider unavailable')); await Promise.resolve(); await Promise.resolve();
    const failed = await f.recall.packet(f.input); expect(failed.status).toBe('failed'); expect(failed.items.length).toBeGreaterThan(0);
    const empty = createTaskRecall({ state: f.store, conversations: f.store, memory: f.memory, enrich: null, now: f.now });
    expect((await empty.packet({ ...f.input, scopeKey: 'other' })).status).toBe('withheld');
  });
});
