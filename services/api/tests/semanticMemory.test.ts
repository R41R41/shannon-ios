import { OWNER_AUDIENCE } from '@shannon/cognition';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/chatModel.js';
import { MemoryEmbeddingWorker } from '../src/mind/memory/memoryEmbeddingWorker.js';
import { DeterministicMemoryModelGateway, OpenAIMemoryModelGateway } from '../src/mind/recall/memoryModels.js';
import { DEFAULT_SEMANTIC_MEMORY_CONFIG, SemanticMemoryRecall, type SemanticMemoryConfig } from '../src/mind/recall/semanticMemoryRecall.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { prepareTurnCognitiveContext } from '../src/turnCognitiveContext.js';
import { ShannonTurnMemoryRecall, withMemorySearchLatency } from '../src/mind/recall/turnMemoryRecall.js';
import type { VoiceTurnDecision } from '../src/voiceDecision.js';

const at = '2026-09-30T03:00:00.000Z';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function store(): SQLiteShannonStore {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-semantic-'));
  directories.push(directory);
  return new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => at });
}

function recall(persistent: SQLiteShannonStore, gateway: DeterministicMemoryModelGateway, config: Partial<SemanticMemoryConfig> = {}) {
  return new ShannonTurnMemoryRecall(new SemanticMemoryRecall(gateway, persistent, { ...DEFAULT_SEMANTIC_MEMORY_CONFIG, ...config }));
}

async function seeded() {
  const persistent = store();
  const thread = persistent.createThread('owner');
  const trip = persistent.appendTurn('owner', thread, '旅行計画は沖縄にする', '了解、沖縄で組もう', '2026-09-01T00:00:00.000Z');
  persistent.appendTurn('owner', thread, '朝食にパンを食べた', 'いいね', '2026-09-02T00:00:00.000Z');
  const embedder = new DeterministicMemoryModelGateway();
  expect(await new MemoryEmbeddingWorker(persistent, persistent, embedder, persistent, { now: () => at }).runOnce()).toBe('worked');
  return { persistent, thread, trip };
}

class RecordingChatModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: '返答' };
  }
}

