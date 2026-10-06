import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { SHANNON_SEED_PURSUITS } from '@shannon/cognition';
import { InMemoryAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { AutonomyActivityRecord, summarizeAutonomyDay } from '../src/mind/inhibition/store/autonomyActivity.js';
import { SQLiteAutonomyAnnouncer, budgetRequestMessage } from '../src/autonomyAnnouncer.js';
import { configuredAutonomy, type AutonomyConfig } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { readApiSource } from './support/sources.js';

const scope = 'owner';
const directory = mkdtempSync(join(tmpdir(), 'shannon-autonomy-service-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function harness(options: { enabled?: boolean; path?: string; environment?: Record<string, string> } = {}) {
  const clock = { at: '2026-10-02T01:00:00.000Z' };
  const path = options.path ?? ':memory:';
  const store = new SQLiteAutonomyStore(path);
  const config: AutonomyConfig = {
    ...configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: options.enabled === false ? 'false' : 'true', ...options.environment }),
    places: {
      hostFolders: { 'owner-mac': '/Users/owner/Shannon' }, workspaceRoot: '/srv/shannon-workspace',
      productionRoots: ['/home/azureuser/shannon-ios'], repositoryRoots: ['/home/azureuser/shannon-ios', '/srv/shannon-workspace/checkout'],
      protectedPaths: ['/home/azureuser/shannon-ios-data'],
    },
  };
  const agentTasks = new InMemoryAgentTaskStore();
  const service = new ShannonAutonomyService({
    store, config, now: () => clock.at, agentTasks, defaultThread: () => 'thread-1',
    resolvePath: value => (value.startsWith('/') ? normalize(value) : null),
    ...(path === ':memory:' ? {} : { announcer: new SQLiteAutonomyAnnouncer(path) }),
  });
  const entries = () => service.activityDays(scope, 30).flatMap(day => day.entries);
  return { clock, store, service, agentTasks, entries, path };
}

