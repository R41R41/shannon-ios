import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { InMemoryAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { executiveRouteWiring } from '../src/wiring/executiveRouteWiring.js';
import { SHANNON_TOOLS } from '../src/mind/tools/shannonTools.js';
import { capabilityOfOwnTimeAction } from '../src/mind/action/executive/capabilityCatalog.js';

const scope = 'owner';
const directory = mkdtempSync(join(tmpdir(), 'shannon-executive-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function world() {
  const clock = { at: '2026-10-13T01:00:00.000Z' };
  const store = new SQLiteAutonomyStore(':memory:');
  const config = configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true' });
  const service = new ShannonAutonomyService({ store, config, now: () => clock.at, agentTasks: new InMemoryAgentTaskStore(), defaultThread: () => 'thread-1' });
  const routes = executiveRouteWiring({
    path: join(directory, 'missing.sqlite'), ownerScope: scope, now: () => clock.at, store: { valueVersions: () => null } as never,
    autonomy: service, autonomyStore: store, config,
  });
  const call = (method: string, path: string, principal: { scopeKey: string } | null = { scopeKey: scope }, query = '') =>
    routes.dispatch({ method, path, query: new URLSearchParams(query), body: method === 'POST' ? { scopeKey: scope } : undefined }, principal) as { status: number; body: any };
  const database = (store as unknown as { database: DatabaseSync }).database;
  const add = (title: string) => service.addPursuit(scope, { kind: 'work', title, why: '書きたいからです。', origin: 'self' }).pursuit!;
  const events = (kind?: string) => store.pursuits.goals.events(scope, { limit: 200 }).filter(event => !kind || event.kind === kind);
  return { clock, store, service, call, database, add, events };
}

describe('goals: only evidence or the owner closes a goal (ADR-0009 stage 2, E2)', () => {
  it('keeps a goal open when the old loop asks for done, and records her proposal', () => {
    const { service, add, events, store } = world();
    const goal = add('雨の日の物語');
    expect(store.pursuits.goals.columns(scope).get(goal.id)).toMatchObject({ sourceKind: 'self', progress: 0, reviewAt: '2026-10-20T01:00:00.000Z' });
    const result = service.updatePursuit(scope, goal.id, { status: 'done' });
    expect(result.pursuit?.status).toBe('resting');
    expect(events('propose_complete')).toHaveLength(1);
    expect(store.pursuits.goals.columns(scope).get(goal.id)?.closedReason).toBe('proposed_complete');
    // Asked again, it is not proposed twice.
    service.updatePursuit(scope, goal.id, { status: 'done' });
    expect(events('propose_complete')).toHaveLength(1);
    expect(service.activityDays(scope, 1)[0]!.entries[0]!.summary).toBe('やりたいこと「雨の日の物語」をやり終えたと考えました（確かめが済むまで休ませます）。');
  });

  it('completes a goal when evidence meets its predicate, and not before', () => {
    const { add, store } = world();
    const goal = add('メモを集める');
    expect(store.pursuits.goals.completeWithEvidence(scope, goal.id, [], '2026-10-13T02:00:00.000Z')).toMatchObject({ met: false });
    store.pursuits.goals.setPredicate(scope, goal.id, { type: 'notes_count', n: 2 }, 'shannon', '2026-10-13T02:00:00.000Z');
    const note = (ref: string) => ({ kind: 'note_written' as const, ref, at: '2026-10-13T02:00:00.000Z' });
    expect(store.pursuits.goals.completeWithEvidence(scope, goal.id, [note('a')], '2026-10-13T02:00:00.000Z')).toMatchObject({ met: false, progress: 0.5 });
    expect(store.pursuits.get(scope, goal.id)?.status).toBe('active');
    expect(store.pursuits.goals.completeWithEvidence(scope, goal.id, [note('b')], '2026-10-13T03:00:00.000Z')).toMatchObject({ met: true });
    expect(store.pursuits.get(scope, goal.id)?.status).toBe('done');
    expect(store.pursuits.goals.columns(scope).get(goal.id)).toMatchObject({ closedReason: 'evidence', progress: 1 });
  });

  it('keeps eight goals active: a new one stays active and the least recently worked rests', () => {
    const { add, store, events, clock } = world();
    const goals = Array.from({ length: 9 }, (_, index) => { clock.at = `2026-10-13T0${index}:00:00.000Z`; return add(`目標${index}`); });
    const statuses = store.pursuits.list(scope, clock.at).filter(item => item.origin !== 'seed');
    expect(statuses.filter(item => item.status === 'active')).toHaveLength(8);
    expect(store.pursuits.get(scope, goals[8]!.id)?.status).toBe('active');
    expect(store.pursuits.get(scope, goals[0]!.id)?.status).toBe('resting');
    expect(store.pursuits.goals.columns(scope).get(goals[0]!.id)?.closedReason).toBe('cap');
    expect(events('capped')).toHaveLength(1);
  });

  it('migrates existing pursuits once: reviews over seven days, progress, last work, the active cap, legacy closes', () => {
    const { store, database } = world();
    const insert = database.prepare(`INSERT INTO autonomy_pursuits (scope_key, pursuit_id, kind, title, why, status, origin, links_json, created_at, updated_at)
      VALUES (?, ?, 'work', ?, 'x', ?, 'self', '[]', ?, ?)`);
    for (let index = 0; index < 12; index += 1) {
      const created = `2026-09-${String(index + 10).padStart(2, '0')}T00:00:00.000Z`;
      insert.run(scope, `p${index}`, `目標${index}`, index < 10 ? 'active' : 'resting', created, created);
    }
    insert.run(scope, 'closed', '終えた', 'done', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
    // p0 (the oldest) was worked on most recently: it stays active although it is the oldest.
    database.prepare(`INSERT INTO study_pieces (scope_key, piece_id, kind, title, body, status, version, readable_version, pursuit_id, created_at, updated_at)
      VALUES (?, 'piece', 'story', 't', 'b', 'shown', 2, 2, 'p0', ?, ?)`).run(scope, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
    // A database of before E2: the table without the goal columns, and no mark (the store made nothing for seeds alone).
    expect(database.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'autonomy_pursuit_marks'`).get()).toBeUndefined();
    const at = '2026-10-13T00:00:00.000Z';
    expect(store.pursuits.migrateGoals(at)).toEqual({ scopes: 1, reviewed: 12, capped: 2, closed: 1 });
    expect(store.pursuits.migrateGoals(at)).toBeNull();
    const columns = store.pursuits.goals.columns(scope);
    expect(columns.get('p0')).toMatchObject({ reviewAt: '2026-10-13T14:00:00.000Z', progress: 0.45, lastWorkedAt: '2026-10-12T00:00:00.000Z', sourceKind: 'self' });
    expect(columns.get('p11')?.reviewAt).toBe('2026-10-20T00:00:00.000Z');
    const statuses = Object.fromEntries(store.pursuits.list(scope, at).map(item => [item.id, item.status]));
    expect(Object.values(statuses).filter(status => status === 'active')).toHaveLength(8 + 2);
    expect(statuses.p0).toBe('active');
    // Never worked on: the least recently changed rest.
    expect([statuses.p1, statuses.p2, statuses.p3]).toEqual(['resting', 'resting', 'active']);
    expect(columns.get('p2')).toMatchObject({ closedReason: 'cap' });
    expect(columns.get('closed')).toMatchObject({ closedReason: 'legacy', closedAt: '2026-09-02T00:00:00.000Z' });
    expect(store.pursuits.goals.columns(scope).get('seed-goal-moving-story')).toMatchObject({ sourceKind: 'seed', reviewAt: null });
    expect(() => database.exec(`DELETE FROM autonomy_pursuit_events`)).toThrow(/PURSUIT_EVENTS_APPEND_ONLY/u);
  });
});

describe('the owner\'s Executive routes (docs/executive-ui-contract.md)', () => {
  it('answers the owner only', () => {
    const { call } = world();
    expect(call('GET', '/v1/autonomy/goals', { scopeKey: 'guest' }).status).toBe(403);
    expect(call('GET', '/v1/autonomy/goals', null).status).toBe(403);
    expect(call('GET', '/v1/autonomy/goals', null, 'scopeKey=owner').status).toBe(200);
    expect(call('GET', '/v1/autonomy/goals', { scopeKey: scope }, 'scopeKey=guest').status).toBe(403);
  });

  it('lets the owner confirm an active or resting goal, idempotently, and rest or drop it once', () => {
    const { call, add, service, events, store } = world();
    const resting = add('休んでいる目標');
    expect(service.setPursuitStatusByOwner(scope, resting.id, 'resting')).toMatchObject({ pursuits: expect.any(Array) });
    expect(service.setPursuitStatusByOwner(scope, resting.id, 'resting')).toMatchObject({ pursuits: expect.any(Array) });
    expect(events('status')).toHaveLength(1);
    const goals = call('GET', '/v1/autonomy/goals').body;
    const item = goals.goals.find((goal: { id: string }) => goal.id === resting.id);
    expect(item).toMatchObject({ status: 'resting', closedReason: 'ライ氏が休めた', ownerCanConfirm: true, ownerCanRest: false, ownerCanDrop: true });
    expect(goals.activeLimit).toBe(8);
    const confirmed = call('POST', `/v1/autonomy/pursuits/${resting.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.goals.find((goal: { id: string }) => goal.id === resting.id)).toMatchObject({ status: 'done', closedReason: 'ライ氏が完了を認めた', progress: 1 });
    expect(call('POST', `/v1/autonomy/pursuits/${resting.id}/confirm`).status).toBe(200);
    expect(events('owner_confirmed')).toHaveLength(1);
    expect(service.activityDays(scope, 1)[0]!.entries.filter(entry => entry.summary.includes('やり終えたと認めました'))).toHaveLength(1);
    const dropped = add('やめる目標');
    service.setPursuitStatusByOwner(scope, dropped.id, 'dropped');
    expect(service.setPursuitStatusByOwner(scope, dropped.id, 'dropped')).toMatchObject({ pursuits: expect.any(Array) });
    expect(store.pursuits.goals.columns(scope).get(dropped.id)?.closedReason).toBe('owner_drop');
    expect(call('POST', `/v1/autonomy/pursuits/${dropped.id}/confirm`)).toMatchObject({ status: 409, body: { error: 'PURSUIT_CLOSED' } });
    expect(call('POST', '/v1/autonomy/pursuits/seed-goal-moving-story/confirm')).toMatchObject({ status: 409, body: { error: 'PURSUIT_SEED_IMMUTABLE' } });
    expect(call('POST', '/v1/autonomy/pursuits/missing/confirm').status).toBe(404);
    expect(call('GET', '/v1/autonomy/pursuits/x/confirm').status).toBe(405);
    const today = call('GET', '/v1/autonomy/inspection').body;
    expect(today).toMatchObject({ day: '2026-10-13', today: { goals: { created: 2, completed: 1, rested: 1, dropped: 1 }, spentYen: 0 } });
    expect(today.week.goals.created).toBe(2);
  });

  it('lists every registry tool and the activities, with policy; choices are empty before E5', () => {
    const { call } = world();
    const { capabilities } = call('GET', '/v1/autonomy/capabilities').body as { capabilities: Array<Record<string, any>> };
    const tools = capabilities.filter(item => item.layer === 'tool');
    const activities = capabilities.filter(item => item.layer === 'activity');
    expect(tools.map(item => item.id).sort()).toEqual(SHANNON_TOOLS.map(tool => `tool.${tool.name}`).sort());
    expect(activities.length).toBeGreaterThanOrEqual(10);
    for (const tool of SHANNON_TOOLS.filter(item => !item.surfaces.includes('autonomy'))) {
      expect(tools.find(item => item.id === `tool.${tool.name}`)?.policy, tool.name).toBe('owner_request_only');
    }
    expect(activities.find(item => item.id === 'minecraft.session')).toMatchObject({ policy: 'own_time', execution: 'fca', enabled: false, blockedBy: ['executive_on'] });
    expect(activities.find(item => item.id === 'self.improve')?.permission).toEqual({ gateDomain: 'vm_workspace', policy: 'propose_only' });
    expect(activities.find(item => item.id === 'create.story')).toMatchObject({ enabled: true, value: null, uses7d: 0 });
    expect(['draft', 'reach_out', 'call', 'look', 'show', 'rest', 'aetherFolder.create'].map(capabilityOfOwnTimeAction))
      .toEqual(['create.story', 'notify.text', 'notify.call', 'look.room', 'show.piece', 'rest', 'aether.write']);
    expect(call('GET', '/v1/autonomy/choices', undefined, 'days=7').body).toMatchObject({ days: 7, choices: [] });
    expect(call('GET', '/v1/autonomy/choices', undefined, 'days=31').status).toBe(400);
  });
});
