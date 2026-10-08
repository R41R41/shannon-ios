import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { fcaResearchTools } from '../src/wiring/fcaResearchWiring.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { actionHarness } from './support/actionThreadHarness.js';

const at = '2026-10-09T00:00:00.000Z', closes: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function researchFixture() {
  const h = actionHarness(() => at); closes.push(h.close);
  const tools = createInMemoryAutonomyService(() => at).tools;
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  let searches = 0, ownerAlone = true, visible = true;
  tools.useReads({ web: async () => { searches++; return { status: 'results', text: 'Verified public result',
    sources: [{ title: 'Public source', url: 'https://example.com/source' }] }; } });
  const research = fcaResearchTools({ tools, state, conversations, scopeKey: 'owner', ownerAlone: () => ownerAlone, sourcesVisible: () => visible });
  const call = { scopeKey: 'owner', taskId: 'task', operationId: 'step:search', name: 'web.search', input: { query: 'public topic' }, signal: new AbortController().signal };
  return { ...h, tools, research, call, searches: () => searches,
    revoke: (kind: 'source' | 'owner') => { if (kind === 'source') visible = false; else ownerAlone = false; },
    async claim() {
      const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'research' })).id);
      expect(action).not.toBeNull(); return leaseOf(action!);
    },
  };
}

describe('FCA execution permission races', () => {
  it('holds a source revoked during claim without inventing an unknown model result, and runs after restore', async () => {
    const h = actionHarness(() => at); closes.push(h.close);
    const claimed = barrier(), releaseClaim = barrier(); let visible = true, blockFirstClaim = true, modelCalls = 0;
    const driver = createTaskRuntimeWiring({ db: h.db, scopeKey: 'owner', ownerAlone: () => true, now: () => at,
      actions: { ...h.actions, async claim(id) {
        const action = await h.actions.claim(id);
        if (blockFirstClaim) { blockFirstClaim = false; claimed.release(); await releaseClaim.promise; }
        return action;
      } },
      canRunTask: () => visible, stepPorts: () => ({ sourcesVisible: () => visible }),
      model: { async decide() { modelCalls++; return { decision: { kind: 'complete', summary: 'Finished' }, history: ['known response'] }; }, toolResults: results => results },
    });
    closes.push(() => driver.close(), releaseClaim.release);
    const root = driver.runtime.ensureRoot('owner'), task = driver.runtime.createChild('owner', root.id, { title: 'Research', goal: 'Research' }, 'research');
    await driver.tick(); await claimed.promise;
    expect(h.store.list('owner')).toMatchObject([{ state: 'running', sent: false }]);
    visible = false; releaseClaim.release(); await driver.drain();
    expect(modelCalls).toBe(0);
    expect(driver.runtime.get('owner', task.id)).toMatchObject({ phase: 'ready', pauseReason: null });
    expect(driver.runtime.snapshot('owner', task.id)?.history).toEqual([]);
    expect(driver.runtime.activeSteps('owner')).toEqual([]);
    expect(driver.runtime.pendingReceipts('owner')).toEqual([]);
    expect(h.store.list('owner')).toMatchObject([{ state: 'cancelled', sent: false, result: 'fca_not_dispatched' }]);
    await driver.tick(); await driver.drain();
    expect(h.store.list('owner')).toHaveLength(1);
    visible = true; await driver.tick(); await driver.drain();
    expect(modelCalls).toBe(1);
    expect(driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(h.store.list('owner').map(action => action.state).sort()).toEqual(['cancelled', 'completed']);
    expect(driver.runtime.pendingReceipts('owner')).toEqual([]);
  });

  it.each(['source', 'owner'] as const)('does not issue a web request when %s permission is revoked while its execution permit waits', async kind => {
    const f = researchFixture(), lease = await f.claim(), entered = barrier(), release = barrier();
    closes.push(release.release); let checkpoints = 0;
    const result = inActionExecution({ lease, signal: f.call.signal,
      permit: async resources => { entered.release(); await release.promise; return f.actions.dispatch(lease, resources); },
      checkpoint: async code => { checkpoints++; return f.actions.checkpoint(lease, code); },
    }, () => f.research.execute(f.call));
    const settled = result.then(value => ({ value, error: null }), error => ({ value: null, error }));
    await entered.promise;
    expect(f.searches()).toBe(0);
    f.revoke(kind); release.release();
    const outcome = await settled;
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toBe('FCA_SOURCE_WITHHELD');
    expect(f.searches()).toBe(0);
    expect(checkpoints).toBe(0);
  });

  it('keeps FCA acknowledgement with the segment owner while preserving the ordinary tool checkpoint', async () => {
    const f = researchFixture(), lease = await f.claim(), checkpoints: string[] = [];
    await inActionExecution({ lease, signal: f.call.signal, permit: resources => f.actions.dispatch(lease, resources),
      checkpoint: async code => { checkpoints.push(code); return f.actions.checkpoint(lease, code); },
    }, async () => {
      expect((await f.research.execute(f.call)).ok).toBe(true);
      expect(f.searches()).toBe(1);
      expect(checkpoints).toEqual([]);
      expect(f.store.get(lease.id)).toMatchObject({ state: 'running', sent: true, holder: lease.holder });
      expect((await f.tools.call('web.search', { query: 'another public topic' }, {
        scopeKey: 'owner', surface: 'text', audience: 'owner_alone', memory: toolSessionMemory(),
      }, f.call.signal)).ok).toBe(true);
      expect(f.searches()).toBe(2);
      expect(checkpoints).toEqual(['tool_returned']);
      expect(f.store.get(lease.id)).toMatchObject({ state: 'waiting', sent: false, holder: lease.holder });
    });
  });
});
