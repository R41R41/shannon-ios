import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore, OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE } from '@shannon/cognition';
import type { ConversationStore, ShannonExperience, StoredConversationMessage } from '../src/mind/memory/conversationContract.js';
import { DisclosureGate } from '../src/mind/inhibition/memoryDisclosure.js';

/**
 * 2026-10-19: production's remembered turns hold thread summaries that recall each other's thread: a turn of thread A recalled the
 * summary of thread B, and a turn of thread B the summary of thread A (4 such cycles over 7 threads on 2026-10-18). The disclosure
 * gate judges a thread summary by the turns of its thread, and a turn by the summaries it recalled, and remembered a thread's
 * answer only once it had one: so with another person present (the owner alone never asks) the judging never ended, and the turn
 * failed with a bare `RangeError` ("Maximum call stack size exceeded") before its model call.
 */
const at = '2026-10-09T00:00:00.000Z';
function world(threads: Record<string, string[]>) {
  // `threads`: thread -> the thread summaries that the turn of that thread recalled.
  const rows = new Map<string, ShannonExperience>();
  const messages = new Map<string, StoredConversationMessage[]>();
  for (const [thread, recalled] of Object.entries(threads)) {
    const id = `turn-${thread}`;
    rows.set(id, { id, observedAt: at, summary: 'chat', userMessage: 'hello', shannonReply: 'hi',
      ...(recalled.length ? { recalledMemoryIds: recalled.map(other => `thread:${other}`) } : {}) });
    messages.set(thread, [{ id: `message-${thread}`, sourceExperienceId: id, role: 'assistant', content: 'hi', observedAt: at }]);
  }
  const store = {
    experiencesById: (_scope: string, ids: readonly string[]) => ids.flatMap(id => rows.has(id) ? [rows.get(id)!] : []),
    threadSummaryLineage: (_scope: string, thread: string) => ({ messages: messages.get(thread) ?? [], updatedAt: at }),
  } as unknown as ConversationStore;
  const snapshot = new InMemoryCompanionStateStore(() => at).snapshot('owner');
  return { gate: (present = UNKNOWN_GUEST_PRESENCE) => new DisclosureGate(present, snapshot, store, 'owner') };
}

describe('thread summaries that recall each other', () => {
  it('are judged cautiously, not forever, when two threads recall each other', () => {
    const gate = world({ a: ['b'], b: ['a'] }).gate();
    expect(() => gate.allowsThreadSummary('a')).not.toThrow();
    expect(world({ a: ['b'], b: ['a'] }).gate().allowsThreadSummary('a')).toBe(false);
    expect(world({ a: ['b'], b: ['a'] }).gate().allowsThreadSummary('b')).toBe(false);
  });

  it('are judged cautiously when a thread recalls its own summary, or a ring of three', () => {
    expect(world({ a: ['a'] }).gate().allowsThreadSummary('a')).toBe(false);
    const ring = world({ a: ['b'], b: ['c'], c: ['a'] });
    for (const thread of ['a', 'b', 'c']) expect(ring.gate().allowsThreadSummary(thread)).toBe(false);
  });

  it('are judged through a turn too (a message of a thread in the ring)', () => {
    const f = world({ a: ['b'], b: ['a'] });
    expect(f.gate().allowsExperience('turn-a')).toBe(false);
    expect(f.gate().allowsMessage({ sourceExperienceId: 'turn-b' })).toBe(false);
  });

  it('are judged as before without a cycle, and for the owner alone', () => {
    const f = world({ a: ['b'], b: ['c'], c: [], d: ['b', 'c'] });
    for (const thread of ['a', 'b', 'c', 'd']) expect(f.gate().allowsThreadSummary(thread)).toBe(true);
    expect(world({ a: ['b'], b: ['a'] }).gate(OWNER_AUDIENCE).allowsThreadSummary('a')).toBe(true);
  });

  it('do not leave a half-judged answer behind when the store throws', () => {
    let fail = true;
    const store = { experiencesById: () => [], threadSummaryLineage: () => { if (fail) throw new Error('database busy'); return { messages: [], updatedAt: at }; } } as unknown as ConversationStore;
    const gate = new DisclosureGate(UNKNOWN_GUEST_PRESENCE, new InMemoryCompanionStateStore(() => at).snapshot('owner'), store, 'owner');
    expect(() => gate.allowsThreadSummary('a')).toThrow('database busy');
    fail = false;
    expect(gate.allowsThreadSummary('a')).toBe(true);
  });
});
