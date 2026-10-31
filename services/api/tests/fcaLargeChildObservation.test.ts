import { afterEach, expect, it } from 'vitest';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { createFcaTaskObservationMonitor } from '../src/wiring/fcaTaskObservationWiring.js';
import { inheritObservedTaskSources } from '../src/wiring/fcaTaskSourcesWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

const closes: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

function fixture(rejectTail = false, monitor = false) {
  const now = () => '2026-10-31T03:33:41.290Z';
  const h = actionHarness(now); closes.push(h.close);
  const inputs: FcaModelInput[] = [], groups: string[][] = [];
  let current: TaskStep;
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now,
    model: { async decide(input) { inputs.push(input); return { decision: { kind: 'wait', summary: 'Observed all children' }, history: [] }; },
      toolResults: results => ({ role: 'user', results }) },
    stepPorts: (runtime, step) => {
      current = step;
      const inherit = runtime.inheritTaskSources.bind(runtime);
      const observed = { ...runtime, inheritTaskSources: (_: TaskStep, ids: readonly string[]) => {
        groups.push([...ids]); if (rejectTail && ids.includes(children.at(-1)!)) return false;
        return inherit(step, ids);
      }, taskSources: runtime.taskSources.bind(runtime) } as typeof runtime;
      const observeTasks = (ids: readonly string[]) => inheritObservedTaskSources(observed, step, ids);
      return { observeTasks, ...(monitor ? { observations: [createFcaTaskObservationMonitor({ runtime, step,
        allowed: () => true, sourcesVisible: () => true, taskVisible: () => true, observeTasks })] } : {}) };
    },
  }); closes.push(() => driver.close());
  const root = driver.runtime.ensureRoot('owner'), children: string[] = [];
  for (let i = 0; i < 110; i++) {
    const child = driver.runtime.createChild('owner', root.id, { title: `Child ${i}`, goal: 'Observed history' }, `child-${i}`);
    children.push(child.id); driver.runtime.stop('owner', child.id, 'history');
  }
  children.splice(0, children.length, ...driver.runtime.get('owner', root.id)!.childIds);
  driver.runtime.send('owner', children.at(-1)!, root.id, 'Observe child states', 'wake-root');
  return { driver, root, children, inputs, groups, current: () => current! };
}

it.each([false, true])('reads all 110 stopped children under real authority, with monitor=%s', async monitor => {
  const f = fixture(false, monitor); await f.driver.tick(); await f.driver.drain();
  expect(f.inputs).toHaveLength(1);
  expect(f.inputs[0]!.children!.map(child => child.id)).toEqual(f.children);
  expect(f.groups.flat()).toEqual(monitor ? [...f.children, ...f.children] : f.children);
  expect(f.groups.every(group => group.length <= 100)).toBe(true);
  expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
  expect(() => f.driver.runtime.inheritTaskSources(f.current(), f.children)).toThrow('FCA_SOURCE');
});

it.each([false, true])('releases no inference when the second source group is refused, monitor=%s', async monitor => {
  const f = fixture(true, monitor); await f.driver.tick(); await f.driver.drain();
  expect(f.inputs).toHaveLength(0);
  expect(f.groups).toHaveLength(monitor ? 4 : 2);
  expect(f.groups.flat()).toEqual(monitor ? [...f.children, ...f.children] : f.children);
  expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('unknown');
});
