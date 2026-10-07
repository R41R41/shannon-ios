import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createLocalApiKernel } from '../../src/infra/http/apiKernel.js';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { BackgroundUpdateCoordinator } from '../../src/mind/sleep/backgroundUpdates.js';
import { SQLitePeopleMemoryStore } from '../../src/mind/memory/store/peopleMemoryStore.js';
import { memoryPortsOf, memoryWriterOf } from '../../src/wiring/memoryOutboxWiring.js';

/** The API kernel on SQLite with the memory outbox on (Syzygy ADR-0008 stage 3), its writer run only when a scenario says so. */
export function memoryKernel() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-mem-scenario-'));
  const path = join(directory, 'shannon.sqlite');
  const clock = { at: Date.parse('2026-10-07T03:00:00.000Z') };
  const now = () => new Date(clock.at).toISOString();
  const store = new SQLiteShannonStore({ path, now, memoryOutbox: true, moodHistory: null });
  const ports = memoryPortsOf(store, now)!;
  const writer = memoryWriterOf(store, { now, log: () => {} })!;
  const people = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store, undefined, undefined, ports.proposals);
  const api = createLocalApiKernel(now, { stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: people, memory: ports });
  const chat = async (message: string) => {
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message } });
    expect(response.status).toBe(200);
    await api.waitForBackground('owner');
    clock.at += 60_000;
    return (response.body as { turnId: string }).turnId;
  };
  const close = () => { people.close(); store.close(); rmSync(directory, { recursive: true, force: true }); };
  return { store, ports, writer, people, api, chat, clock, now, outbox: store.memoryOutbox()!, close };
}

