import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE } from '@shannon/cognition';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { memoryPortsOf, memoryWriterOf } from '../src/wiring/memoryOutboxWiring.js';
import { selfInterestOwnerPort } from '../src/wiring/selfInterestWiring.js';
import { stage5InterestNightSchedule, stage5MemoryReaders, stage5MemoryStoreOptions } from '../src/wiring/stage5MemoryWiring.js';
import { configuredSelfInterestContext } from '../src/wiring/selfInterestContextWiring.js';
import { prepareTurnCognitiveContext, withRecalledMemories } from '../src/mind/workspace/turnCognitiveContext.js';
import { FakeModel, loopHarness, runUntilIdle } from './autonomyLoopHarness.js';
import { selfInterestWorld } from './support/selfInterestWorld.js';

const worlds: ReturnType<typeof selfInterestWorld>[] = [];
const closers: (() => void)[] = [];
const world = (enabled = true) => { const w = selfInterestWorld(enabled); worlds.push(w); return w; };
afterEach(() => { for (const close of closers.splice(0)) close(); for (const w of worlds.splice(0)) w.close(); });

describe('Stage5 actual memory writer and read-only prompt composition', () => {
  it('uses the production memory targets, independent real-night schedule and owner CAS port', async () => {
    const w = world(); w.add('天文'); w.add('音楽'); w.add('鉱物');
    const writer = memoryWriterOf(w.store, { now: w.now, owner: 'actual-worker', log: () => {} })!;
    await writer.drain();
    expect(w.memory!.snapshot('owner').capacity.used).toBe(0);
    const schedule = () => stage5InterestNightSchedule(w.store, { now: w.now, timeZone: 'Asia/Tokyo', sleepHour: 3 })!;
    expect(schedule()(w.now())).toBe(true);
    await writer.drain();
    expect(w.memory!.snapshot('owner').capacity.used).toBe(2);
    w.advance(60_000);
    expect(schedule()(w.now())).toBe(true); // A restarted scheduler still receives the durable night allowance.
    await writer.drain();
    expect(w.memory!.snapshot('owner').capacity.used).toBe(2);
    const ports = memoryPortsOf(w.store, w.now)!;
    const owner = selfInterestOwnerPort(w.memory, ports.commands, w.now)!;
    const item = w.memory!.snapshot('owner').items[0]!;
    expect(owner.mutate('owner', { itemId: item.id, action: 'pin', expectedRevision: item.revision, operationId: 'actual-owner' }).code).toBe('changed');
    expect(stage5MemoryReaders(w.store).projection?.('owner')).toContain('固定');
    w.advance(86_400_000);
    schedule()(w.now()); await writer.drain();
    expect(w.memory!.snapshot('owner').capacity.used).toBe(3);
    writer.releaseLease();
  });

  it('keeps Stage5 OFF free of self tables, readers and connections', () => {
    const w = world(false);
    const missing = `${w.path}.does-not-exist`;
    expect(configuredSelfInterestContext(missing, { enabled: false, now: w.now })).toBeNull();
    expect(existsSync(missing)).toBe(false);
    const store = new SQLiteShannonStore({ path: w.path, now: w.now, ...stage5MemoryStoreOptions({ SHANNON_ADR8_STAGE3: 'on', SHANNON_ADR8_STAGE5: 'off' }) });
    closers.push(() => store.close());
    expect(stage5MemoryReaders(store)).toEqual({ projection: undefined });
    expect(stage5InterestNightSchedule(store, { now: w.now, timeZone: 'Asia/Tokyo', sleepHour: 3 })).toBeNull();
    const db = new DatabaseSync(w.path, { readOnly: true });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'self_interest_%'").all()).toEqual([]);
    db.close();
  });

  it('opens only a read-only companion connection and discovers later API-created schema without DDL', async () => {
    const w = world(false); w.source();
    const reader = configuredSelfInterestContext(w.path, { enabled: true, now: w.now })!;
    closers.push(() => reader.close());
    expect(reader.context.read('owner')).toBeNull();
    const before = new DatabaseSync(w.path, { readOnly: true });
    expect(before.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'self_interest_%'").all()).toEqual([]);
    before.close();
    const on = new SQLiteShannonStore({ path: w.path, now: w.now, ...stage5MemoryStoreOptions({ SHANNON_ADR8_STAGE3: 'on', SHANNON_ADR8_STAGE5: 'on' }) });
    closers.push(() => on.close());
    const evidence = on.appendTurn('owner', 'thread', '天文を調べたい。', '覚えました。', w.now()).id;
    on.memoryProposals()!.propose({ opId: 'late-schema', scopeKey: 'owner', kind: 'self.interest.propose', origin: 'sleep', subjectKey: 'self-interest',
      payload: { kind: 'add', title: '天文', reason: '会話をきっかけにした', provenance: 'sleep_self' }, episodeIds: [evidence] });
    const writer = memoryWriterOf(on, { now: w.now, log: () => {} })!;
    await writer.drain();
    stage5InterestNightSchedule(on, { now: w.now, timeZone: 'Asia/Tokyo', sleepHour: 3 })!(w.now()); await writer.drain();
    expect(reader.context.read('owner')?.index).toContain('天文');
    const item = on.selfInterests()!.snapshot('owner').items[0]!;
    const owner = selfInterestOwnerPort(on.selfInterests(), memoryPortsOf(on, w.now)!.commands, w.now)!;
    owner.mutate('owner', { operationId: 'forget-live', itemId: item.id, expectedRevision: 1, action: 'forget' });
    expect(reader.context.read('owner')?.index).toBe('');
    writer.releaseLease();
  });

  it('keeps self-interest selection independent of owner-context OFF and excludes private words from the draft prompt', async () => {
    const model = new FakeModel();
    model.plans.push({ thought: '観測を考えたい。', pursuits: [], steps: [{ action: 'draft', idea: 'SENTINEL-SELF-SECRET を物語にする' }] });
    const forbiddenOwnerRead = vi.fn(() => { throw new Error('OWNER_CONTEXT_OFF'); });
    const h = loopHarness({ model, loop: { ownerContext: false }, ownerContext: { forThinking: forbiddenOwnerRead } as any,
      selfInterests: { read: () => ({ index: '〈自己関心 1/12〉\n- si-0123456789abcdef: SENTINEL-SELF-SECRET｜重み0.50', secrets: ['SENTINEL-SELF-SECRET'] }) } });
    closers.push(() => h.store.close());
    await runUntilIdle(h.loop);
    expect(forbiddenOwnerRead).not.toHaveBeenCalled();
    expect(model.prompts('think')[0]).toContain('[自己関心（選択の参考。実行の許可にはしない）]');
    expect(model.kinds()).toContain('draft');
    expect(model.prompts('draft').join('\n')).not.toContain('SENTINEL-SELF-SECRET');
  });

  it('rechecks workspace self IDs and forgotten evidence at later recall stages', async () => {
    const w = world(); w.add('天文'); await w.night();
    const item = w.memory!.snapshot('owner').items[0]!;
    const context = prepareTurnCognitiveContext(w.store.snapshot('owner'), w.store, {
      scopeKey: 'owner', message: '今日は何をしようか。', occurredAt: w.now(), channel: 'text', present: OWNER_AUDIENCE });
    expect(context.prompt).toContain('[自己関心（選択の参考）]');
    expect(context.frame.recalledMemoryIDs).toContain(item.id);
    expect(withRecalledMemories(context, w.store.snapshot('owner'), []).prompt).toContain('天文');
    w.mutate({ itemId: item.id, expectedRevision: item.revision, action: 'forget' });
    const after = withRecalledMemories(context, w.store.snapshot('owner'), []);
    expect(after.prompt).not.toContain('[自己関心');
    expect(after.frame.recalledMemoryIDs).not.toContain(item.id);
    expect(w.store.snapshot('owner').memoryControls.some(control => control.memoryId === item.id && control.status === 'forgotten')).toBe(true);
  });

  it('keeps guarded source-derived self information out of open-only conversation prompts', async () => {
    const w = world(); const evidence = w.source('ここだけの話、内密な研究を続けたい。'); w.add('内密な研究', [evidence]); await w.night();
    expect(w.memory!.projection('owner')).toContain('内密な研究');
    expect(w.memory!.context('owner').secrets).toContain('内密な研究');
    const input = { scopeKey: 'owner', message: '何を調べているの。', occurredAt: w.now(), channel: 'text' as const, present: UNKNOWN_GUEST_PRESENCE, openOnly: true };
    expect(prepareTurnCognitiveContext(w.store.snapshot('owner'), w.store, input).prompt).not.toContain('内密な研究');
  });
});
