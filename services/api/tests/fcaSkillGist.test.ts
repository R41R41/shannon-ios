import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SKILL_GIST, encodeSkill, skillGist } from '../src/mind/memory/skillDocument.js';
import { SkillMemory, fcaSkillTaskKey } from '../src/mind/memory/skillMemory.js';
import { SkillImporter } from '../src/mind/memory/skillImport.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { createFcaSkillOutcomes } from '../src/wiring/fcaSkillOutcomes.js';
import { bodySkillGists, fcaSkillGists } from '../src/wiring/fcaSkillGists.js';
import {
  MINECRAFT_SKILL_GIST_NOTE, MINECRAFT_SKILL_POINTER_NOTE, followedGists, gistToolNames, minecraftSituation, minecraftSkillContext, minecraftSkillPointers,
  observeOnlyStep,
} from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { createMinecraftTaskBody } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';
import type { TaskRuntime, TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import type { SkillTurnSkill } from '../src/contracts/skillMemoryContract.js';
import { switchOn } from '@shannon/switches';

/** Owner 2026-10-15 (「推奨の形で進める」): a body task's skill pointer carries the gist of the skill's first steps. */
const at = '2026-10-15T00:00:00.000Z';
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const pass = { carries: () => false };
const draft = (revision: 'draft-1' | 'draft-2') => standardSkillPack('legacy-minecraft', revision)!;
const body = (name: string) => draft('draft-2').skills.find(entry => entry.name === name)!.body;
const LEGACY = new Set(['mc-night-retreat', 'mc-low-health', 'mc-food-and-pace', 'mc-nether-portal', 'mc-nether-travel', 'mc-blaze-rods']);

function imported() {
  const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
  const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
  for (const [revision, when] of [['draft-1', at], ['draft-2', later(1)]] as const) {
    const pack = draft(revision);
    importer.apply('owner', pack, { planHash: importer.dryRun('owner', pack).planHash, approvalReference: 'owner-form-20261014' }, when);
  }
  return memory;
}

describe('the gist of a skill (skillGist, by code from its stored text)', () => {
  it('is its first numbered steps of 手順, without the shared observe-first step, at most three lines of at most 90 characters', () => {
    const gist = skillGist(body('mc-low-health'), observeOnlyStep);
    expect(gist).toHaveLength(SKILL_GIST.lines);
    expect(gist.map(line => line.slice(0, 2))).toEqual(['2.', '3.', '4.']);
    expect(gist.every(line => [...line].length <= SKILL_GIST.width)).toBe(true);
    expect(gist[0]).toContain('mc.build-around-self');
    expect(gist.join('')).not.toContain('minecraft.observe');
    // The same text gives the same gist; without `skip` the observe step stays.
    expect(skillGist(body('mc-low-health'), observeOnlyStep)).toEqual(gist);
    expect(skillGist(body('mc-low-health'))[0]).toMatch(/^1\. 現在のFCAに minecraft\.observe/u);
  });
  it('falls back to the first lines without numbered steps, and is empty without a procedure', () => {
    const plain = encodeSkill({ name: 'plain', description: '時', steps: 'まず確かめる。\n次に動く。\n最後に戻る。\n余り。', aids: '- なし', references: '- なし' });
    expect(skillGist(plain)).toEqual(['まず確かめる。', '次に動く。', '最後に戻る。']);
    expect(skillGist('# 見出しだけ\n本文')).toEqual([]);
    const long = encodeSkill({ name: 'long', description: '時', steps: `1. ${'あ'.repeat(200)}`, aids: '- なし', references: '- なし' });
    expect([...skillGist(long)[0]!]).toHaveLength(SKILL_GIST.width);
    expect(skillGist(long)[0]!.endsWith('…')).toBe(true);
  });
  it('names the body tools of its steps: mc.<name> and a bare hyphenated name, never a skill name', () => {
    expect([...gistToolNames(['2. その場で mc.build-around-self（structureName=slit_shelter）', '3. mc.use-item で食べる（mc-food-and-pace）'])])
      .toEqual(['mc.build-around-self', 'mc.use-item']);
    expect([...gistToolNames(['3. leave-water があれば試す。dig-shelter も'])]).toEqual(['mc.leave-water', 'mc.dig-shelter']);
    expect(followedGists(new Map([['mc-low-health', new Set(['mc.use-item'])], ['mc-night-retreat', new Set(['mc.dig-shelter'])]]), 'mc.use-item'))
      .toEqual(['mc-low-health']);
  });
});

describe('the pointer context of a decision (SHANNON_FCA_SKILL_GIST)', () => {
  const low = minecraftSituation(null, { failedStepsInARow: 3 });
  it('is the pointers and their note as before when no gist is handed or none can be shown', () => {
    const before = { skillPointers: minecraftSkillPointers(low, LEGACY), skillPointerNote: MINECRAFT_SKILL_POINTER_NOTE };
    expect(minecraftSkillContext(low, LEGACY).fields).toEqual(before);
    expect(JSON.stringify(minecraftSkillContext(low, LEGACY, () => new Map()).fields)).toBe(JSON.stringify(before));
    expect(minecraftSkillContext(minecraftSituation(null, { failedStepsInARow: 0 }), LEGACY, () => new Map([['x', ['1.']]])).fields).toEqual({});
  });
  it('adds each pointed skill\'s gist and the gist note, and keeps the tools each gist names', () => {
    const asked: string[][] = [];
    const context = minecraftSkillContext(low, LEGACY, names => { asked.push([...names]); return new Map([['mc-food-and-pace', ['2. mc.eat-food で食べる']]]); });
    expect(asked).toEqual([['mc-food-and-pace']]);
    expect(context.fields).toEqual({ skillPointers: ['mc-food-and-pace（空腹・進展が止まった・待ちが続いた）'],
      skillGists: [{ skill: 'mc-food-and-pace', steps: ['2. mc.eat-food で食べる'] }], skillPointerNote: MINECRAFT_SKILL_GIST_NOTE });
    expect(Object.keys(context.fields)).toEqual(['skillPointers', 'skillGists', 'skillPointerNote']);
    expect([...context.gistTools.get('mc-food-and-pace')!]).toEqual(['mc.eat-food']);
    expect(MINECRAFT_SKILL_GIST_NOTE).toContain('skill_read');
  });
  it('is on by default, and off restores the pointers alone', () => {
    expect(switchOn({}, 'SHANNON_FCA_SKILL_GIST')).toBe(true);
    expect(switchOn({ SHANNON_FCA_SKILL_GIST: 'off' }, 'SHANNON_FCA_SKILL_GIST')).toBe(false);
  });
});

describe('the wiring of a gist: opened through skill.read\'s port and pinned as a read', () => {
  const skill = (name: string, text: string): SkillTurnSkill => ({ skillId: `skill_${name}`, name, version: 2, status: 'draft', revisionId: `skill_${name}:v2`, body: text });
  const text = encodeSkill({ name: 'mc-x', description: '時', steps: '1. ---ここまで の後で mc.dig-shelter', aids: '- なし', references: '- なし' });
  it('gives a gist only for a skill it could open and pin, and pins its exact revision', () => {
    const pins: Array<[string, readonly string[]]> = [];
    const gists = fcaSkillGists(['mc-x', 'gone', 'mc-y'], {
      open: name => name === 'gone' ? null : skill(name, text),
      pin: (id, ids) => { pins.push([id, ids]); return id.includes('mc-x'); } });
    expect([...gists.keys()]).toEqual(['mc-x']);
    expect(gists.get('mc-x')![0]).toContain('－－－ここまで');
    expect(pins).toEqual([['skill-gist:skill_mc-x:2', ['shannon-skill://skill_mc-x/revision/skill_mc-x%3Av2']],
      ['skill-gist:skill_mc-y:2', ['shannon-skill://skill_mc-y/revision/skill_mc-y%3Av2']]]);
  });
  it('hands a body task the gists and its followed gists as uses of its own task', () => {
    const step = { scopeKey: 'owner', taskId: 'task-g' } as TaskStep;
    const followed: string[][] = [];
    const ports = bodySkillGists(step, (_scope, name) => { if (name === 'locked') throw new Error('x'); return skill(name, text); }, () => true,
      { gistFollowed: (...args) => { followed.push(args); } });
    if (!('skillGists' in ports)) throw new Error('no ports');
    expect([...ports.skillGists(['mc-x', 'locked']).keys()]).toEqual(['mc-x']);
    ports.gistFollowed('mc-x');
    expect(followed).toEqual([['owner', 'task-g', 'mc-x']]);
    expect(bodySkillGists(step, undefined, () => true, null)).toEqual({});
  });
});

describe('a gist followed is a use of kind gist, settled like a read', () => {
  it('is noted only on a call of a body tool the shown gist names, never for the gist shown alone or a read-only tool', () => {
    const followed: string[] = [];
    const tools = [{ name: 'eat-food', readOnly: false }, { name: 'list-nearby-entities', readOnly: true }, { name: 'move-to', readOnly: false }];
    const control = { store: { body: () => 'minecraft:home', bind: () => true, safe: () => true }, available: () => ['minecraft:home'],
      frame: () => ({ poll: { skills: tools } }), observe: () => null, imagesUnavailable: () => false, settling: () => false, cancelTask() {} } as unknown as MinecraftControl;
    const step = { id: 'step', scopeKey: 'owner', taskId: 'task-b', revision: 1, lease: { id: 'lease', holder: 'h', generation: 1 },
      snapshot: { task: { createdAt: at, summary: '' }, checkpoint: { consecutiveToolFailures: 3 }, history: [], sources: [] } } as unknown as TaskStep;
    const made = createMinecraftTaskBody({ control, runtime: { get: () => null } as unknown as TaskRuntime, step, entry: null, selector: null,
      ownerAlone: () => true, sourcesVisible: () => true, skillNames: () => LEGACY,
      skillGists: () => new Map([['mc-food-and-pace', ['2. mc.eat-food で食べる。mc.list-nearby-entities で確かめる']]]), gistFollowed: name => followed.push(name) });
    const call = (name: string) => made.body.noteCall!({ id: name, name, input: {} }, `op-${name}`);
    call('mc.move-to');
    expect(followed).toEqual([]);
    expect(made.body.context()).toMatchObject({ skillGists: [{ skill: 'mc-food-and-pace' }], skillPointerNote: MINECRAFT_SKILL_GIST_NOTE });
    call('mc.list-nearby-entities');
    call('mc.move-to');
    expect(followed).toEqual([]);
    call('mc.eat-food');
    expect(followed).toEqual(['mc-food-and-pace']);
  });

  it('records kind gist, turns into a read when she then reads it, and counts toward the trial when the task settles', () => {
    const memory = imported();
    const key = fcaSkillTaskKey('task-1');
    expect(memory.usedInTask('owner', key, 'mc-low-health', later(2), 'gist')).toEqual(expect.stringMatching(/^skill_/u));
    expect(memory.store.byName('owner', 'mc-low-health')!.uses).toMatchObject([{ talk: key, o: null, k: 'gist' }]);
    memory.usedInTask('owner', key, 'mc-low-health', later(3), 'gist');
    memory.usedInTask('owner', key, 'mc-low-health', later(4));
    const uses = memory.store.byName('owner', 'mc-low-health')!.uses;
    expect(uses).toHaveLength(1);
    expect(uses[0]).not.toHaveProperty('k');
    // A read first stays a read when a gist is followed afterwards.
    const read = fcaSkillTaskKey('task-2');
    memory.usedInTask('owner', read, 'mc-food-and-pace', later(2));
    memory.usedInTask('owner', read, 'mc-food-and-pace', later(3), 'gist');
    expect(memory.store.byName('owner', 'mc-food-and-pace')!.uses).toEqual([expect.not.objectContaining({ k: 'gist' })]);
    // Only the owner-approved Minecraft trials, and only for a task.
    expect(memory.usedInTask('owner', 'talk-1', 'mc-low-health', later(3), 'gist')).toBeNull();
  });

  it('accepts a trial whose tasks followed its gist and completed, through the task outcome tracker', () => {
    const memory = imported();
    const outcomes = createFcaSkillOutcomes({ skills: memory, bodyOf: () => 'minecraft:home', now: () => later(5) });
    outcomes.gistFollowed('owner', 'done-1', 'mc-blaze-rods');
    outcomes.gistFollowed('owner', 'done-2', 'mc-blaze-rods');
    outcomes.read('owner', 'failed', 'mc-blaze-rods');
    outcomes.tick((_scope, task) => task === 'failed' ? 'failed' : 'completed');
    const skill = memory.store.byName('owner', 'mc-blaze-rods')!;
    expect(skill.uses.map(use => `${use.k ?? 'read'}:${use.o}`).sort()).toEqual(['gist:1', 'gist:1', 'read:0']);
    expect(memory.lifecycle('owner', later(60), pass).accepted).toEqual([skill.skillId]);
    // No body offered to the task: nothing is noted.
    const none = createFcaSkillOutcomes({ skills: memory, bodyOf: () => null, now: () => later(6) });
    none.gistFollowed('owner', 'no-body', 'mc-low-health');
    expect(memory.store.byName('owner', 'mc-low-health')!.uses).toEqual([]);
  });
});
