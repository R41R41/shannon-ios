import { afterEach, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { forgetLlmcEvents, urgentFacts, withLlmcBody } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { forgetThreatSights, nearThreats, readThreatSight, threatLine } from '../src/surfaces/minecraft/minecraftLlmcThreat.js';
import { forgetSurpriseWatches } from '../src/surfaces/minecraft/minecraftLlmcProbe.js';
import { v2tree } from './helpers/planTreeV2.js';

afterEach(() => { forgetLlmcEvents(); forgetThreatSights(); forgetSurpriseWatches(); });
const blocked = JSON.stringify({ v: 1, kind: 'sight', text: '見えない。間にstone', visible: false,
  between: [{ at: { x: 1, y: 5, z: 1 }, name: 'stone' }] });
const threat = (canReachMe: boolean | null, canSee = false, name = 'zombie') => ({ id: 9, name, kind: 'hostile', distance: 4,
  position: { x: 1, y: 2, z: 0 }, canReachMe, canSee });
const frame = (enemy: unknown): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: { position: { x: 0, y: 5, z: 0 }, dimension: 'overworld', health: 16, food: 17,
    inventory: [{ name: 'iron_pickaxe', count: 1 }], nearbyThreats: [enemy] } as never }, facts: { alive: true } });
function bodyFor(observe: () => BodyObservation) {
  const nodes = [{ id: 'p1', parentId: null, order: 0, title: '食料を補う', state: 'continue' as const }];
  return withLlmcBody({ start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }),
    async guard() { return true; }, toolSignal: (_name, parent) => parent, async close() {} },
  { taskId: 'fresh-urgent', createdAt: '2026-10-31T00:00:00Z', observe, arrival: () => ({ at: 1, kind: 'login' }), log: () => undefined,
    llmc: { plan: () => ({ revision: 1, current: 'p1', nodes }) as never,
      planView: () => ({ revision: 1, done: '0/1', now: 'p1 食料を補う', path: [], next: [], blocked: [] }),
      planTree: () => v2tree({ revision: 1, current: 'p1', nodes }) },
    r4: { probe: () => async () => blocked, planWhere: () => null } });
}
it('returns to the full context on the next tool round when the current threat is resolved', async () => {
  let observation = frame(threat(true)); const body = bodyFor(() => observation);
  await body.investigate!(new AbortController().signal);
  expect(body.urgent!()).toBe(true);
  body.context(); expect((body.transient!() as any).mode).toContain('急ぎ');
  observation = frame(threat(false));
  body.context(); // A tool round refreshes context without calling urgent() again.
  const live = body.transient!() as any;
  expect(live.urgent).toBeUndefined(); expect(live.mode).toBeUndefined();
});
it('still enters urgent mode when a new reachable threat appears between tool rounds', async () => {
  let observation = frame(threat(false)); const body = bodyFor(() => observation);
  await body.investigate!(new AbortController().signal);
  expect(body.urgent!()).toBe(false);
  body.context(); expect((body.transient!() as any).mode).toBeUndefined();
  observation = frame(threat(true)); body.context();
  expect((body.transient!() as any).mode).toContain('急ぎ');
});
it('does not turn an unknown path into a confirmed path', () => {
  const [enemy] = nearThreats(frame(threat(null)));
  const line = threatLine(enemy!, readThreatSight(blocked));
  expect(line).toContain('道は不明'); expect(line).not.toContain('道はある');
  expect(urgentFacts(frame(threat(null)), null, new Map([[9, readThreatSight(blocked)!]])).reasons).toHaveLength(1);
});
it('does not suppress a currently visible shooter with an older blocked sight answer', () => {
  const observation = frame(threat(true, true, 'skeleton'));
  const sight = readThreatSight(blocked)!;
  expect(urgentFacts(observation, null, new Map([[9, sight]])).reasons[0]).toContain('見える');
});
