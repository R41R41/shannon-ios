import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { SKILL_CAPACITY, SKILL_INDEX_HEADER, SKILL_INDEX_LINES, SKILL_INDEX_WIDTH, encodeSkill } from '../src/mind/memory/skillDocument.js';
import { FCA_TASK_USE_PREFIX, SkillMemory, fcaSkillTaskKey } from '../src/mind/memory/skillMemory.js';
import { SkillImporter, skillArtifactSha256 } from '../src/mind/memory/skillImport.js';
import type { SkillPack } from '../src/mind/memory/skillImportContract.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { createFcaSkillOutcomes, withSkillOutcomes } from '../src/wiring/fcaSkillOutcomes.js';
import { fcaResearchTools } from '../src/wiring/fcaResearchWiring.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { actionHarness } from './support/actionThreadHarness.js';

const at = '2026-10-14T00:00:00.000Z';
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const pass = { carries: () => false };
const draft1 = () => standardSkillPack('legacy-minecraft', 'draft-1')!;
const draft2 = () => standardSkillPack('legacy-minecraft', 'draft-2')!;

function world() {
  const database = new DatabaseSync(':memory:');
  const memory = new SkillMemory({ database, createsSchema: true, defer: task => task(), log: () => {} });
  const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
  const apply = (pack: SkillPack, when = at) => importer.apply('owner', pack, { planHash: importer.dryRun('owner', pack).planHash, approvalReference: 'owner-form-20261014' }, when);
  return { database, memory, importer, apply };
}

describe('skill capacity 25 (owner decision of 2026-10-14)', () => {
  it('lists up to 25 skills in a 26-line index of at most 80 characters', () => {
    expect(SKILL_CAPACITY).toBe(25);
    expect(SKILL_INDEX_LINES).toBe(26);
    const { memory } = world();
    for (let i = 0; i < SKILL_CAPACITY; i++) {
      const created = memory.create('owner', { draft: { name: `skill-${i}`, description: `用途${i}の時`, steps: '1. 確かめる', aids: '- なし', references: '- 運用作成' }, evidence: [] }, pass, at);
      expect(created).toHaveProperty('skillId');
    }
    const lines = memory.index('owner').split('\n');
    expect(lines[0]).toBe(`${SKILL_INDEX_HEADER} 25/25（目次。中身は skill_read で開く）]`);
    expect(lines).toHaveLength(SKILL_INDEX_LINES);
    expect(lines.every(line => [...line].length <= SKILL_INDEX_WIDTH)).toBe(true);
    expect(memory.create('owner', { draft: { name: 'one-more', description: '余分な時', steps: '1. 確かめる', aids: '- なし', references: '- 運用作成' }, evidence: [] }, pass, at)).toEqual({ rejected: 'over_capacity' });
  });
});

