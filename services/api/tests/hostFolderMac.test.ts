import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dispatchHostStepRequest } from '../src/apiAutonomyHostStepRoutes.js';
import { configuredAutonomy } from '../src/autonomyBudget.js';
import { hostFolderLabel, hostFolderPath } from '../src/autonomyHostFolderPath.js';
import { ShannonAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import type { ApiRequest, ApiResponse } from '../src/contracts.js';
import { toolSessionMemory } from '../src/shannonToolTypes.js';
import { SHANNON_TOOLS, type ToolSurface } from '../src/shannonTools.js';

/**
 * Roadmap A18 S1: her folder on the Mac beside the one on the Windows PC (`docs/host-folder-contract.md`, 「Two hosts」).
 * The binding route, the names of two hosts, the rule when both are connected and none is named (owner decision
 * 2026-10-06), and no v1 copy for a device that left `write` out of its claim. With one host nothing here changes.
 */
const scope = 'owner';
const WINDOWS = 'owner-windows';
const MAC = 'owner-mac';
const WINDOWS_DEVICE = '0123456789abcdef';
const MAC_DEVICE = 'fedcba9876543210';
const READING = ['list', 'read', 'search'];
const ALL = ['write', 'list', 'read', 'search', 'create', 'update', 'move', 'delete'];

function harness(hosts: Record<string, { deviceId: string }> = { [WINDOWS]: { deviceId: WINDOWS_DEVICE }, [MAC]: { deviceId: MAC_DEVICE } }) {
  const store = new SQLiteAutonomyStore(':memory:');
  const service = new ShannonAutonomyService({
    store, now: () => new Date().toISOString(),
    config: configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true', SHANNON_AUTONOMY_HOST_FOLDERS_JSON: JSON.stringify(hosts) }),
  });
  const memory = toolSessionMemory();
  const call = (name: string, input: Record<string, unknown>, surface: ToolSurface = 'text') =>
    service.tools.call(name, JSON.stringify(input), { scopeKey: scope, surface, audience: 'owner_alone', memory });
  const route = async (request: { method: ApiRequest['method']; path: string; body?: Record<string, unknown>; query?: URLSearchParams }, deviceId?: string): Promise<ApiResponse> =>
    await dispatchHostStepRequest({ ...request, ...(deviceId ? { deviceId } : {}) }, service.folder, service.folderOperations);
  const claim = (host: string, deviceId: string, operations: readonly string[], waitSeconds = 0) => route({
    method: 'POST', path: '/v1/autonomy/host-steps/claim', body: { scopeKey: scope, host, protocol: 2, operations, waitSeconds, localStop: false },
  }, deviceId);
  /** A device that holds a long-poll open and answers one step with an empty listing. */
  const answerOne = async (host: string, deviceId: string) => {
    for (;;) {
      const step = ((await claim(host, deviceId, READING, 3)).body as { step: { id: string; operation: string } | null }).step;
      if (!step) continue;
      await route({ method: 'POST', path: `/v1/autonomy/host-steps/${step.id}/report`, body: { scopeKey: scope, outcome: 'done', result: { entries: [], truncated: false } } }, deviceId);
      return step;
    }
  };
  return { store, service, call, route, claim, answerOne };
}

describe('her folder on the Mac beside the Windows PC (A18 S1)', () => {
  it('answers each paired device with the host it is bound to, so the app does not need to know the name', async () => {
    const { route } = harness();
    const binding = (deviceId?: string, query = new URLSearchParams({ scopeKey: scope })) =>
      route({ method: 'GET', path: '/v1/autonomy/host-steps/binding', query }, deviceId);
    expect(await binding(MAC_DEVICE)).toEqual({ status: 200, body: { host: MAC, label: 'Mac' } });
    expect(await binding(WINDOWS_DEVICE)).toEqual({ status: 200, body: { host: WINDOWS, label: 'WindowsのPC' } });
    expect(await binding('1111111111111111')).toEqual({ status: 200, body: { host: null } });
    expect((await binding(undefined)).status).toBe(403);
    expect((await binding(MAC_DEVICE, new URLSearchParams())).status).toBe(400);
    expect((await route({ method: 'DELETE', path: '/v1/autonomy/host-steps/binding' }, MAC_DEVICE)).status).toBe(404);
  });

  it('plans no v1 copy for a host whose v2 claim leaves write out, and still plans one for the host that writes', async () => {
    const { store, service, claim } = harness();
    const at = new Date().toISOString();
    store.study.create(scope, { kind: 'note', title: '駅のこと', body: '夕方の駅は光が低い。' }, at);
    // Before any v2 claim both hosts keep v1's meaning.
    expect(service.folder.copyHosts(scope)).toEqual([WINDOWS, MAC]);
    await claim(MAC, MAC_DEVICE, READING);
    expect(service.folder.copyHosts(scope)).toEqual([WINDOWS]);
    await claim(WINDOWS, WINDOWS_DEVICE, ALL);
    expect(service.folder.nextCopy(scope, at)).toMatchObject({ host: WINDOWS });
    expect(() => service.folder.enqueue(scope, { host: MAC, pieceId: store.study.list(scope)[0]!.id, pieceVersion: 1 }, at)).toThrow('HOST_STEP_HOST_CANNOT_WRITE');
    // A reading-only device alone: nothing is planned at all.
    const mac = harness({ [MAC]: { deviceId: MAC_DEVICE } });
    mac.store.study.create(scope, { kind: 'note', title: '駅のこと', body: '夕方の駅は光が低い。' }, at);
    expect(mac.service.folder.available(scope, at)).toBe(true);
    await mac.claim(MAC, MAC_DEVICE, READING);
    expect(mac.service.folder.available(scope, at)).toBe(false);
    expect(mac.service.folder.nextCopy(scope, at)).toBeNull();
  });

  it('names two hosts in the tools with the names she and the owner say, and leaves one host as it was', () => {
    const two = harness().service.tools.offered('text', 'owner_alone', scope).find(tool => tool.name === 'folder.read')!;
    const host = two.input.properties.host as { description: string };
    expect(host.description).toContain('owner-windows（WindowsのPC）、owner-mac（Mac）');
    expect(host.description).toContain('ライ氏に聞いて');
    const one = harness({ [WINDOWS]: { deviceId: WINDOWS_DEVICE } }).service.tools.offered('text', 'owner_alone', scope).find(tool => tool.name === 'folder.read')!;
    expect(one.input).toEqual(SHANNON_TOOLS.find(tool => tool.name === 'folder.read')!.input);
    expect(hostFolderLabel('owner-mac')).toBe('Mac');
    expect(hostFolderLabel('studio')).toBe('studio');
  });

  it('with both registered and none named: uses the one that can be reached, and asks when both can', async () => {
    const { call, claim, answerOne } = harness();
    // Neither reachable: the failure says the folder cannot be seen now, in words for both machines.
    const none = await call('folder.list', {});
    expect(none).toMatchObject({ ok: false, failure: 'unavailable' });
    expect(none.text).toContain('PCやMacのフォルダはいま見られない');
    // Only the Mac reachable: it is used.
    await claim(MAC, MAC_DEVICE, READING);
    const answered = answerOne(MAC, MAC_DEVICE);
    expect(await call('folder.list', {})).toMatchObject({ ok: true });
    expect((await answered).operation).toBe('list');
    // Only the Mac can read, the Windows PC lists nothing it reads: still the Mac.
    await claim(WINDOWS, WINDOWS_DEVICE, ['write']);
    const read = answerOne(MAC, MAC_DEVICE);
    expect(await call('folder.list', {})).toMatchObject({ ok: true });
    await read;
    // Both reachable: she asks the owner (in her own time she names one).
    await claim(WINDOWS, WINDOWS_DEVICE, ALL);
    await claim(MAC, MAC_DEVICE, READING);
    const both = await call('folder.list', {});
    expect(both).toMatchObject({ ok: false, failure: 'invalid_input', retryable: false });
    expect(both.text).toContain('owner-windows（WindowsのPC）、owner-mac（Mac）の両方につながっている');
    expect(both.text).toContain('ライ氏に聞いて');
    expect((await call('folder.list', {}, 'autonomy')).text ?? '').not.toContain('ライ氏に聞いて');
    // Named: as before.
    const named = answerOne(MAC, MAC_DEVICE);
    expect(await call('folder.list', { host: MAC })).toMatchObject({ ok: true });
    await named;
    expect(await call('folder.list', { host: 'owner-ipad' })).toMatchObject({ ok: false, failure: 'invalid_input' });
  });
});

describe('the path rules as shared cases (the Mac app checks its own rule against the same file)', () => {
  it('matches every recorded case', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/host-folder-paths-v1/cases.json', import.meta.url), 'utf8')) as {
      cases: Array<{ value: string; kind: 'file' | 'entry' | 'folder'; path: string | null }>;
    };
    expect(fixture.cases.length).toBeGreaterThan(200);
    for (const item of fixture.cases) {
      const checked = hostFolderPath(item.value, item.kind);
      expect('path' in checked ? checked.path : null, `${JSON.stringify(item.value)} as ${item.kind}`).toBe(item.path);
    }
  });
});
