import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { fcaResearchTools } from '../src/wiring/fcaResearchWiring.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { actionHarness } from './support/actionThreadHarness.js';

/**
 * Minecraft run 11 (2026-10-15): a read with no effect outside whose result could not be shown after it ran closed its step unknown,
 * and the task was retired. Now such a read is a known failure with nothing of its result; a tool with an effect still throws.
 */
const at = '2026-10-15T00:00:00.000Z', closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

async function fixture() {
  const h = actionHarness(() => at); closes.push(h.close);
  const tools = createInMemoryAutonomyService(() => at).tools;
  tools.useReads({ web: async () => ({ status: 'results', text: '公開の結果', sources: [{ title: '出典', url: 'https://example.com/' }] }) });
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'read' })).id);
  const lease = leaseOf(action!);
  let observed = 0;
  // The source check after the read withholds it (as `fca-unresolved://` did for minecraft.lifecycle_status).
  const research = fcaResearchTools({ tools, state, conversations, scopeKey: 'owner', ownerAlone: () => true, sourcesVisible: () => true,
    task: { id: 'task', origin: 'owner_request', leaseId: lease.id }, observeRead: () => { observed += 1; return false; } });
  const run = (name: string, input: Record<string, unknown>) => inActionExecution({ lease, signal: new AbortController().signal,
    permit: resources => h.actions.dispatch(lease, resources) }, () => research.execute({ scopeKey: 'owner', taskId: 'task', operationId: `step:${name}`,
    name, input, signal: new AbortController().signal }));
  return { research, run, observed: () => observed };
}

describe('a read whose result cannot be shown after it ran', () => {
  it('is a known failure without its result when the read has no effect outside, and the step can go on', async () => {
    const f = await fixture();
    expect(f.research.definitions.some(tool => tool.name === 'study.list')).toBe(true);
    const result = await f.run('study.list', {});
    expect(result).toEqual({ ok: false, text: 'この結果は今は使えません。', failure: 'unavailable', retryable: false });
    expect(f.observed()).toBeGreaterThan(0);
  });

  it('still throws for a read with an effect outside (a paid search), whose step stays unknown as before', async () => {
    const f = await fixture();
    await expect(f.run('web.search', { query: '公開の話題' })).rejects.toThrow('FCA_SOURCE_WITHHELD');
  });
});