describe('legacy-minecraft draft-2: five new trials and a revision of mc-night-retreat', () => {
  it('ships exact artifacts with descriptions that name the situation within the index width', () => {
    const pack = draft2();
    expect(pack.skills.map(entry => entry.name)).toEqual(['mc-nether-portal', 'mc-nether-travel', 'mc-blaze-rods', 'mc-low-health', 'mc-food-and-pace', 'mc-night-retreat']);
    expect(pack.skills.every(entry => skillArtifactSha256(entry.body) === entry.sha256)).toBe(true);
    const old = draft1().skills.find(entry => entry.name === 'mc-night-retreat')!;
    expect(pack.skills.find(entry => entry.name === 'mc-night-retreat')!.revises).toEqual({ bodySha256: old.sha256 });
    for (const entry of pack.skills) {
      expect(entry.body).not.toMatch(/-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/u);
      expect(entry.body).toContain('旧Minebot実験');
      expect(entry.body).not.toMatch(/朝まで待つ|回復を待つ/u);
    }
  });

  it('imports after draft-1 through the ordinary paths, idempotently, and keeps version 1 of the revised skill', () => {
    const { memory, importer, apply } = world();
    expect(apply(draft1())).toHaveProperty('receipt');
    const before = memory.store.byName('owner', 'mc-night-retreat')!;
    const plan = importer.dryRun('owner', draft2());
    expect(plan.problems).toEqual([]);
    expect(plan.capacity).toEqual({ used: 4, added: 5, limit: SKILL_CAPACITY });
    const result = apply(draft2(), later(1));
    if (!('receipt' in result)) throw new Error(JSON.stringify(result));
    expect(result.idempotent).toBe(false);
    expect(memory.store.all('owner')).toHaveLength(9);
    const revised = memory.store.byName('owner', 'mc-night-retreat')!;
    expect(revised).toMatchObject({ skillId: before.skillId, version: 2, status: 'trial', trialBaseVersion: null, madeBy: 'operator_authored', uses: [], successes: 0,
      provenance: { packRevision: 'draft-1' } });
    expect(skillArtifactSha256(revised.body)).toBe(draft2().skills.find(entry => entry.name === 'mc-night-retreat')!.sha256);
    expect(result.receipt.skills.find(item => item.name === 'mc-night-retreat')).toMatchObject({ skillId: before.skillId, revisionId: `${before.skillId}:v2` });
    const revisions = memory.store.revisions('owner', before.skillId);
    expect(revisions.map(item => [item.version, item.actor, item.reason])).toEqual([[1, 'operator_authored', 'operator_import'], [2, 'operator_authored', 'operator_revised']]);
    expect(revisions[0]!.body).toBe(before.body);
    expect(revisions[1]!.evidence).toEqual([`import:${result.receipt.receiptId}`]);
    const audits = memory.store.audits('owner').filter(entry => entry.skillId === before.skillId);
    expect(audits.map(entry => [entry.kind, entry.status])).toEqual(expect.arrayContaining([['create', 'superseded'], ['patch', 'trial']]));
    expect(memory.open('owner', 'mc-night-retreat')).not.toBeNull();
    for (const name of ['mc-nether-portal', 'mc-blaze-rods']) expect(memory.store.byName('owner', name)).toMatchObject({ status: 'trial', provenance: { packRevision: 'draft-2' } });
    expect(['mc-nether-portal', 'mc-nether-travel', 'mc-blaze-rods', 'mc-low-health', 'mc-food-and-pace', 'mc-night-retreat']
      .map(name => memory.store.byName('owner', name)!.provenance?.targetMilestone ?? 'none')).toEqual(['nether', 'nether', 'blaze_rods', 'none', 'none', 'none']);
    // A milestone is only the aim of a new skill, and only one the body reports.
    const pack = draft2();
    const bad = (milestone: unknown, revises = false) => importer.dryRun('owner', { ...pack, revision: 'draft-x', skills: [{ ...pack.skills[0]!, name: 'mc-x', milestone,
      ...(revises ? { revises: { bodySha256: pack.skills[0]!.sha256 } } : {}) } as never] }).problems;
    expect(bad('dragon')).toContainEqual({ name: 'mc-x', code: 'invalid_milestone' });
    expect(bad('nether', true)).toContainEqual({ name: 'mc-x', code: 'invalid_milestone' });
    // The same pack again: the same receipt, nothing written.
    expect(apply(draft2(), later(2))).toMatchObject({ idempotent: true, receipt: { receiptId: result.receipt.receiptId } });
    expect(memory.store.byName('owner', 'mc-night-retreat')!.version).toBe(2);
    expect(memory.store.all('owner')).toHaveLength(9);
  });

  it('refuses the revision when its base changed, was used, was edited by the owner or is missing, and rolls the whole pack back', () => {
    const missing = world();
    expect(missing.importer.dryRun('owner', draft2()).problems).toContainEqual({ name: 'mc-night-retreat', code: 'revision_target_missing' });
    const used = world();
    used.apply(draft1());
    used.memory.usedInTask('owner', fcaSkillTaskKey('task-1'), 'mc-night-retreat', later(1));
    expect(used.importer.dryRun('owner', draft2()).problems).toContainEqual({ name: 'mc-night-retreat', code: 'on_trial' });
    expect(used.apply(draft2())).toMatchObject({ rejected: 'validation_failed' });
    expect(used.memory.store.all('owner')).toHaveLength(4);
    const edited = world();
    edited.apply(draft1());
    const id = edited.memory.store.byName('owner', 'mc-night-retreat')!.skillId;
    edited.memory.adoptOwnerEdit('owner', id, edited.memory.store.get('owner', id)!.body.replace('近場の退避', '近くの退避'), { documentId: 'copy', version: 2 }, pass, at);
    expect(edited.importer.dryRun('owner', draft2()).problems).toContainEqual({ name: 'mc-night-retreat', code: 'owner_edited' });
    const changed = world();
    changed.apply(draft1());
    const body = encodeSkill({ name: 'mc-night-retreat', description: '夜の時', steps: '1. 確かめる', aids: '- なし', references: '- 運用作成' });
    const pack = { ...draft2(), skills: draft2().skills.map(entry => entry.name === 'mc-night-retreat' ? { ...entry, revises: { bodySha256: skillArtifactSha256(body) } } : entry) };
    expect(changed.importer.dryRun('owner', pack).problems).toContainEqual({ name: 'mc-night-retreat', code: 'revision_base_changed' });
  });
});