describe('activity record', () => {
  it('writes every decision, allowed or not, with domain, model, reason and approval', () => {
    const { service, entries } = harness();
    service.authorize(scope, { domain: 'aether_study', summary: '書斎に短い物語の下書きを書きます。' });
    service.authorize(scope, { domain: 'core', summary: '人格の定義を直したいです。' });
    service.authorize(scope, { domain: 'self_replication', summary: '自分の写しを別の場所で動かします。' });
    service.authorize(scope, { domain: 'thinking', summary: '構成を考えます。', tool: 'outline', paid: { model: 'gemini-3.8-flash', estimatedCostYen: 5 } });
    service.authorize(scope, null as never);
    const [malformed, paid, replication, core, study] = entries();
    expect(study).toMatchObject({ kind: 'decision', actor: 'shannon', domain: 'aether_study', domainLabel: '自分の書斎', outcome: 'allowed', approval: 'not_needed', reasonCode: 'free_domain', costYen: 0 });
    expect(study!.summary).toBe('書斎に短い物語の下書きを書きます。');
    expect(core).toMatchObject({ domain: 'core', outcome: 'needs_approval', approval: 'needed', reasonCode: 'core_path' });
    expect(replication).toMatchObject({ domain: 'self_replication', outcome: 'refused', reasonCode: 'forbidden_domain' });
    expect(paid).toMatchObject({ model: 'gemini-3.8-flash', tool: 'outline', outcome: 'allowed' });
    expect(malformed).toMatchObject({ outcome: 'refused', reasonCode: 'malformed_request', domain: 'unknown', domainLabel: '不明な範囲' });
    expect(study!.dayKey).toBe('2026-10-02');
  });

  it('cannot be rewritten or deleted through the store, the service, or SQL', () => {
    const { store, service } = harness();
    service.authorize(scope, { domain: 'aether_study', summary: '下書きを書きます。' });
    const members = (value: object) => Object.getOwnPropertyNames(Object.getPrototypeOf(value)).filter(name => name !== 'constructor');
    expect(members(store.activity).sort()).toEqual(['append', 'countForDay', 'days', 'followUps', 'get']);
    for (const name of [...members(store), ...members(service), ...members(store.activity)]) {
      expect(name, name).not.toMatch(/delete|remove|clear|purge|rewrite|edit|truncate|updateActivity|reset/iu);
    }
    const database = (store as unknown as { database: DatabaseSync }).database;
    expect(() => database.exec(`UPDATE autonomy_activity SET summary = 'x'`)).toThrow(/AUTONOMY_ACTIVITY_APPEND_ONLY/u);
    expect(() => database.exec('DELETE FROM autonomy_activity')).toThrow(/AUTONOMY_ACTIVITY_APPEND_ONLY/u);
    expect(() => database.exec(`INSERT OR REPLACE INTO autonomy_activity
      (sequence, activity_id, scope_key, occurred_at, day_key, kind, actor, summary, domain, outcome, approval)
      VALUES (1, 'x', 'owner', 'x', 'x', 'decision', 'shannon', 'x', 'x', 'allowed', 'not_needed')`)).toThrow(/AUTONOMY_ACTIVITY_APPEND_ONLY/u);
    const existingId = service.activityDays(scope)[0]!.entries[0]!.id;
    expect(() => database.prepare(`INSERT OR REPLACE INTO autonomy_activity
      (activity_id, scope_key, occurred_at, day_key, kind, actor, summary, domain, outcome, approval)
      VALUES (?, 'owner', 'x', 'x', 'decision', 'shannon', 'x', 'x', 'allowed', 'not_needed')`).run(existingId)).toThrow(/AUTONOMY_ACTIVITY_APPEND_ONLY/u);
    expect(service.activityDays(scope)[0]!.entries).toHaveLength(1);
    expect(service.activityDays(scope)[0]!.entries[0]!.summary).toBe('下書きを書きます。');
  });

  it('keeps the triggers when the schema is ensured again on restart', () => {
    const path = join(directory, 'restart.sqlite');
    const first = harness({ path });
    first.service.authorize(scope, { domain: 'aether_study', summary: '下書きを書きます。' });
    first.service.setPaused(scope, true);
    first.store.close();
    const second = harness({ path });
    expect(second.entries()).toHaveLength(2);
    expect(second.service.overview(scope).control).toMatchObject({ state: 'paused', paused: true });
    const database = (second.store as unknown as { database: DatabaseSync }).database;
    expect(() => database.exec('DELETE FROM autonomy_activity')).toThrow(/APPEND_ONLY/u);
    expect(() => new AutonomyActivityRecord(database)).not.toThrow();
    second.store.close();
  });

  it('groups by owner-local day and summarises a day from counts alone', () => {
    const { service, clock } = harness();
    clock.at = '2026-10-01T14:59:00.000Z'; // 23:59 on 1 October in Tokyo
    const first = service.authorize(scope, { domain: 'thinking', summary: '構成を考えます。', paid: { model: 'gpt-5.6-luna', estimatedCostYen: 1 } });
    service.recordAction(scope, { decisionId: first.activityId, summary: '物語の構成を三つ考えました。', outcome: 'done', usage: { inputTokens: 100_000, outputTokens: 50_000 } });
    clock.at = '2026-10-01T15:01:00.000Z'; // 00:01 on 2 October in Tokyo
    service.authorize(scope, { domain: 'core', summary: '記憶の仕組みを直したいです。' });
    service.authorize(scope, { domain: 'spending', summary: '本を買います。' });
    service.setPaused(scope, true);
    const days = service.activityDays(scope, 7);
    expect(days.map(day => day.dayKey)).toEqual(['2026-10-02', '2026-10-01']);
    expect(days[0]!.summary).toBe('承認が必要1件、止めたこと1件、所有者の操作1件。使った費用は0円です。');
    // 100k input at $0.2/M + 50k output at $1.2/M = $0.08, at 160 yen per dollar.
    expect(days[1]!.costYen).toBe(12.8);
    expect(days[1]!.summary).toBe('したこと1件。使った費用は12.80円です。');
    expect(days[1]!.entries.map(entry => entry.kind)).toEqual(['action', 'decision']);
    expect(summarizeAutonomyDay('2026-10-03', []).summary).toBe('記録0件。使った費用は0円です。');
  });

  it('accepts an action only for a decision that allowed it, once, with the priced model', () => {
    const { service } = harness();
    const refused = service.authorize(scope, { domain: 'core', summary: '基幹を直します。' });
    expect(() => service.recordAction(scope, { decisionId: refused.activityId, summary: '直しました。', outcome: 'done' })).toThrow('AUTONOMY_ACTION_NOT_AUTHORIZED');
    expect(() => service.recordAction(scope, { decisionId: 'nothing', summary: '何かしました。', outcome: 'done' })).toThrow('AUTONOMY_ACTION_NOT_AUTHORIZED');
    const unpaid = service.authorize(scope, { domain: 'aether_study', summary: '下書きを書きます。' });
    expect(() => service.recordAction(scope, { decisionId: unpaid.activityId, summary: '書きました。', outcome: 'done', usage: { inputTokens: 1, outputTokens: 1 } }))
      .toThrow('AUTONOMY_ACTION_NOT_AUTHORIZED');
    const done = service.recordAction(scope, { decisionId: unpaid.activityId, summary: '下書きを書きました。', outcome: 'done', link: 'aether://study/draft-1' });
    expect(done).toMatchObject({ kind: 'action', outcome: 'done', link: 'aether://study/draft-1', relatedId: unpaid.activityId, domain: 'aether_study' });
    expect(() => service.recordAction(scope, { decisionId: unpaid.activityId, summary: 'もう一度書きました。', outcome: 'done' })).toThrow('AUTONOMY_ACTION_NOT_AUTHORIZED');
  });
});

