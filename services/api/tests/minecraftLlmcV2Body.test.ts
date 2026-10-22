import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import { forgetLlmcEvents, urgentFacts, withLlmcBody } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { llmcResult } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { llmcBodyDefinitions } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { layersMap } from './support/minecraftMaps.js';
import { candidateAct } from '../src/surfaces/minecraft/minecraftLlmcV2.js';

/**
 * SHANNON_MINECRAFT_LLMC_V2: what it leaves out of the head's own lines (the shooter line cells of r10's H5, the omitted lines, the recall) and
 * what it gives (every hostile, the whole pack), while the same calls without the switch are as they were.
 */
const stops = JSON.parse(readFileSync(new URL('./fixtures/minecraft-run34-stops-v1.json', import.meta.url), 'utf8')) as { acts: Array<{ n: number; hands: unknown[]; result: unknown }> };
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't',
  connected: true, state: { world: world as never }, facts: {} });
const PIGLIN = { id: 848, name: 'piglin', kind: 'hostile', distance: 7.1, position: { x: 219.5, y: 58, z: 62.5 }, canSee: true, canReachMe: true };
const scene = (extra: Record<string, unknown> = {}) => frame({ position: { x: 226.5, y: 57, z: 63.5 }, health: 16, nearbyThreats: [PIGLIN], nearbyEntities: [PIGLIN], ...extra });

describe('v2: the head\'s lines', () => {
  it('leaves the line cells of a shooter out of the urgent line (r10\'s H5 added nothing in the replay) and keeps the reflex hold', () => {
    expect(urgentFacts(scene(), null).reasons[0]).toContain('線上のマス');
    expect(urgentFacts(scene(), null, null, null, false).reasons[0]).not.toContain('線上のマス');
    const held = scene({ reflexes: { recent: [{ ageSec: 0, kind: 'flee', detail: '低体力で逃げ道なし' }], counts: {} } });
    expect(urgentFacts(held, null, null, null, false).reasons[0]).toContain('反射の最中');
  });
  it('gives every hostile and the whole pack, with no omitted-lines mark, where the bound cut them before', () => {
    const threats = Array.from({ length: 14 }, (_, i) => ({ id: 100 + i, name: 'zombie', kind: 'hostile', distance: 3 + i, position: { x: 200 + i, y: 57, z: 60 } }));
    const inventory = Array.from({ length: 60 }, (_, i) => ({ name: `item_${i}`, count: 1 + i }));
    const world = { position: { x: 226.5, y: 57, z: 63.5 }, health: 20, food: 20, localMap: layersMap({ x: 226, y: 57, z: 63 }), nearbyThreats: threats, inventory };
    const parts = { observation: frame(world), elapsedMinutes: 1, trend: createFoodTrend(() => 0), events: [] };
    const before = JSON.stringify(minecraftLlmcLive(parts));
    const after = minecraftLlmcLive(parts, 0, true) as { threats: string[]; inventory: string[] };
    const cut = JSON.parse(before) as { threats: string[]; inventory: string[] };
    expect([cut.threats.length, cut.inventory.length]).toEqual([8, 36]);
    expect(JSON.stringify(after)).not.toContain('長いため略');
    expect(after.threats).toHaveLength(14);
    expect(after.inventory).toHaveLength(60);
  });
  it('adds no stop note to a stopped hand\'s result when the input is not handed over (the switch leaves it out), and offers no read tool', () => {
    const stop = stops.acts.find(item => item.n === 5)!;
    const receipt = { id: 'a', connectionId: 'c', outcome: 'failed', inputsReleased: true, observedAt: 't', result: JSON.stringify(stop.result) } as unknown as MinecraftControlReceipt;
    const input = { hands: stop.hands };
    const withNote = llmcResult('mc.act', receipt, null, [], input, null).text;
    const without = llmcResult('mc.act', receipt, null, [], undefined, null).text;
    expect(withNote).toContain('頭の補足');
    expect(without).not.toContain('頭の補足');
    const definition = (name: string, description: string, readOnly: boolean) => ({ name, description, input: { type: 'object', properties: {}, required: [], additionalProperties: false },
      domain: 'minecraft_body', effect: readOnly ? 'read' : 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] }) as never;
    const skills = ['act', 'view', 'probe', 'find-blocks', 'check-recipe'].map(name => ({ name, description: name, readOnly: name !== 'act', inputSchema: {} })) as never;
    expect(llmcBodyDefinitions(skills, definition, { probe: true, v2: true }).map(tool => tool.name)).toEqual(['mc.act', 'mc.view', 'mc.probe']);
    expect(llmcBodyDefinitions(skills, definition, { probe: true }).map(tool => tool.name)).toContain('mc.find-blocks');
  });
  it('asks for no recall: a failed act makes the next decision wait for none', () => {
    forgetLlmcEvents();
    const base = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; }, tools: undefined } as never;
    const parts = { llmc: { plan: () => undefined, planView: () => null }, taskId: 'v2-body', createdAt: '2026-10-23T00:00:00.000Z', observe: () => scene(),
      arrival: () => ({ at: null, kind: null }), log() {} } as never;
    const off = withLlmcBody(base, parts), on = withLlmcBody(base, { ...(parts as object), v2: true } as never);
    off.noteResult?.({ id: 'c', name: 'mc.act', input: {} } as never, { ok: false, text: '失敗' } as never, 5);
    expect(off.recallWanted?.()).toBe(true);
    expect(on.recallWanted?.()).toBe(false);
    forgetLlmcEvents();
  });
});

describe('v2: what the head does to the model\'s act (the replay\'s entry)', () => {
  const MAP = ['地図 v1 足=(10,5,20) x=8..12 z=19..21 方式=layers 上=北',
    'y=6 x=8..12 z=19..21', ' 19 # # . . #', ' 20 # # . . #', ' 21 # # # # #',
    'y=5 x=8..12 z=19..21', ' 19 # . . . #', ' 20 # . @ . #', ' 21 # # # # #',
    'y=4 x=8..12 z=19..21', ' 19 # # # # #', ' 20 # # # . #', ' 21 # # # # #'].join('\n');
  const here = frame({ position: { x: 10.5, y: 5, z: 20.5 }, health: 20, localMap: MAP });
  it('makes the lines ready, holds the whole act at the first hand, or sends the hands before the held one', () => {
    const fine = candidateAct({ why: 'x', hands: ['walk 10,5,19', 'wait 1'] }, here);
    expect(fine.problem).toBeNull();
    expect(fine.guard).toBeUndefined();
    expect((fine.input as { hands: unknown[] }).hands).toHaveLength(2);
    const whole = candidateAct({ hands: ['walk 9,5,20'] }, here);
    expect(whole.guard).toMatchObject({ stopped: true, hand: 1 });
    expect(whole.guard!.text).toContain('体には何も送っていない');
    const part = candidateAct({ hands: ['walk 10,5,19', 'walk 9,5,20', 'wait 1'] }, here);
    expect(part.guard).toMatchObject({ stopped: false, hand: 2, sentHands: 1 });
    expect((part.input as { hands: unknown[] }).hands).toHaveLength(1);
    expect(part.guard!.text).toContain('手 2 から先 2 手');
  });
  it('refuses a line it cannot read with one line, and fixes the stopIf as the body\'s tools do', () => {
    const bad = candidateAct({ hands: ['fly 1,2,3'] }, here);
    expect(bad.problem).toContain('手の書き方が読めない');
    const waiting = candidateAct({ hands: ['wait 5'] }, here);
    expect(waiting.fixes.join()).toContain('hostileWithin');
  });
});
