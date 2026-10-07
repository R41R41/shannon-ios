import { mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { InMemoryOrganizeStore } from '../src/integrations/voyager/organize.js';
import { SQLiteOrganizeStore } from '../src/integrations/voyager/store/organizePersistence.js';
import { FileAetherProposalStore } from '../src/integrations/aether/aetherProposal.js';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { extractProspectiveMemories } from '../src/mind/memory/prospectiveMemory.js';
import { reconcileSleepOutcome, reviewCommitments } from '../src/mind/sleep/sleepCommitmentReview.js';
import { resolveCommitmentCommand } from '../src/mind/action/respond/commitmentCommands.js';
import { InMemoryAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';

const dirs: string[] = [];
const at = '2026-09-24T12:00:00.000Z';
afterEach(() => dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'shannon-commands-')); dirs.push(path); return path; };

describe('voice capability authority and receipts', () => {
  it('offers the same explicit task proposal from text and attaches its review card to the saved reply', async () => {
    const store = new InMemoryOrganizeStore();
    const api = createLocalApiKernel(() => at, { organizeStore: store });
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat',
      body: { scopeKey: 'owner', threadId: 'thread', message: '写真整理をタスクにして' } });
    const session = store.list('owner', 'thread')[0]!;
    expect(response).toMatchObject({ status: 200, body: {
      uiBlocks: [{ type: 'organize_session', session: { id: session.id } }],
    } });
    expect(session.commandThroughMessageId).toBeTruthy();
    expect(session.items[0]).toMatchObject({ title: '写真整理', decision: 'proposed', destinationStatus: 'pending' });
    expect(session.state).toBe('ready_for_review');
  });

  it('uses the verbatim user input, not a generated tool request, and deduplicates proposals', async () => {
    const store = new InMemoryOrganizeStore();
    const api = createLocalApiKernel(() => at, { organizeStore: store });
    const body = { scopeKey: 'owner', threadId: 'thread', transcript: '写真整理をタスクにして' };
    await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body });
    expect(store.list('owner', 'thread')).toHaveLength(0);
    const deviceContext = { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
      userUtterance: { id: 'voice-1', text: '写真整理をタスクにして' } };
    const first = await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: { ...body, deviceContext } });
    const second = await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: { ...body, deviceContext } });
    expect(first).toMatchObject({ status: 200, body: {
      receipt: { capability: 'voyager.propose', status: 'proposed' },
      organizeSession: { id: store.list('owner', 'thread')[0]?.id, state: 'ready_for_review' },
    } });
    expect(second).toEqual(first);
    expect(store.list('owner', 'thread')).toHaveLength(1);
    expect(store.list('owner', 'thread')[0]?.items[0]).toMatchObject({ title: '写真整理', decision: 'proposed', destinationStatus: 'pending' });
    await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: { ...body, participantMode: 'guest', deviceContext: { ...deviceContext, userUtterance: { id: 'voice-2', text: '別の作業をタスクにして' } } } });
    expect(store.list('owner', 'thread')).toHaveLength(1);
  });

  it('retains proposal identity across SQLite restarts without duplicating the actual task operation', () => {
    const path = join(directory(), 'state.sqlite');
    let store = new SQLiteOrganizeStore(path);
    const input = { scopeKey: 'owner', threadId: 'thread', sourceMessageIds: ['u1'], requestKey: 'u1', drafts: [{ title: '写真整理', details: '' }] };
    const first = store.create(input, at);
    store.close();
    store = new SQLiteOrganizeStore(path);
    const again = store.create(input, '2026-09-25T00:00:00.000Z');
    expect(again.id).toBe(first.id);
    expect(again.items[0]?.idempotencyKey).toBe(first.items[0]?.idempotencyKey);
    expect(store.list('owner', 'thread')).toHaveLength(1);
    store.close();
  });

  it('never resends an Aether proposal after the other app consumed the inbox file', () => {
    const path = directory();
    let store = new FileAetherProposalStore(path, () => at);
    const input = { requestKey: 'utterance-1', content: '旅行の振り返り' };
    const first = store.create('owner', input);
    unlinkSync(join(path, `${first.id}.json`)); // Simulates the consumer acknowledging its own fixture.
    store = new FileAetherProposalStore(path, () => at);
    expect(store.create('owner', input).id).toBe(first.id);
    expect(readdirSync(path).filter(name => name.endsWith('.json'))).toEqual([]);
    expect(() => store.create('owner', { ...input, content: 'different' })).toThrow('CONFLICT');
  });

  it('rechecks forget boundaries when a delayed sleep result commits', () => {
    const state = new InMemoryCompanionStateStore(() => at);
    const memory = extractProspectiveMemories('明日、写真を整理しよう', at)[0]!;
    state.apply('owner', { type: 'prospective-memory-upserted', memory });
    const evidence = memory.evidence!;
    const fact = { id: 'new-fact', statement: '写真を整理したい', confidence: 0.5, evidence, observedAt: at };
    state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: memory.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'user' } });
    const reconciled = reconcileSleepOutcome({ facts: [fact], relationships: [], interests: [], report: { learned: [{ kind: 'user-fact', memoryId: fact.id, text: fact.statement, evidence, reason: 'sleep' }], updated: [], interestChanges: [], contradictions: [] } }, state.snapshot('owner'), at);
    expect(reconciled.facts).toEqual([]);
    expect(reconciled.report.learned).toEqual([]);
    expect(reconciled.report.commitmentReview?.pending).toBe(0);
  });

  it('audits a date-only deadline by the stored local day, not UTC midnight', () => {
    const state = new InMemoryCompanionStateStore(() => at);
    const memory = extractProspectiveMemories('明日、写真を整理しよう', at)[0]!;
    state.apply('owner', { type: 'prospective-memory-upserted', memory });
    expect(reviewCommitments(state.snapshot('owner'), '2026-09-25T14:59:00Z').overdue).toBe(0);
    expect(reviewCommitments(state.snapshot('owner'), '2026-09-25T15:00:00Z').overdue).toBe(1);
  });

  it('does not treat a negation, quotation, question or conditional as a completed promise', () => {
    const state = new InMemoryCompanionStateStore(() => at);
    state.apply('owner', { type: 'prospective-memory-upserted', memory: extractProspectiveMemories('明日、写真を整理しよう', at)[0]! });
    for (const text of ['写真整理の約束は完了していない', '写真整理の約束はまだ終わってない',
      '写真整理の約束が終わったら教えて', '写真整理の約束が完了するまで待って',
      '「写真整理の約束を取り消して」と言った', '写真整理の約束は完了したか教えて']) {
      expect(resolveCommitmentCommand(state.snapshot('owner'), text), text).toBeNull();
    }
    expect(resolveCommitmentCommand(state.snapshot('owner'), '写真整理の約束は完了したよ')).toMatchObject({ mutation: { action: 'complete' } });
  });

  it('steers, pauses, and resumes the one running task from explicit voice utterances', async () => {
    const tasks = new InMemoryAgentTaskStore();
    const created = tasks.create('owner', { idempotencyKey: 'start', conversationThreadID: 'thread',
      title: 'Minebot音声対応', goal: 'Minebotへ音声会話を追加', summary: '準備中' }, at).task;
    tasks.claim('mac', at);
    tasks.recordHostEvents('mac', [{ eventId: 'started', taskId: created.id, type: 'started', title: '開始',
      occurredAt: at, payload: { currentAction: '実装中' } }], at);
    const api = createLocalApiKernel(() => at, { agentTasks: tasks });
    const body = (id: string, text: string) => ({ scopeKey: 'owner', threadId: 'thread', transcript: text,
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id, text } } });

    const steer = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
      body: body('u1', 'あと、Voyagerのタスクも完了にして') });
    expect(steer).toMatchObject({ status: 200, body: { receipt: { capability: 'agent.steer', status: 'confirmed' } } });
    expect(tasks.get('owner', created.id)).toMatchObject({ status: 'running', currentAction: 'あと、Voyagerのタスクも完了にして' });

    await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: body('u2', 'いったん止めて') });
    expect(tasks.get('owner', created.id)?.status).toBe('paused');
    await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: body('u3', '続けて') });
    expect(tasks.get('owner', created.id)?.status).toBe('starting');
  });
});
