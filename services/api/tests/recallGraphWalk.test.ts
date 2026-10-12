import { afterEach, describe, expect, it } from 'vitest';
import { memoryWorld } from './support/memoryWorld.js';
import { MemoryWithholding } from '../src/mind/memory/memoryVisibility.js';
import { prepareTurnCognitiveContext } from '../src/mind/workspace/turnCognitiveContext.js';
import { conversationFcaProvenance } from '../src/mind/action/fca/fcaConversationSources.js';
import { OWNER_AUDIENCE } from '@shannon/cognition';

/**
 * 2026-10-13: `event loop blocked process=api ms=2203` and `ms=4851` while research ran in a call. Each research step builds its
 * recall context, which asks of every remembered turn whether a forgotten memory reached it through what it recalled. With turns
 * that recall ~36 others each, that walk was repeated per turn and per recalling time: 10 s for one step on this world.
 */
const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };
const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

function denseWorld(turns = 855, recalled = 36) {
  const world = memoryWorld(); closes.push(world.close);
  const ids: string[] = [];
  for (let index = 0; index < turns; index++) {
    world.advance(60_000);
    const recall = ids.length ? Array.from({ length: Math.min(recalled, ids.length) }, (_, k) => ids[(index * 7 + k * 13) % ids.length]!) : [];
    ids.push(world.store.appendTurn('owner', `thread-${index % 3}`, `質問${index}${String.fromCharCode(0x4e00 + index)}${'あ'.repeat(120)}`,
      `返答${index}${String.fromCharCode(0x5000 + index)}${'い'.repeat(160)}`, world.now(),
      { capturedStateVersion: 0, messageEmotion: emotion, recalledMemoryIds: recall }).id);
  }
  // An early turn forgotten: much of what came later recalled it, directly or through another turn.
  world.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: ids[40]!, kind: 'experience', status: 'forgotten',
    pinned: false, updatedAt: world.now(), changeReason: 'owner' } });
  return { world, ids };
}
const elapsed = (work: () => unknown) => { const started = performance.now(); work(); return performance.now() - started; };

describe('the recall graph is walked once per read', () => {
  it('builds a research step\'s recall context and a turn\'s provenance on a densely recalled world without a long block', () => {
    const { world } = denseWorld();
    const snapshot = world.store.snapshot('owner');
    const input = { scopeKey: 'owner', message: '太宰府の由来', occurredAt: world.now(), channel: 'system' as const, present: OWNER_AUDIENCE };
    expect(elapsed(() => prepareTurnCognitiveContext(snapshot, world.store, input))).toBeLessThan(2_000);
    expect(elapsed(() => conversationFcaProvenance(snapshot, world.store, 'owner', 'thread-0', []))).toBeLessThan(2_000);
  }, 120_000);

  it('gives the same verdicts in one shared walk as turn by turn', () => {
    const { world } = denseWorld(240, 12);
    const snapshot = world.store.snapshot('owner'), candidates = world.store.experienceCandidates('owner');
    const shared = new MemoryWithholding(snapshot, world.store, 'owner', candidates);
    const together = shared.withReadSnapshot(() => candidates.map(item => shared.withholdsExperience(item)));
    const alone = candidates.map(item => new MemoryWithholding(snapshot, world.store, 'owner', candidates).withholdsExperience(item));
    expect(together).toEqual(alone);
    expect(together.filter(Boolean).length).toBeGreaterThan(1);
    expect(together.filter(value => !value).length).toBeGreaterThan(1);
  }, 120_000);
});
