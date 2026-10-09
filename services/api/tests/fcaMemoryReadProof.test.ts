import { afterEach, expect, it, vi } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { memoryWorld } from './support/memoryWorld.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { MemoryWithholding, visibleReplayMessages } from '../src/mind/memory/memoryVisibility.js';
import { taskExperienceDraft, taskExperienceId } from '../src/mind/memory/taskExperience.js';
import { memoryWriterOf } from '../src/wiring/memoryOutboxWiring.js';

const worlds: ReturnType<typeof memoryWorld>[] = [];
afterEach(() => worlds.splice(0).forEach(world => world.close()));

it('proves ordinary replay needs no provenance rows, then freshly detects a task written after that proof and after reopening with FCA off', async () => {
  const w = memoryWorld(); worlds.push(w); let visible = true;
  w.store.readSourceVisible = () => visible;
  for (let index = 0; index < 220; index += 1) w.store.appendTurn('owner', 'thread', `観測 ${index}`, `記録 ${index}`, w.now());
  expect(w.store.hasReadSourceProvenance('owner')).toBe(false);
  const rows = vi.spyOn(w.store, 'experiencesById'), lineage = vi.spyOn(w.store, 'threadSummaryLineage');
  const reader = new MemoryWithholding(w.store.snapshot('owner'), w.store, 'owner');
  expect(reader.withholdsThreadSummary('thread')).toBe(false);
  expect(reader.withholdsReplaySummary('thread', { summary: '観測の要約', chainStartedAt: w.now(), updatedAt: w.now() })).toBe(false);
  expect(visibleReplayMessages(w.store.snapshot('owner'), w.store, 'owner', 'thread', OWNER_AUDIENCE, 400).messages).toHaveLength(400);
  expect(rows).not.toHaveBeenCalled(); expect(lineage).not.toHaveBeenCalled();

  w.ports.proposals.propose(taskExperienceDraft({ scopeKey: 'owner', taskId: 'new-task', outcomeId: 'result', observedAt: w.now(), status: 'success',
    goal: '秘密の資料の調査', context: '', action: '資料を読んだ', prediction: '', observedResult: '確認した', interpretation: '',
    sourceIds: [], readSourceIds: ['aether-document://private-source'] }));
  const writer = memoryWriterOf(w.store, { now: w.now, owner: 'proof-writer', taskSourceVisible: () => true })!;
  await writer.runOnce(); writer.releaseLease();
  expect(w.store.hasReadSourceProvenance('owner')).toBe(true); expect(w.store.hasReadSourceProvenance('other')).toBe(false);
  const id = taskExperienceId('owner', 'new-task', 'result');
  w.store.appendTurn('owner', 'thread', 'それについて', '意味だけを残した説明', w.now(), { capturedStateVersion: 0,
    messageEmotion: { expression: 'neutral', valence: 0, arousal: 0, openness: 0 }, recalledMemoryIds: [id] });
  visible = false; expect(reader.withholdsThreadSummary('thread')).toBe(true);
  visible = true; expect(reader.withholdsThreadSummary('thread')).toBe(false);

  // No FCA runtime or private-source resolver is configured on this reopened ordinary conversation store.
  const reopened = new SQLiteShannonStore({ path: w.path, now: w.now, moodHistory: null });
  try {
    expect(reopened.hasReadSourceProvenance('owner')).toBe(true);
    expect(new MemoryWithholding(reopened.snapshot('owner'), reopened, 'owner').withholdsThreadSummary('thread')).toBe(true);
    expect(visibleReplayMessages(reopened.snapshot('owner'), reopened, 'owner', 'thread', OWNER_AUDIENCE, 400).messages
      .some(entry => entry.message.content === '意味だけを残した説明')).toBe(false);
  } finally { reopened.close(); }
});
