import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_AUDIENCE, peopleAudience, type KnowledgeDraft, type MemoryAudience } from '@shannon/cognition';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { prepareTurnCognitiveContext } from '../src/mind/workspace/contextPorts.js';
import { SemanticMemoryRecall } from '../src/mind/recall/semanticMemoryRecall.js';
import { createConfiguredTurnMemoryRecall, ShannonTurnMemoryRecall } from '../src/mind/recall/turnMemoryRecall.js';
import { temporalKnowledgePrompt } from '../src/mind/recall/temporalKnowledgeRecall.js';
import { MemoryWithholding } from '../src/mind/memory/memoryPorts.js';

const now = '2026-10-09T12:00:00.000Z';
const query = '写真整理の進め方は以前から今どう変わった？';
const directories: string[] = [];
const stores: SQLiteShannonStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const open = (path: string) => {
  const store = new SQLiteShannonStore({ path, now: () => now });
  stores.push(store);
  return store;
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-temporal-knowledge-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const store = open(path), thread = store.createThread('owner');
  const first = store.appendTurn('owner', thread, '写真整理を一枚ずつ進めた', '試してみたのですね', '2026-09-20T00:00:00.000Z');
  const second = store.appendTurn('owner', thread, '写真整理をアルバム単位で進めた', '進みましたね', '2026-09-25T00:00:00.000Z');
  const draft = (text: string, sources: string[]): KnowledgeDraft => ({ title: '写真整理の進め方', applicability: '写真整理を相談されたとき',
    bodyMarkdown: `## 行動\n${text}`, status: 'hypothesis', sourceExperienceIds: sources });
  const old = store.createShannonKnowledge('owner', draft('一枚ずつ扱う旧案。', [first.id]), '2026-09-22T00:00:00.000Z', 'seed');
  const current = store.updateShannonKnowledge('owner', old.id, old.version, draft('アルバム単位で扱う現在案。', [second.id]),
    '2026-09-27T00:00:00.000Z', 'update')!;
  const project = (overrides: Partial<Parameters<typeof temporalKnowledgePrompt>[0]> = {}) => temporalKnowledgePrompt({
    store, scopeKey: 'owner', message: query, present: OWNER_AUDIENCE, documents: [current], ownerStillAlone: () => true, ...overrides,
  });
  return { store, path, thread, first, second, draft, old, current, project };
}