describe('stop switch', () => {
  it('is off for a new owner, survives a restart, and is audited', () => {
    const path = join(directory, 'pause.sqlite');
    const first = harness({ path });
    expect(first.service.overview(scope).control).toEqual({ state: 'active', enabled: true, paused: false, changedAt: null });
    expect(first.service.authorize(scope, { domain: 'aether_study', summary: '書きます。' }).decision).toBe('allow');
    first.service.setPaused(scope, true);
    // Before the next step: the very next decision is refused.
    expect(first.service.authorize(scope, { domain: 'aether_study', summary: '書きます。' })).toMatchObject({ decision: 'forbidden', reason: 'paused' });
    first.store.close();

    const second = harness({ path });
    expect(second.service.authorize(scope, { domain: 'aether_study', summary: '書きます。' })).toMatchObject({ decision: 'forbidden', reason: 'paused' });
    second.clock.at = '2026-10-02T02:00:00.000Z';
    second.service.setPaused(scope, true); // no change, no second audit line
    second.service.setPaused(scope, false);
    expect(second.service.authorize(scope, { domain: 'aether_study', summary: '書きます。' }).decision).toBe('allow');
    const audit = second.entries().filter(entry => entry.kind === 'control');
    expect(audit.map(entry => [entry.actor, entry.outcome, entry.summary, entry.domainLabel])).toEqual([
      ['owner', 'resumed', '所有者が自律活動の一時停止を解除しました。', '設定と承認'],
      ['owner', 'paused', '所有者が自律活動を一時停止しました。', '設定と承認'],
    ]);
    second.store.close();
  });

  it('treats an unreadable switch as paused', () => {
    const { service, store } = harness();
    (store as unknown as { control: () => never }).control = () => { throw new Error('unreadable'); };
    expect(service.authorize(scope, { domain: 'aether_study', summary: '書きます。' })).toMatchObject({ decision: 'forbidden', reason: 'paused' });
  });

  it('stays refused while the server switch is off, whatever the owner switch says', () => {
    const { service } = harness({ enabled: false });
    expect(service.overview(scope).control.state).toBe('disabled');
    expect(service.authorize(scope, { domain: 'aether_study', summary: '書きます。' })).toMatchObject({ decision: 'forbidden', reason: 'disabled' });
    expect(service.addPursuit(scope, { kind: 'work', title: '雨の日の物語', why: '書きたいからです。', origin: 'self' }).pursuit).toBeUndefined();
    expect(service.requestBudget(scope, { reason: '長い物語を書きたいです', amountYen: 500 }).request).toBeUndefined();
    expect(service.proposeAgentTask(scope, { title: '直したい', goal: '直す', reason: '理由' }).proposal).toBeUndefined();
  });
});

