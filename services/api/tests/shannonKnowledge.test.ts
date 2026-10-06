import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeKnowledgeDraft, type KnowledgeDraft } from '@shannon/cognition';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/chatModel.js';
import { ShannonKnowledgeConsolidator, type KnowledgeAnalyzer, type KnowledgeOperation } from '../src/mind/sleep/knowledgeConsolidation.js';
import { DeterministicMemoryModelGateway } from '../src/mind/recall/memoryModels.js';
import { SemanticMemoryRecall } from '../src/mind/recall/semanticMemoryRecall.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { ShannonTurnMemoryRecall } from '../src/mind/recall/turnMemoryRecall.js';
import { promptOf } from './modelPrompt.js';

const at = '2026-09-30T03:00:00.000Z';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function store(): { persistent: SQLiteShannonStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-knowledge-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  return { persistent: new SQLiteShannonStore({ path, now: () => at }), path };
}

class RecordingChatModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: `返答${this.requests.length}` };
  }
}

const photoNote = (sources: readonly string[], status: KnowledgeDraft['status'] = 'hypothesis'): KnowledgeDraft => ({
  title: '写真整理の進め方',
  applicability: '写真整理の相談を受けたとき',
  bodyMarkdown: '## 状況\n写真が多くて手が止まる。\n## 行動\nアルバム単位で小さく区切る。\n## 結果\n一回で終わらせようとしない方が続く。',
  status, sourceExperienceIds: sources,
});

function seed(persistent: SQLiteShannonStore) {
  const thread = persistent.createThread('owner');
  const first = persistent.appendTurn('owner', thread, '写真整理が進まない', 'アルバムごとに区切ってみよう', '2026-09-20T00:00:00.000Z');
  const second = persistent.appendTurn('owner', thread, '写真の整理、アルバム単位だと進んだ', 'よかった', '2026-09-25T00:00:00.000Z');
  const sources = new Map([first, second].map(item => [item.id, `${item.userMessage}\n${item.shannonReply}`]));
  return { thread, first, second, sources };
}

describe('Shannon knowledge safety gate', () => {
  it('requires provenance, keeps one success as a hypothesis, and rejects copied text or secrets', () => {
    const { persistent } = store();
    const { first, second, sources } = seed(persistent);
    expect(normalizeKnowledgeDraft(photoNote([]), sources)).toEqual({ rejected: 'missing-source' });
    expect(normalizeKnowledgeDraft(photoNote(['unknown']), sources)).toEqual({ rejected: 'unknown-source' });
    const single = normalizeKnowledgeDraft(photoNote([first.id], 'confirmed'), sources);
    expect('draft' in single && single.draft.status).toBe('hypothesis');
    const double = normalizeKnowledgeDraft(photoNote([first.id, second.id], 'confirmed'), sources);
    expect('draft' in double && double.draft.status).toBe('confirmed');
    expect(normalizeKnowledgeDraft({ ...photoNote([second.id]), bodyMarkdown: '## 引用\n写真の整理、アルバム単位だと進んだ よかった と言っていた' }, sources))
      .toEqual({ rejected: 'verbatim-conversation' });
    expect(normalizeKnowledgeDraft({ ...photoNote([first.id]), bodyMarkdown: '## 鍵\nsk-abcdefghijklmnopqrstuvwxyz' }, sources))
      .toEqual({ rejected: 'secret-like' });
    persistent.close();
  });

  it('versions every write, accumulates provenance, and keeps the retirement reason in history', () => {
    const { persistent, path } = store();
    const { first, second } = seed(persistent);
    const created = persistent.createShannonKnowledge('owner', photoNote([first.id]), at, 'test');
    expect(created).toMatchObject({ status: 'hypothesis', version: 1, headings: [{ title: '状況' }, { title: '行動' }, { title: '結果' }] });
    expect(persistent.updateShannonKnowledge('owner', created.id, 9, photoNote([second.id]), at, 'stale')).toBeNull();
    const updated = persistent.updateShannonKnowledge('owner', created.id, 1, photoNote([second.id], 'confirmed'), at, 'second success')!;
    expect(updated).toMatchObject({ version: 2, status: 'confirmed' });
    expect(updated.sourceExperienceIds).toEqual([first.id, second.id]);
    expect(persistent.searchMemory('owner', '写真整理の進め方').map(hit => hit.id)).toContain(`knowledge:${created.id}`);
    persistent.retireShannonKnowledge('owner', created.id, '一括の方が早かった', at, [first.id]);
    expect(persistent.listShannonKnowledge('owner')).toEqual([]);
    expect(persistent.searchMemory('owner', '写真整理の進め方').map(hit => hit.id)).not.toContain(`knowledge:${created.id}`);
    const raw = new DatabaseSync(path);
    expect(raw.prepare('SELECT version, status, reason FROM shannon_knowledge_revisions ORDER BY version').all())
      .toEqual([{ version: 1, status: 'hypothesis', reason: 'test' }, { version: 2, status: 'confirmed', reason: 'second success' },
        { version: 3, status: 'retired', reason: '一括の方が早かった' }]);
    expect(() => raw.prepare(`INSERT INTO shannon_knowledge_documents VALUES ('x','owner','t','b','[]','hypothesis','a','[]','[]',NULL,?,?,1)`).run(at, at))
      .toThrow();
    raw.close();
    persistent.close();
  });
});

