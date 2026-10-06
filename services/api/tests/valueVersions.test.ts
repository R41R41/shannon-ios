import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { foldValues, valueCells, valueOf } from '@shannon/learning';
import { SQLiteAutonomyStore } from '../src/mind/action/ownTime/store/autonomyStore.js';
import { createValuesRoute, ownerValueRecorder } from '../src/infra/http/learningRoutes.js';
import { ledgerPredictionTap } from '../src/mind/learning/predictionLedgerTaps.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';

/**
 * The value table's versions (Syzygy ADR-0008 stage 1, `docs/cognition-ledger-contract.md`): nightly versions from settled
 * choices, V read from the active version, the owner's rollback (identical cells, frozen) and resume, the route and the command
 * line, and each control in the activity record.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-value-versions-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const DAY = 24 * 60 * 60_000;
const START = Date.parse('2026-10-07T03:00:00.000Z');
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
let files = 0;
let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

function harness() {
  const path = join(directory, `values-${files += 1}.sqlite`);
  const store = new SQLiteShannonStore({ path, now: () => at(0), predictionLedger: true, choiceLedger: true, cognitionDefer: task => task(), predictionShadowDefer: task => task() });
  const predictions = store.predictionLedger()!;
  const choices = store.choiceLedger()!;
  const values = store.valueVersions()!;
  const tap = ledgerPredictionTap(predictions, { reachOut: () => undefined }, { ledger: choices, presence: () => 'alone' });
  let step = 0;
  /** One step of hers, done or failed, `minutes` after the start. */
  const choose = (kind: string, outcome: 'done' | 'failed', minutes: number) => {
    const stepId = `step-${step += 1}`;
    tap.chose('owner', { stepId, kind }, at(minutes));
    tap.reported('owner', { stepId, outcome, costYen: 4 }, at(minutes + 1));
    return choices.rows('owner').find(row => row.sourceId === stepId)!;
  };
  return { path, store, predictions, choices, values, choose };
}

describe('the value table\'s versions', () => {
  it('writes a version at night from what was settled, and a later choice reads its V from it', () => {
    const { values, choose, store } = harness();
    for (let index = 0; index < 6; index += 1) choose('note', 'done', index * 10);
    const first = choose('note', 'done', 70);
    expect(first).toMatchObject({ valueVersion: 'initial', expected: 0, expectedLevel: 'root' });
    expect(values.nightly('owner', at(100))).toMatchObject({ decision: 'snapshot' });
    const active = values.overview('owner').active!;
    expect(active).toMatchObject({ madeBy: 'sleep', evidenceFrom: 1, evidenceTo: 7, frozen: false, formula: 'r1' });
    const later = choose('note', 'done', 120);
    expect(later).toMatchObject({ valueVersion: active.versionId, expectedLevel: 'presence' });
    expect(later.expected).toBeGreaterThan(0.1);
    // Nothing new settled: no new version; one more choice: a new one.
    expect(values.nightly('owner', at(130))).toMatchObject({ decision: 'snapshot' });
    expect(values.nightly('owner', at(140))).toMatchObject({ decision: 'unchanged' });
    store.close();
  });

  it('rolls back to identical cells, freezes the evidence after it until resumed, and resumes from all the evidence', () => {
    const { values, choose, choices, store } = harness();
    for (let index = 0; index < 4; index += 1) choose('read', 'done', index);
    values.nightly('owner', at(10));
    const earlier = values.overview('owner').active!;
    for (let index = 0; index < 4; index += 1) choose('read', 'failed', 20 + index);
    values.nightly('owner', at(30));
    const later = values.overview('owner').active!;
    expect(later.evidenceTo).toBe(8);
    const rolled = values.rollback('owner', at(40));
    if (typeof rolled === 'string') throw new Error(rolled);
    expect(rolled).toMatchObject({ madeBy: 'owner_rollback', baseVersion: earlier.versionId, evidenceTo: earlier.evidenceTo, frozen: true });
    expect(values.store.cells(rolled.versionId)).toEqual(values.store.cells(earlier.versionId));
    expect(choose('read', 'done', 50).expected).toBeCloseTo(valueOf(values.store.cells(earlier.versionId), 'read', 'afternoon.alone', earlier.versionId).mean, 5);
    // Frozen: new evidence makes no version at night.
    expect(values.nightly('owner', at(60))).toMatchObject({ decision: 'frozen' });
    expect(values.resume('owner', at(70))).toMatchObject({ madeBy: 'owner_resume', frozen: false, evidenceTo: 9 });
    expect(values.resume('owner', at(71))).toBe('VALUES_NOT_FROZEN');
    const evidence = choices.store.settledInOrder('owner').map(row => ({ choice: row.choice, context: row.context, reward: row.reward!, world: row.world!, serve: row.serve!, growth: row.growth!, costYen: row.costYen, settledAt: row.settledAt! }));
    const resumed = values.overview('owner').active!;
    expect(values.store.cells(resumed.versionId).map(cell => [cell.level, cell.choice, cell.n, Number(cell.mean.toFixed(6))]))
      .toEqual(valueCells(foldValues(evidence)).map(cell => [cell.level, cell.choice, cell.n, Number(cell.mean.toFixed(6))]));
    store.close();
  });

  it('keeps nightly versions 30 days, the active one and the owner\'s always', () => {
    const { values, choose, store } = harness();
    choose('read', 'done', 0);
    values.nightly('owner', at(1));
    choose('read', 'done', 2);
    values.nightly('owner', at(3));
    const rolled = values.rollback('owner', at(4));
    if (typeof rolled === 'string') throw new Error(rolled);
    values.resume('owner', at(5));
    expect(values.nightly('owner', new Date(START + 40 * DAY).toISOString()).pruned).toBe(2);
    expect(values.overview('owner').versions.map(version => version.madeBy)).toEqual(['owner_rollback', 'owner_resume']);
    store.close();
  });
});

