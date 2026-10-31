import { expect, it } from 'vitest';
import { createMinecraftJourney } from '../src/surfaces/minecraft/minecraftLlmcJourney.js';
import { llmcTransient, createLlmcEvents } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { stageKnowledge } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';

function frame(x: number, y: number, n: number, surface = false, food = 0): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:server', sequence: n, connected: true, stateAt: new Date(n * 1000).toISOString(), receivedAt: new Date(n * 1000).toISOString(), facts: {},
    state: { life: { life: 1, dimension: 'overworld', dimensionSince: 'epoch' }, world: { dimension: 'overworld', health: 20, food: 20,
      position: { x, y, z: 0 }, foodPoints: { total: food, items: [] }, inventory: food ? [{ name: 'bread', count: 8 }] : [],
      localMap: `地図 v1 足=(${x},${y},0) x=-1..1 z=-1..1 方式=${surface ? 'surface' : 'layers'} 上=北` } } };
}
it('keeps observed surface and intermediate positions through a task checkpoint, without promising reverse reachability', () => {
  let j = createMinecraftJourney(null);
  expect(j.read(frame(0, 66, 1, true))).toEqual([]);
  j.read(frame(2, 50, 2)); j.read(frame(4, 30, 3));
  j = createMinecraftJourney(JSON.parse(JSON.stringify(j.checkpoint())).minecraftJourney);
  const notes = j.read(frame(6, 20, 4));
  expect(notes[0]).toContain('(0,66,0)'); expect(notes[0]).toContain('安全は未確認');
  expect(notes[1]).toContain('(4,30,0)'); expect(notes[1]).toContain('逆向きの通行可否は未確認');
});
it('does not infer a surface exit from altitude, water, or an unvisited target', () => {
  const j = createMinecraftJourney(null); j.read(frame(0, 66, 1));
  expect(j.read(frame(0, -20, 2))).toEqual([]);
});
it('preserves the record on disconnect and rejects stale observations', () => {
  const j = createMinecraftJourney(null); j.read(frame(0, 66, 10, true)); j.read(frame(0, 30, 11));
  const before = j.checkpoint(); expect(j.read({ ...frame(100, 90, 12, true), connected: false })).toEqual([]);
  expect(j.read(frame(100, 90, 9, true))).toEqual([]); expect(j.checkpoint()).toEqual(before);
});
it.each(['life', 'dimension', 'bodyId'])('does not reuse another %s epoch as the return route', field => {
  const j = createMinecraftJourney(null); j.read(frame(0, 66, 1, true));
  const next = frame(0, 20, 2);
  if (field === 'bodyId') next.bodyId = 'minecraft:other';
  else next.state = { ...next.state, life: { life: field === 'life' ? 2 : 1, dimension: field === 'dimension' ? 'the_nether' : 'overworld', dimensionSince: 'next' } };
  expect(j.read(next)).toEqual([]);
});
it('sends return observations in the actual normal live context even before HP is lost', () => {
  const j = createMinecraftJourney(null); j.read(frame(0, 66, 1, true));
  const llmc = { plan: () => undefined, planView: () => null, returnRoute: j.read };
  const live = llmcTransient(llmc, createLlmcEvents('journey-test'), frame(0, 30, 2), 2);
  expect(JSON.stringify(live)).toContain('帰還の観測記録');
  expect(stageKnowledge({ body: { state: { dimension: 'overworld' } } })).toContain('水や鉱石の座標は地上の出口ではない');
});
it('bounds the retained observations and hides food-return notes when food is already sufficient', () => {
  const j = createMinecraftJourney(null); j.read(frame(0, 90, 1, true));
  for (let n = 2; n < 30; n++) j.read(frame(n, 90 - n * 4, n));
  expect(j.checkpoint().minecraftJourney?.points.length).toBeLessThanOrEqual(12);
  expect(j.read(frame(30, -40, 30, false, 100))).toEqual([]);
});
const surveyed = (x: number, n: number, entities: unknown[] = []): BodyObservation => {
  const v = frame(x, 66, n, true);
  v.state = { ...v.state, world: { ...(v.state.world as Record<string, never>), nearbyEntities: entities as never } };
  return v;
};
it('keeps bounded food-search observations through a checkpoint without claiming old animals still exist', () => {
  let j = createMinecraftJourney(null);
  j.read(surveyed(0, 1, [{ id: 7, name: 'chicken', distance: 3 }]));
  j = createMinecraftJourney(JSON.parse(JSON.stringify(j.checkpoint())).minecraftJourney);
  const notes = j.read(surveyed(30, 31)).join('\n');
  expect(notes).toContain('(0,66,0)・30秒前'); expect(notes).toContain('#7 chicken');
  expect(notes).toContain('動物の現在地・未走査の範囲は未確認');
  for (let n = 32; n < 60; n++) j.read(surveyed(n * 24, n));
  expect(j.checkpoint().minecraftJourney?.surveys.length).toBe(12);
});
it('updates the same survey cell, accepts an old checkpoint, and clears surveys across lives', () => {
  let j = createMinecraftJourney(null); j.read(surveyed(0, 1)); j.read(surveyed(2, 2));
  expect(j.checkpoint().minecraftJourney?.surveys.length).toBe(1);
  const old = JSON.parse(JSON.stringify(j.checkpoint())).minecraftJourney; delete old.surveys;
  j = createMinecraftJourney(old); expect(j.checkpoint().minecraftJourney?.surveys).toEqual([]);
  j.read(surveyed(30, 3));
  const next = frame(40, 20, 4); next.state = { ...next.state, life: { life: 2, dimension: 'overworld', dimensionSince: 'next' } };
  expect(j.read(next)).toEqual([]); expect(j.checkpoint().minecraftJourney?.surveys).toEqual([]);
});
it('does not count missing entity observations or underground observations as a surface food survey', () => {
  const j = createMinecraftJourney(null); j.read(frame(0, 66, 1, true));
  const underground = surveyed(30, 2);
  underground.state = { ...underground.state, world: { ...(underground.state.world as Record<string, never>), localMap: '地図 v1 方式=layers' } };
  j.read(underground); expect(j.checkpoint().minecraftJourney?.surveys).toEqual([]);
});