describe('daily budget and the request to raise it', () => {
  const paidStep = { domain: 'thinking', summary: '物語を書き進めます。', paid: { model: 'gpt-5.6-sol', estimatedCostYen: 100 } };

  it('defaults to 2,000 yen per owner-local day at 160 yen per dollar', () => {
    const config = configuredAutonomy({});
    expect(config).toMatchObject({ enabled: false, dailyBudgetYen: 2_000, yenPerUsd: 160, timeZone: 'Asia/Tokyo', maximumExtraYenPerDay: 3_000 });
    expect(configuredAutonomy({ SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '-5', SHANNON_AUTONOMY_YEN_PER_USD: 'abc' })).toMatchObject({ dailyBudgetYen: 2_000, yenPerUsd: 160 });
    expect(configuredAutonomy({ SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '400', SHANNON_AUTONOMY_ENABLED: 'true' })).toMatchObject({ dailyBudgetYen: 400, enabled: true });
  });

  it('counts actual usage and refuses paid steps once the cap is reached, until the next owner-local day', () => {
    const { service, clock, store } = harness();
    const spend = (inputTokens: number, outputTokens: number) => {
      const decision = service.authorize(scope, paidStep);
      if (decision.decision !== 'allow') return decision;
      service.recordAction(scope, { decisionId: decision.activityId, summary: '書き進めました。', outcome: 'done', usage: { inputTokens, outputTokens, purpose: 'prose' } });
      return decision;
    };
    // gpt-5.6-sol: $4 in / $20 out per million. 250k out = $5 = 800 yen; 312.5k out = 1,000 yen.
    expect(spend(0, 250_000).decision).toBe('allow');
    expect(spend(0, 312_500).decision).toBe('allow');
    expect(service.overview(scope).budget).toMatchObject({ capYen: 2_000, spentYen: 1_800, remainingYen: 200, exhausted: false, baseCapYen: 2_000, extraYen: 0 });
    // The spending count is append-only too: it cannot be lowered to make room.
    const database = (store as unknown as { database: DatabaseSync }).database;
    expect(() => database.exec('UPDATE autonomy_spend SET cost_yen = 0')).toThrow(/AUTONOMY_SPEND_APPEND_ONLY/u);
    expect(() => database.exec('DELETE FROM autonomy_spend')).toThrow(/AUTONOMY_SPEND_APPEND_ONLY/u);
    expect(spend(0, 62_500).decision).toBe('allow'); // another 200 yen: exactly at the cap
    expect(service.overview(scope).budget).toMatchObject({ spentYen: 2_000, remainingYen: 0, exhausted: true });
    expect(spend(0, 1)).toMatchObject({ decision: 'forbidden', reason: 'budget_exhausted' });
    expect(service.authorize(scope, { ...paidStep, paid: { model: 'gpt-5.6-luna', estimatedCostYen: 0 } })).toMatchObject({ decision: 'forbidden', reason: 'budget_exhausted' });
    // Unpaid work and proposals are not blocked by the budget.
    expect(service.authorize(scope, { domain: 'aether_study', summary: '読み返します。' }).decision).toBe('allow');
    clock.at = '2026-10-02T15:00:00.000Z'; // midnight in Tokyo
    expect(service.overview(scope).budget).toMatchObject({ dayKey: '2026-10-03', spentYen: 0, capYen: 2_000 });
    expect(spend(0, 1_000).decision).toBe('allow');
  });

  it('charges a Gemini call at the fail-safe rate until its price is configured', () => {
    const run = (environment: Record<string, string>) => {
      const { service } = harness({ environment });
      const decision = service.authorize(scope, { domain: 'thinking', summary: '文章を書きます。', paid: { model: 'gemini-3.8-flash', estimatedCostYen: 10 } });
      return service.recordAction(scope, { decisionId: decision.activityId, summary: '文章を書きました。', outcome: 'done', usage: { inputTokens: 1_000_000, outputTokens: 0 } }).costYen;
    };
    expect(run({})).toBe(800); // $5 per million input
    expect(run({ SHANNON_AUTONOMY_MODEL_PRICES_JSON: '{"gemini-3.8-flash":{"input":0.5,"output":3}}' })).toBe(80);
  });

  it('lets her ask once a day, and the owner raise only that day', () => {
    const { service, clock, entries } = harness();
    expect(service.requestBudget(scope, { reason: '', amountYen: 500 }).rejection).toBe('BUDGET_REQUEST_INVALID');
    expect(service.requestBudget(scope, { reason: '理由', amountYen: 0 }).rejection).toBe('BUDGET_REQUEST_INVALID');
    expect(service.requestBudget(scope, { reason: '理由', amountYen: 3_001 }).rejection).toBe('BUDGET_REQUEST_INVALID');
    const asked = service.requestBudget(scope, { reason: '長い物語の第一稿を今日のうちに書き切りたいです', amountYen: 500 });
    expect(asked.request).toMatchObject({ status: 'pending', requestedYen: 500, dayKey: '2026-10-02', approvedYen: 0 });
    expect(service.requestBudget(scope, { reason: 'もう一度お願いします', amountYen: 300 }).rejection).toBe('BUDGET_REQUEST_ALREADY_MADE');
    expect(service.overview(scope).budget.capYen).toBe(2_000);
    expect(service.overview(scope).budgetRequest?.id).toBe(asked.request!.id);

    expect(service.decideBudgetRequest(scope, 'missing', 'approve')).toBe('BUDGET_REQUEST_NOT_FOUND');
    expect(service.decideBudgetRequest(scope, asked.request!.id, 'approve', 5_000)).toBe('BUDGET_AMOUNT_INVALID');
    const approved = service.decideBudgetRequest(scope, asked.request!.id, 'approve', 300);
    expect(typeof approved).toBe('object');
    expect(service.overview(scope).budget).toMatchObject({ capYen: 2_300, extraYen: 300, baseCapYen: 2_000 });
    expect(service.decideBudgetRequest(scope, asked.request!.id, 'decline')).toBe('BUDGET_REQUEST_DECIDED');
    expect(entries().filter(entry => entry.kind === 'budget').map(entry => [entry.actor, entry.outcome, entry.approval, entry.summary])).toEqual([
      ['owner', 'approved', 'approved', '所有者が今日の予算を300円増やしました。'],
      ['shannon', 'requested', 'needed', '今日の予算をあと500円増やしてほしいとお願いしました。'],
    ]);

    clock.at = '2026-10-03T01:00:00.000Z';
    expect(service.overview(scope).budget).toMatchObject({ dayKey: '2026-10-03', capYen: 2_000, extraYen: 0 });
    expect(service.overview(scope).budgetRequest).toBeNull();
    const next = service.requestBudget(scope, { reason: '今日も続きを書きたいです', amountYen: 200 });
    clock.at = '2026-10-04T01:00:00.000Z';
    expect(service.decideBudgetRequest(scope, next.request!.id, 'approve')).toBe('BUDGET_REQUEST_EXPIRED');
    expect(service.overview(scope).budget.capYen).toBe(2_000);
  });

  it('records a declined request without changing the cap', () => {
    const { service, entries } = harness();
    const asked = service.requestBudget(scope, { reason: '調べものが増えました', amountYen: 400 });
    service.decideBudgetRequest(scope, asked.request!.id, 'decline');
    expect(service.overview(scope)).toMatchObject({ budget: { capYen: 2_000 }, budgetRequest: { status: 'declined', approvedYen: 0 } });
    expect(entries()[0]).toMatchObject({ actor: 'owner', outcome: 'declined', approval: 'declined', summary: '所有者が予算の追加を見送りました。' });
  });

  it('cannot ask while paused', () => {
    const { service } = harness();
    service.setPaused(scope, true);
    const asked = service.requestBudget(scope, { reason: '書きたいです', amountYen: 100 });
    expect(asked.request).toBeUndefined();
    expect(asked.decision).toMatchObject({ decision: 'forbidden', reason: 'paused' });
  });

  it('tells the owner as one ordinary initiative message in her voice', () => {
    const path = join(directory, 'announce.sqlite');
    const persistent = new SQLiteShannonStore({ path, now: () => '2026-10-02T01:00:00.000Z' });
    const initiatives = new SQLiteInitiativeStore(path, () => '2026-10-02T01:00:00.000Z');
    const threadId = persistent.createThread(scope, 'いつものトーク');
    const { service, store } = harness({ path });
    const asked = service.requestBudget(scope, { reason: '長い物語を書き切りたいです。', amountYen: 500 });
    const unread = initiatives.unreadMessages(scope);
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({ threadId, sourceTitle: '今日の予算', expression: 'thinking' });
    expect(unread[0]!.content).toBe(
      'ライ氏、お願いがあります。今日の予算の2,000円では足りなくなりそうです。理由は「長い物語を書き切りたいです」です。'
      + '今日だけ、あと500円増やしてもらえますか。増やすかどうかは、頭の中の「したことの記録」から決められます。断ってもらっても大丈夫です。');
    const history = persistent.conversationHistory(scope, threadId);
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: unread[0]!.content });
    // The day's spontaneous-topic slot is still free for the initiative loop.
    const database = new DatabaseSync(path);
    expect(database.prepare(`SELECT day_key FROM initiative_messages`).all()).toEqual([{ day_key: 'autonomy-budget:2026-10-02' }]);
    database.close();
    expect(asked.request?.status).toBe('pending');
    store.close(); initiatives.close(); persistent.close();
  });

  it('speaks the request as Shannon, not as the system', () => {
    const message = budgetRequestMessage({ requestId: 'r', dayKey: '2026-10-02', reason: '調べたいことが増えました！', requestedYen: 250, capYen: 1_300 });
    expect(message).toContain('ライ氏');
    expect(message).toContain('1,300円');
    expect(message).toContain('あと250円');
    expect(message).not.toMatch(/あなた|所有者|だよ。|るよ。/u);
    const source = readApiSource('autonomyAnnouncer.ts');
    expect(source).not.toMatch(/'[^'\n]*(?:あなた|だよ。|てね。)[^'\n]*'/u);
  });
});