class ScriptedAnalyzer implements KnowledgeAnalyzer {
  readonly inputs: Parameters<KnowledgeAnalyzer['analyze']>[1][] = [];
  constructor(private readonly operations: (input: Parameters<KnowledgeAnalyzer['analyze']>[1]) => KnowledgeOperation[]) {}
  async analyze(_scopeKey: string, input: Parameters<KnowledgeAnalyzer['analyze']>[1]) {
    this.inputs.push(input);
    return this.operations(input);
  }
}

const createOp = (sources: string[], overrides: Partial<KnowledgeOperation> = {}): KnowledgeOperation => ({
  operation: 'create', knowledgeId: '', expectedVersion: 0, ...photoNote(sources), status: 'confirmed', reason: '繰り返し', ...overrides,
});

describe('knowledge consolidation worker', () => {
  it('writes validated notes without approval and never sees or cites forgotten experiences', async () => {
    const { persistent } = store();
    const { first, second } = seed(persistent);
    persistent.apply('owner', { type: 'memory-control-upserted', control: {
      memoryId: first.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'test', sourceEvidence: first.userMessage,
    } });
    const analyzer = new ScriptedAnalyzer(() => [createOp([second.id]), createOp([first.id]), createOp([second.id], { bodyMarkdown: '## 引用\n写真の整理、アルバム単位だと進んだ' })]);
    const result = await new ShannonKnowledgeConsolidator(persistent, persistent, persistent, analyzer, persistent, { now: () => at })
      .consolidate('owner', '2026-09-19T00:00:00.000Z', '2026-09-26T00:00:00.000Z');
    expect(result).toMatchObject({ status: 'applied', created: 1, rejected: 2 });
    expect(analyzer.inputs[0]!.experiences.map(item => item.id)).toEqual([second.id]);
    expect(persistent.listShannonKnowledge('owner')).toMatchObject([{ status: 'hypothesis', sourceExperienceIds: [second.id] }]);
    persistent.close();
  });

  it('retires a contradicted note with evidence, and respects the background budget', async () => {
    const { persistent } = store();
    const { first, second } = seed(persistent);
    const note = persistent.createShannonKnowledge('owner', photoNote([first.id]), at, 'seed');
    const retire = new ScriptedAnalyzer(() => [{ ...createOp([second.id]), operation: 'retire', knowledgeId: note.id, reason: '矛盾する結果' }]);
    expect(await new ShannonKnowledgeConsolidator(persistent, persistent, persistent, retire, persistent, { backgroundBudgetUsd: 0 })
      .consolidate('owner', '2026-09-19T00:00:00.000Z', '2026-09-26T00:00:00.000Z')).toMatchObject({ status: 'budget' });
    expect(await new ShannonKnowledgeConsolidator(persistent, persistent, persistent, retire, persistent, { now: () => at })
      .consolidate('owner', '2026-09-19T00:00:00.000Z', '2026-09-26T00:00:00.000Z')).toMatchObject({ retired: 1 });
    expect(persistent.listShannonKnowledge('owner', { includeRetired: true })[0]).toMatchObject({
      status: 'retired', retiredReason: '矛盾する結果', sourceExperienceIds: [first.id, second.id],
    });
    persistent.close();
  });
});

