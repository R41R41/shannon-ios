import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore, OWNER_AUDIENCE } from '@shannon/cognition';
import type { ConversationStore } from '../src/mind/memory/conversationContract.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { createFcaReadSources } from '../src/wiring/fcaReadSources.js';
import { chain } from './support/recallChainFixture.js';

/**
 * A read check that runs the stack out by itself (a reader that recurses without end). 5e086d7 answered such a check "not visible"
 * (the reader caught it), so the turn's memory was withheld and nothing failed. The long-chain fix lets an overflow go up to the walk,
 * which settles the chain and asks again: when the check overflows again that must be the same cautious answer, never a RangeError.
 */
const burn = (frames: number): number => frames ? burn(frames - 1) + 1 : 0;
const at = '2026-10-09T00:00:00.000Z';

describe('a read check that itself runs the stack out', () => {
  for (const depth of [1, 3, 40, 150, 250, 1500]) {
    it(`withholds as it always did, for a chain of ${depth}, and fails nothing`, () => {
      const f = chain(depth, {
        reads: () => 'shannon-skill://s1',
        reader: (store, state) => createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state, conversations: store,
          skill: () => { burn(1e8); return { body: 'skill' }; } }),
      });
      expect(f.reply()).toBe(true);
      expect(f.message()).toBe(true);
      expect(f.thread()).toBe(true);
      expect(f.task()).toBe(0);
    });
  }

  it('is "not visible" for the native reader asked outside every walk, as before', () => {
    let reader: ConversationStore['readSourceVisible'];
    chain(1, { reads: () => 'shannon-skill://s1', reader: (store, state) => reader = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state,
      conversations: store, skill: () => { burn(1e8); return { body: 'skill' }; } }) });
    expect(reader!('owner', 'shannon-skill://s1', at)).toBe(false);
  });

  const overflowing = () => { throw new RangeError('Maximum call stack size exceeded'); };

  it('is withheld, not a crash, for a reader that throws it at the experience check and the task knowledge check', () => {
    const f = chain(2, { reader: () => overflowing });
    const row = { id: 'episode-0', summary: 'chat 0' };
    expect(f.reader().withholdsExperience(row)).toBe(true);
    // Other errors are not swallowed.
    const broken = chain(2, { reader: () => () => { throw new TypeError('broken'); } });
    expect(() => broken.reader().withholdsExperience(row)).toThrow(TypeError);
    const knowledge = (visible: ConversationStore['readSourceVisible']) => {
      const state = new InMemoryCompanionStateStore(() => at);
      const store = { experienceCandidates: () => [], experiencesById: () => [], hasReadSourceProvenance: () => true, threadSummaryLineage: () => undefined } as unknown as ConversationStore;
      const document = { id: 'k1', title: 'title', bodyMarkdown: 'body', updatedAt: at, applicability: 'always', sourceExperienceIds: [],
        aetherReferences: [{ documentId: 'd1' }] };
      return createTaskMemory({ state, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => at, readSourceVisible: visible,
        knowledge: { listShannonKnowledge: () => [document] } as never }).read('owner', ['knowledge:k1'], OWNER_AUDIENCE).length;
    };
    expect(knowledge(() => true)).toBe(1);
    expect(knowledge(overflowing)).toBe(0);
  });
});