async function serve(route: ReturnType<typeof createValuesRoute>, scopeKey: string | null) {
  server = createServer((request, response) => { void route(request, response, scopeKey ? { scopeKey } : null, new URL(request.url ?? '/', 'http://x').pathname); });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((done, fail) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json' } }, response => {
      let text = '';
      response.on('data', chunk => { text += String(chunk); });
      response.on('end', () => done({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
    });
    request.on('error', fail);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe('the owner\'s route and command line', () => {
  it('shows the table to the owner only, and writes each control to the activity record', async () => {
    const { path, store, values, predictions, choices, choose } = harness();
    choose('read', 'done', 0);
    values.nightly('owner', at(1));
    choose('read', 'failed', 2);
    values.nightly('owner', at(3));
    const autonomy = new SQLiteAutonomyStore(path);
    const config = configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true' });
    const dependencies = {
      values, calibration: (scopeKey: string) => predictions.calibration(scopeKey), choices: (scopeKey: string) => choices.store.counts(scopeKey),
      record: ownerValueRecorder(autonomy.activity, config), ownerScopeKey: 'owner', now: () => at(10),
    };
    const call = await serve(createValuesRoute(dependencies), 'owner');
    const view = await call('GET', '/v1/autonomy/values');
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ frozen: false, choices: { settled: 2, pending: 0, void: 0 } });
    expect((view.body.cells as unknown[]).length).toBeGreaterThan(0);
    expect((view.body.calibration as { domains: unknown[] }).domains.length).toBeGreaterThan(0);
    expect((await call('POST', '/v1/autonomy/values')).status).toBe(405);
    expect((await call('POST', '/v1/autonomy/values/rollback', { versionId: 'not an id' })).status).toBe(400);
    expect(await call('POST', '/v1/autonomy/values/resume')).toEqual({ status: 409, body: { error: 'VALUES_NOT_FROZEN' } });
    expect((await call('POST', '/v1/autonomy/values/rollback', {})).body).toMatchObject({ frozen: true });
    expect((await call('POST', '/v1/autonomy/values/resume')).body).toMatchObject({ frozen: false });
    const entries = autonomy.activity.days('owner').flatMap(day => day.entries).filter(entry => entry.tool?.startsWith('values.'));
    expect(entries.map(entry => [entry.actor, entry.kind, entry.tool, entry.outcome]).sort()).toEqual([
      ['owner', 'control', 'values.resume', 'recorded'], ['owner', 'control', 'values.rollback', 'recorded'],
    ]);
    server?.close();
    const stranger = await serve(createValuesRoute(dependencies), 'guest');
    expect((await stranger('GET', '/v1/autonomy/values')).status).toBe(403);
    server?.close();
    const off = await serve(createValuesRoute({ ...dependencies, values: null }), 'owner');
    expect((await off('GET', '/v1/autonomy/values')).body).toMatchObject({ error: 'VALUES_DISABLED' });
    autonomy.close();

    // The command line gives the same view and records its controls the same way.
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, '../scripts/shannon-values.ts'), ...args, '--database', path, '--scope', 'owner'],
      { cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8' });
    const shown = run('show');
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ frozen: false, choices: { settled: 2 } });
    expect(run('rollback').status).toBe(0);
    expect(run('rollback', '--version', 'missing').stderr).toContain('VALUES_VERSION_NOT_FOUND');
    expect(JSON.parse(run('resume').stdout)).toMatchObject({ frozen: false });
    const after = new SQLiteAutonomyStore(path);
    expect(after.activity.days('owner').flatMap(day => day.entries).filter(entry => entry.tool?.startsWith('values.')).length).toBe(4);
    after.close();
    store.close();
  }, 60_000);
});
