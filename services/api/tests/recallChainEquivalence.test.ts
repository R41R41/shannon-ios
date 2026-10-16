import { describe, expect, it, vi } from 'vitest';
import { InMemoryCompanionStateStore, OWNER_AUDIENCE } from '@shannon/cognition';
import type { ConversationStore, ShannonExperience } from '../src/mind/memory/conversationContract.js';
import { MemoryWithholding } from '../src/mind/memory/memoryVisibility.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';

/**
 * `force.on` makes every walk behave as if it had overflowed the stack: the nodes are settled (all of them, children first) and the
 * walk runs again on their memo. Off, the walks are exactly as they ship. The same graphs are judged both ways and by an oracle that
 * never recurses, so the settled answer is shown to be the recursive one.
 */
const force = vi.hoisted(() => ({ on: false }));
vi.mock('../src/mind/memory/recallChainDepth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/mind/memory/recallChainDepth.js')>();
  return {
    ...actual,
    deepWalk: <T>(walk: () => T, settle: () => 'ok' | 'too_deep', cautious: T): T =>
      force.on ? (settle() === 'too_deep' ? cautious : walk()) : actual.deepWalk(walk, settle, cautious),
    settleDeepChains: (roots: readonly string[], children: (id: string) => readonly string[], warm: (id: string) => void, maximum?: number) =>
      actual.settleDeepChains(roots, children, warm, maximum, force.on ? 0 : undefined),
  };
});

const at = '2026-10-09T00:00:00.000Z';
const time = (index: number) => new Date(Date.parse(at) + index * 1000).toISOString();

function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Graph { recalled: number[][]; sources: (string | undefined)[]; hidden: ReadonlySet<string> }

/** Turn `i` recalls earlier turns (usually `i - 1`, plus some further back) and some turns read one of a few sources. */
function graph(seed: number, size: number, options: { reach: number; cycle?: boolean; readRate?: number; chain?: number }): Graph {
  const next = random(seed);
  const recalled: number[][] = [], sources: (string | undefined)[] = [];
  for (let index = 0; index < size; index += 1) {
    const edges = new Set<number>();
    if (index && next() < (options.chain ?? 0.85)) edges.add(index - 1);
    for (let extra = Math.floor(next() * 3); extra > 0 && index; extra -= 1) edges.add(Math.max(0, index - 1 - Math.floor(next() * options.reach)));
    recalled.push([...edges]);
    sources.push(next() < (options.readRate ?? 0.06) ? `aether-document://s${Math.floor(next() * 5)}` : undefined);
  }
  if (options.cycle) { const from = Math.floor(next() * size); recalled[from]!.push(Math.min(size - 1, from + 1 + Math.floor(next() * 6))); }
  const hidden = new Set<string>(); for (let source = 0; source < 5; source += 1) if (next() < 0.35) hidden.add(`aether-document://s${source}`);
  return { recalled, sources, hidden };
}

function judge(g: Graph, root: number) {
  const rows = new Map<string, ShannonExperience>();
  g.recalled.forEach((edges, index) => rows.set(`episode-${index}`, { id: `episode-${index}`, observedAt: time(index), summary: `chat ${index}`, userMessage: 'hello', shannonReply: 'hi',
    ...(g.sources[index] ? { readSourceIds: [g.sources[index]!] } : {}), ...(edges.length ? { recalledMemoryIds: edges.map(edge => `episode-${edge}`) } : {}) }));
  const id = `episode-${root}`, observedAt = time(g.recalled.length);
  const state = new InMemoryCompanionStateStore(() => observedAt);
  const store = {
    experienceCandidates: () => [...rows.values()],
    experiencesById: (_scope: string, ids: readonly string[]) => ids.flatMap(row => rows.has(row) ? [rows.get(row)!] : []),
    threadSummaryLineage: () => ({ messages: [{ id: 'message', sourceExperienceId: id, role: 'assistant' as const, content: 'summary', observedAt, recalledMemoryIds: [id] }], updatedAt: observedAt }),
    readSourceVisible: (_scope: string, source: string) => !g.hidden.has(source),
    hasReadSourceProvenance: () => true,
  } as unknown as ConversationStore;
  const reader = () => new MemoryWithholding(state.snapshot('owner'), store, 'owner');
  return {
    reply: reader().withholdsReply({ text: 'x', observedAt, recalledMemoryIds: [id] }),
    thread: reader().withholdsThreadSummary('thread'),
    task: createTaskMemory({ state, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => observedAt,
      readSourceVisible: store.readSourceVisible }).read('owner', [id], OWNER_AUDIENCE).length,
  };
}