function kernel(persistent: SQLiteShannonStore, gateway = new DeterministicMemoryModelGateway()) {
  const model = new RecordingChatModel();
  const api = createLocalApiKernel(() => at, {
    chatModel: model, stateStore: persistent, conversationStore: persistent,
    memoryRecall: new ShannonTurnMemoryRecall(new SemanticMemoryRecall(gateway, persistent), persistent),
  });
  const chat = (message: string) => api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message } });
  return { api, model, chat };
}

describe('knowledge recall', () => {
  it('projects a hypothesis as Shannon\'s lowest-authority note, never as a user fact', async () => {
    const { persistent } = store();
    const { first } = seed(persistent);
    persistent.createShannonKnowledge('owner', photoNote([first.id]), at, 'seed');
    const { model, chat, api } = kernel(persistent);
    await chat('写真整理のコツある？');
    const prompt = promptOf(model.requests[0]!);
    expect(prompt).toContain('[Shannon private knowledge — lowest authority]');
    expect(prompt).toContain('[仮説] 写真整理の進め方');
    expect(prompt).toContain('ユーザーが確定した事実ではない');
    expect(prompt).toContain('Aether decisions > the user profile > these notes');
    expect(persistent.snapshot('owner').userFacts.map(fact => fact.statement).join()).not.toContain('写真整理の進め方');
    await api.waitForBackground('owner');
    persistent.close();
  });

  it('stops using a note once any source experience is forgotten', async () => {
    const { persistent } = store();
    const { first, second } = seed(persistent);
    persistent.createShannonKnowledge('owner', photoNote([first.id, second.id], 'confirmed'), at, 'seed');
    persistent.apply('owner', { type: 'memory-control-upserted', control: {
      memoryId: second.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'test',
    } });
    const { model, chat, api } = kernel(persistent);
    await chat('写真整理のコツある？');
    expect(promptOf(model.requests[0]!)).not.toContain('写真整理の進め方');
    await api.waitForBackground('owner');
    persistent.close();
  });

  it('navigates a long note by heading and projects only the chosen section', async () => {
    const { persistent } = store();
    const { first } = seed(persistent);
    const long = `## 準備\n${'準備の詳細。'.repeat(200)}\n## 写真の分類\nアルバム単位で区切る。\n## 後片付け\n${'片付けの詳細。'.repeat(200)}`;
    persistent.createShannonKnowledge('owner', { ...photoNote([first.id]), bodyMarkdown: long }, at, 'seed');
    const gateway = new DeterministicMemoryModelGateway({ sections: ['h2'] });
    const { model, chat, api } = kernel(persistent, gateway);
    await chat('写真整理のコツある？');
    const prompt = promptOf(model.requests[0]!);
    expect(gateway.calls).toEqual(['navigate']);
    expect(prompt).toContain('アルバム単位で区切る。');
    expect(prompt).not.toContain('片付けの詳細。');
    await api.waitForBackground('owner');
    persistent.close();
  });

  it('answers an inquiry with provenance and forgets exactly the cited items on request', async () => {
    const { persistent } = store();
    const { first } = seed(persistent);
    const note = persistent.createShannonKnowledge('owner', photoNote([first.id]), at, 'seed');
    const { model, chat, api } = kernel(persistent);
    await chat('写真整理について何を覚えてる？');
    expect(promptOf(model.requests[0]!)).toContain('[Memory inquiry]');
    expect(promptOf(model.requests[0]!)).toContain('シャノン自身の仮説「写真整理の進め方」');
    await api.waitForBackground('owner');
    const forget = await chat('それは忘れて');
    expect(forget).toMatchObject({ status: 200 });
    expect(String((forget.body as { reply: string }).reply)).toContain('今後の想起に使わない');
    expect(model.requests).toHaveLength(1);
    expect(persistent.listShannonKnowledge('owner', { includeRetired: true }).find(item => item.id === note.id)?.status).toBe('retired');
    expect(persistent.snapshot('owner').memoryControls.find(control => control.memoryId === first.id)?.status).toBe('forgotten');
    await chat('写真整理について何を覚えてる？');
    expect(promptOf(model.requests[1]!)).not.toContain('写真整理の進め方');
    await api.waitForBackground('owner');
    persistent.close();
  });
});