describe('a Minecraft task reading a skill: a use its outcome settles', () => {
  function imported() {
    const w = world();
    w.apply(draft1()); w.apply(draft2(), later(1));
    return w;
  }

  it('records one pending use per task and version, which the night does not settle from G', () => {
    const { memory } = imported();
    const key = fcaSkillTaskKey('task-a');
    expect(key.startsWith(FCA_TASK_USE_PREFIX)).toBe(true);
    expect(memory.usedInTask('owner', key, 'mc-blaze-rods', later(2))).toEqual(expect.stringMatching(/^skill_/u));
    memory.usedInTask('owner', key, 'mc-blaze-rods', later(3));
    expect(memory.usedInTask('owner', 'talk-1', 'mc-blaze-rods', later(3))).toBeNull();
    expect(memory.usedInTask('owner', key, 'no-such-skill', later(3))).toBeNull();
    expect(memory.store.byName('owner', 'mc-blaze-rods')!.uses).toMatchObject([{ talk: key, o: null }]);
    expect(memory.settleUses('owner', later(24 * 60))).toBe(0);
    expect(memory.lifecycle('owner', later(24 * 60), pass)).toEqual({ accepted: [], reverted: [], retired: [] });
    expect(memory.store.byName('owner', 'mc-blaze-rods')!.uses[0]!.o).toBeNull();
  });

  it('accepts a trial after two tasks succeed, and retires one whose tasks failed, by the existing rule at night', () => {
    const { memory } = imported();
    for (const [task, outcome] of [['t1', 1], ['t2', 1]] as const) {
      memory.usedInTask('owner', fcaSkillTaskKey(task), 'mc-blaze-rods', later(2));
      expect(memory.settleTask('owner', fcaSkillTaskKey(task), outcome, later(3))).toBe(1);
    }
    for (const [task, outcome] of [['t3', 0], ['t4', 1], ['t5', 0]] as const) {
      memory.usedInTask('owner', fcaSkillTaskKey(task), 'mc-nether-travel', later(2));
      memory.settleTask('owner', fcaSkillTaskKey(task), outcome, later(3));
    }
    const blaze = memory.store.byName('owner', 'mc-blaze-rods')!, travel = memory.store.byName('owner', 'mc-nether-travel')!;
    expect(blaze).toMatchObject({ successes: 2 });
    expect(memory.lifecycle('owner', later(60), pass)).toEqual({ accepted: [blaze.skillId], reverted: [], retired: [travel.skillId] });
  });

  it('settles by milestones (null is unknown), death, completion and failure, and leaves a stopped task pending', () => {
    const { memory } = imported();
    const bodies = new Map([['nether', 'minecraft:a'], ['rods', 'minecraft:a'], ['dead', 'minecraft:a'], ['done', 'minecraft:b'], ['fail', 'minecraft:b'], ['stop', 'minecraft:b']]);
    const outcomes = createFcaSkillOutcomes({ skills: memory, bodyOf: task => bodies.get(task) ?? null, now: () => later(5) });
    const evidence = (milestones: unknown) => JSON.stringify({ schemaVersion: 1, boss: { verified: false }, milestones });
    const pending = (task: string, name: string) => memory.store.byName('owner', name)!.uses.find(use => use.talk === fcaSkillTaskKey(task))?.o;

    outcomes.evidence('owner', 'nether', evidence({ netherReached: false, blazeRods: null }));
    outcomes.read('owner', 'nether', 'mc-nether-portal');
    outcomes.evidence('owner', 'nether', evidence({ netherReached: null, blazeRods: null }));
    expect(pending('nether', 'mc-nether-portal')).toBeNull();
    outcomes.evidence('owner', 'nether', evidence({ netherReached: true, blazeRods: null }));
    expect(pending('nether', 'mc-nether-portal')).toBe(1);

    outcomes.read('owner', 'rods', 'mc-blaze-rods');
    outcomes.evidence('owner', 'rods', evidence({ netherReached: true, blazeRods: null }));
    outcomes.evidence('owner', 'rods', evidence({ netherReached: true, blazeRods: 2 }));
    expect(pending('rods', 'mc-blaze-rods')).toBeNull();
    outcomes.evidence('owner', 'rods', evidence({ netherReached: true, blazeRods: null }));
    outcomes.evidence('owner', 'rods', evidence({ netherReached: true, blazeRods: 3 }));
    expect(pending('rods', 'mc-blaze-rods')).toBe(1);

    outcomes.read('owner', 'dead', 'mc-low-health');
    outcomes.died('minecraft:other');
    expect(pending('dead', 'mc-low-health')).toBeNull();
    outcomes.died('minecraft:a');
    expect(pending('dead', 'mc-low-health')).toBe(0);

    // A milestone credits only the skills aiming at it: a skill without one waits for the task's end.
    outcomes.read('owner', 'done', 'mc-low-health');
    outcomes.evidence('owner', 'done', evidence({ netherReached: false, blazeRods: 0 }));
    outcomes.evidence('owner', 'done', evidence({ netherReached: true, blazeRods: 1 }));
    expect(pending('done', 'mc-low-health')).toBeNull();
    for (const task of ['done', 'fail', 'stop']) outcomes.read('owner', task, 'mc-food-and-pace');
    const phases: Record<string, 'completed' | 'failed' | 'stopped'> = { done: 'completed', fail: 'failed', stop: 'stopped' };
    outcomes.tick((_scope, task) => phases[task] ?? 'executing');
    expect([pending('done', 'mc-food-and-pace'), pending('done', 'mc-low-health'), pending('fail', 'mc-food-and-pace')]).toEqual([1, 1, 0]);
    // Stopped: its pending read is dropped, never left to push settled uses out.
    expect(memory.store.byName('owner', 'mc-food-and-pace')!.uses.some(use => use.talk === fcaSkillTaskKey('stop'))).toBe(false);
    outcomes.evidence('owner', 'nether', 'not json');
  });

  it('notes a skill.read of a task run through the research port, and never for a turn without a task', async () => {
    const reads: string[] = [];
    const definition = { name: 'skill.read', description: 'read', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
      domain: 'skill_read', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
    const tools = { offered: () => [definition], call: async () => ({ ok: true, text: 'スキル' }), skillIndex: () => '', skillIndexSources: () => [] };
    const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
    const lease = { id: 'lease-1' };
    const port = fcaResearchTools({ tools: tools as never, state, conversations, scopeKey: 'owner', ownerAlone: () => true,
      task: { id: 'task-1', origin: 'owner_request', leaseId: lease.id }, observeRead: () => true, skillRead: name => reads.push(name) });
    const signal = new AbortController().signal;
    await inActionExecution({ lease, signal, permit: async () => true } as never, () => port.execute({ name: 'skill.read', input: { name: ' mc-blaze-rods ' }, scopeKey: 'owner', taskId: 'task-1', operationId: 'op-1', signal } as never));
    expect(reads).toEqual(['mc-blaze-rods']);
  });

  it('tells the death listeners when a body on the same connection is seen alive and then dead, once', () => {
    const h = actionHarness(() => at);
    try {
      const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
      const control = new MinecraftControl(new MinecraftControlStore(h.db), configuration, { now: () => Date.parse(at), ownerAlone: () => true, leaseValid: () => true });
      const deaths: string[] = [];
      control.deathListeners.add(body => deaths.push(body));
      control.deathListeners.add(() => { throw new Error('a listener never fails a poll'); });
      let sequence = 0;
      const poll = (alive: boolean, connectionId = 'connection') => control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, {
        schemaVersion: 1, serverId: 'world', connectionId,
        observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: at, receivedAt: at, connected: true, state: {}, facts: { alive } },
        skills: [], candidates: [], receipts: [], activeOperationIds: [] } as never);
      poll(false); poll(true); poll(false); poll(false); poll(false, 'other');
      expect(deaths).toEqual(['minecraft:world']);
    } finally { h.close(); }
  });

  it('settles a death of the only connected body for a task not yet bound to it, as reads count it', () => {
    const { memory } = imported();
    const listeners = new Set<(body: string) => void>();
    const control = { store: { body: () => null }, available: () => ['minecraft:only'], deathListeners: listeners };
    const minecraft = withSkillOutcomes({ control: control as never }, memory, () => later(5))!;
    minecraft.skillOutcomes!.read('owner', 'unbound', 'mc-low-health');
    expect(memory.store.byName('owner', 'mc-low-health')!.uses).toMatchObject([{ talk: fcaSkillTaskKey('unbound'), o: null }]);
    for (const listener of listeners) listener('minecraft:only');
    expect(memory.store.byName('owner', 'mc-low-health')!.uses).toMatchObject([{ talk: fcaSkillTaskKey('unbound'), o: 0 }]);
    expect(withSkillOutcomes(null, memory)).toBeNull();
  });

  it('records nothing for a skill outside the legacy Minecraft pack, even while a body is connected and then dies', () => {
    const { memory, apply } = imported();
    const standard = standardSkillPack('standard10', 'draft-2')!;
    expect(apply({ ...standard, skills: standard.skills.slice(0, 1) } as SkillPack, later(2))).toHaveProperty('receipt');
    const learned = memory.create('owner', { draft: { name: 'her-own', description: '自分で覚えた時', steps: '1. 確かめる', aids: '- なし', references: '- 経験' }, evidence: [] }, pass, at);
    expect(learned).toHaveProperty('skillId');
    const listeners = new Set<(body: string) => void>();
    const control = { store: { body: () => null }, available: () => ['minecraft:only'], deathListeners: listeners };
    const outcomes = withSkillOutcomes({ control: control as never }, memory, () => later(5))!.skillOutcomes!;
    const names = [standard.skills[0]!.name, 'her-own'];
    for (const name of names) outcomes.read('owner', 'research', name);
    expect(memory.usedInTask('owner', fcaSkillTaskKey('research'), names[0]!, later(6))).toBeNull();
    for (const listener of listeners) listener('minecraft:only');
    outcomes.tick(() => 'failed');
    for (const name of names) expect(memory.store.byName('owner', name)!.uses).toEqual([]);
  });
});
