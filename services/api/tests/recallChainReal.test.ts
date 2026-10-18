import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAXIMUM_WALK_DEPTH, isStackOverflow, settleDeepChains } from '../src/mind/memory/recallChainDepth.js';
import { createFcaReadSources } from '../src/wiring/fcaReadSources.js';
import type { ConversationStore } from '../src/mind/memory/conversationContract.js';
import { chain, quietWarnings, type ChainOptions } from './support/recallChainFixture.js';

/**
 * Second round on the long-recall-chain overflow (2026-10-19), with the stack really running out (nothing is mocked): a stack
 * overflow that lands inside a read-receipt check must reach the walk that settles the chain (the production reader answered
 * `false`, "not visible", for any error, and the walks remembered that), and the walks' own bound is held to the turn.
 */
afterEach(() => { vi.restoreAllMocks(); });
const at = '2026-10-09T00:00:00.000Z';
/** A recursion that needs `frames` more stack: it overflows exactly when a walk has gone deep enough that this no longer fits. */
const burn = (frames: number): number => frames ? burn(frames - 1) + 1 : 0;
const pad = <T>(frames: number, work: () => T): T => frames ? pad(frames - 1, work) : work();

describe('isStackOverflow', () => {
  it('knows the stack running out, whichever way V8 reports it', () => {
    expect(isStackOverflow(new RangeError('Maximum call stack size exceeded'))).toBe(true);
    expect(isStackOverflow(new SyntaxError('Invalid regular expression: /^(a|b)$/u: Stack overflow'))).toBe(true);
    for (const other of [new TypeError('Maximum call stack size exceeded'), new RangeError('Invalid array length'), new SyntaxError('Unexpected token'),
      new Error('call stack'), 'Maximum call stack size exceeded', null, undefined, 3, {}]) expect(isStackOverflow(other)).toBe(false);
  });

  it('knows the errors that a really exhausted stack raises, in a recursion and in a regular expression', () => {
    const found = new Map<string, number>();
    const look = (work: (n: number) => unknown) => {
      // What `work` raises inside a catch block at the end of the stack (where the reader's own checks run when a walk overflows).
      const errors: unknown[] = [];
      for (let frames = 0; frames < 300; frames += 1) {
        let asked = 0;
        // Every frame that unwinds asks again, with a little more stack than the one below it had.
        try { pad(frames, () => { const recurse = (): number => { try { return 1 + recurse(); } catch (error) { if (asked < 40) { asked += 1; try { work(frames); } catch (inner) { errors.push(inner); } } throw error; } }; return recurse(); }); } catch { /* the overflow itself */ }
      }
      for (const error of errors) {
        const kind = `${(error as Error).name}`;
        found.set(kind, (found.get(kind) ?? 0) + 1);
        expect(isStackOverflow(error), `${kind}: ${(error as Error).message}`).toBe(true);
      }
    };
    const receipt = /^(aether-document|notion-page):\/\/(.+)$/u;
    look(() => receipt.exec('aether-document://x'));
    look(() => burn(1e6));
    expect(found.get('RangeError') ?? 0, JSON.stringify([...found])).toBeGreaterThan(0);
    // (A regular expression with no stack left to compile is reported as a SyntaxError on some runs; whatever V8 raised is recognized.)
  });
});

describe('a stack overflow inside a read-receipt check', () => {
  // A skill reader that needs stack of its own (a deep search of the skill store, say): a walk that is deep enough leaves it too
  // little, and it overflows inside the receipt check, whose catch-all answered `false` (not visible) and was remembered for the
  // receipt. The answer must be the one a chain of a few turns gets: the skill is there, nothing is withheld.
  const readers: Record<string, () => { body: string }> = {
    'a RangeError': () => { burn(2500); return { body: 'skill' }; },
    'a larger RangeError': () => { burn(4000); return { body: 'skill' }; },
    // V8 reports a regular expression that has no stack left to run like this (the receipt is parsed with some)
    'a regular expression with no stack left': () => {
      try { burn(2500); } catch { throw new SyntaxError('Invalid regular expression: /^(aether-document|notion-page):\\/\\/(.+)$/u: Stack overflow'); }
      return { body: 'skill' };
    },
  };
  for (const [name, skill] of Object.entries(readers)) {
    it(`reaches the walk that settles the chain when the production reader overflows with ${name}`, () => {
      const reader: ChainOptions['reader'] = (store, state) => createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state, conversations: store, skill });
      const reads = (index: number) => index % 7 === 0 ? `shannon-skill://skill-${index}` : undefined;
      for (const phase of [0, 3]) {
        const f = chain(3500 + phase, { reads: index => reads(index + phase), reader });
        expect([f.reply(), f.message(), f.thread(), f.task()], `phase ${phase}`).toEqual([false, false, false, 1]);
      }
      const few = chain(40, { reads, reader });
      expect([few.reply(), few.message(), few.thread(), few.task()]).toEqual([false, false, false, 1]);
    });
  }

  it('still finds a document that is gone, at any depth', () => {
    const gone = chain(4200, { reads: index => index % 7 === 0 ? `aether-document://doc-${index}` : undefined,
      reader: (store, state) => createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state, conversations: store, aetherAvailable: () => false }) });
    expect([gone.reply(), gone.message(), gone.task()]).toEqual([true, true, 0]);
  });

  it('is still "not visible" for any other error, and out of a walk an overflow is raised, not answered', () => {
    const throwing = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state: { snapshot: () => { throw new TypeError('broken'); } }, conversations: {} as ConversationStore });
    expect(throwing('owner', 'aether-document://x', at)).toBe(false);
    const overflowing = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state: { snapshot: () => { burn(1e7); throw new Error('unreachable'); } }, conversations: {} as ConversationStore });
    expect(() => overflowing('owner', 'aether-document://x', at)).toThrow(RangeError);
  });
});

describe('the walks\' own bound, exactly', () => {
  // A walk cuts a node that has MAXIMUM_WALK_DEPTH nodes above it on its path: a chain of that many turns is judged, one more is not.
  for (const depth of [MAXIMUM_WALK_DEPTH - 1, MAXIMUM_WALK_DEPTH]) {
    it(`judges a chain of ${depth} turns as a short one, visible or gone`, () => {
      const f = chain(depth);
      expect([f.reply(), f.message(), f.thread(), f.task()]).toEqual([false, false, false, 1]);
      const gone = chain(depth, { visible: false });
      expect([gone.reply(), gone.message(), gone.thread(), gone.task()]).toEqual([true, true, true, 0]);
    });
  }
  it(`answers a chain of ${MAXIMUM_WALK_DEPTH + 1} turns with the cautious result`, () => {
    quietWarnings();
    const f = chain(MAXIMUM_WALK_DEPTH + 1);
    expect([f.reply(), f.message(), f.task()]).toEqual([true, true, 0]);
  });
  it('holds the same bound in the settling itself', () => {
    const edges = new Map<string, string[]>(); for (let i = 1; i <= 6000; i += 1) edges.set(`n${i}`, [`n${i - 1}`]);
    const kids = (id: string) => edges.get(id) ?? [];
    expect(settleDeepChains([`n${MAXIMUM_WALK_DEPTH - 1}`], kids, () => {})).toBe('ok');
    expect(settleDeepChains([`n${MAXIMUM_WALK_DEPTH}`], kids, () => {})).toBe('too_deep');
    expect(settleDeepChains(['n6'], kids, () => {}, 7)).toBe('ok'); // 7 nodes
    expect(settleDeepChains(['n7'], kids, () => {}, 7)).toBe('too_deep'); // 8 nodes
  });
});