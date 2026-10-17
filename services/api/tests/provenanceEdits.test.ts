import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { provenanceEdits } from '../src/mind/memory/provenanceEdits.js';
import { SQLiteTouchExperiences } from '../src/mind/memory/store/bodyTouchMemory.js';
import { TASK_EXPERIENCE_DISCLOSURE, type TaskExperienceRecord } from '../src/mind/memory/taskExperience.js';
import { insertVoiceSummary, removeVoiceSummaries } from '../src/mind/memory/store/sqliteVoiceSummaries.js';
import { ensureVoiceSummarySchema } from '../src/mind/memory/store/voiceSummaryMigration.js';
import { ensureReplayEpochSchema } from '../src/mind/memory/store/sqliteReplayEpochs.js';
import { memoryWorld } from './support/memoryWorld.js';

/**
 * The FCA source guard trusts a walked base for 30 s only while `provenanceEdits()` is unchanged (`fcaConversationSources.ts`). These
 * run the REAL writers that change what a remembered id stands for without a companion-state version, so that removing a call to
 * `noteProvenanceEdit` from any of them fails here, and that a plain insert (which changes no id already walked) does not count.
 */
const worlds: ReturnType<typeof memoryWorld>[] = [];
afterEach(() => worlds.splice(0).forEach(world => world.close()));
const bumped = (work: () => unknown) => { const before = provenanceEdits(); work(); return provenanceEdits() - before; };

describe('the writers that edit a remembered id in place', () => {
  it('a task experience: the first write is an insert, the rewrite of the unobserved one (sources added) is an edit', () => {
    const w = memoryWorld(); worlds.push(w);
    const writer = w.store.taskExperiences();
    const record = (status: TaskExperienceRecord['status'], sourceIds: string[], readSourceIds: string[]): TaskExperienceRecord => ({ scopeKey: 'owner', taskId: 't', outcomeId: 'o',
      observedAt: w.now(), status, goal: '目的', context: '', action: '行動', prediction: '予測', observedResult: '', interpretation: '', sourceIds, readSourceIds });
    expect(bumped(() => expect(writer.write('owner', record('unobserved', ['a'], ['doc-1']))).toBe(true))).toBe(0);
    expect(bumped(() => expect(writer.write('owner', record('success', ['b'], ['doc-2']))).toBe(true))).toBe(1);
    // A write that changes nothing (it is refused: the row is no longer unobserved) is no edit either.
    expect(bumped(() => expect(writer.write('owner', record('failure', ['c'], []))).toBe(false))).toBe(0);
  });

  it('a body touch: the first write inserts, a later write of the same burst rewrites it in place', () => {
    const w = memoryWorld(); worlds.push(w);
    const touches = new SQLiteTouchExperiences(w.path);
    try {
      const experience = (summary: string) => ({ id: 'burst-1', observedAt: w.now(), summary, shannonReply: '', disclosure: TASK_EXPERIENCE_DISCLOSURE,
        touch: { type: 'pat', count: 1, totalDurationMs: 100, lastAt: w.now(), others: false } });
      expect(bumped(() => expect(touches.write('owner', experience('体の記憶: 一度'))).toBe(true))).toBe(0);
      expect(bumped(() => expect(touches.write('owner', experience('体の記憶: 何度も'))).toBe(true))).toBe(1);
    } finally { touches.close(); }
  });

  it('a knowledge document: creating is no edit; growing its sources and retiring it are', () => {
    const w = memoryWorld(); worlds.push(w);
    const draft = (sources: string[]) => ({ title: '手順', bodyMarkdown: '## 手順\n確かめる', applicability: '調べるとき', status: 'hypothesis' as const, sourceExperienceIds: sources });
    let id = '';
    expect(bumped(() => { id = w.store.createShannonKnowledge('owner', draft(['x']), w.now(), '作成').id; })).toBe(0);
    expect(bumped(() => expect(w.store.updateShannonKnowledge('owner', id, 1, draft(['x', 'y']), w.now(), '更新')).not.toBeNull())).toBe(1);
    expect(bumped(() => expect(w.store.retireShannonKnowledge('owner', id, '統合済み', w.now(), ['z'])).not.toBeNull())).toBe(1);
  });

  it('a voice summary: inserting a version (dropping the others) and removing versions are edits; removing none is not', () => {
    const database = new DatabaseSync(':memory:');
    try {
      ensureReplayEpochSchema(database);
      ensureVoiceSummarySchema(database);
      const record = { version: 1, summary: '話題: 合成', coversFromMessageId: 'a', coveredThroughMessageId: 'b', chainStartedAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' };
      expect(bumped(() => insertVoiceSummary(database, 'owner', 'thread', record, []))).toBe(1);
      expect(bumped(() => insertVoiceSummary(database, 'owner', 'thread', { ...record, version: 2 }, [1]))).toBe(1);
      expect(bumped(() => removeVoiceSummaries(database, 'owner', 'thread', [1]))).toBe(1);
      expect(bumped(() => removeVoiceSummaries(database, 'owner', 'thread', []))).toBe(0);
    } finally { database.close(); }
  });
});
