import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { FCA_WAIT_REFUSALS } from '../src/mind/action/fca/fcaWaitGate.js';
import { actionHarness } from './support/actionThreadHarness.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const at = () => '2026-10-14T00:00:00.000Z';

/** A task model that asks to wait at every decision, as the run 1 task did once it thought it needed supplies. */
function waitingRun(counterpart: boolean | undefined) {
  const h = actionHarness(at);
  cleanups.push(h.close);
  const inputs: FcaModelInput[] = [];
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: at,
    model: { async decide(input) {
      inputs.push(input);
      return { decision: { kind: 'wait', summary: `持ち物がないので指示を待ちます（${inputs.length}）` }, history: [{ role: 'assistant', content: `wait ${inputs.length}` }] };
    }, toolResults: results => ({ role: 'user', results }) },
    stepPorts: () => (counterpart === undefined ? {} : { waitCounterpart: () => counterpart }),
  });
  cleanups.push(() => driver.close());
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '（運用者経由）エンドラを討伐してください', goal: 'エンドラを討伐してください' }, 'operator:run-1');
  const step = async () => { await driver.tick(); await driver.drain(); return driver.runtime.get('owner', task.id)!; };
  return { driver, task, inputs, step, root };
}

describe('a wait nobody can answer (Minebot lane run 1, 2026-10-14)', () => {
  it('tells the decision, turns the wait away a bounded number of times, then keeps her summary and stops the task', async () => {
    const run = waitingRun(false);
    for (let refused = 1; refused <= FCA_WAIT_REFUSALS; refused++) {
      const view = await run.step();
      expect(view.phase).toBe('ready');
      expect(run.driver.runtime.snapshot('owner', run.task.id)!.checkpoint).toMatchObject({ fcaWaitRefusals: refused });
    }
    expect(run.inputs.map(input => input.waiting)).toEqual([0, 1].map(refusedWaits => ({ replyPossible: false, refusedWaits, refusalLimit: FCA_WAIT_REFUSALS })));
    const stopped = await run.step();
    expect(run.inputs).toHaveLength(FCA_WAIT_REFUSALS + 1);
    expect(run.inputs.at(-1)!.waiting).toEqual({ replyPossible: false, refusedWaits: FCA_WAIT_REFUSALS, refusalLimit: FCA_WAIT_REFUSALS });
    expect(stopped).toMatchObject({ phase: 'stopped', status: 'paused', pauseReason: 'fca_stopped', summary: '持ち物がないので指示を待ちます（3）' });
    // Stopped is finished: nothing runs it again and the scheduler holds no lease for it.
    expect(await run.step()).toMatchObject({ phase: 'stopped' });
    expect(run.inputs).toHaveLength(FCA_WAIT_REFUSALS + 1);
    expect(run.driver.runtime.activeSteps('owner')).toEqual([]);
    expect(run.driver.runtime.pendingReceipts('owner')).toEqual([]);
  });

  it.each([['his own request', true], ['a task without the port', undefined]] as const)('leaves the wait of %s alone', async (_, counterpart) => {
    const run = waitingRun(counterpart);
    expect(await run.step()).toMatchObject({ phase: 'waiting' });
    expect(run.inputs[0]!.waiting).toBeUndefined();
    expect(run.driver.runtime.snapshot('owner', run.task.id)!.checkpoint).not.toHaveProperty('fcaWaitRefusals');
  });

  it('accepts the wait while a child of the task is still working', async () => {
    const run = waitingRun(false);
    run.driver.runtime.createChild('owner', run.task.id, { title: '木を集める', goal: '原木を集める' }, 'child-1');
    // Only the parent is admitted here: the child stays ready, which is unfinished work the parent may wait for.
    const parent = run.driver.runtime.get('owner', run.task.id)!;
    expect(parent.childIds).toHaveLength(1);
    let view = parent;
    for (let index = 0; index < 4 && view.phase !== 'waiting'; index++) view = await run.step();
    expect(view.phase).toBe('waiting');
    expect(run.inputs.find(input => input.task.id === run.task.id)!.waiting).toBeUndefined();
  });
});
