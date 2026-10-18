import { vi } from 'vitest';
import { InMemoryCompanionStateStore, OWNER_AUDIENCE } from '@shannon/cognition';
import type { ConversationStore, ShannonExperience } from '../../src/mind/memory/conversationContract.js';
import { MemoryWithholding } from '../../src/mind/memory/memoryVisibility.js';
import { createTaskMemory } from '../../src/mind/memory/taskMemory.js';

/** A long chain of remembered turns that each recalled only the turn before it (a game chat that goes on for days). */
const at = '2026-10-09T00:00:00.000Z';
const time = (index: number) => new Date(Date.parse(at) + index * 1000).toISOString();

export interface ChainOptions {
  /** Which turns read a source. By default only the first turn reads one, a document that is there. */
  reads?: (index: number) => string | undefined;
  /** The reader the store answers read receipts with, made from the store and the state; the default is `visible`. */
  reader?: (store: ConversationStore, state: InMemoryCompanionStateStore) => ConversationStore['readSourceVisible'];
  visible?: boolean;
}

export function chain(depth: number, options: ChainOptions = {}) {
  const rows = new Map<string, ShannonExperience>();
  for (let index = 0; index < depth; index += 1) {
    const source = options.reads ? options.reads(index) : index === 0 ? 'aether-document://original' : undefined;
    rows.set(`episode-${index}`, { id: `episode-${index}`, observedAt: time(index), summary: `chat ${index}`, userMessage: 'hello', shannonReply: 'hi',
      ...(source ? { readSourceIds: [source] } : {}), ...(index ? { recalledMemoryIds: [`episode-${index - 1}`] } : {}) });
  }
  const root = `episode-${depth - 1}`, observedAt = time(depth);
  const state = new InMemoryCompanionStateStore(() => observedAt);
  const store = {
    experienceCandidates: () => [...rows.values()],
    experiencesById: (_scope: string, ids: readonly string[]) => ids.flatMap(id => rows.has(id) ? [rows.get(id)!] : []),
    threadSummaryLineage: () => ({ messages: [{ id: 'message', sourceExperienceId: root, role: 'assistant' as const, content: 'summary', observedAt, recalledMemoryIds: [root] }], updatedAt: observedAt }),
    readSourceVisible: () => options.visible ?? true,
    hasReadSourceProvenance: () => true,
  } as unknown as ConversationStore;
  if (options.reader) store.readSourceVisible = options.reader(store, state);
  const reader = () => new MemoryWithholding(state.snapshot('owner'), store, 'owner');
  const reply = (id = root, withholding = reader()) => withholding.withholdsReply({ text: 'x', observedAt, recalledMemoryIds: [id] });
  const message = (id = root) => reader().withholdsMessage({ id: 'm', sourceExperienceId: id, role: 'assistant', content: 'hi', observedAt });
  const task = () => createTaskMemory({ state, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => observedAt,
    readSourceVisible: store.readSourceVisible }).read('owner', [root], OWNER_AUDIENCE).length;
  return { root, reader, reply, message, task, thread: () => reader().withholdsThreadSummary('thread') };
}

/** Quiets the "too deep" line (`recallChainDepth.ts`) of a test that goes past the bound on purpose; the lines are returned. */
export function quietWarnings() { return vi.spyOn(console, 'warn').mockImplementation(() => {}); }