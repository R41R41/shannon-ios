import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { deadlyGateHold } from '../src/surfaces/minecraft/minecraftLlmcDeadlyGates.js';
import { heldOfFrame } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { BEFORE_END, END_BOW_KNOWLEDGE, PLAN_PREP_WORDS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { V2_STAGES, stageKnowledge } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
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

  // The review of 11/10 (G15): the bow stays an aim of the gate (above); the ground is told where its string comes from and what it saves,
  // and a return is told that a death in the void left nothing to pick up.
  it('says on the ground where the string of the bow comes from, and what a death in the void leaves', () => {
    expect(V2_STAGES.prep).toContain(END_BOW_KNOWLEDGE);
    expect(END_BOW_KNOWLEDGE).toContain('弓の糸はクモから');
    expect(END_BOW_KNOWLEDGE).toContain('入場は止まらない');
    const walking = stageKnowledge({ body: { state: { dimension: 'overworld' }, inventory: ['ender_eye×12'] } })!;
    expect(walking).toContain('stronghold');
    expect(walking).toContain(END_BOW_KNOWLEDGE);
    expect(PLAN_PREP_WORDS).toContain('クモを見たら剣で倒して糸3');
    expect(PLAN_PREP_WORDS).not.toContain('エンダーマンに要る');
    const cautions = seedPlan('エンドラを倒して')!.nodes.flatMap(node => node.caution ?? []);
    expect(cautions.some(line => line.includes('クモ（剣で倒すと糸'))).toBe(true);
    for (const stage of [V2_STAGES.stronghold, V2_STAGES.end]) expect(stage).toContain('虚空に落ちて死んだ時（最後の死の行の y が 0 より下');
    expect(V2_STAGES.stronghold).toContain('鉄以上の剣（止まり木の竜を打つ手）を作り直し');
  });
});