describe('semantic memory recall', () => {
  it('finds a paraphrased experience that deterministic recall misses, and marks it as a candidate', async () => {
    const { persistent, thread, trip } = await seeded();
    const message = '旅の予定どうなったっけ？';
    const deterministic = prepareTurnCognitiveContext(persistent.snapshot('owner'), persistent, { present: OWNER_AUDIENCE,
      scopeKey: 'owner', message, occurredAt: at, channel: 'text', threadId: 'other-thread',
    });
    expect(deterministic.frame.recalledMemoryIDs).not.toContain(trip.id);
    const gateway = new DeterministicMemoryModelGateway({ rewrites: { [message]: ['旅行計画 沖縄'] } });
    const enriched = await recall(persistent, gateway).enrich(deterministic, {
      scopeKey: 'owner', message, snapshot: persistent.snapshot('owner'), threadId: thread,
    });
    expect(enriched.memoryRecall.status).toBe('used');
    expect(enriched.frame.recalledMemoryIDs).toContain(trip.id);
    expect(enriched.memories.find(memory => memory.id === trip.id)?.reasons).toEqual(['semantic']);
    expect(enriched.prompt).toContain('[Semantic recall]');
    expect(gateway.calls).toEqual(['rewrite', 'embed', 'rerank']);
    persistent.close();
  });

  it('respects the per-turn model-call ceiling', async () => {
    const { persistent } = await seeded();
    const snapshot = persistent.snapshot('owner');
    const base = prepareTurnCognitiveContext(snapshot, persistent, { present: OWNER_AUDIENCE, scopeKey: 'owner', message: '前に決めた旅行計画', occurredAt: at, channel: 'text' });
    for (const [limit, calls] of [[1, ['embed']], [2, ['embed', 'rerank']], [0, []]] as const) {
      const gateway = new DeterministicMemoryModelGateway();
      await recall(persistent, gateway, { maximumModelCallsPerTurn: limit, minimumSimilarity: 0 }).enrich(base, { scopeKey: 'owner', message: '前に決めた旅行計画', snapshot });
      expect(gateway.calls).toEqual(calls);
    }
    persistent.close();
  });

  it('falls back to deterministic recall on failure or timeout', async () => {
    const { persistent } = await seeded();
    const snapshot = persistent.snapshot('owner');
    const message = '旅の予定どうなったっけ？';
    const base = prepareTurnCognitiveContext(snapshot, persistent, { present: OWNER_AUDIENCE, scopeKey: 'owner', message, occurredAt: at, channel: 'text' });
    const failed = await recall(persistent, new DeterministicMemoryModelGateway({ fail: 'embed' })).enrich(base, { scopeKey: 'owner', message, snapshot });
    expect(failed.memoryRecall.status).toBe('failed');
    expect(failed.prompt).toBe(base.prompt);
    const started = performance.now();
    const slow = await recall(persistent, new DeterministicMemoryModelGateway({ delayMilliseconds: 5_000 }), { timeoutMilliseconds: 200 })
      .enrich(base, { scopeKey: 'owner', message, snapshot });
    expect(slow.memoryRecall.status).toBe('timeout');
    expect(slow.frame.recalledMemoryIDs).toEqual(base.frame.recalledMemoryIDs);
    expect(performance.now() - started).toBeLessThan(2_000);
    persistent.close();
  });

  it('never returns or re-sends a forgotten experience even when its embedding exists', async () => {
    const { persistent, trip } = await seeded();
    persistent.apply('owner', { type: 'memory-control-upserted', control: {
      memoryId: trip.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at,
      changeReason: 'test', sourceEvidence: trip.userMessage,
    } });
    const snapshot = persistent.snapshot('owner');
    const message = '旅の予定どうなったっけ？';
    const gateway = new DeterministicMemoryModelGateway({ rewrites: { [message]: ['旅行計画 沖縄'] } });
    const base = prepareTurnCognitiveContext(snapshot, persistent, { present: OWNER_AUDIENCE, scopeKey: 'owner', message, occurredAt: at, channel: 'text' });
    const enriched = await recall(persistent, gateway).enrich(base, { scopeKey: 'owner', message, snapshot });
    expect(enriched.frame.recalledMemoryIDs).not.toContain(trip.id);
    expect(enriched.prompt).not.toContain('沖縄');
    persistent.close();
  });

  it('skips the model stage for ordinary text turns', async () => {
    const { persistent } = await seeded();
    const gateway = new DeterministicMemoryModelGateway();
    const snapshot = persistent.snapshot('owner');
    const base = prepareTurnCognitiveContext(snapshot, persistent, { present: OWNER_AUDIENCE, scopeKey: 'owner', message: '今日は暑いね', occurredAt: at, channel: 'text' });
    expect((await recall(persistent, gateway).enrich(base, { scopeKey: 'owner', message: '今日は暑いね', snapshot })).memoryRecall.status).toBe('skipped');
    expect(gateway.calls).toEqual([]);
    persistent.close();
  });

  it('answers a text turn even when semantic recall fails', async () => {
    const { persistent } = await seeded();
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(() => at, {
      chatModel: model, stateStore: persistent, conversationStore: persistent,
      memoryRecall: recall(persistent, new DeterministicMemoryModelGateway({ fail: 'rewrite' })),
    });
    const result = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: '前に話した旅の予定を覚えてる？' } });
    expect(result).toMatchObject({ status: 200, body: { reply: '返答' } });
    await api.waitForBackground('owner');
    persistent.close();
  });
});

