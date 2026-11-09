import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { deadlyGateHold } from '../src/surfaces/minecraft/minecraftLlmcDeadlyGates.js';
import { heldOfFrame } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { BEFORE_END } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { preparationShortage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';

type Pack = Array<[string, number]>;
const MAP = ['地図 v1 足=(0,70,0) x=0..1 z=0..0 方式=cube', 'y=70 x=0..1 z=0..0', '0 . e'].join('\n');
const walk = { hands: [{ do: 'walk', to: { x: 1, y: 70, z: 0 }, range: 0 }] };
const frame = (pack: Pack, extra: Record<string, unknown> = {}): BodyObservation => ({
  schemaVersion: 1, bodyId: 'end-entry-body', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, localMap: MAP, health: 20, food: 20,
    inventory: pack.map(([name, count]) => ({ name, count })), ...extra } as never },
});
const FULL: Pack = [['cobblestone', 64], ['obsidian', 8], ['water_bucket', 1], ['white_bed', 8], ['cooked_beef', 16]];
const RETURN: Pack = [['cobblestone', 20], ['cooked_beef', 10]];
const endDeath = { lastDeath: '2分前 the_end (10,60,10) 「void」 落とした物: iron_sword×1' };

describe('End entry goals and recovery', () => {
  it('shows bow, 30 arrows and an iron-or-better sword as goals, leaving the main bed plan admissible', () => {
    for (const item of ['bow', 'arrow', 'iron_sword', 'diamond_sword', 'netherite_sword']) {
      expect(BEFORE_END.needs.find(need => need.pattern.test(item))?.goal, item).toBe(true);
    }
    const arrows = BEFORE_END.needs.find(need => need.pattern.test('spectral_arrow'))!;
    expect(arrows).toMatchObject({ count: 30, goal: true });
    expect(deadlyGateHold(walk, frame(FULL))).toBeNull();
    expect(deadlyGateHold(walk, frame(FULL.filter(([name]) => name !== 'white_bed')))?.line).toContain('ベッド');
  });

  it('counts ordinary and spectral arrows together in the displayed shortage', () => {
    const counts = new Map([...FULL, ['bow', 1], ['arrow', 10], ['spectral_arrow', 20], ['ender_eye', 12], ['iron_sword', 1]] as Pack);
    const shortage = () => preparationShortage({ dimension: 'overworld', nowKinds: ['end'], counts, food: 333 });
    expect(shortage()).toBeNull();
    counts.set('spectral_arrow', 19);
    expect(shortage()).toContain('29/30');
    expect(shortage()).toContain('目標（そろえば。必須ではない）');
  });

  it('allows a return with food and 20 blocks, without collecting another eight beds and obsidian', () => {
    for (const history of [endDeath, { deaths: [{ dimension: 'minecraft:the_end' }], lastDeath: '1分前 overworld (1,64,1)' }]) {
      expect(deadlyGateHold(walk, frame(RETURN, history))).toBeNull();
      const lack = deadlyGateHold(walk, frame([['cobblestone', 19]], history))!.line;
      expect(lack).toContain('19/20');
      expect(lack).toContain('食料');
      expect(lack).not.toContain('ベッド');
      expect(lack).not.toContain('水入りバケツ');
    }
    expect(deadlyGateHold(walk, frame(RETURN))).not.toBeNull();
    expect(deadlyGateHold(walk, frame(RETURN, { deaths: [{ dimension: 'overworld' }] }))).not.toBeNull();
  });

  it('remembers an observed End visit for the same task and keeps another task on its first-entry requirements', () => {
    heldOfFrame({ hands: [{ do: 'wait', seconds: 1 }] }, frame([], { dimension: 'the_end' }), 'end-visit-task');
    expect(deadlyGateHold(walk, frame(RETURN), 'end-visit-task')).toBeNull();
    expect(deadlyGateHold(walk, frame(RETURN), 'unvisited-end-task')?.line).toContain('ベッド');
    const words = preparationShortage({ dimension: 'overworld', nowKinds: ['end'], counts: new Map(RETURN), food: 80,
      world: {}, taskId: 'end-visit-task' });
    expect(words).not.toContain('ベッド');
    expect(words).not.toContain('エンダーアイ');
  });

  it('uses the same return facts for the live shortage after an End death without in-process history', () => {
    const words = preparationShortage({ dimension: 'overworld', nowKinds: ['end'], counts: new Map(RETURN), food: 80, world: endDeath });
    expect(words).toContain('目標（そろえば。必須ではない）');
    expect(words).not.toContain('ベッド');
    expect(words).not.toContain('未達の必須');
  });
});
