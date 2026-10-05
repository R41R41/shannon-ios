import { describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { InMemoryAgentTaskStore } from '../src/agentTaskStore.js';
import { configuredAutonomy } from '../src/autonomyBudget.js';
import { ShannonAutonomyService, type AutonomyOverview } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import type { AutonomyActivityDay } from '../src/autonomyActivity.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { promptOf } from './modelPrompt.js';

const scopeKey = 'owner';
const now = () => '2026-10-02T01:00:00.000Z';

class PromptRecorder implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly prompts: string[] = [];
  async generate(request: ShannonChatModelRequest) { this.prompts.push(promptOf(request)); return { mode: this.mode, model: this.model, reply: '返答です。' }; }
  async generateVoice(request: ShannonVoiceModelRequest) { this.prompts.push(promptOf(request)); return { mode: this.mode, model: this.model, reply: '音声の返答です。' }; }
}

function harness(enabled = true) {
  const agentTasks = new InMemoryAgentTaskStore();
  const chatModel = new PromptRecorder();
  const autonomy = new ShannonAutonomyService({
    store: new SQLiteAutonomyStore(':memory:'), config: configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: String(enabled) }),
    now, agentTasks, defaultThread: () => 'thread-1',
  });
  const api = createLocalApiKernel(now, { autonomy, agentTasks, chatModel });
  const get = (path: string, query: Record<string, string> = {}) =>
    api.dispatch({ method: 'GET', path, query: new URLSearchParams({ scopeKey, ...query }) });
  const post = (path: string, body: Record<string, unknown>) => api.dispatch({ method: 'POST', path, body: { scopeKey, ...body } });
  return { api, autonomy, agentTasks, chatModel, get, post };
}

