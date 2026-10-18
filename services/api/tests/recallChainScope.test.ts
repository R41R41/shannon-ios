import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepChains, MAXIMUM_WALK_DEPTH, deepWalk, settleDeepChains } from '../src/mind/memory/recallChainDepth.js';
import { InMemoryCompanionStateStore, OWNER_AUDIENCE } from '@shannon/cognition';
import type { ConversationStore, ShannonExperience } from '../src/mind/memory/conversationContract.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { chain, quietWarnings } from './support/recallChainFixture.js';

/**
 * A chain past the walks' bound is found once per query scope (one synchronous read), not once per call: the answer is the cautious
 * one at every turn that leads into it, and it is logged once, in closed words.
 */
afterEach(() => { vi.restoreAllMocks(); });

describe('a chain past the bound is found once per query scope', () => {
  const edges = new Map<string, string[]>(); for (let i = 1; i <= 12_000; i += 1) edges.set(`n${i}`, [`n${i - 1}`]);

  it('is not searched again for a node it was found below', () => {
    let asked = 0;
    const kids = (id: string) => { asked += 1; return edges.get(id) ?? []; };
    const chains = new DeepChains('test'), warn = quietWarnings();
    expect(settleDeepChains(['n9000'], kids, () => {}, undefined, undefined, chains)).toBe('too_deep');
    expect(asked).toBeGreaterThan(4000);
    for (const tip of ['n9000', 'n9001', 'n9002', 'n9100']) {
      asked = 0;
      expect(settleDeepChains([tip], kids, () => {}, undefined, undefined, chains), tip).toBe('too_deep');
      expect(asked, tip).toBeLessThan(120);
    }
    // What is not past the bound is still settled: n4000 starts a chain of 4,001 nodes, which the first search went through.
    expect(settleDeepChains(['n4000'], kids, () => {}, undefined, undefined, chains)).toBe('ok');
    expect(warn).toHaveBeenCalledTimes(1); // five searches ended too deep; the scope logs the first only
  });

  it('skips the walk that would overflow again, for a root already found too deep', () => {
    const chains = new DeepChains('test'); let walks = 0, settles = 0;
    chains.note('r', MAXIMUM_WALK_DEPTH + 1);
    expect(deepWalk(() => { walks += 1; return false; }, () => { settles += 1; return 'ok'; }, true, chains, 'r')).toBe(true);
    expect([walks, settles]).toEqual([0, 0]);
    chains.reset();
    expect(deepWalk(() => { walks += 1; return false; }, () => 'ok', true, chains, 'r')).toBe(false);
    expect(walks).toBe(1);
  });

  it('logs once per query scope, in closed words, and not at all for a chain that is judged', () => {
    const warn = quietWarnings();
    const f = chain(MAXIMUM_WALK_DEPTH + 200);
    const withholding = f.reader();
    const tips = [199, 198, 197, 196, 195].map(back => `episode-${MAXIMUM_WALK_DEPTH + back}`);
    withholding.withReadSnapshot(() => { for (const tip of tips) expect(f.reply(tip, withholding)).toBe(true); });
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual(['Shannon recall chain too deep walk=recalled links>5000']);
    withholding.withReadSnapshot(() => { for (const tip of tips) expect(f.reply(tip, withholding)).toBe(true); });
    expect(warn).toHaveBeenCalledTimes(2); // the next scope starts afresh
    warn.mockClear();
    const short = chain(3000);
    expect(short.reply()).toBe(false); expect(short.message()).toBe(false); expect(short.task()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs each walk once per scope (read, recalled), and answers every tip cautiously', () => {
    const warn = quietWarnings();
    const f = chain(MAXIMUM_WALK_DEPTH + 200);
    expect([f.message(), f.message('episode-5190'), f.message('episode-5191')]).toEqual([true, true, true]);
    const lines = warn.mock.calls.map(call => String(call[0]));
    expect(lines).toEqual(Array(3).fill('Shannon recall chain too deep walk=read links>5000')); // three scopes, one per withholding
    expect(f.task()).toBe(0);
    expect(warn.mock.calls.slice(3).map(call => String(call[0])).every(line => /^Shannon recall chain too deep walk=\w+ links>5000$/u.test(line))).toBe(true);
  });

  /** A chain through thread summaries: only the walk of a task memory's lineage follows it (the others stop at a thread). */
  function threadChain(links: number) {
    const rows = new Map<string, ShannonExperience>();
    for (let index = 0; index < links; index += 1) {
      rows.set(`turn-${index}`, { id: `turn-${index}`, observedAt: `2026-10-09T00:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:00.000Z`, summary: `chat ${index}`, userMessage: 'hello', shannonReply: 'hi',
        ...(index ? { recalledMemoryIds: [`thread:t${index - 1}`] } : {}) });
    }
    const observedAt = '2026-10-10T00:00:00.000Z', state = new InMemoryCompanionStateStore(() => observedAt);
    const store = {
      experienceCandidates: () => [...rows.values()],
      experiencesById: (_scope: string, ids: readonly string[]) => ids.flatMap(id => rows.has(id) ? [rows.get(id)!] : []),
      threadSummaryLineage: (_scope: string, thread: string) => ({ messages: [{ id: `m-${thread}`, sourceExperienceId: `turn-${thread.slice(1)}`, role: 'assistant' as const, content: 'x', observedAt }], updatedAt: observedAt }),
      hasReadSourceProvenance: () => false,
    } as unknown as ConversationStore;
    return () => createTaskMemory({ state, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => observedAt })
      .read('owner', [`turn-${links - 1}`], OWNER_AUDIENCE).length;
  }

  it('logs the lineage walk once, and judges a chain of threads that is not past the bound as a short one', () => {
    const warn = quietWarnings();
    expect(threadChain(1400)()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    expect(threadChain(2600)()).toBe(0); // 2 x 2600 nodes: past the bound, answered cautiously
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual(['Shannon recall chain too deep walk=lineage links>5000']);
  });
});