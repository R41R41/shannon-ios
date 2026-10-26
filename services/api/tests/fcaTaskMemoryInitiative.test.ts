import { afterEach, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { memoryWorld } from './support/memoryWorld.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';

const worlds: ReturnType<typeof memoryWorld>[] = [];
afterEach(() => worlds.splice(0).forEach(world => world.close()));

/**
 * dragon26 fix 4 (2026-10-26): the owner's 「やめる」 in the mod was refused twice as `turn_not_visible`. The turn had recalled a long thread summary, two of whose
 * messages were her own initiatives (stored with the source `initiative:<id>`, no turn behind them); the lineage walk asked for that "turn" as an experience, found none
 * and called the summary, and every turn, knowledge document and later turn resting on it, invisible.
 */
function world(noteKind: string) {
  const w = memoryWorld(); worlds.push(w);
  const memory = createTaskMemory({ state: w.store, conversations: w.store, ownerScope: 'owner', ownerAlone: () => true, now: w.now });
  w.store.appendTurn('owner', 'thread', 'こんにちは', 'やあ', w.now(), { capturedStateVersion: 0, messageEmotion: { expression: 'neutral', valence: 0, arousal: 0, openness: 0 }, recalledMemoryIds: [] });
  const note = w.store.appendNote('owner', 'thread', '今日の続きの話をしてもいい？', w.now(), noteKind);
  const thread = w.store.listThreads('owner')[0]!.threadId;
  const turn = w.store.appendTurn('owner', 'platform:minecraft:world', '今の作業をやめて', '止めるよ', w.now(), { capturedStateVersion: 0,
    messageEmotion: { expression: 'neutral', valence: 0, arousal: 0, openness: 0 }, recalledMemoryIds: [`thread:${thread}`] });
  return { w, memory, note, turn, thread };
}

it('sees a turn that recalled a thread holding her own initiative message', () => {
  const { memory, note, turn } = world('initiative');
  expect(note.sourceExperienceId).toMatch(/^initiative:/u);
  expect(memory.read('owner', [turn.id], OWNER_AUDIENCE)).toHaveLength(1);
});

it('still closes a thread whose message names a source that is neither a turn nor her initiative', () => {
  const { memory, note, turn } = world('reminder');
  expect(note.sourceExperienceId).toMatch(/^reminder:/u);
  expect(memory.read('owner', [turn.id], OWNER_AUDIENCE)).toHaveLength(0);
});
