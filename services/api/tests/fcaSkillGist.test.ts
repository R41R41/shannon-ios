import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SKILL_GIST, encodeSkill, skillGist } from '../src/mind/memory/skillDocument.js';
import { SkillMemory, fcaSkillTaskKey } from '../src/mind/memory/skillMemory.js';
import { SkillImporter } from '../src/mind/memory/skillImport.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { createFcaSkillOutcomes } from '../src/wiring/fcaSkillOutcomes.js';
import { bodySkillGists, fcaSkillGists, stepReadObserver } from '../src/wiring/fcaSkillGists.js';
import { isSkillGistPin, privateReadIds, skillGistSource } from '../src/wiring/fcaSkillGistSource.js';
import {
  GENERIC_BODY_TOOLS, MINECRAFT_SKILL_GIST_NOTE, MINECRAFT_SKILL_POINTER_NOTE, followedGists, gistToolNames, minecraftSituation, minecraftSkillContext, minecraftSkillPointers,
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
      .toEqual(['mc.build-around-self']);
    // A registry name without a hyphen is taken with the `mc.` prefix; a bare name needs a hyphen.
    expect([...gistToolNames(['1. mc.sleep と mc.dig と sleep'])]).toEqual(['mc.sleep']);
    expect([...gistToolNames(['3. leave-water があれば試す。dig-shelter も'])]).toEqual(['mc.leave-water', 'mc.dig-shelter']);
    expect(followedGists(new Map([['mc-low-health', new Set(['mc.build-around-self'])], ['mc-night-retreat', new Set(['mc.dig-shelter'])]]), 'mc.dig-shelter'))
      .toEqual(['mc-night-retreat']);
  });
  it('leaves generic tools out of the attribution, with the real legacy-minecraft draft-2 skill bodies (M2)', () => {
    const tools = (name: string) => [...gistToolNames(skillGist(body(name), observeOnlyStep))];
    // Eating in the shelter (mc.use-item) is not following the gist; building it is.
    expect(tools('mc-low-health')).toEqual(['mc.build-around-self']);
    expect(followedGists(new Map([['mc-low-health', gistToolNames(skillGist(body('mc-low-health'), observeOnlyStep))]]), 'mc.use-item')).toEqual([]);
    expect(followedGists(new Map([['mc-low-health', gistToolNames(skillGist(body('mc-low-health'), observeOnlyStep))]]), 'mc.build-around-self')).toEqual(['mc-low-health']);
    // The first three steps of the blaze gist name only generic tools: it can never record a gist use.
    expect(tools('mc-blaze-rods')).toEqual([]);
    expect(tools('mc-blaze-rods')).not.toContain('mc.accept-threat');
    expect(tools('mc-blaze-rods')).not.toContain('mc.move-to');
    expect(tools('mc-blaze-rods')).not.toContain('mc.attack-continuously');
    expect(tools('mc-blaze-rods')).not.toContain('mc.recall-places');
    expect(tools('mc-night-retreat')).toEqual(['mc.sleep-in-bed']);
    expect(tools('mc-nether-portal')).toEqual(['mc.build-structure']);
    for (const generic of ['mc.use-item', 'mc.move-to', 'mc.attack-continuously', 'mc.recall-places', 'mc.accept-threat', 'mc.list-nearby-entities']) {
      expect(GENERIC_BODY_TOOLS.has(generic)).toBe(true);
    }
    expect(tools('mc-food-and-pace')).toEqual([]);
  });
  it('shows the real skill bodies\' gists as they are (snapshot)', () => {
    const shown = Object.fromEntries([...LEGACY].map(name => [name, skillGist(body(name), observeOnlyStep)]));
    expect(shown).toMatchInlineSnapshot(`
      {
        "mc-blaze-rods": [
          "1. 持ち物を確かめる: 建築用ブロック（丸石や要塞のネザーレンガ）約80個、ハーフブロック8個、剣。足りなければ先にそろえる（ハーフブロックは同じ石3個で6個）。",
          "2. スポナーの場所は mc.recall-places（kind=spawner）で思い出す。要塞の通路を歩いてブレイズを探さない。",
          "3. mc.accept-threat（kinds=blaze,wither_skeleton、seconds=120）を呼んでから、スポナーの東西南北どれかの隣（足がスポナーと…",
        ],
        "mc-food-and-pace": [
          "2. 満腹度に余裕があり、食べられる物も持っているうちは、食料集めを始めず、道具と資源の連鎖を先に進める。準備は当面に要る最小限にする。",
          "3. 食料を持たずに満腹度が半分を切ったら、道具より先に食料を確保する。昼の地上で陸の動物を狩り、かまどで焼く。水中の魚は追わない。",
          "4. 鉄のつるはしができて深く潜る前、ポータルに入る前は、焼いた食料を十数個持つ。数個まで減ったら補ってから進む。",
        ],
        "mc-low-health": [
          "2. 逃げ続けない。建築用ブロック約10個とハーフブロック4個があれば、その場で mc.build-around-self（structureName=slit_shelter、…",
          "3. 囲いの中で食べる（mc.use-item で焼いた食料など）。体力は満腹度18以上の時しか自然に戻らないので、満腹度を高く保って回復させ、その間も囲いの中でできるクラフトを…",
          "4. 敵がいないのに体力が減る時は、火・溶岩を疑い、溶岩側をブロックで塞ぐ。",
        ],
        "mc-nether-portal": [
          "2. 鉄は先に鉄のつるはし分（3個）を確保し、次に盾（板6＋鉄1）、次にバケツ（鉄3、作業台が要る）に回す。作業台が手元に無ければ先に作って置く。",
          "3. 水を汲み、溶岩源の隣まで寄ってから、溶岩の縁へ正面から流して黒曜石にする。遠くからバケツを使わない。掘ったら所持数を確かめ、枠に要る数になるまで繰り返す。溶岩の近くでは先に…",
          "4. mc.build-structure（structureName=nether_portal）があれば材料を確かめて建て、火打石で着火する。着火後は…",
        ],
        "mc-nether-travel": [
          "2. ガストの視線が通る開けた所や、溶岩の上の細い足場に長く立たない。遠くへ行く時は、ネザーラックを掘り進むか、丸石で壁と屋根を付けてから進む。撃たれたら、まず丸石か地形で視線を…",
          "3. 長い移動は短い区間に分ける。経路の失敗や被弾が続いたら、同じ移動を繰り返さず、先に通路と退避場所を作る。",
          "4. 敵が見えないのに体力が減る時は、火・溶岩・落下を疑い、その場で待たない。溶岩側をブロックで塞ぎ、足元と周りを固めて離れる。",
        ],
        "mc-night-retreat": [
          "2. 夜の地上をさまよわない。地下へ入り、採掘・精錬・クラフトなど地下でできる用事を進める。地上でしかできない用事（食料・木）は朝に回す。",
          "3. 夜は地上に出ない。体力が半分以下なら mc-low-health、つるはしが無ければ作る。囲いの中でクラフトや精錬を進め、何もせずに待たない。",
          "4. ベッドを持っていて敵が近くにいなければ、暗くなってから mc.sleep-in-bed で夜を飛ばし、朝に回収して持ち歩く。羊が近い昼のうちに羊毛3個でベッドを作っておく。",
        ],
      }
    `);
  });
  it('cuts a line at a tool-name boundary, never inside a tool name (L1)', () => {
    const long = encodeSkill({ name: 'cut', description: '時', steps: `1. ${'あ'.repeat(70)} mc.find-blocks で探して mc.build-around-self`, aids: '- なし', references: '- なし' });
    const line = skillGist(long)[0]!;
    expect([...line].length).toBeLessThanOrEqual(SKILL_GIST.width);
    expect(line.endsWith('…')).toBe(true);
    expect(line).not.toMatch(/mc\.[a-z-]*…/u);
    for (const name of ['mc-low-health', 'mc-blaze-rods', 'mc-nether-portal', 'mc-night-retreat']) {
      for (const gist of skillGist(body(name), observeOnlyStep)) expect(gist).not.toMatch(/[a-z]-?…$/u);
    }
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
    const context = minecraftSkillContext(low, LEGACY, names => { asked.push([...names]); return new Map([['mc-food-and-pace', ['2. mc.dig-shelter で隠れる']]]); });
    expect(asked).toEqual([['mc-food-and-pace']]);
    expect(context.fields).toEqual({ skillPointers: ['mc-food-and-pace（空腹・進展が止まった・待ちが続いた）'],
      skillGists: [{ skill: 'mc-food-and-pace', steps: ['2. mc.dig-shelter で隠れる'] }], skillPointerNote: MINECRAFT_SKILL_GIST_NOTE });
    expect(Object.keys(context.fields)).toEqual(['skillPointers', 'skillGists', 'skillPointerNote']);
    expect([...context.gistTools.get('mc-food-and-pace')!]).toEqual(['mc.dig-shelter']);
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
    expect(pins).toEqual([['skill-gist:skill_mc-x:2', ['shannon-skill://skill_mc-x/gist-revision/skill_mc-x%3Av2']],
      ['skill-gist:skill_mc-y:2', ['shannon-skill://skill_mc-y/gist-revision/skill_mc-y%3Av2']]]);
  });
  it('pins a skill revision once however many decisions follow (M1)', () => {
    const sources: Array<{ readSourceIds?: string[]; recalledMemoryIds?: string[] }> = [{ recalledMemoryIds: ['turn-1'] }];
    const step = { scopeKey: 'owner', taskId: 'task-m1', snapshot: { sources } } as unknown as TaskStep;
    let pins = 0;
    const ports = bodySkillGists(step, (_scope, name) => skill(name, text), (_id, receipt) => {
      pins += 1; sources.push({ readSourceIds: [...(receipt.documents?.sourceIds ?? [])] }); return true;
    }, null);
    if (!('skillGists' in ports)) throw new Error('no ports');
    for (let decision = 0; decision < 50; decision += 1) expect([...ports.skillGists(['mc-x']).keys()]).toEqual(['mc-x']);
    expect(pins).toBe(1);
    expect(sources).toHaveLength(2);
    // Another revision of the same skill is a new source.
    const next = bodySkillGists(step, (_scope, name) => ({ ...skill(name, text), version: 3, revisionId: 'skill_mc-x:v3' }), () => { pins += 1; return true; }, null);
    if ('skillGists' in next) next.skillGists(['mc-x']);
    expect(pins).toBe(2);
  });
  it('refuses the pin and gives only the pointer when the owner is not alone (L3)', () => {
    const step = { id: 's', scopeKey: 'owner', taskId: 'task-l3', messageIds: [], snapshot: { sources: [{ kind: 'conversation', recalledMemoryIds: ['turn-1'] }] } } as unknown as TaskStep;
    let alone = false;
    const observeRead = stepReadObserver({ runtime: { observeSources: () => true, taskSources: () => [] } as unknown as TaskRuntime, step,
      ownerAlone: () => alone, readSourceVisible: () => true, sourcesVisible: () => true });
    const real = skill('mc-low-health', body('mc-low-health'));
    const ports = bodySkillGists(step, () => real, observeRead, null);
    if (!('skillGists' in ports)) throw new Error('no ports');
    const low = { ...minecraftSituation(null, { failedStepsInARow: 0 }), lowHealth: true };
    const context = minecraftSkillContext(low, new Set(['mc-low-health']), ports.skillGists);
    expect(context.fields.skillGists).toBeUndefined();
    expect(context.fields.skillPointerNote).toBe(MINECRAFT_SKILL_POINTER_NOTE);
    expect(context.fields.skillPointers?.length).toBeGreaterThan(0);
    expect(JSON.stringify(context.fields)).not.toContain('mc.build-around-self');
    expect(context.gistTools.size).toBe(0);
    alone = true;
    expect(minecraftSkillContext(low, new Set(['mc-low-health']), ports.skillGists).fields.skillGists).toHaveLength(1);
  });
  it('hands a body task the gists and its followed gists as uses of its own task', () => {
    const step = { scopeKey: 'owner', taskId: 'task-g', snapshot: { sources: [{ recalledMemoryIds: ['turn-1'] }] } } as unknown as TaskStep;
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

describe('a gist never changes whether a task can run or be consolidated (review of release/16a, M2)', () => {
  const skill = (name: string): SkillTurnSkill => ({ skillId: `skill_${name}`, name, version: 2, status: 'draft', revisionId: `skill_${name}:v2`, body: encodeSkill({ name, description: '時', steps: '1. mc.dig-shelter', aids: '- なし', references: '- なし' }) });
  it('gives a task that holds no source of its own (an operator\'s request) the pointer alone and pins nothing', () => {
    const sources: unknown[] = []; let pins = 0;
    const step = { scopeKey: 'owner', taskId: 'operator', snapshot: { sources } } as unknown as TaskStep;
    const ports = bodySkillGists(step, (_scope, name) => skill(name), () => { pins += 1; return true; }, null);
    if (!('skillGists' in ports)) throw new Error('no ports');
    expect(ports.skillGists(['mc-x']).size).toBe(0);
    expect(pins).toBe(0);
    // A pin that was made does not turn such a task into one that holds sources.
    sources.push({ readSourceIds: ['shannon-skill://skill_mc-x/gist-revision/r'] });
    expect(ports.skillGists(['mc-x']).size).toBe(0);
  });
  it('a gist pin is a skill read source for visibility but is not a private read for sleep evidence', () => {
    expect(isSkillGistPin(skillGistSource('skill_mc-x', 'skill_mc-x:v2'))).toBe(true);
    expect(isSkillGistPin(skillGistSource('skill_mc-x'))).toBe(true);
    expect(isSkillGistPin('shannon-skill://skill_mc-x/revision/skill_mc-x%3Av2')).toBe(false);
    expect(isSkillGistPin('aether-document://private')).toBe(false);
    expect(privateReadIds([skillGistSource('skill_mc-x', 'r'), 'shannon-skill://skill_mc-x/revision/r', 'aether-document://a'])).toEqual(['shannon-skill://skill_mc-x/revision/r', 'aether-document://a']);
  });
});

describe('a gist followed is a use of kind gist, settled like a read', () => {
  it('is noted only on a call of a body tool the shown gist names, never for the gist shown alone or a read-only tool', () => {
    const followed: string[] = [];
    const tools = [{ name: 'dig-shelter', readOnly: false }, { name: 'list-nearby-entities', readOnly: true }, { name: 'move-to', readOnly: false }, { name: 'use-item', readOnly: false }];
    const control = { store: { body: () => 'minecraft:home', bind: () => true, safe: () => true }, available: () => ['minecraft:home'],
      frame: () => ({ poll: { skills: tools } }), observe: () => null, imagesUnavailable: () => false, settling: () => false, cancelTask() {} } as unknown as MinecraftControl;
    const step = { id: 'step', scopeKey: 'owner', taskId: 'task-b', revision: 1, lease: { id: 'lease', holder: 'h', generation: 1 },
      snapshot: { task: { createdAt: at, summary: '' }, checkpoint: { consecutiveToolFailures: 3 }, history: [], sources: [] } } as unknown as TaskStep;
    const made = createMinecraftTaskBody({ control, runtime: { get: () => null } as unknown as TaskRuntime, step, entry: null, selector: null,
      ownerAlone: () => true, sourcesVisible: () => true, skillNames: () => LEGACY,
      skillGists: () => new Map([['mc-food-and-pace', ['2. mc.dig-shelter で隠れる。mc.use-item で食べ、mc.list-nearby-entities で確かめる']]]), gistFollowed: name => followed.push(name) });
    const call = (name: string) => made.body.noteCall!({ id: name, name, input: {} }, `op-${name}`);
    call('mc.move-to');
    expect(followed).toEqual([]);
    expect(made.body.context()).toMatchObject({ skillGists: [{ skill: 'mc-food-and-pace' }], skillPointerNote: MINECRAFT_SKILL_GIST_NOTE });
    call('mc.list-nearby-entities');
    call('mc.move-to');
    call('mc.use-item');
    expect(followed).toEqual([]);
    call('mc.dig-shelter');
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
