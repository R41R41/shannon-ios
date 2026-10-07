import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleShannonSystemPrompt, createInitialCompanionState, reduceCompanionState } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { consolidateSleepMemory } from '../src/mind/sleep/sleepConsolidation.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('Shannon memory transparency', () => {
  it('shows evidence and persists correction, pin, forget, reject, and restore controls', async () => {
    const store = makeStore();
    const at = '2026-08-31T12:00:00.000Z';
    store.apply('owner-a', {
      type: 'user-fact-upserted',
      fact: { id: 'fact-a', statement: 'ユーザーは紅茶が好き', confidence: 0.55, observedAt: at, evidence: '僕は紅茶が好き' },
    });
    const memories = new ShannonMemoryService(store, store, () => '2026-08-31T12:10:00.000Z');
    const api = createLocalApiKernel(() => '2026-08-31T12:10:00.000Z', {
      stateStore: store, conversationStore: store, memoryStore: memories,
    });

    const loaded = await api.dispatch({ method: 'GET', path: '/v1/memories', query: new URLSearchParams({ scopeKey: 'owner-a' }) });
    expect(loaded).toMatchObject({ status: 200, body: { items: [{ id: 'fact-a', evidence: [{ quote: '僕は紅茶が好き' }] }] } });

    for (const [action, text] of [['correct', 'ユーザーはアールグレイが好き'], ['pin', undefined], ['forget', undefined], ['restore', undefined], ['reject', undefined]] as const) {
      const response = await api.dispatch({
        method: 'POST', path: '/v1/memories/action',
        body: { scopeKey: 'owner-a', memoryId: 'fact-a', action, ...(text ? { text } : {}) },
      });
      expect(response.status).toBe(200);
    }
    const control = store.snapshot('owner-a').memoryControls.find(item => item.memoryId === 'fact-a');
    expect(control).toMatchObject({ status: 'rejected', pinned: false, overrideText: 'ユーザーはアールグレイが好き' });
    expect(assembleShannonSystemPrompt(store.snapshot('owner-a'))).not.toContain('紅茶');
    store.close();
  });

  it('keeps rejected relearning and opposing statements as visible sleep contradictions', async () => {
    const at = '2026-09-01T00:00:00.000Z';
    const statement = 'ユーザーは猫が好き';
    const id = `user-fact-${createHash('sha256').update(statement.toLowerCase()).digest('hex').slice(0, 20)}`;
    let state = createInitialCompanionState('owner-a', at);
    state = reduceCompanionState(state, {
      type: 'memory-control-upserted',
      control: { memoryId: id, kind: 'user-fact', status: 'rejected', pinned: false, updatedAt: at, changeReason: 'ユーザーが否定' },
    }, at);
    const rejected = await consolidateSleepMemory(
      { mode: 'local-rules', analyze: async () => [{ statement, evidence: '僕は猫が好き' }] },
      [{ content: '僕は猫が好き', observedAt: at }], state, at,
    );
    expect(rejected.facts).toEqual([]);
    expect(rejected.report.contradictions[0]?.reason).toContain('事実ではない');

    state = createInitialCompanionState('owner-b', at);
    state = reduceCompanionState(state, {
      type: 'user-fact-upserted',
      fact: { id: 'existing', statement: 'ユーザーは猫が苦手', confidence: 0.7, observedAt: at },
    }, at);
    const conflict = await consolidateSleepMemory(
      { mode: 'local-rules', analyze: async () => [{ statement, evidence: '僕は猫が好き' }] },
      [{ content: '僕は猫が好き', observedAt: at }], state, at,
    );
    expect(conflict.facts).toEqual([]);
    expect(conflict.report.contradictions[0]).toMatchObject({ currentText: 'ユーザーは猫が苦手', candidateText: statement });
  });
});

function makeStore(): SQLiteShannonStore {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-memory-test-'));
  directories.push(directory);
  return new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => '2026-08-31T12:00:00.000Z' });
}
