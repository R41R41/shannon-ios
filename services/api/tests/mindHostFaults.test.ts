import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, createInitialCompanionState } from '@shannon/cognition';
import { textPerception } from '../src/mind/perception/perceptionPorts.js';
import { MIND_HOST_LIMITS, createMindHost } from '../src/mind/workspace/workspacePorts.js';
import { SQLiteWorkspaceJournal } from '../src/mind/workspace/store/workspaceJournalStore.js';
import { MIND_WORLD_START, mindWorld } from './support/mindWorld.js';
import { configuredMind } from '../src/wiring/mindWiring.js';
import { withMindOps } from '../src/wiring/mindOpsWiring.js';

/**
 * Syzygy ADR-0008 stage 3, step F3: the mind's fault circuit. A fault falls back to the switched-off path (no item, no block) and
 * writes a `mind_fault` trace; three faults within 10 minutes open the circuit until the process restarts.
 */
const MINUTE = 60_000;
const directory = mkdtempSync(join(tmpdir(), 'shannon-mind-faults-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const brokenStore = { experiencesById: () => { throw new TypeError('broken'); } } as never;

describe('the mind\'s fault circuit', () => {
  it('falls back to the switched-off path with a trace, and opens after three faults within 10 minutes until restart', () => {
    const path = join(directory, 'faults.sqlite');
    const clock = { at: Date.parse(MIND_WORLD_START) };
    const now = () => new Date(clock.at).toISOString();
    const database = new DatabaseSync(path);
    const logs: string[] = [];
    const make = () => createMindHost({ switches: { attention: true, workspace: true, dataFrames: true }, now, schedule: task => task(), log: line => logs.push(line),
      journal: new SQLiteWorkspaceJournal(database, { createSchema: true }), inbox: null });
    const host = make();
    const start = now();
    const turn = (store: unknown, at = now()) => ({ scopeKey: 'owner', surface: 'text' as const, present: OWNER_AUDIENCE, at, currentItemId: null, current: null,
      snapshot: createInitialCompanionState('owner', now()), store: store as never });
    host.perceive('owner', textPerception({ threadId: 'other', message: 'ねえ', present: OWNER_AUDIENCE, alone: true, at: now() }));
    host.bind('owner', host.view('owner', now()).held[0]!.id, 'experience:turn-1');
    host.turnEnded();
    expect(host.render(turn(null))).toContain('[いまの場]');
    // A fault: the render answers the off path, and a trace is written (closed values only).
    expect(host.render(turn(brokenStore))).toBe('');
    const traces = () => database.prepare(`SELECT data_json FROM mind_workspace_journal WHERE op = 'mind_fault'`).all() as Array<{ data_json: string }>;
    expect(traces().map(row => JSON.parse(row.data_json))).toEqual([{ stage: 'render', error: 'TypeError', open: false }]);
    expect(host.faulted).toBe(false);
    clock.at += 4 * MINUTE;
    expect(host.render(turn(brokenStore))).toBe('');
    // Eleven minutes after the first, two within the window: still closed.
    clock.at += 7 * MINUTE;
    expect(host.render(turn(brokenStore))).toBe('');
    expect(host.faulted).toBe(false);
    clock.at += MINUTE;
    expect(host.render(turn(brokenStore))).toBe('');
    expect(host.faulted).toBe(true);
    expect(traces().at(-1)!.data_json).toContain('"open":true');
    expect(logs.at(-1)).toBe('mind_fault stage=render error=TypeError circuit=open');
    // Open: everything answers the off path, whatever the input, until the process restarts.
    expect(host.perceive('owner', textPerception({ threadId: 'other', message: 'まだいる？', present: OWNER_AUDIENCE, alone: true, at: now() }))).toBeNull();
    expect(host.render(turn(null))).toBe('');
    clock.at += MIND_HOST_LIMITS.faultWindowMilliseconds * 3;
    expect(host.render(turn(null))).toBe('');
    // A new process starts closed, with the workspace it had.
    const next = make();
    expect(next.faulted).toBe(false);
    expect(next.render(turn(null, start))).toContain('[いまの場]');
    database.close();
  });

  it('gives the turn the prompt it would have without the mind while the circuit is open', async () => {
    const steps = async (world: ReturnType<typeof mindWorld>) => {
      await world.speak('シャノン、木材を集めておいてね');
      world.advance(MINUTE);
      await world.chat('ただいま');
      return world.lastContext();
    };
    const off = mindWorld({ SHANNON_ADR8_STAGE3: 'off' }, 'faults-off');
    const expected = await steps(off);
    const faulted = mindWorld({ SHANNON_ADR8_STAGE3: 'on' }, 'faults-on');
    const host = faulted.mind!.host!;
    // Something to render, so that a broken store faults.
    const item = host.perceive('owner', textPerception({ threadId: 'elsewhere', message: 'ねえ', present: OWNER_AUDIENCE, alone: true, at: faulted.now() }))!;
    host.bind('owner', item.itemId, 'experience:elsewhere-1');
    for (let index = 0; index < MIND_HOST_LIMITS.faultsToOpen; index += 1) {
      host.render({ scopeKey: 'owner', surface: 'text', present: OWNER_AUDIENCE, at: faulted.now(), currentItemId: null, current: null,
        snapshot: faulted.store.snapshot('owner'), store: brokenStore });
    }
    expect(host.faulted).toBe(true);
    const context = await steps(faulted);
    expect(context).not.toContain('[いまの場]');
    expect(context).toBe(expected);
    await off.close(); await faulted.close();
  });

  it('keeps a batch whose write failed, and does not count a busy database as a fault (review: journal)', () => {
    const path = join(directory, 'requeue.sqlite');
    const database = new DatabaseSync(path);
    const journal = new SQLiteWorkspaceJournal(database, { createSchema: true });
    const failures: Error[] = [];
    const append = journal.append.bind(journal);
    journal.append = rows => { const failure = failures.shift(); if (failure) throw failure; return append(rows); };
    const host = createMindHost({ switches: { attention: true, workspace: true, dataFrames: true }, now: () => MIND_WORLD_START, schedule: task => task(), journal, inbox: null });
    const perceived = () => (database.prepare(`SELECT COUNT(*) AS rows FROM mind_workspace_journal WHERE op = 'perceive'`).get() as { rows: number }).rows;
    const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
    failures.push(busy, busy);
    host.perceive('owner', textPerception({ threadId: 't', message: 'ひとつめ', present: OWNER_AUDIENCE, alone: true, at: MIND_WORLD_START }));
    host.turnEnded();
    host.perceive('owner', textPerception({ threadId: 't', message: 'ふたつめ', present: OWNER_AUDIENCE, alone: true, at: MIND_WORLD_START }));
    host.tick();
    expect(perceived()).toBe(0);
    expect([host.faulted, host.faultCount, host.busyCount]).toEqual([false, 0, 2]);
    host.tick();
    expect(perceived()).toBe(2);
    // Any other failure is a fault, and its batch is still kept.
    failures.push(new TypeError('disk'));
    host.perceive('owner', textPerception({ threadId: 't', message: 'みっつめ', present: OWNER_AUDIENCE, alone: true, at: MIND_WORLD_START }));
    host.tick();
    expect([host.faulted, host.faultCount, perceived()]).toEqual([false, 1, 2]);
    host.tick();
    expect(perceived()).toBe(3);
    database.close();
  });

  it('waits 250 ms on the journal connection, and a write lock held by another process only delays the batch', () => {
    const path = join(directory, 'locked.sqlite');
    const wired = configuredMind({ SHANNON_ADR8_STAGE3: 'on' }, { databasePath: path, now: () => MIND_WORLD_START })!;
    const host = wired.host!;
    const other = new DatabaseSync(path);
    other.exec('PRAGMA busy_timeout = 5000;');
    host.perceive('owner', textPerception({ threadId: 't', message: 'ねえ', present: OWNER_AUDIENCE, alone: true, at: MIND_WORLD_START }));
    other.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    host.tick();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect([host.faulted, host.faultCount, host.busyCount]).toEqual([false, 0, 1]);
    other.exec('COMMIT');
    host.tick();
    expect((other.prepare(`SELECT COUNT(*) AS rows FROM mind_workspace_journal WHERE op = 'perceive'`).get() as { rows: number }).rows).toBe(1);
    other.close(); wired.close();
  });

  it('shows the owner the circuit and the outbox backlog in /v1/ops, and nothing with stage 3 off', () => {
    const server = { revision: 'r' };
    const host = { faulted: false, faultCount: 1, busyCount: 2 };
    const outbox = { backlog: () => ({ pending: 3, oldestPendingSeconds: 40, failed: 0 }) };
    expect(withMindOps(server, { host, outbox, now: () => MIND_WORLD_START })).toEqual({ revision: 'r', mind: {
      workspace: { faulted: false, faults: 1, busyWrites: 2 }, memoryOutbox: { pending: 3, oldestPendingSeconds: 40, failed: 0 } } });
    expect(withMindOps(null, { host, outbox, now: () => MIND_WORLD_START })).toBeNull();
    expect(withMindOps(server, { host: null, outbox: null, now: () => MIND_WORLD_START })).toBe(server);
    expect(withMindOps(server, { host: null, outbox: { backlog: () => { throw new Error('x'); } }, now: () => MIND_WORLD_START }))
      .toEqual({ revision: 'r', mind: { workspace: null, memoryOutbox: null } });
  });
});