describe('memory embedding worker', () => {
  it('re-embeds a changed thread summary and withholds forgotten sources', async () => {
    const persistent = store();
    const embedder = new DeterministicMemoryModelGateway();
    const worker = new MemoryEmbeddingWorker(persistent, persistent, embedder, persistent, { now: () => at });
    const thread = persistent.createThread('owner', '計画');
    const context = (threadSummary: string) => ({ capturedStateVersion: 0,
      messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const }, threadSummary });
    const secret = persistent.appendTurn('owner', thread, '秘密の合言葉は青い鳥', 'わかった', at, context('合言葉の相談'));
    persistent.apply('owner', { type: 'memory-control-upserted', control: {
      memoryId: secret.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at,
      changeReason: 'test', sourceEvidence: secret.userMessage,
    } });
    expect(await worker.runOnce()).toBe('worked');
    const raw = new DatabaseSync(persistent['context'].options.path);
    const statuses = () => Object.fromEntries((raw.prepare('SELECT source_id, status, source_revision FROM memory_embeddings').all() as Array<{ source_id: string; status: string; source_revision: number }>)
      .map(row => [row.source_id, `${row.status}@${row.source_revision}`]));
    expect(statuses()[secret.id]).toBe('withheld@1');
    // The summary was written by the forgotten turn, so it is withheld with it.
    expect(statuses()[thread]).toBe('withheld@1');
    expect(await worker.runOnce()).toBe('idle');
    // A later turn rewrites the summary from visible history only: a fresh chain, embedded again.
    persistent.appendTurn('owner', thread, '次の話', 'うん', '2026-09-30T04:00:00.000Z', context('新しい計画の相談'));
    expect(await worker.runOnce()).toBe('worked');
    expect(statuses()[thread]).toBe('embedded@2');
    raw.close();
    persistent.close();
  });

  it('stops at the shared monthly background budget and records the memory_background lane', async () => {
    const persistent = store();
    persistent.appendTurn('owner', persistent.createThread('owner'), '予算テスト', 'うん', at);
    const fetcher = (async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2] }, { index: 1, embedding: [0.3, 0.1] }], usage: { prompt_tokens: 10, total_tokens: 10 },
    }))) as typeof fetch;
    const gateway = new OpenAIMemoryModelGateway({ apiKey: 'test-key', fetcher, usageStore: persistent, now: () => at });
    expect(await new MemoryEmbeddingWorker(persistent, persistent, gateway, persistent, { backgroundBudgetUsd: 0, now: () => at }).runOnce()).toBe('budget');
    expect(await new MemoryEmbeddingWorker(persistent, persistent, gateway, persistent, { backgroundBudgetUsd: 1, now: () => at }).runOnce()).toBe('worked');
    expect(persistent.llmUsageSummary('owner', '2026-09').map(row => row.lane)).toContain('memory_background');
    persistent.close();
  });
});

function memoryDecision(): VoiceTurnDecision {
  return {
    source: 'jev', shouldRespond: true, replyRequiredProbability: 0.95, solutionWantedProbability: 0.6,
    conversationClass: 'skill_simple', latencyClass: 'under_3s', affect: 'neutral', affectIntensity: 0.2,
    delivery: 'conversational', selectedSkills: ['conversation_memory'], skillScores: {
      current_web: 0, place_discovery: 0, conversation_memory: 0.95, daily_mind: 0, aether_notes: 0,
      voyager_tasks: 0, agent_status: 0, device_context: 0,
    }, elapsedMilliseconds: 40,
  };
}

describe('voice memory turns', () => {
  it('plays the waiting phrase before a semantic memory search and skips it for guests', async () => {
    const { persistent } = await seeded();
    const gateway = new DeterministicMemoryModelGateway();
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(() => at, {
      chatModel: model, stateStore: persistent, conversationStore: persistent,
      voiceDecision: { mode: 'jev', model: 'test-jev', decide: async () => memoryDecision() },
      memoryRecall: recall(persistent, gateway),
    });
    const owner = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
      body: { scopeKey: 'owner', transcript: '前に話した旅行の件、覚えてる？' } });
    expect(owner).toMatchObject({ status: 200, body: { voicePlan: { latencyClass: 'under_10s' } } });
    expect((owner.body as { voicePlan: { waitingPhrase?: string } }).voicePlan.waitingPhrase).toBeTruthy();
    expect(gateway.calls).toContain('embed');
    gateway.calls.splice(0);
    const guest = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
      body: { scopeKey: 'owner', transcript: '前に話した旅行の件、覚えてる？', participantMode: 'guest' } });
    expect(guest.status).toBe(200);
    expect(gateway.calls).toEqual([]);
    persistent.close();
  });

  it('records response-path model calls in the memory lane without storing requests at the provider', async () => {
    const persistent = store();
    const bodies: string[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ output_text: JSON.stringify({ queries: ['旅行計画'] }),
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } }));
    }) as unknown as typeof fetch;
    const gateway = new OpenAIMemoryModelGateway({ apiKey: 'test-key', fetcher, usageStore: persistent, now: () => at });
    expect(await gateway.rewriteQuery('owner', '旅の予定は？')).toEqual(['旅行計画']);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ store: false, text: { format: { type: 'json_schema', strict: true } } });
    expect(persistent.llmUsageSummary('owner', '2026-09').map(row => row.lane)).toEqual(['memory']);
    persistent.close();
  });

  it('classifies a model-assisted memory turn as longer than three seconds', () => {
    const decision = { latencyClass: 'under_3s' } as Pick<VoiceTurnDecision, 'latencyClass'>;
    expect(withMemorySearchLatency(decision).latencyClass).toBe('under_10s');
    expect(withMemorySearchLatency({ latencyClass: 'over_10s' as const }).latencyClass).toBe('over_10s');
  });
});