describe("Shannon's own pursuits ledger", () => {
  it('starts with the immutable seed entries of the decision', () => {
    const { service, store } = harness();
    const pursuits = service.overview(scope).pursuits;
    expect(pursuits.map(item => [item.id, item.kind, item.origin, item.status])).toEqual(
      SHANNON_SEED_PURSUITS.map(seed => [seed.id, seed.kind, 'seed', 'active']));
    expect(pursuits[0]!.title).toBe('人を感動させる物語を作ること');
    const seedId = pursuits[0]!.id;
    expect(service.updatePursuit(scope, seedId, { status: 'dropped' }).rejection).toBe('PURSUIT_SEED_IMMUTABLE');
    expect(service.setPursuitStatusByOwner(scope, seedId, 'resting')).toBe('PURSUIT_SEED_IMMUTABLE');
    const database = (store as unknown as { database: DatabaseSync }).database;
    expect(() => database.exec(`UPDATE autonomy_pursuits SET title = '別の目標' WHERE origin = 'seed'`)).toThrow(/PURSUIT_SEED_IMMUTABLE/u);
    expect(() => database.exec(`DELETE FROM autonomy_pursuits WHERE origin = 'seed'`)).toThrow(/PURSUIT_SEED_IMMUTABLE/u);
    expect(service.overview(scope).pursuits[0]!.title).toBe('人を感動させる物語を作ること');
  });

  it('lets her add and change her own entries through the gate, and records it', () => {
    const { service, entries } = harness();
    const added = service.addPursuit(scope, { kind: 'work', title: '雨の日の短い物語', why: '雨の音から始まる話を書いてみたいからです。', origin: 'self' });
    expect(added.pursuit).toMatchObject({ kind: 'work', status: 'active', origin: 'self', links: [] });
    expect(service.addPursuit(scope, { kind: 'work', title: '雨の日の短い物語 ', why: '同じです。', origin: 'self' }).rejection).toBe('PURSUIT_DUPLICATE');
    expect(service.addPursuit(scope, { kind: 'work', title: '', why: 'x', origin: 'self' }).rejection).toBe('PURSUIT_INVALID');
    expect(service.addPursuit(scope, { kind: 'work', title: '種のふり', why: 'x', origin: 'seed' as never }).rejection).toBe('PURSUIT_INVALID');
    expect(service.addPursuit(scope, { kind: 'question', title: '人はなぜ泣ける話を読むのか', why: 'ライ氏と話して気になりました。', origin: 'conversation' }).pursuit?.origin).toBe('conversation');
    const linked = service.updatePursuit(scope, added.pursuit!.id, { links: [{ label: '下書き', url: 'aether://study/draft-1' }] });
    expect(linked.pursuit?.links).toEqual([{ label: '下書き', url: 'aether://study/draft-1' }]);
    expect(service.updatePursuit(scope, added.pursuit!.id, { links: [{ label: '外', url: 'file:///etc/passwd' }] }).rejection).toBe('PURSUIT_INVALID');
    expect(service.updatePursuit(scope, added.pursuit!.id, { status: 'done' }).pursuit?.status).toBe('done');
    expect(entries().filter(entry => entry.kind === 'pursuit').map(entry => entry.summary)).toEqual([
      'やりたいこと「雨の日の短い物語」をやり終えました。',
      'やりたいこと「雨の日の短い物語」を続けることにしました。',
      'やりたいこと「人はなぜ泣ける話を読むのか」を台帳に書きました。',
      'やりたいこと「雨の日の短い物語」を台帳に書きました。',
    ]);
  });

  it('lets the owner only rest or drop a non-seed entry', () => {
    const { service, entries } = harness();
    const added = service.addPursuit(scope, { kind: 'work', title: '雨の日の短い物語', why: '書きたいからです。', origin: 'self' }).pursuit!;
    const rested = service.setPursuitStatusByOwner(scope, added.id, 'resting');
    expect(typeof rested === 'object' && rested.pursuits.find(item => item.id === added.id)?.status).toBe('resting');
    service.setPursuitStatusByOwner(scope, added.id, 'dropped');
    expect(service.setPursuitStatusByOwner(scope, added.id, 'resting')).toBe('PURSUIT_CLOSED');
    expect(service.updatePursuit(scope, added.id, { status: 'active' }).rejection).toBe('PURSUIT_CLOSED');
    expect(service.setPursuitStatusByOwner(scope, 'missing', 'resting')).toBe('PURSUIT_NOT_FOUND');
    expect(entries().find(entry => entry.actor === 'owner')).toMatchObject({ kind: 'pursuit', summary: '所有者が「雨の日の短い物語」をやめるよう伝えました。' });
  });

  it('gives the prompt a small projection and never the owner goals', () => {
    const { service } = harness();
    expect(service.pursuitPrompt(scope)).toBe('');
    service.addPursuit(scope, { kind: 'work', title: '雨の日の短い物語', why: '書きたいからです。', origin: 'self' });
    expect(service.pursuitPrompt(scope)).toBe('[ボク自身のやりたいこと]（持ち主の目的とは別。やったことの証拠ではない）\n- 作品: 雨の日の短い物語');
    expect(service.pursuitPrompt('another-owner')).toBe('');
  });
});

