import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { ConversationReplaySummarizer, type ReplaySummaryWriter } from '../../src/mind/memory/conversationReplaySummary.js';
import type { MemoryWriter } from '../../src/mind/memory/memoryWriter.js';
import type { MemoryOp } from '../../src/mind/memory/memoryOpCodec.js';
import { memoryPortsOf, memoryWriterOf } from '../../src/wiring/memoryOutboxWiring.js';
import { STORE_MEMORY_PARTS } from '../../src/infra/sqlite/storeMemoryParts.js';

/**
 * A temporary database with the memory outbox switched on (Syzygy ADR-0008 stage 3, F5), a moved clock, a replay summarizer over
 * a recording model, and writers made on demand (each its own lease holder, as after a restart).
 */
export const MEMORY_AT = '2026-10-07T03:00:00.000Z';
// Small budgets so a thread of thirty messages already overflows (as `conversationReplaySummary.test.ts`).
export const SMALL_REPLAY = { SHANNON_CONVERSATION_REPLAY_CHARACTERS: '2000', SHANNON_VOICE_REPLAY_CHARACTERS: '2000' };
export const replayLine = (index: number) => `発言${String(index).padStart(3, '0')}${'あ'.repeat(95)}`;

export function memoryWorld(options: { summary?: (call: number) => string | null | Promise<string | null> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-memory-'));
  const path = join(directory, 'shannon.sqlite');
  const clock = { at: Date.parse(MEMORY_AT) };
  const now = () => new Date(clock.at).toISOString();
  const store = new SQLiteShannonStore({ path, now, memoryOutbox: true, memoryParts: STORE_MEMORY_PARTS, moodHistory: null, predictionShadow: false, decisionTraces: false,
    predictionLedger: false, choiceLedger: false });
  const calls: Array<{ previousSummary: string | null; lines: readonly string[] }> = [];
  const model: ReplaySummaryWriter = { update: async (_scopeKey, input) => {
    calls.push(input);
    return options.summary ? options.summary(calls.length) : `要約${calls.length}`;
  } };
  const ports = memoryPortsOf(store, now)!;
  const summarizer = new ConversationReplaySummarizer(store, store, model, { backgroundLlmCostUsd: () => 0 },
    { environment: SMALL_REPLAY, backgroundBudgetUsd: 1, now, memory: ports.proposals });
  const writer = (parts: { owner?: string; beforeLock?: (op: MemoryOp) => void } = {}): MemoryWriter => memoryWriterOf(store, {
    now, owner: parts.owner ?? 'writer-1', replaySummaries: summarizer, log: () => {}, ...(parts.beforeLock ? { beforeLock: parts.beforeLock } : {}),
  })!;
  const thread = (turns: number, threadId = 'thread') => {
    let last = '';
    for (let index = 0; index < turns; index += 1) {
      last = store.appendTurn('owner', threadId, replayLine(index * 2), replayLine(index * 2 + 1), new Date(clock.at + index * 60_000).toISOString()).id;
    }
    return last;
  };
  const outbox = store.memoryOutbox()!;
  return {
    directory, path, clock, now, store, outbox, ports, summarizer, calls, writer, thread,
    advance: (milliseconds: number) => { clock.at += milliseconds; },
    rows: () => outbox.rows(),
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