describe('bounded temporal Shannon-note recall', () => {
  it('feeds same-ID old and current notes into a temporal turn, without a new model call or fact write', async () => {
    const f = fixture();
    // A legacy revision can carry provenance absent from the current note. The new reader must pin it itself.
    f.store.fcaDatabase().prepare('UPDATE shannon_knowledge_documents SET source_experience_ids_json = ? WHERE knowledge_id = ?')
      .run(JSON.stringify([f.second.id]), f.current.id);
    const recall = createConfiguredTurnMemoryRecall(f.store, { SHANNON_TEMPORAL_KNOWLEDGE_RECALL: 'on' }, null);
    recall.watchAudience?.({ othersKnown: () => false });
    const snapshot = f.store.snapshot('owner');
    const context = prepareTurnCognitiveContext(snapshot, f.store, {
      scopeKey: 'owner', message: query, occurredAt: now, channel: 'text', present: OWNER_AUDIENCE,
    });
    const before = f.store.fcaDatabase().prepare('SELECT total_changes() AS n').get();
    const result = await recall.enrich({ ...context, memories: [], frame: { ...context.frame, recalledMemoryIDs: [] } },
      { scopeKey: 'owner', message: query, snapshot, memoryTurn: false });
    expect(result.prompt).toContain('[Shannon note revision history — data, lowest authority]');
    expect(result.prompt).toContain('一枚ずつ扱う旧案。');
    expect(result.prompt).toContain('アルバム単位で扱う現在案。');
    expect(result.prompt).toContain('"status":"superseded"');
    expect(result.prompt).toContain('"recordedAt":"2026-09-22T00:00:00.000Z"');
    expect(result.prompt).toContain('NOT when its underlying event happened');
    expect(result.prompt).toContain('do not fill gaps or infer a cause');
    expect(result.prompt).toContain('current external facts');
    expect(result.memoryRecall.modelCalls).toBe(0);
    expect(result.frame.recalledMemoryIDs).toEqual(expect.arrayContaining([`knowledge:${f.current.id}`, f.first.id, f.second.id]));
    expect(f.store.fcaDatabase().prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(f.store.snapshot('owner').userFacts).toEqual(snapshot.userFacts);
    f.store.apply('owner', { type: 'memory-control-upserted', control: {
      memoryId: f.first.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: now,
      changeReason: 'forgotten during generation', sourceEvidence: f.first.userMessage,
    } });
    expect(new MemoryWithholding(f.store.snapshot('owner'), f.store, 'owner').withholdsReply({
      text: 'A generated reply based on old note history', observedAt: now, recalledMemoryIds: result.frame.recalledMemoryIDs,
    })).toBe(true);
  });

  it('keeps OFF, ordinary and nonowner projections byte-identical to existing recall', async () => {
    const f = fixture();
    const enrich = async (enabled: boolean, message: string, present: MemoryAudience, openOnly = false) => {
      const recall = new ShannonTurnMemoryRecall(new SemanticMemoryRecall(null, f.store), f.store, null, { temporalKnowledge: enabled });
      recall.watchAudience({ othersKnown: () => false });
      const snapshot = f.store.snapshot('owner');
      const context = prepareTurnCognitiveContext(snapshot, f.store, {
        scopeKey: 'owner', message, occurredAt: now, channel: 'text', present, ...(openOnly ? { openOnly: true } : {}),
      });
      return recall.enrich(context, { scopeKey: 'owner', message, snapshot, memoryTurn: false });
    };
    for (const [message, present, openOnly] of [
      ['写真整理の進め方を教えて', OWNER_AUDIENCE, false], [query, peopleAudience([], true), false], [query, OWNER_AUDIENCE, true],
    ] as const) expect(await enrich(true, message, present, openOnly)).toEqual(await enrich(false, message, present, openOnly));
    expect((await enrich(false, query, OWNER_AUDIENCE)).prompt).not.toContain('Shannon note revision history');
    expect(f.project({ ownerStillAlone: () => false })).toBe('');
    let calls = 0;
    const sources = vi.fn();
    expect(f.project({ ownerStillAlone: () => ++calls === 1, observeSources: sources })).toBe('');
    expect(sources).not.toHaveBeenCalled();
  });

  it('rechecks forgetting, correction and source revocation against current controls', () => {
    const f = fixture();
    const oldSnapshot = f.store.snapshot('owner');
    const control = { memoryId: f.first.id, kind: 'experience' as const, pinned: false, updatedAt: now,
      changeReason: 'owner correction', sourceEvidence: f.first.userMessage };
    f.store.apply('owner', { type: 'memory-control-upserted', control: { ...control, status: 'forgotten' } });
    expect(f.project()).toBe('');
    f.store.apply('owner', { type: 'memory-control-upserted', control: { ...control, status: 'active', overrideText: '訂正後の記憶' } });
    expect(f.project()).toBe('');
    f.store.apply('owner', { type: 'memory-control-upserted', control: { ...control, status: 'active' } });
    expect(f.project()).toContain('superseded');
    expect(oldSnapshot.memoryControls).not.toEqual(f.store.snapshot('owner').memoryControls);
    const readHistory = f.store.readShannonKnowledgeRevisions.bind(f.store);
    const duringRead = vi.spyOn(f.store, 'readShannonKnowledgeRevisions').mockImplementation((scope, id, version) => {
      const rows = readHistory(scope, id, version);
      f.store.apply('owner', { type: 'memory-control-upserted', control: { ...control, status: 'forgotten' } });
      return rows;
    });
    expect(f.project()).toBe('');
    duringRead.mockRestore();
    f.store.apply('owner', { type: 'memory-control-upserted', control: { ...control, status: 'active' } });
    const original = f.store.experiencesById.bind(f.store);
    vi.spyOn(f.store, 'experiencesById').mockImplementation((scope, ids) => original(scope, ids).map(source => ({ ...source,
      ...(source.id === f.first.id ? { readSourceIds: ['aether-note://revoked'] } : {}),
    })));
    f.store.readSourceVisible = () => false;
    expect(f.project()).toBe('');
  });

  it('never links similar titles, absent sources, changed latest versions or retired notes', () => {
    const f = fixture();
    const unrelated = f.store.createShannonKnowledge('owner', f.draft('似た名前だが別ノートの内容。', [f.second.id]), now, 'separate');
    expect(f.project()).not.toContain('別ノートの内容');
    expect(f.project({ documents: [unrelated] })).toBe('');
    const history = vi.spyOn(f.store, 'readShannonKnowledgeRevisions').mockImplementation(() => { throw new Error('unavailable history'); });
    expect(f.project()).toBe('');
    history.mockRestore();
    const original = f.store.experiencesById.bind(f.store);
    const lookup = vi.spyOn(f.store, 'experiencesById').mockImplementation((scope, ids) => original(scope, ids).filter(source => source.id !== f.first.id));
    expect(f.project()).toBe('');
    lookup.mockRestore();
    f.store.updateShannonKnowledge('owner', f.current.id, f.current.version, f.draft('さらに変更された案。', [f.second.id]), now, 'third');
    expect(f.project()).toBe('');
    f.store.retireShannonKnowledge('owner', f.current.id, 'retired', now);
    expect(f.project()).toBe('');
  });

  it('reads at most two old revisions, survives restart, and isolates the owner scope', () => {
    const f = fixture();
    let note = f.current;
    for (let index = 3; index <= 6; index += 1) note = f.store.updateShannonKnowledge('owner', note.id, note.version,
      f.draft(`案${index}。`, [f.second.id]), now, `version${index}`)!;
    const before = f.project({ documents: [note] });
    expect(f.store.readShannonKnowledgeRevisions('owner', note.id, note.version).map(item => item.version)).toEqual([4, 5]);
    expect(before).not.toContain('一枚ずつ扱う旧案');
    expect(before).toContain('"version":6');
    expect(f.store.readShannonKnowledgeRevisions('someone-else', note.id, note.version)).toEqual([]);
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = open(f.path);
    expect(f.project({ store: reopened, documents: [note] })).toBe(before);
  });
});