describe('model choice', () => {
  it('recommends Gemini for Japanese prose by default and stores her own preference', () => {
    const { service, entries } = harness();
    const defaults = service.overview(scope).modelChoices;
    expect(defaults.map(choice => [choice.purpose, choice.modelId, choice.chosenBy])).toEqual([
      ['prose', 'gemini-3.8-flash', 'default'], ['research_reading', 'gpt-5.6-luna', 'default'],
      ['planning', 'gpt-5.6-luna', 'default'], ['critique', 'gpt-5.6-terra', 'default'],
    ]);
    expect(defaults[0]!.recommendation).toContain('Gemini');
    expect(service.setModelPreference(scope, { purpose: 'prose', modelId: 'gpt-5.6-luna', reason: '安いから' }).rejection).toBe('MODEL_PREFERENCE_INVALID');
    expect(service.setModelPreference(scope, { purpose: 'prose', modelId: 'mystery', reason: '試したい' }).rejection).toBe('MODEL_PREFERENCE_INVALID');
    expect(service.setModelPreference(scope, { purpose: 'poetry', modelId: 'gpt-5.6-sol', reason: '試したい' }).rejection).toBe('MODEL_PREFERENCE_INVALID');
    expect(service.setModelPreference(scope, { purpose: 'prose', modelId: 'gpt-5.6-sol', reason: '長い場面の流れが良かったからです。' }).rejection).toBeUndefined();
    expect(service.overview(scope).modelChoices[0]).toMatchObject({ modelId: 'gpt-5.6-sol', chosenBy: 'shannon', reason: '長い場面の流れが良かったからです。' });
    expect(entries()[0]).toMatchObject({ kind: 'model', model: 'gpt-5.6-sol', summary: '使うモデルをGPT-5.6 Solに選びました。' });
  });
});

