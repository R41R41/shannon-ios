import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recordMindWorkerStart } from '../src/infra/ops/store/livenessStore.js';
import { startLivenessMonitor } from '../src/wiring/livenessWiring.js';
import { SQLitePushNotificationStore } from '../src/surfaces/outreach/pushNotifications.js';
import { LIVENESS_NOTICE_TITLE } from '../src/contracts/livenessNoticeContract.js';

/** ADR-0009 §9 follow-up (iii): a liveness incident reaches the owner's iPhone once per episode, through the push path. */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-liveness-notice-'));
  const path = join(directory, 'db.sqlite');
  const db = new DatabaseSync(path);
  const push = new SQLitePushNotificationStore(path);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }), () => db.close(), () => push.close());
  push.register({ deviceId: 'iphone', scopeKey: 'owner', displayName: 'iPhone' }, 'a'.repeat(64), 'production', '2026-10-11T00:00:00.000Z');
  const clock = { at: '2026-10-12T00:00:00.000Z' };
  const monitor = () => {
    const started = startLivenessMonitor({ database: db, ownerScope: 'owner', ownTimeEnabled: false, now: () => clock.at, log: () => {}, intervalMs: null });
    cleanups.push(() => started.close());
    return started;
  };
  return { db, push, clock, monitor };
}

function deliverAll(push: SQLitePushNotificationStore, at: string) {
  const sent = push.pending(at).filter(notice => notice.kind === 'liveness_incident');
  for (const notice of sent) {
    expect(push.claim(notice, at)).toBe(true);
    push.record(notice, { delivered: true, permanentFailure: false, status: 200, reason: null }, at);
  }
  return sent;
}

describe('liveness notices for the owner', () => {
  it('sends one neutral notice per incident episode, also across a server restart, and a new one for a new episode', () => {
    const h = harness();
    for (let n = 0; n < 3; n++) recordMindWorkerStart(h.db, `2026-10-11T23:${10 + n * 10}:00.000Z`);
    expect(h.monitor().check()?.incidents).toEqual(['mind_worker_restarting']);
    const first = deliverAll(h.push, h.clock.at);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ title: LIVENESS_NOTICE_TITLE, threadId: '', deviceId: 'iphone' });
    expect(first[0]!.content).toContain('再起動を繰り返しています');

    // The same episode, checked again and after a restart of the server: nothing more.
    h.clock.at = '2026-10-12T00:05:00.000Z';
    h.monitor().check();
    expect(deliverAll(h.push, h.clock.at)).toEqual([]);

    // It recovers, then begins again: a second episode, a second notice.
    h.clock.at = '2026-10-12T02:00:00.000Z';
    expect(h.monitor().check()?.incidents).toEqual([]);
    for (let n = 0; n < 3; n++) recordMindWorkerStart(h.db, `2026-10-12T02:0${n}:00.000Z`);
    h.clock.at = '2026-10-12T02:05:00.000Z';
    h.monitor().check();
    const second = deliverAll(h.push, h.clock.at);
    expect(second).toHaveLength(1);
    expect(second[0]!.initiativeId).not.toBe(first[0]!.initiativeId);
  });

  it('sends nothing while every check is quiet', () => {
    const h = harness();
    expect(h.monitor().check()?.incidents).toEqual([]);
    expect(deliverAll(h.push, h.clock.at)).toEqual([]);
  });
});
