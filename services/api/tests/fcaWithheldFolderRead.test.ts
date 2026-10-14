import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { dispatchHostStepRequest } from '../src/infra/http/apiAutonomyHostStepRoutes.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { hostStepContentDigest } from '../src/mind/action/ownTime/autonomyHostFolderPath.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { fcaResearchTools } from '../src/wiring/fcaResearchWiring.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';
import { actionHarness } from './support/actionThreadHarness.js';

/**
 * A folder.read of a common task whose result a check after the run withholds (a source she may not use, the owner no longer
 * alone) leaves no path in her activity record or the Observer: the device's close no longer writes the path-bearing line for
 * a read its tool still waits for; the runner writes it once the result may be used, and otherwise a line without the path.
 */
const HOST = 'owner-windows', DEVICE = '0123456789abcdef', PATH = 'notes/秘密の旅程.md', SECRET = 'ファイルの中身-SENTINEL-4410';
const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

async function fixture(options: { sourceUsable: boolean }) {
  const now = () => new Date().toISOString();
  const store = new SQLiteAutonomyStore(':memory:'); closes.push(() => store.close());
  const service = new ShannonAutonomyService({ store, now, config: configuredAutonomy({
    SHANNON_AUTONOMY_ENABLED: 'true', SHANNON_AUTONOMY_HOST_FOLDERS_JSON: JSON.stringify({ [HOST]: { deviceId: DEVICE } }),
  }) });
  const h = actionHarness(now); closes.push(h.close);
  const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'folder' })).id);
  const lease = leaseOf(action!);
  let alone = true;
  const research = fcaResearchTools({ tools: service.tools, state: new InMemoryCompanionStateStore(now), conversations: new InMemoryConversationStore(),
    scopeKey: 'owner', ownerAlone: () => alone, sourcesVisible: () => true, task: { id: 'task', origin: 'owner_request', leaseId: lease.id },
    observeRead: () => options.sourceUsable });
  const route = (path: string, body: Record<string, unknown>) => dispatchHostStepRequest({ method: 'POST', path, body: { scopeKey: 'owner', ...body }, deviceId: DEVICE },
    service.folder, service.folderOperations);
  const claim = (waitSeconds: number) => route('/v1/autonomy/host-steps/claim', { host: HOST, protocol: 2, operations: ['write', 'list', 'read', 'search'], waitSeconds, localStop: false });
  await claim(0);
  /** A device that answers the one read; `onReport` runs just before the report reaches the API. */
  const device = async (onReport: () => void = () => {}) => {
    for (;;) {
      const step = ((await claim(3)).body as { step: Record<string, unknown> | null }).step;
      if (!step) continue;
      expect(step).toMatchObject({ operation: 'read', relativePath: PATH });
      onReport();
      const sha256 = hostStepContentDigest(SECRET).sha256;
      expect((await route(`/v1/autonomy/host-steps/${step.id as string}/report`, { outcome: 'done',
        result: { content: SECRET, offset: 0, nextOffset: null, totalBytes: 40, sha256, modifiedAt: '2026-10-15T00:00:00.000Z' } })).status).toBe(200);
      return;
    }
  };
  const read = async () => {
    const events: unknown[] = [];
    const restore = installObserverSink(event => { events.push(event); });
    try {
      const outcome = await withObserverRun({ scopeKey: 'owner', surface: 'text' }, () => inActionExecution({ lease, signal: new AbortController().signal,
        permit: resources => h.actions.dispatch(lease, resources) }, () => research.execute({ scopeKey: 'owner', taskId: 'task', operationId: 'step:read',
        name: 'folder.read', input: { path: PATH }, signal: new AbortController().signal }))).then(result => ({ result }), (error: unknown) => ({ error }));
      return { outcome, events };
    } finally { restore(); }
  };
  const entries = () => service.activityDays('owner', 30).flatMap(day => day.entries);
  return { research, device, read, entries, leaveAlone: () => { alone = false; } };
}

/** Thrown through as before (`FCA_SOURCE_WITHHELD`), or, once a withheld effect-free read is a known failure, that fixed failure. */
function expectWithheld(outcome: { result?: unknown; error?: unknown }): void {
  if ('error' in outcome) expect(String((outcome.error as Error)?.message)).toMatch(/^FCA_(SOURCE|READ)_WITHHELD$/u);
  else expect(outcome.result).toEqual({ ok: false, text: 'この結果は今は使えません。', failure: 'unavailable', retryable: false });
}

function expectNoPath(text: string): void {
  for (const content of [PATH, '秘密の旅程', SECRET]) expect(text).not.toContain(content);
}

describe('a folder.read whose result is withheld after it ran', () => {
  it.each([
    ['a source she may not use', false, false],
    ['the owner no longer alone when the file comes back', true, true],
  ])('leaves no path in her activity record or the Observer (%s)', async (_case, sourceUsable, othersArrive) => {
    const f = await fixture({ sourceUsable });
    expect(f.research.definitions.some(tool => tool.name === 'folder.read')).toBe(true);
    const answered = f.device(othersArrive ? f.leaveAlone : undefined);
    const { outcome, events } = await f.read();
    await answered;
    expectWithheld(outcome);
    const entries = f.entries();
    // The read is still recorded (ADR-0002), as the call alone.
    expect(entries).toEqual([expect.objectContaining({ tool: 'folder.read', outcome: 'failed', reasonCode: 'result_withheld' })]);
    expectNoPath(JSON.stringify(entries));
    expect(JSON.stringify(events)).toContain('"phase":"execute"');
    expectNoPath(JSON.stringify(events));
  });

  it('still records the path once the result may be used', async () => {
    const f = await fixture({ sourceUsable: true });
    const answered = f.device();
    const { outcome } = await f.read();
    await answered;
    expect(outcome).toMatchObject({ result: { ok: true, text: expect.stringContaining(SECRET) } });
    const entries = f.entries();
    expect(entries).toEqual([expect.objectContaining({ tool: 'folder.read', outcome: 'done' })]);
    expect(entries[0]!.summary).toContain(`自分のフォルダ（${HOST}）の「${PATH}」を読みました`);
    expect(entries[0]!.summary).not.toContain(SECRET);
  });
});
