import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryConversationOrchestrationStore,
  buildConversationOrchestrationPrompt,
  observeConversationTurn,
  recordConversationProposal,
  recordVoiceTaskDecision,
  settleVoiceTaskDecision,
  voiceTurnSetsImplementation,
} from '../src/mind/action/respond/conversationOrchestration.js';
import { SQLiteConversationOrchestrationStore } from '../src/mind/action/respond/store/conversationOrchestrationPersistence.js';


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

  it('asks for the structured voice reply only on the turn whose words set the request (2026-10-13: a stale 「…して」)', () => {
    let clock = Date.parse(at);
    const turn = (previous: ReturnType<typeof observeConversationTurn>, message: string) => {
      const occurredAt = new Date(clock += 60_000).toISOString();
      const state = observeConversationTurn({ previous, scopeKey: 'owner', threadId: 'thread', message, occurredAt, participantMode: 'owner', tasks: [] });
      return { state, structured: voiceTurnSetsImplementation(state, message, occurredAt) };
    };
    const set = turn(null, 'shannon-homeを起動して');
    expect(set.state?.pendingAction).toMatchObject({ kind: 'implement', status: 'pending' });
    expect(set.structured).toBe(true);
    const later = turn(recordVoiceTaskDecision(set.state!, 'none'), '元気？');
    expect(later.state?.pendingAction).toMatchObject({ kind: 'implement', status: 'pending' }); // Still pending in the Talk ...
    expect(later.structured).toBe(false); // ... but this turn did not set it: streamed.
    expect(turn(later.state, 'あと、ログも出して').structured).toBe(true);
    const proposed = recordConversationProposal(later.state!, '起動の提案', at);
    expect(voiceTurnSetsImplementation(proposed, 'それと設定も', at)).toBe(true);
    expect(voiceTurnSetsImplementation(proposed, 'ありがとう', at)).toBe(false);
  });

  it('keeps the structured voice reply while she waits for his answer to her clarifying question (review B1)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-orchestration-')); directories.push(directory);
    const store = new SQLiteConversationOrchestrationStore(join(directory, 'state.sqlite'));
    let clock = Date.parse(at);
    const turn = (message: string) => {
      const occurredAt = new Date(clock += 60_000).toISOString();
      const state = store.save(observeConversationTurn({ previous: store.read('owner', 'thread'), scopeKey: 'owner', threadId: 'thread', message,
        occurredAt, participantMode: 'owner', tasks: [] })!);
      return { state, structured: voiceTurnSetsImplementation(state, message, occurredAt) };
    };
    const asked = turn('設定画面に〇〇を実装して');
    expect(asked.structured).toBe(true);
    settleVoiceTaskDecision({ conversationOrchestration: store }, asked.state, asked.structured, { disposition: 'clarify' }); // 「どの画面ですか？」
    const answer = turn('ホーム画面で');
    expect(answer.structured).toBe(true); // His answer can still bring the proposal.
    const proposed = store.save(recordConversationProposal(settleVoiceTaskDecision({ conversationOrchestration: store }, answer.state, true, { disposition: 'propose' })!, '〇〇の実装', at));
    expect(proposed.awaitingClarification).toBeUndefined();
    const chat = turn('ありがとう');
    expect(chat.structured).toBe(false);
    store.close();
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

  it('gives a further proposal its own identity once the previous one became a durable task', () => {
    let state = observeConversationTurn({ previous: null, scopeKey: 'owner', threadId: 'thread',
      message: 'ログイン画面を修正して', occurredAt: at, participantMode: 'owner', tasks: [] })!;
    state = recordConversationProposal(state, 'ログイン画面を修正する', at);
    const firstProposalID = state.resumeToken!;
    const started = [{
      id: firstProposalID, title: 'ログイン修正', goal: 'ログイン画面を修正する', summary: '完了', status: 'completed' as const,
      createdAt: at, updatedAt: at, conversationThreadID: 'thread',
      plan: [], timeline: [], tests: [], changes: [], isPinned: false, isArchived: false, latestSequence: 1,
    }];

    // The wording matches no action rule, so the thread state still points at the finished task.
    state = observeConversationTurn({ previous: state, scopeKey: 'owner', threadId: 'thread',
      message: 'このバグも直せる？お願い', occurredAt: at, participantMode: 'owner', tasks: started })!;
    expect(state.resumeToken).toBe(firstProposalID);
    state = recordConversationProposal(state, '別のバグを直す', at, started);

    expect(state.resumeToken).toBeTruthy();
    expect(state.resumeToken).not.toBe(firstProposalID);
    expect(state.pendingAction).toMatchObject({ status: 'proposed', summary: '別のバグを直す' });
    expect(state.addedRequirements).toEqual([]);
    // A follow-up before the new proposal starts keeps that new identity.
    const secondProposalID = state.resumeToken;
    state = recordConversationProposal(state, '別のバグを直す（履歴も残す）', at, started);
    expect(state.resumeToken).toBe(secondProposalID);
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
