import { usableKnowledgeFor } from '../src/mind/recall/turnKnowledgeRecall.js';
import { afterEach, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { memoryWorld } from './support/memoryWorld.js';
import { taskExperienceDraft, taskExperienceId } from '../src/mind/memory/taskExperience.js';
import { memoryWriterOf } from '../src/wiring/memoryOutboxWiring.js';
import { MemoryWithholding } from '../src/mind/memory/memoryVisibility.js';
import { prepareTurnCognitiveContext } from '../src/mind/workspace/contextPorts.js';
const worlds: ReturnType<typeof memoryWorld>[] = [];
afterEach(() => worlds.splice(0).forEach(world => world.close()));
it('ordinary recall, derived knowledge and summaries retain task read-source checks even without forgetting controls', async () => {
  const w = memoryWorld(); worlds.push(w); let visible = true;
  const sourceId = 'aether-document://private-source';
  const record = { scopeKey: 'owner', taskId: 'task', outcomeId: 'result', observedAt: w.now(), status: 'success' as const,
    goal: '望遠鏡の秘密の仕様', context: '', action: '文書を読んだ', prediction: '', observedResult: '望遠鏡の望遠レンズ', interpretation: '', sourceIds: [], readSourceIds: [sourceId] };
  w.ports.proposals.propose(taskExperienceDraft(record));
  const writer = memoryWriterOf(w.store, { now: w.now, owner: 'retained-writer', taskSourceVisible: () => true })!;
  await writer.runOnce(); writer.releaseLease();
  const id = taskExperienceId('owner', 'task', 'result');
  expect(w.store.experiencesById('owner', [id])[0]?.readSourceIds).toEqual([sourceId]);
  const recall = () => prepareTurnCognitiveContext(w.store.snapshot('owner'), w.store, { scopeKey: 'owner', message: '望遠鏡', occurredAt: w.now(), channel: 'text', present: OWNER_AUDIENCE });
  expect(recall().memories.some(item => item.id === id)).toBe(false); // An unconfigured worker cannot reveal it.
  w.store.readSourceVisible = (_scope, ref) => ref === sourceId && visible;
  expect(recall().memories.some(item => item.id === id)).toBe(true);
  w.store.appendTurn('owner', 'thread', 'それについて', '分かった', w.now(), { capturedStateVersion: 0,
    messageEmotion: { expression: 'neutral', valence: 0, arousal: 0, openness: 0 }, recalledMemoryIds: [id] });
  const knowledge = w.store.createShannonKnowledge('owner', { title: '望遠鏡の知識', bodyMarkdown: '## 観測\n結果', applicability: '比較するとき', status: 'hypothesis', sourceExperienceIds: [id] }, w.now(), '整理');
  visible = false;
  const withholding = new MemoryWithholding(w.store.snapshot('owner'), w.store, 'owner');
  expect(withholding.inactive).toBe(true);
  expect(withholding.withholdsKnowledge(knowledge)).toBe(true);
  expect(usableKnowledgeFor(w.store, 'owner', w.store.snapshot('owner')).map(item => item.id)).not.toContain(knowledge.id);
  expect(withholding.withholdsThreadSummary('thread')).toBe(true);
  expect(withholding.withholdsReplaySummary('thread', { summary: '意味だけを残した要約', chainStartedAt: w.now(), updatedAt: w.now() })).toBe(true);
  expect(recall().memories.some(item => item.id === id)).toBe(false);
  visible = true; expect(recall().memories.some(item => item.id === id)).toBe(true);
});
