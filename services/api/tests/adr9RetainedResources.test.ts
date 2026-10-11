import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ACTION_LIMITS } from '@shannon/mind';
import { SQLiteActionStore, type ActionResourceRetained } from '../src/mind/action/threads/store/actionStore.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { configuredRetainedResources } from '../src/wiring/configuredActionResourceProof.js';
import { knownAgentHostIds } from '../src/mind/action/agentTasks/store/agentHostIds.js';

/** ADR-0009 §9 follow-up (i): Agent Host locks with their folder locks, and a base Minecraft body, wait for a release proof. */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

const OWNER = 'owner';
const mac = actionResource('shannon-mac', 'agent-host');
const cloud = actionResource('shannon-cloud', 'agent-host');
const folderMac = actionResource(OWNER, 'folder:mac');
const body = actionResource('minebot', 'minecraft-body');

function clock() {
  let time = Date.parse('2026-10-12T00:00:00.000Z');
  return { now: () => new Date(time).toISOString(), advance: (milliseconds: number) => { time += milliseconds; } };
}

function store(retained: ActionResourceRetained, proof: () => boolean = () => false) {
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  return new SQLiteActionStore(db, proof, retained);
}

const server = { serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' };
const values = { SHANNON_MINECRAFT_LIFECYCLE: 'on', SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [server] }) };

/** Claims, dispatches and lets the lease and the unknown deadline pass: the action is unknown with its slot released. */
function strandPastRelease(actions: SQLiteActionStore, c: ReturnType<typeof clock>, kind: 'agentTask' | 'minecraft' | 'ownTime',
  source: string, base: string[], added: string[] = []) {
  const origin = kind === 'ownTime' ? 'own_time' : 'owner_request';
  const queued = actions.enqueue({ scopeKey: OWNER, kind, origin, sourceId: source, resources: base }, c.now());
  const lease = leaseOf(actions.claim(queued.id, 'runner', c.now())!);
  expect(actions.dispatch(lease, c.now(), added)).toBe(true);
  c.advance(ACTION_LIMITS.leaseMs + 1);
  actions.transaction(() => actions.sweep(c.now()));
  c.advance(ACTION_LIMITS.unknownReleaseMs);
  actions.transaction(() => actions.sweep(c.now()));
  expect(actions.get(lease.id)).toMatchObject({ state: 'unknown', sent: false, result: 'unknown_expired' });
  return lease;
}

function claimable(actions: SQLiteActionStore, c: ReturnType<typeof clock>, source: string, resources: string[]): boolean {
  const next = actions.enqueue({ scopeKey: OWNER, kind: 'agentTask', origin: 'owner_request', sourceId: source, resources }, c.now());
  const view = actions.claim(next.id, 'runner', c.now());
  if (view) actions.finish(leaseOf(view), 'completed', 'done', c.now());
  return view !== null;
}

describe('retained resources after the unknown release', () => {
  it('holds an Agent Host lock and its folder lock until the Host\'s canonical report closes the task', () => {
    const c = clock();
    const actions = store(configuredRetainedResources(values, () => ['shannon-mac', 'shannon-cloud']));
    const lease = strandPastRelease(actions, c, 'agentTask', 'codex-task', [mac, folderMac]);
    expect(claimable(actions, c, 'same-host', [mac])).toBe(false);
    expect(claimable(actions, c, 'same-folder', [folderMac])).toBe(false);
    // The slot itself and another host are free.
    expect(claimable(actions, c, 'other-host', [cloud])).toBe(true);
    expect(actions.reconcile(lease, 'completed', 'host_completed', c.now())).toBe(true);
    expect(claimable(actions, c, 'after-report', [mac, folderMac])).toBe(true);
  });

  it('still releases a folder lock that a folder tool took alone, which has no proof', () => {
    const c = clock();
    const actions = store(configuredRetainedResources(values, () => ['shannon-mac']));
    strandPastRelease(actions, c, 'ownTime', 'cycle', [actionResource(OWNER, 'ownTime')], [folderMac]);
    expect(claimable(actions, c, 'folder-again', [folderMac])).toBe(true);
  });

  it('holds a base Minecraft body until its domain proof, then frees only that', () => {
    const c = clock();
    const actions = store(configuredRetainedResources(values), () => true);
    const lease = strandPastRelease(actions, c, 'minecraft', 'dig', [body]);
    expect(claimable(actions, c, 'body-again', [body])).toBe(false);
    expect(actions.reconcileResource(lease, body, 'release-proof')).toBe(true);
    expect(claimable(actions, c, 'body-after-proof', [body])).toBe(true);
    expect(actions.get(lease.id)).toMatchObject({ state: 'unknown' });
  });

  it('does not let a proof release a base resource that is not retained', () => {
    const c = clock();
    const study = actionResource(OWNER, 'study');
    const actions = store(configuredRetainedResources(values), () => true);
    const lease = strandPastRelease(actions, c, 'minecraft', 'note', [study]);
    expect(actions.reconcileResource(lease, study, 'release-proof')).toBe(false);
  });
});

describe('the retained set is built by hashing the configured names', () => {
  it('reads the registered Agent Hosts, and none before the registry exists', () => {
    const db = new DatabaseSync(':memory:');
    cleanups.push(() => db.close());
    expect(knownAgentHostIds(db)).toEqual([]);
    db.exec(`CREATE TABLE agent_hosts (host_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, last_seen_at TEXT NOT NULL);
      INSERT INTO agent_hosts VALUES ('shannon-mac', 'Mac', '2026-10-12T00:00:00Z');`);
    expect(knownAgentHostIds(db)).toEqual(['shannon-mac']);
    const retained = configuredRetainedResources({}, () => knownAgentHostIds(db));
    expect(retained(mac, [mac])).toBe(true);
    expect(retained(folderMac, [mac, folderMac])).toBe(true);
    expect(retained(folderMac, [folderMac])).toBe(false);
    expect(retained(body, [body])).toBe(false);
  });
});