/** Whether a turn, or any turn below it, read a source that is no longer available: found by walking with a list, not by recursion. */
function oracleUnavailable(g: Graph, root: number): boolean {
  const done = new Set<number>(), todo = [root];
  while (todo.length) {
    const index = todo.pop()!; if (done.has(index)) continue; done.add(index);
    const source = g.sources[index]; if (source && g.hidden.has(source)) return true;
    todo.push(...g.recalled[index]!);
  }
  return false;
}
function reachesCycle(g: Graph, root: number): boolean {
  const state = new Map<number, 1 | 2>(), stack: { index: number; next: number }[] = [{ index: root, next: 0 }]; state.set(root, 1);
  while (stack.length) {
    const top = stack[stack.length - 1]!, edges = g.recalled[top.index]!;
    if (top.next >= edges.length) { state.set(top.index, 2); stack.pop(); continue; }
    const child = edges[top.next++]!, seen = state.get(child);
    if (seen === 1) return true;
    if (!seen) { state.set(child, 1); stack.push({ index: child, next: 0 }); }
  }
  return false;
}
function both(g: Graph, root: number) {
  force.on = false; const plain = judge(g, root);
  force.on = true; try { return { plain, settled: judge(g, root) }; } finally { force.on = false; }
}

describe('settling a recall chain from its far end answers as the recursive walk does', () => {
  it('on random acyclic graphs of every small size', () => {
    let withheld = 0, kept = 0;
    for (let trial = 0; trial < 120; trial += 1) {
      const size = 1 + (trial * 7) % 130, g = graph(1000 + trial, size, { reach: 1 + trial % 40, readRate: trial % 3 ? 0.06 : 0.02 });
      for (const root of [size - 1, Math.floor(size / 2), 0]) {
        const { plain, settled } = both(g, root), unavailable = oracleUnavailable(g, root);
        expect(settled, `trial ${trial} root ${root}`).toEqual(plain);
        expect(plain, `trial ${trial} root ${root}`).toEqual({ reply: unavailable, thread: unavailable, task: unavailable ? 0 : 1 });
        if (unavailable) withheld += 1; else kept += 1;
      }
    }
    expect(withheld).toBeGreaterThan(30); expect(kept).toBeGreaterThan(30); // both outcomes were exercised
  });

  it('on random graphs that have a cycle, where both answer cautiously', () => {
    let cyclic = 0;
    for (let trial = 0; trial < 80; trial += 1) {
      const size = 3 + (trial * 5) % 60, g = graph(5000 + trial, size, { reach: 1 + trial % 10, cycle: true });
      const root = size - 1, { plain, settled } = both(g, root);
      expect(settled, `trial ${trial}`).toEqual(plain);
      if (reachesCycle(g, root)) { cyclic += 1; expect(plain.reply).toBe(true); expect(plain.task).toBe(0); }
    }
    expect(cyclic).toBeGreaterThan(10);
  });

  it('on long random chains, where the recursion itself would overflow', () => {
    force.on = false;
    for (const [seed, size] of [[1, 2600], [2, 3400], [3, 4200], [4, 4800]] as const) {
      // Nothing read except, in the second and third graph, the first turn: a source that is still there, and one that is gone.
      for (const [name, first] of [['nothing read', undefined], ['source kept', 'aether-document://s9'], ['source gone', 'aether-document://s8']] as const) {
        const base = graph(seed, size, { reach: 30, readRate: 0, chain: 1 }), g: Graph = { ...base, sources: base.sources.map((_, index) => index ? undefined : first), hidden: new Set(['aether-document://s8']) };
        const root = size - 1, unavailable = oracleUnavailable(g, root);
        expect(unavailable).toBe(name === 'source gone');
        expect(judge(g, root), `seed ${seed} ${name}`).toEqual({ reply: unavailable, thread: unavailable, task: unavailable ? 0 : 1 });
      }
    }
  });

  it('does not throw on chains of 5,000 turns and more, and answers cautiously once the walks\' own bound is passed', () => {
    force.on = false;
    // The bound is on the length of a walk's path, which differs by a few turns between the walks (a thread summary starts one further
    // up), so right at 5,000 either answer is correct; only that it answers is held. Well past it, the answer is the cautious one.
    for (const size of [4999, 5000, 5001, 5200, 6500]) {
      const g: Graph = { recalled: Array.from({ length: size }, (_, index) => index ? [index - 1] : []), sources: Array.from({ length: size }, () => undefined), hidden: new Set() };
      let answer: ReturnType<typeof judge> | undefined;
      expect(() => { answer = judge(g, size - 1); }, `size ${size}`).not.toThrow();
      if (size >= 5200) expect(answer).toEqual({ reply: true, thread: true, task: 0 });
    }
  });
});