describe('proposals from Shannon', () => {
  const draft = {
    title: '感情の決め方を見直したい', goal: '物語を読んだ後の気持ちが顔に出るようにする。', reason: '読んで感じたことを覚えておきたいからです。',
    projectHint: 'shannon-ios', paths: ['/srv/shannon-workspace/checkout/packages/cognition/src/emotionState.ts', '/srv/shannon-workspace/checkout/packages/cognition/src/persona.ts'],
  };

  it('records a proposal and starts nothing', () => {
    const { service, agentTasks, entries } = harness();
    const { decision, proposal } = service.proposeAgentTask(scope, draft);
    expect(decision).toMatchObject({ decision: 'needs_approval', reason: 'core_path', coreAreas: ['emotion', 'persona'] });
    expect(proposal).toMatchObject({ origin: 'shannon', status: 'proposed', reason: draft.reason, coreAreas: ['emotion', 'persona'], coreAreaLabels: ['感情', '人格'], projectHint: 'shannon-ios' });
    expect(agentTasks.list(scope)).toEqual([]);
    expect(agentTasks.claim('any-host', '2026-10-02T01:00:01.000Z')).toBeNull();
    expect(entries()[0]).toMatchObject({ kind: 'proposal', actor: 'shannon', outcome: 'needs_approval', approval: 'needed', link: `shannon-proposal://${proposal!.id}` });
    expect(service.overview(scope).proposals.map(item => item.id)).toEqual([proposal!.id]);
  });

  it('starts a task only when the owner starts the proposal, once', () => {
    const { service, agentTasks, entries } = harness();
    const { proposal } = service.proposeAgentTask(scope, draft);
    const started = service.decideProposal(scope, proposal!.id, 'start');
    if (typeof started === 'string') throw new Error(started);
    expect(started.task).toMatchObject({ title: draft.title, goal: draft.goal, status: 'queued', conversationThreadID: 'thread-1', projectHint: 'shannon-ios' });
    expect(started.task!.summary).toBe('シャノンからの提案です。理由：読んで感じたことを覚えておきたいからです。');
    expect(agentTasks.list(scope)).toHaveLength(1);
    expect(started.overview.proposals[0]).toMatchObject({ status: 'started', taskId: started.task!.id });
    expect(service.decideProposal(scope, proposal!.id, 'start')).toBe('PROPOSAL_DECIDED');
    expect(service.decideProposal(scope, proposal!.id, 'decline')).toBe('PROPOSAL_DECIDED');
    expect(agentTasks.list(scope)).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ actor: 'owner', outcome: 'approved', approval: 'approved', link: `shannon-task://${started.task!.id}` });
  });

  it('creates no task when the owner declines', () => {
    const { service, agentTasks } = harness();
    const { proposal } = service.proposeAgentTask(scope, draft);
    const declined = service.decideProposal(scope, proposal!.id, 'decline');
    expect(typeof declined === 'object' && declined.overview.proposals[0]!.status).toBe('declined');
    expect(agentTasks.list(scope)).toEqual([]);
    expect(service.decideProposal(scope, 'missing', 'start')).toBe('PROPOSAL_NOT_FOUND');
  });

  it('never turns a forbidden or paused request into a proposal', () => {
    const { service, agentTasks } = harness();
    service.setPaused(scope, true);
    expect(service.proposeAgentTask(scope, draft).proposal).toBeUndefined();
    service.setPaused(scope, false);
    expect(service.proposeAgentTask(scope, { ...draft, paths: ['relative/path.ts'] }).proposal).toBeUndefined();
    expect(service.proposeAgentTask(scope, { ...draft, title: '' }).proposal).toBeUndefined();
    expect(service.overview(scope).proposals).toEqual([]);
    expect(agentTasks.list(scope)).toEqual([]);
  });

  it('has no path from an allowed decision to a started task', () => {
    const { service, agentTasks } = harness();
    for (let index = 0; index < 5; index += 1) {
      const decision = service.authorize(scope, { domain: 'vm_workspace', summary: '道具を作ります。', paths: [`/srv/shannon-workspace/tools/tool-${index}.mjs`] });
      service.recordAction(scope, { decisionId: decision.activityId, summary: '道具を作りました。', outcome: 'done' });
    }
    expect(agentTasks.list(scope)).toEqual([]);
  });
});
