import { expect, it } from 'vitest';
import { createObserverFcaFixture } from '../../../scripts/observer-fca-fixture.js';
import { installObserverSink } from '../src/infra/observer/observerContext.js';
import type { ObserverDraft } from '../src/contracts/observerContract.js';

it('runs parallel local FCA tasks through tools, wait and completion without a provider', async () => {
  const events: ObserverDraft[] = [];
  const restore = installObserverSink(event => events.push(event));
  const fixture = createObserverFcaFixture('local-fixture', () => true);
  try {
    const ids = await fixture.start();
    expect(ids.tasks).toHaveLength(3);
    await fixture.next();
    await fixture.next();
    await fixture.next();
    expect(fixture.summary().every(task => task.phase === 'waiting')).toBe(true);
    await fixture.finish();
    expect(fixture.summary().every(task => task.phase === 'completed')).toBe(true);
    const llm = events.filter(event => event.node === 'llm' && event.kind === 'span.completed');
    expect(llm.length).toBeGreaterThan(0);
    expect(llm.every(event => event.model === 'local-ui-fixture-no-provider')).toBe(true);
    expect(events.some(event => event.node === 'tools' && event.kind === 'span.completed')).toBe(true);
    expect(events.some(event => event.node === 'wait' && event.kind === 'span.completed')).toBe(true);
    expect(events.filter(event => event.kind === 'span.started' && event.node === 'fca').map(event => event.taskId)).toEqual(expect.arrayContaining(ids.tasks));
    expect(events.filter(event => event.kind === 'span.started' && event.node === 'fca').every(event => [ids.rootId, ...ids.tasks].includes(event.taskId!))).toBe(true);
  } finally { await fixture.close(); restore(); }
});
