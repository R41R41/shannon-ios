import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore, OWNER_AUDIENCE } from '@shannon/cognition';
import type { ConversationStore, ShannonExperience, StoredConversationMessage } from '../src/mind/memory/conversationContract.js';
import { MemoryWithholding, visibleConversationHistory, visibleReplayMessages } from '../src/mind/memory/memoryVisibility.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';

const at = '2026-10-09T00:00:00.000Z';
/** Four overlapping ancestors per round: exponential path count but only O(rounds) canonical rows/edges. */
function graph(rounds = 160) {
  let visits = 0, reads = 0, checks = 0, visible = true;
  const rows = new Map<string, ShannonExperience>();
  const time = (index: number) => new Date(Date.parse(at) + index * 1000).toISOString();
  for (let index = 0; index < rounds; index += 1) {
    const refs = Array.from({ length: Math.min(4, index) }, (_, offset) => `episode-${index - offset - 1}`);
    rows.set(`episode-${index}`, { id: `episode-${index}`, observedAt: time(index), summary: `望遠鏡の観測${index}`, userMessage: '資料を調べた', shannonReply: '確認した',
      ...(index === 0 ? { readSourceIds: ['aether-document://original'] } : {}),
      get recalledMemoryIds() { visits += 1; if (visits > rounds * 80) throw new Error('REPEATED_PROVENANCE_WALK'); return refs; } });
  }
  const root = `episode-${rounds - 1}`, observedAt = time(rounds);
  const state = new InMemoryCompanionStateStore(() => observedAt);
  const store = {
    experienceCandidates: () => [...rows.values()],
    experiencesById: (_scope: string, ids: readonly string[]) => { reads += 1; return ids.flatMap(id => rows.has(id) ? [rows.get(id)!] : []); },
    threadSummaryLineage: () => ({ messages: [{ id: 'message', sourceExperienceId: root, role: 'assistant' as const,
      content: '間接的な要約', observedAt, recalledMemoryIds: [root] }], updatedAt: observedAt }),
    readSourceVisible: () => { checks += 1; return visible; },
  } as unknown as ConversationStore;
  return { state, store, root, observedAt, rounds, rows, counts: () => ({ visits, reads, checks }), visible(value: boolean) { visible = value; },
    reset() { visits = 0; reads = 0; checks = 0; } };
}
describe('bounded traversal of overlapping memory provenance', () => {
  it('visits each id/time once per reply query and rechecks native source availability on the next use', () => {
    const f = graph(), reader = new MemoryWithholding(f.state.snapshot('owner'), f.store, 'owner');
    const input = { text: '違う表現', observedAt: f.observedAt, recalledMemoryIds: [f.root] };
    expect(reader.withholdsReply(input)).toBe(false);
    expect(f.counts().visits).toBeLessThan(f.rounds * 16);
    expect(f.counts().reads).toBeLessThanOrEqual(f.rounds);
    f.visible(false); f.reset(); expect(reader.withholdsReply(input)).toBe(true); expect(f.counts().checks).toBeGreaterThan(0);
    f.visible(true); f.reset(); expect(reader.withholdsReply(input)).toBe(false); expect(f.counts().checks).toBeGreaterThan(0);
  });
  it('bounds both summary source scans independently of memory-control rules', () => {
    const f = graph(), reader = new MemoryWithholding(f.state.snapshot('owner'), f.store, 'owner');
    expect(reader.inactive).toBe(true); expect(reader.withholdsThreadSummary('thread')).toBe(false);
    expect(f.counts().visits).toBeLessThan(f.rounds * 4);
    f.visible(false); f.reset(); expect(reader.withholdsReplaySummary('thread', { summary: '要約', chainStartedAt: at, updatedAt: f.observedAt })).toBe(true);
    f.visible(true); f.reset(); expect(reader.withholdsThreadSummary('thread')).toBe(false);
  });
  it('bounds task recall row lookups and graph walks while retaining fresh private-source checks', () => {
    const f = graph(), memory = createTaskMemory({ state: f.state, conversations: f.store, ownerScope: 'owner', ownerAlone: () => true,
      now: () => f.observedAt, readSourceVisible: f.store.readSourceVisible });
    expect(memory.read('owner', [f.root], OWNER_AUDIENCE)).toHaveLength(1);
    expect(f.counts().visits).toBeLessThan(f.rounds * 30);
    expect(f.counts().reads).toBeLessThanOrEqual(f.rounds * 2);
    f.visible(false); f.reset(); expect(memory.read('owner', [f.root], OWNER_AUDIENCE)).toEqual([]);
    f.visible(true); f.reset(); expect(memory.read('owner', [f.root], OWNER_AUDIENCE)).toHaveLength(1);
  });
  it('still rejects cycles without treating a shared ancestor as a cycle', () => {
    const f = graph(20), root = f.rows.get(f.root)!;
    f.rows.set('episode-0', { ...f.rows.get('episode-0')!, recalledMemoryIds: [root.id] });
    const reader = new MemoryWithholding(f.state.snapshot('owner'), f.store, 'owner');
    expect(reader.withholdsReply({ text: '要約', observedAt: f.observedAt, recalledMemoryIds: [root.id] })).toBe(true);
    expect(reader.withholdsThreadSummary('thread')).toBe(true);
  });
  it('shares canonical batches and graph decisions across a replay window, then rechecks revoked sources', () => {
    const f = graph(240);
    const messages: StoredConversationMessage[] = [...f.rows.values()].flatMap(row => [
      { id: `${row.id}:user`, sourceExperienceId: row.id, role: 'user', content: row.userMessage, observedAt: row.observedAt },
      { id: `${row.id}:reply`, sourceExperienceId: row.id, role: 'assistant', content: row.shannonReply, observedAt: row.observedAt,
        recalledMemoryIds: row.recalledMemoryIds },
    ]);
    const store: ConversationStore = { ...f.store, recentMessages: () => messages, history: () => messages,
      conversationHistory: () => messages };
    const replay = () => visibleReplayMessages(f.state.snapshot('owner'), store, 'owner', 'thread', OWNER_AUDIENCE, 480);
    f.reset(); expect(replay().messages).toHaveLength(480);
    expect(f.counts().reads).toBe(2); expect(f.counts().visits).toBeLessThan(f.rounds * 20);
    f.visible(false); f.reset(); expect(replay().messages).toHaveLength(0); expect(f.counts().reads).toBe(2);
    f.visible(true); f.reset(); expect(visibleConversationHistory(f.state.snapshot('owner'), store, 'owner', 'thread', OWNER_AUDIENCE)).toHaveLength(480);
    expect(f.counts().reads).toBe(2);
  });
  it('primes every summary lineage turn in bounded batches rather than issuing a query per message', () => {
    const f = graph(240), messages: StoredConversationMessage[] = [...f.rows.values()].map(row => ({
      id: `${row.id}:reply`, sourceExperienceId: row.id, role: 'assistant', content: row.shannonReply, observedAt: row.observedAt,
    }));
    const store: ConversationStore = { ...f.store, threadSummaryLineage: () => ({ messages, updatedAt: f.observedAt }) };
    const reader = new MemoryWithholding(f.state.snapshot('owner'), store, 'owner');
    expect(reader.withholdsThreadSummary('thread')).toBe(false); expect(f.counts().reads).toBe(2);
    expect(f.counts().visits).toBeLessThan(f.rounds * 4);
    f.visible(false); f.reset(); expect(reader.withholdsReplaySummary('thread', { summary: '要約', chainStartedAt: at, updatedAt: f.observedAt })).toBe(true);
    expect(f.counts().checks).toBeGreaterThan(0);
    f.visible(true); f.reset(); expect(reader.withholdsThreadSummary('thread')).toBe(false);
  });
  it('does not narrow forgotten evidence candidates to the replay window when priming canonical rows', () => {
    const f = graph(2), old = { ...f.rows.get('episode-0')!, userMessage: '非公開の望遠鏡の仕様', shannonReply: 'また同じ場所で待っています。', recalledMemoryIds: [] };
    const current = { ...f.rows.get('episode-1')!, userMessage: '今日は何をしましょう', shannonReply: old.shannonReply, recalledMemoryIds: [] };
    f.rows.set(old.id, old); f.rows.set(current.id, current);
    f.state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: old.id, kind: 'experience', status: 'forgotten',
      pinned: false, updatedAt: f.observedAt, sourceEvidence: old.userMessage, contextInvalidatedAt: f.observedAt, changeReason: 'synthetic' } });
    const messages: StoredConversationMessage[] = [
      { id: 'current-user', sourceExperienceId: current.id, role: 'user', content: current.userMessage, observedAt: current.observedAt },
      { id: 'current-reply', sourceExperienceId: current.id, role: 'assistant', content: current.shannonReply, observedAt: current.observedAt },
    ];
    const store: ConversationStore = { ...f.store, recentMessages: () => messages };
    expect(visibleReplayMessages(f.state.snapshot('owner'), store, 'owner', 'thread', OWNER_AUDIENCE, 2).messages.map(entry => entry.message.id)).toEqual(['current-user']);
  });
});
