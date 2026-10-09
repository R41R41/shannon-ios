import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { PlatformConversationSummarizer } from '../src/surfaces/platform/platformPeopleSummaries.js';
import { ImpressionUpdater } from '../src/mind/memory/impressionUpdater.js';
import { createFcaSleepPeoplePhase } from '../src/wiring/fcaSleepPeopleWiring.js';
import { memoryOpCodec, type MemoryOpDraft } from '../src/mind/memory/memoryOpCodec.js';
import { memoryOpBlockedBeforePrepare } from '../src/mind/memory/memoryOps.js';
const AT = '2026-10-09T03:00:00.000Z';
const job = { id: 'sleep-1', scopeKey: 'owner', dayKey: '2026-10-09', startAt: '2026-10-08T00:00:00.000Z', endAt: '2026-10-10T00:00:00.000Z' };
const close: Array<() => void> = [];
afterEach(() => { for (const clean of close.splice(0)) clean(); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'fca-people-')), database = join(path, 'state.sqlite');
  const store = new SQLiteShannonStore({ path: database, now: () => AT }), peopleStore = new SQLitePeopleMemoryStore(database);
  close.push(() => { peopleStore.close(); store.close(); rmSync(path, { recursive: true, force: true }); });
  const people = new PlatformPeople(peopleStore, store);
  const item = people.ingest('owner', { platform: 'discord', requestId: 'request-1', payloadHash: 'hash-1', threadKey: 'discord:test',
    label: '友人', conversationKind: 'group', sourceUserId: 'user-1', sourceDisplayName: 'ミキ', sourceKind: 'person',
    message: '今日は猫の話をしたいです', shannonReply: 'どんな猫ですか', observedAt: AT });
  const writes = vi.fn(), summarize = vi.fn(async () => '飼い猫について話した。');
  const analyze = vi.fn(async () => ({ observations: [], candidates: [{ kind: 'preference', pattern: '猫の話をする', keyTerms: ['猫'], feeling: '嬉しい', feelingTag: 'happy' }] }));
  const usage = { backgroundLlmCostUsd: () => 0 }, observed = vi.fn((_ids: readonly string[]) => true), hidden = new Set<string>();
  const sourcesVisible = (ids: readonly string[]) => ids.every(id => !hidden.has(id));
  const summaries = new PlatformConversationSummarizer(peopleStore, people, { summarize }, usage, { now: () => AT });
  const impressions = new ImpressionUpdater(store, store, store.impressionStore(), { analyze }, usage, {
    now: () => AT, people: peopleStore, memory: { propose: writes } as never, environment: {},
  });
  const phase = () => createFcaSleepPeoplePhase({ summaries, impressions, observeSources: ids => sourcesVisible(ids) && observed(ids), sourcesVisible });
  return { store, peopleStore, summaries, impressions, item, phase, summarize, analyze, writes, observed, hidden };
}
it('runs one summary then one impression; only IDs persist and only apply uses the existing writer', async () => {
  const h = fixture(), signal = new AbortController().signal;
  const input = { job, state: null, signal }, phase = h.phase(), first = await phase.decide(input);
  expect(h.summarize).toHaveBeenCalledTimes(1); expect(h.analyze).not.toHaveBeenCalled();
  expect(h.peopleStore.items('owner').find(item => item.kind === 'summary')!.text).not.toContain('飼い猫について');
  const result = await phase.apply(first, { ...input, operationId: 'step:1' });
  expect(JSON.stringify(result.state)).not.toContain('猫');
  expect(result.done).toBe(false);
  const secondInput = { ...input, state: result.state }, secondPhase = h.phase(), second = await secondPhase.decide(secondInput);
  expect(h.analyze).toHaveBeenCalledTimes(1); expect(h.writes).not.toHaveBeenCalled();
  expect((await secondPhase.apply(second, { ...secondInput, operationId: 'step:2' })).done).toBe(true);
  expect(h.writes).toHaveBeenCalledTimes(1);
  expect(h.writes.mock.calls[0]![0].episodeIds).toContain(`person:${h.item.itemId}`);
  expect(await h.impressions.prepareFca('owner', h.impressions.fcaTargets('owner', job.startAt, job.endAt)[0]!.callId,
    h.item.personId!, signal, () => true).then(apply => apply())).toBe('duplicate');
  expect(h.analyze).toHaveBeenCalledTimes(1);
});
it('withholds forgotten evidence before inference and rejects forgetting or late cancellation before apply', async () => {
  const h = fixture(), signal = new AbortController().signal, input = { job, state: null, signal };
  h.hidden.add(`person:${h.item.itemId}`);
  const phase = h.phase(), skipped = await phase.decide(input);
  expect(h.summarize).not.toHaveBeenCalled(); await phase.apply(skipped, { ...input, operationId: 'skip' });
  h.hidden.clear(); const active = h.phase(), answer = await active.decide(input);
  h.hidden.add(`person:${h.item.itemId}`);
  await expect(active.apply(answer, { ...input, operationId: 'forget' })).rejects.toThrow('SOURCE_CHANGED');
  h.hidden.clear(); const controller = new AbortController();
  h.summarize.mockImplementation(async () => { controller.abort(); return '猫について話した。'; });
  await expect(h.phase().decide({ ...input, signal: controller.signal })).rejects.toThrow();
});
it('pre-counts uncertain impression inference so restart cannot pay for it twice', async () => {
  const h = fixture(), signal = new AbortController().signal;
  const target = h.impressions.fcaTargets('owner', job.startAt, job.endAt)[0]!;
  h.analyze.mockRejectedValueOnce(new Error('PAID_UNKNOWN'));
  await expect(h.impressions.prepareFca('owner', target.callId, target.personId, signal, () => true)).rejects.toThrow('PAID_UNKNOWN');
  expect(await h.impressions.prepareFca('owner', target.callId, target.personId, signal, () => true).then(apply => apply())).toBe('duplicate');
  expect(h.analyze).toHaveBeenCalledTimes(1); expect(h.writes).not.toHaveBeenCalled();
});
it('carries all 40 summary lines through the existing outbox so a later forget blocks the one writer', async () => {
  const h = fixture(), callId = h.summaries.fcaTargets('owner', job.startAt, job.endAt)[0]!;
  const original = h.peopleStore.items('owner').find(item => item.kind === 'turn')!;
  h.peopleStore.upsertCallItems('owner', callId, Array.from({ length: 39 }, (_, i) => ({ ...original, id: `extra-${i}`, text: `猫の話題 ${i}` })));
  let draft: MemoryOpDraft | undefined;
  const people = new PlatformPeople(h.peopleStore, h.store, undefined, { propose: (value: MemoryOpDraft) => { draft = value; } } as never);
  const summaries = new PlatformConversationSummarizer(h.peopleStore, people, { summarize: h.summarize }, { backgroundLlmCostUsd: () => 0 }, { now: () => AT });
  const apply = await summaries.prepareFca('owner', callId, new AbortController().signal, () => true, () => true);
  expect(apply()).toBe('written');
  expect(draft!.episodeIds).toHaveLength(41);
  const encoded = memoryOpCodec.encode(draft!); expect(encoded.ok).toBe(true); if (!encoded.ok) return;
  const decoded = memoryOpCodec.decode({ ...encoded.value, seq: 1, attempts: 0 }); expect(decoded.ok).toBe(true); if (!decoded.ok) return;
  const state = { ...h.store.snapshot('owner'), memoryControls: [{ memoryId: 'person:extra-38', kind: 'experience' as const,
    status: 'forgotten' as const, pinned: false, updatedAt: AT, changeReason: 'owner'  }] };
  expect(memoryOpBlockedBeforePrepare({} as never, decoded.value, state)).toBe('forgotten');
});
