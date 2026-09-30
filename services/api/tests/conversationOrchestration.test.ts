import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryConversationOrchestrationStore,
  buildConversationOrchestrationPrompt,
  observeConversationTurn,
  recordConversationProposal,
} from '../src/conversationOrchestration.js';
import { SQLiteConversationOrchestrationStore } from '../src/conversationOrchestrationPersistence.js';

const at = '2026-09-28T12:00:00.000Z';
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe('conversation execution orchestration', () => {
  it('recognizes a colloquial request to add a capability as implementation work', () => {
    const state = observeConversationTurn({ previous: null, scopeKey: 'owner', threadId: 'thread',
      message: '新しいセンサーの機能を、あの、作ってくれない？シャノンに。',
      occurredAt: at, participantMode: 'owner', tasks: [] })!;
    expect(state.pendingAction?.kind).toBe('implement');
    expect(state.approvedScope).toHaveLength(1);
  });

  it('keeps additions and corrections on one durable proposal identity', () => {
    const store = new InMemoryConversationOrchestrationStore();
    let state = observeConversationTurn({ previous: null, scopeKey: 'owner', threadId: 'thread',
      message: 'この音声会話をMinebotにも実装して', occurredAt: at, participantMode: 'owner', tasks: [] })!;
    state = store.save(recordConversationProposal(state, 'Minebotへ音声会話を接続する', at));
    const proposalID = state.resumeToken;
    state = store.save(observeConversationTurn({ previous: state, scopeKey: 'owner', threadId: 'thread',
      message: 'あと、終わったらVoyagerも完了にして', occurredAt: at, participantMode: 'owner', tasks: [] })!);
    state = store.save(observeConversationTurn({ previous: state, scopeKey: 'owner', threadId: 'thread',
      message: '違う、Aetherの仕様を先に確認して', occurredAt: at, participantMode: 'owner', tasks: [] })!);

    expect(state.resumeToken).toBe(proposalID);
    expect(state.addedRequirements).toEqual(['あと、終わったらVoyagerも完了にして']);
    expect(state.corrections).toEqual(['違う、Aetherの仕様を先に確認して']);
    expect(state.pendingAction?.summary).toContain('Aetherの仕様を先に確認');
    expect(buildConversationOrchestrationPrompt(state, [])).toContain('never execute both versions');
  });

  it('does not persist owner execution state from guest conversation', () => {
    const state = observeConversationTurn({ previous: null, scopeKey: 'owner', threadId: 'guest',
      message: 'シャノンを実装して', occurredAt: at, participantMode: 'guest', tasks: [] });
    expect(state).toBeNull();
  });

  it('does not attach a new proposal to an older task from the same thread', () => {
    let state = observeConversationTurn({ previous: null, scopeKey: 'owner', threadId: 'thread',
      message: '新しい音声機能を実装して', occurredAt: at, participantMode: 'owner', tasks: [] })!;
    const proposalID = state.resumeToken;
    state = observeConversationTurn({ previous: state, scopeKey: 'owner', threadId: 'thread',
      message: 'あと、履歴も残して', occurredAt: at, participantMode: 'owner', tasks: [{
        id: 'older-task', title: '以前の実装', goal: '以前の実装', summary: '完了', status: 'completed',
        createdAt: '2026-09-27T10:00:00.000Z',
        updatedAt: '2026-09-27T11:00:00.000Z', conversationThreadID: 'thread',
        plan: [], timeline: [], tests: [], changes: [], isPinned: false, isArchived: false, latestSequence: 1,
      }] })!;

    expect(state.resumeToken).toBe(proposalID);
    expect(state.pendingAction?.summary).toContain('履歴も残して');
    expect(state.sourceReferences).not.toContain('agent-task:older-task');
  });

  it('restores the bounded state from SQLite after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-orchestration-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    let store = new SQLiteConversationOrchestrationStore(path);
    const state = observeConversationTurn({ previous: null, scopeKey: 'owner', threadId: 'thread',
      message: 'Aetherのノートを見て実装して', occurredAt: at, participantMode: 'owner', tasks: [] })!;
    store.save(state);
    store.close();
    store = new SQLiteConversationOrchestrationStore(path);
    expect(store.read('owner', 'thread')).toEqual(state);
    expect(store.read('another', 'thread')).toBeNull();
    store.close();
  });
});
