import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteTestFlightDeliveryStore } from '../src/testflightDeliveryStore.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('TestFlight delivery history', () => {
  it('starts in a waiting state before the first automatic check', () => {
    const store = new SQLiteTestFlightDeliveryStore(databasePath());
    expect(store.dashboard()).toEqual({
      condition: 'waiting',
      latestBuildVersion: null,
      lastCheckedAt: null,
      activeFailureCode: null,
      history: [],
      release: {
        platform: 'ios', buildVersion: null,
        gates: [
          { key: 'build', status: 'pending', completedAt: null },
          { key: 'archive', status: 'pending', completedAt: null },
          { key: 'upload', status: 'pending', completedAt: null },
          { key: 'processing', status: 'pending', completedAt: null },
          { key: 'assignment', status: 'pending', completedAt: null },
          { key: 'install', status: 'pending', completedAt: null },
          { key: 'smoke', status: 'pending', completedAt: null },
        ],
      },
    });
    store.close();
  });

  it('keeps the seven gates independent and persists user-confirmed install and smoke', () => {
    const path = databasePath();
    const store = new SQLiteTestFlightDeliveryStore(path);
    store.recordResult(
      { status: 'distributed', buildId: 'build-44', version: '44' },
      '2026-09-05T02:00:00.000Z',
    );
    expect(store.dashboard(30, 'owner-a').release.gates.map(gate => gate.status))
      .toEqual(['complete', 'complete', 'complete', 'complete', 'complete', 'pending', 'pending']);
    expect(() => store.confirmGate('owner-a', '44', 'smoke', '2026-09-05T02:01:00.000Z'))
      .toThrow('TESTFLIGHT_INSTALL_REQUIRED');
    store.confirmGate('owner-a', '44', 'install', '2026-09-05T02:02:00.000Z');
    store.confirmGate('owner-a', '44', 'smoke', '2026-09-05T02:03:00.000Z');
    store.close();

    const reopened = new SQLiteTestFlightDeliveryStore(path);
    expect(reopened.dashboard(30, 'owner-a').release.gates.map(gate => gate.status))
      .toEqual(Array(7).fill('complete'));
    expect(reopened.dashboard(30, 'owner-b').release.gates.slice(-2).map(gate => gate.status))
      .toEqual(['pending', 'pending']);
    reopened.close();
  });

  it('groups repeated failures into one notification episode and recovers on success', () => {
    const store = new SQLiteTestFlightDeliveryStore(databasePath());
    expect(store.recordFailure(new Error('APP_STORE_CONNECT_401'), '2026-09-05T01:00:00.000Z'))
      .toEqual({ notificationQueued: true, failureCode: 'authentication' });
    expect(store.recordFailure(new Error('APP_STORE_CONNECT_401: repeated'), '2026-09-05T01:10:00.000Z'))
      .toEqual({ notificationQueued: false, failureCode: 'authentication' });
    expect(store.dashboard()).toMatchObject({
      condition: 'attention',
      activeFailureCode: 'authentication',
      history: [
        { status: 'failed', notificationStatus: 'suppressed' },
        { status: 'failed', notificationStatus: 'pending' },
      ],
    });

    store.recordResult(
      { status: 'distributed', buildId: 'build-17', version: '17' },
      '2026-09-05T01:20:00.000Z',
    );
    const recovered = store.dashboard();
    expect(recovered).toMatchObject({
      condition: 'healthy', latestBuildVersion: '17', activeFailureCode: null,
    });
    expect(recovered.history[0]).toMatchObject({
      status: 'distributed', buildVersion: '17', notificationStatus: 'not-needed',
    });
    store.close();
  });

  it('starts a new notification episode when the failure category changes', () => {
    const store = new SQLiteTestFlightDeliveryStore(databasePath());
    expect(store.recordFailure(new Error('APP_STORE_CONNECT_401'), '2026-09-05T01:00:00.000Z').notificationQueued)
      .toBe(true);
    expect(store.recordFailure(new Error('fetch failed: network'), '2026-09-05T01:10:00.000Z'))
      .toEqual({ notificationQueued: true, failureCode: 'network' });
    expect(store.dashboard()).toMatchObject({ condition: 'attention', activeFailureCode: 'network' });
    store.close();
  });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-testflight-history-'));
  directories.push(directory);
  return join(directory, 'shannon.sqlite');
}
