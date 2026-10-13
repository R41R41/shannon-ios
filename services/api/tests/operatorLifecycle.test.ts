import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredMinecraftLifecycle } from '../src/wiring/minecraftLifecycleWiring.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import type { LifecycleSettlement } from '../src/wiring/minecraftLifecycleRunner.js';
import type { MinecraftLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';
import { actionHarness } from './support/actionThreadHarness.js';

// The operator's lifecycle operation (2026-10-14) runs the conversation's detached path, allowed only by its own audit row.
const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const finish of close.splice(0).reverse()) await finish(); });
const values = { SHANNON_MINECRAFT_LIFECYCLE: 'on', SHANNON_ADR8_STAGE4: 'on', SHANNON_MINECRAFT_LIFECYCLE_SERVERS: '["home"]',
  SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'operator', servers: [{ serverId: 'home', title: 'Home',
    ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146', onlineMode: true }] }) };

async function until(test: () => boolean) {
  for (let index = 0; index < 500; index += 1) {
    if (test()) return;
    await delay(2);
  }
  expect(test()).toBe(true);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-operator-lifecycle-')), path = join(directory, 'store.sqlite');
  close.push(() => rmSync(directory, { recursive: true, force: true }));
  let at = '2026-10-14T07:00:00.000Z', alone = true, sequence = 0;
  const store = new SQLiteAutonomyStore(path);
  close.push(() => store.close());
  const autonomy = new ShannonAutonomyService({ store, config: configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true' }), now: () => at });
  const h = actionHarness(() => at, path);
  close.push(h.close);
  const auditDb = new DatabaseSync(path);
  close.push(() => auditDb.close());
  const audit = new OperatorAuditStore(auditDb);
  const configured = configuredMinecraftLifecycle(values, { path, autonomy, actions: h.actions, ownerAlone: () => alone,
    taskAllowed: () => false, now: () => at })!;
  close.push(async () => {
    const ticking = setInterval(() => { at = new Date(Date.parse(at) + 1000).toISOString(); }, 20);
    try {
      await configured.close();
    } finally {
      clearInterval(ticking);
    }
  });
  const principal = { scopeKey: 'owner', deviceId: 'operator' };
  const state = (patch: Partial<MinecraftLifecycleState> = {}): MinecraftLifecycleState =>
    ({ serverId: 'home', observedAt: at, running: 'running', bot: 'absent', otherPlayers: 0, ...patch });
  const poll = (receipts: never[] = []) => configured.service.poll(principal, { schemaVersion: 1, connectionId: 'connection',
    sequence: sequence++, states: [state()], receipts });
  poll();
  const invoke = (id: string, action = 'login') => audit.append({ operationId: id, scopeKey: 'owner', at, operator: 'ops', command: 'lifecycle',
    event: 'invoked', code: 'invoked', argsJson: '{}', action, serverId: 'home' });
  return { ...h, configured, poll, invoke, at: () => at, alone(value: boolean) { alone = value; } };
}

describe('an operator lifecycle operation', () => {
  it('is carried out under its own Minecraft action when the audit shows the operator invoked it', async () => {
    const f = fixture(), id = `operator:${randomUUID()}`, settled: LifecycleSettlement[] = [];
    f.invoke(id);
    const admission = await f.configured.operator.execute({ id, serverId: 'home', action: 'login' }, value => settled.push(value));
    expect(admission).toMatchObject({ ok: true, lifecycleId: id });
    await until(() => f.configured.service.store.pending().length === 1);
    const command = f.poll().commands[0]!;
    expect(command).toMatchObject({ id, action: 'login', serverId: 'home' });
    expect(command.authority.sourceIds).toEqual([id]);
    expect(f.store.get(command.authority.executionId)).toMatchObject({ kind: 'minecraft', origin: 'owner_request', sourceId: id });
    f.poll([{ id, connectionId: command.connectionId, serverId: 'home', action: 'login', outcome: 'completed', code: 'changed',
      observedAt: f.at(), inputsReleased: true, state: { serverId: 'home', observedAt: f.at(), running: 'running', bot: 'joined', otherPlayers: 0 } }] as never);
    await until(() => settled.length === 1);
    expect(settled[0]).toMatchObject({ issued: true, receipt: { outcome: 'completed' } });
  });

  it('is refused without the audit row, for another action than invoked, and while someone else is present', async () => {
    const f = fixture(), id = `operator:${randomUUID()}`;
    expect(await f.configured.operator.execute({ id, serverId: 'home', action: 'login' }, () => {})).toMatchObject({ ok: false, code: 'refused' });
    const changed = `operator:${randomUUID()}`;
    f.invoke(changed, 'logout');
    expect(await f.configured.operator.execute({ id: changed, serverId: 'home', action: 'login' }, () => {}))
      .toMatchObject({ ok: false, code: 'refused' });
    const other = `operator:${randomUUID()}`;
    f.invoke(other);
    f.alone(false);
    expect(await f.configured.operator.execute({ id: other, serverId: 'home', action: 'login' }, () => {})).toMatchObject({ ok: false, code: 'owner_not_alone' });
    expect(await f.configured.operator.execute({ id: 'operator:not-a-uuid', serverId: 'home', action: 'login' }, () => {}))
      .toMatchObject({ ok: false, code: 'invalid_input' });
    expect(f.configured.service.store.pending()).toEqual([]);
  });
});