describe('autonomy routes', () => {
  it('shows the owner the switch, budget, pursuits, model choices and proposals', async () => {
    const { get } = harness();
    const result = await get('/v1/autonomy');
    expect(result.status).toBe(200);
    const overview = result.body as AutonomyOverview;
    expect(overview.control).toEqual({ state: 'active', enabled: true, paused: false, changedAt: null });
    expect(overview.budget).toMatchObject({ dayKey: '2026-10-02', capYen: 2_000, spentYen: 0, remainingYen: 2_000, yenPerUsd: 160 });
    expect(overview.budgetRequest).toBeNull();
    expect(overview.pursuits.map(item => item.origin)).toEqual(['seed', 'seed']);
    expect(overview.modelChoices[0]).toMatchObject({ purpose: 'prose', modelId: 'gemini-3.8-flash' });
    expect(overview.proposals).toEqual([]);
  });

  it('is switched off by default: a kernel without configuration reports disabled and allows nothing', async () => {
    const api = createLocalApiKernel(now);
    const result = await api.dispatch({ method: 'GET', path: '/v1/autonomy', query: new URLSearchParams({ scopeKey }) });
    expect((result.body as AutonomyOverview).control.state).toBe('disabled');
    expect(harness(false).autonomy.authorize(scopeKey, { domain: 'aether_study', summary: '書きます。' }).decision).toBe('forbidden');
  });

  it('pauses and resumes, and shows the state with the activity list', async () => {
    const { post, get, autonomy } = harness();
    const paused = await post('/v1/autonomy/pause', { paused: true });
    expect((paused.body as AutonomyOverview).control).toMatchObject({ state: 'paused', paused: true, changedAt: now() });
    expect(autonomy.authorize(scopeKey, { domain: 'aether_study', summary: '書きます。' })).toMatchObject({ decision: 'forbidden', reason: 'paused' });
    const activity = (await get('/v1/autonomy/activity')).body as { control: AutonomyOverview['control']; days: AutonomyActivityDay[] };
    expect(activity.control.state).toBe('paused');
    expect(activity.days).toHaveLength(1);
    expect(activity.days[0]!.entries.map(entry => entry.summary)).toEqual(['書きます。', '所有者が自律活動を一時停止しました。']);
    expect(activity.days[0]!.summary).toBe('止めたこと1件、所有者の操作1件。使った費用は0円です。');
    expect(((await post('/v1/autonomy/pause', { paused: false })).body as AutonomyOverview).control.state).toBe('active');
    expect((await post('/v1/autonomy/pause', { paused: 'yes' })).status).toBe(400);
    expect((await get('/v1/autonomy/activity', { days: '0' })).status).toBe(400);
    expect((await get('/v1/autonomy/activity', { days: '91' })).status).toBe(400);
  });

  it('keeps ordinary chat, memory and owner-started work running while paused', async () => {
    const { post, get, agentTasks } = harness();
    await post('/v1/autonomy/pause', { paused: true });
    const chat = await post('/v1/chat', { message: 'おはよう' });
    expect(chat.status).toBe(200);
    expect((chat.body as { reply: string }).reply).toBe('返答です。');
    expect((await get('/v1/memories')).status).toBe(200);
    expect((await get('/v1/cognition')).status).toBe(200);
    const task = await post('/v1/agent/tasks', {
      idempotencyKey: 'owner-start-1', conversationThreadID: 'thread-1', title: '修正', goal: 'バグを直す', summary: '所有者が開始した作業',
    });
    expect(task.status).toBe(201);
    expect(agentTasks.list(scopeKey)).toHaveLength(1);
  });

  it('carries the owner decision on a budget request', async () => {
    const { post, autonomy } = harness();
    const asked = autonomy.requestBudget(scopeKey, { reason: '第一稿を書き切りたいです', amountYen: 500 }).request!;
    expect((await post(`/v1/autonomy/budget-requests/${asked.id}/decision`, { decision: 'maybe' })).status).toBe(400);
    expect((await post(`/v1/autonomy/budget-requests/${asked.id}/decision`, { decision: 'approve', amountYen: '300' })).status).toBe(400);
    expect((await post(`/v1/autonomy/budget-requests/${asked.id}/decision`, { decision: 'approve', amountYen: 9_999 })).status).toBe(400);
    expect((await post('/v1/autonomy/budget-requests/missing/decision', { decision: 'approve' })).status).toBe(404);
    const approved = await post(`/v1/autonomy/budget-requests/${asked.id}/decision`, { decision: 'approve', amountYen: 300 });
    expect(approved.status).toBe(200);
    expect((approved.body as AutonomyOverview).budget).toMatchObject({ capYen: 2_300, extraYen: 300 });
    expect((approved.body as AutonomyOverview).budgetRequest).toMatchObject({ status: 'approved', approvedYen: 300 });
    expect((await post(`/v1/autonomy/budget-requests/${asked.id}/decision`, { decision: 'decline' })).status).toBe(409);
  });

  it('lets the owner rest or drop a pursuit and nothing more', async () => {
    const { post, autonomy } = harness();
    const pursuit = autonomy.addPursuit(scopeKey, { kind: 'work', title: '雨の日の短い物語', why: '書きたいからです。', origin: 'self' }).pursuit!;
    expect((await post(`/v1/autonomy/pursuits/${pursuit.id}/status`, { status: 'done' })).status).toBe(400);
    expect((await post(`/v1/autonomy/pursuits/${pursuit.id}/status`, { status: 'active' })).status).toBe(400);
    const rested = await post(`/v1/autonomy/pursuits/${pursuit.id}/status`, { status: 'resting' });
    expect((rested.body as AutonomyOverview).pursuits.find(item => item.id === pursuit.id)?.status).toBe('resting');
    expect((await post('/v1/autonomy/pursuits/seed-goal-moving-story/status', { status: 'dropped' })).status).toBe(409);
    expect((await post('/v1/autonomy/pursuits/missing/status', { status: 'dropped' })).status).toBe(404);
    // There is no route to add, retitle, or delete an entry.
    expect((await post('/v1/autonomy/pursuits', { kind: 'work', title: '所有者が足した案', why: 'x' })).status).toBe(404);
    expect((await post(`/v1/autonomy/pursuits/${pursuit.id}`, { title: '書き換え' })).status).toBe(404);
  });

  it('starts a Shannon proposal only on the owner decision', async () => {
    const { post, autonomy, agentTasks } = harness();
    const proposal = autonomy.proposeAgentTask(scopeKey, { title: '感情の決め方を見直したい', goal: '見直す', reason: '読んだ後の気持ちを残したいからです。' }).proposal!;
    expect(agentTasks.list(scopeKey)).toEqual([]);
    expect((await post(`/v1/autonomy/proposals/${proposal.id}/decision`, { decision: 'go' })).status).toBe(400);
    const started = await post(`/v1/autonomy/proposals/${proposal.id}/decision`, { decision: 'start' });
    expect(started.status).toBe(200);
    const body = started.body as AutonomyOverview & { task: { id: string; status: string } };
    expect(body.task.status).toBe('queued');
    expect(body.proposals[0]).toMatchObject({ status: 'started', taskId: body.task.id, origin: 'shannon' });
    expect(agentTasks.list(scopeKey)).toHaveLength(1);
    expect((await post(`/v1/autonomy/proposals/${proposal.id}/decision`, { decision: 'start' })).status).toBe(409);
    expect((await post('/v1/autonomy/proposals/missing/decision', { decision: 'decline' })).status).toBe(404);
  });

  it('has no HTTP entrance for acting as Shannon or for changing the record', async () => {
    const { post, get, api } = harness();
    for (const path of ['/v1/autonomy/authorize', '/v1/autonomy/actions', '/v1/autonomy/activity', '/v1/autonomy/budget-requests',
      '/v1/autonomy/models', '/v1/autonomy/proposals', '/v1/autonomy/activity/delete', '/v1/autonomy/budget']) {
      expect((await post(path, { domain: 'aether_study', summary: '書きます。', paused: false })).status, path).toBe(404);
    }
    expect((await get('/v1/autonomy/unknown')).status).toBe(404);
    expect((await api.dispatch({ method: 'GET', path: '/v1/autonomy' })).status).toBe(400);
    expect((await api.dispatch({ method: 'POST', path: '/v1/autonomy/pause', body: { paused: true } })).status).toBe(400);
  });

  it('adds her current pursuits to the owner text prompt, apart from owner goals, and nothing while there are none', async () => {
    const { post, autonomy, chatModel } = harness();
    await post('/v1/chat', { message: 'おはよう' });
    expect(chatModel.prompts[0]).not.toContain('[ボク自身のやりたいこと]');
    autonomy.addPursuit(scopeKey, { kind: 'work', title: '雨の日の短い物語', why: '書きたいからです。', origin: 'self' });
    await post('/v1/chat', { message: 'こんにちは' });
    expect(chatModel.prompts[1]).toContain('[ボク自身のやりたいこと]（持ち主の目的とは別。やったことの証拠ではない）\n- 作品: 雨の日の短い物語');
    // A temporary guest call never receives her ledger.
    await post('/v1/voice/gemini/cascade/delegations', { transcript: '聞こえる？', participantMode: 'guest' });
    expect(chatModel.prompts[2]).not.toContain('雨の日の短い物語');
  });
});
