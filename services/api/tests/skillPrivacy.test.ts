import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { UNKNOWN_GUEST_PRESENCE, createInitialCompanionState, type CompanionStateSnapshot } from '@shannon/cognition';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { WITHDRAWN_COPY_BODY } from '../src/integrations/aether/skillExport.js';
import { encodeSkill, type SkillDocument } from '../src/mind/memory/skillDocument.js';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { configuredSkillExport, skillBodyCheck, skillSeedSources } from '../src/wiring/skillMemoryWiring.js';
import { SKILL_SOURCES_LIMIT } from '../src/mind/memory/skillMemoryParts.js';
import { createSkillsRoute, HIDDEN_BODY } from '../src/infra/http/skillRoutes.js';
import { ShannonSkillConsolidator } from '../src/mind/sleep/skillConsolidation.js';
import type { SkillSleepModel } from '../src/mind/sleep/skillSleepModel.js';
import { FakeAetherFolder } from './support/fakeAetherFolder.js';

/**
 * Privacy review B1 and B2 of Syzygy ADR-0008 stage 2 (`docs/skill-and-routing-contract.md`, 「スキル記憶」): what a skill may be
 * built from, and the check of every body at build, restore, adoption and export, with a copy withdrawn when its skill may no
 * longer be shown.
 */
const AT = '2026-10-07T03:00:00.000Z';
const SECRET = 'ウォンバット会の集まりに毎月出ている';
/** A day later: the night's limits on new and patched skills start again. */
const NEXT_DAY = '2026-10-08T03:00:00.000Z';
const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };
const directory = mkdtempSync(join(tmpdir(), 'shannon-skill-privacy-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let files = 0;

function world() {
  const path = join(directory, `privacy-${files += 1}.sqlite`);
  const store = new SQLiteShannonStore({ path, now: () => AT });
  const skills = new SkillMemory({ database: new DatabaseSync(path), createsSchema: true, defer: task => task(), log: () => {} });
  const overrides: { state: CompanionStateSnapshot } = { state: createInitialCompanionState('owner', AT) };
  const viewed = Object.assign(Object.create(store) as SQLiteShannonStore, { snapshot: () => overrides.state });
  return { store, viewed, skills, overrides };
}
const forgetting = (id: string): CompanionStateSnapshot => ({
  ...createInitialCompanionState('owner', AT), memoryControls: [{ memoryId: id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: AT, changeReason: 'forget' }],
});
const keeping = (statement: string): CompanionStateSnapshot => ({
  ...createInitialCompanionState('owner', AT), userFacts: [{ id: 's', statement, confidence: 0.9, observedAt: AT, disclosure: { category: 'secret' } }],
});
const doc = (name: string, steps: string): SkillDocument => ({ name, description: 'ふりかえりの時', steps, aids: '- なし', references: '- 会話から' });

describe('what a skill may be built from (B1)', () => {
  it('seeds a knowledge note only when every turn it was built from passes the seed rule', () => {
    const { store, viewed, overrides } = world();
    const thread = store.createThread('owner');
    const alone = store.appendTurn('owner', thread, '写真整理が進まない', 'アルバムごとに区切ろう', '2026-09-20T00:00:00.000Z', { capturedStateVersion: 0, messageEmotion: emotion });
    const again = store.appendTurn('owner', thread, 'アルバム単位だと進んだ', 'よかった', '2026-09-25T00:00:00.000Z', { capturedStateVersion: 0, messageEmotion: emotion });
    const guest = store.appendTurn('owner', thread, '友だちと写真の話', 'いいですね', '2026-09-26T00:00:00.000Z',
      { capturedStateVersion: 0, messageEmotion: emotion, audience: UNKNOWN_GUEST_PRESENCE, speaker: 'unknown' });
    const note = (title: string, sources: string[]) => store.createShannonKnowledge('owner', {
      title, applicability: '写真整理の相談', bodyMarkdown: '## 行動\nアルバム単位で小さく区切る。', status: 'confirmed', sourceExperienceIds: sources }, AT, 'test');
    note('二人の時の話', [alone.id, again.id]);
    note('ほかの人もいた話', [alone.id, guest.id]);
    note('元が見つからない話', [alone.id, 'turn-missing']);
    const titles = () => skillSeedSources(viewed, null).knowledge('owner').map(item => item.title);
    expect(titles()).toEqual(['二人の時の話']);
    // A source forgotten afterwards takes the note out at once.
    overrides.state = forgetting(again.id);
    expect(titles()).toEqual([]);
    store.close();
  });
});

describe('every body checked again (B2)', () => {
  it('withdraws the copy of a skill whose source was forgotten, or whose body is now 内緒, and writes nothing to it again', async () => {
    const { store, viewed, skills, overrides } = world();
    const thread = store.createThread('owner');
    const turn = store.appendTurn('owner', thread, 'ふりかえりの話', 'うん', '2026-09-20T00:00:00.000Z', { capturedStateVersion: 0, messageEmotion: emotion });
    const pass = { carries: () => false };
    const forgotten = (skills.create('owner', { draft: doc('from-a-turn', '1. 三つ挙げる'), evidence: [`experience:${turn.id}`] }, pass, AT) as { skillId: string }).skillId;
    const secret = (skills.create('owner', { draft: doc('club-day', `1. ${SECRET}日を避ける`), evidence: [] }, pass, AT) as { skillId: string }).skillId;
    const fine = (skills.create('owner', { draft: doc('weekly-review', '1. 三つ挙げる'), evidence: [] }, pass, AT) as { skillId: string }).skillId;
    const folder = new FakeAetherFolder();
    const run = configuredSkillExport({}, { memory: skills, store: viewed, access: folder, log: () => {} })!;
    expect(await run('owner', AT)).toMatchObject({ created: 3 });
    overrides.state = { ...forgetting(turn.id), userFacts: keeping(SECRET).userFacts };
    expect(await run('owner', AT)).toMatchObject({ withdrawn: 2, created: 0, updated: 0 });
    for (const skillId of [forgotten, secret]) {
      const skill = skills.store.get('owner', skillId)!;
      expect(folder.documents.get(skill.aetherDocumentId!)!.body).toBe(WITHDRAWN_COPY_BODY);
      expect(skill.exportHold).toBe('withdrawn');
    }
    expect(folder.documents.get(skills.store.get('owner', fine)!.aetherDocumentId!)!.body).toBe(skills.store.get('owner', fine)!.body);
    const writes = folder.writes.length;
    expect(await run('owner', AT)).toMatchObject({ withdrawn: 0 });
    expect(folder.writes).toHaveLength(writes);
    store.close();
  });

  it('treats a new version with the body she wrote as no edit of his (M1)', async () => {
    const { store, viewed, skills } = world();
    const id = (skills.create('owner', { draft: doc('weekly-review', '1. 三つ挙げる'), evidence: [] }, { carries: () => false }, AT) as { skillId: string }).skillId;
    const folder = new FakeAetherFolder();
    const run = configuredSkillExport({}, { memory: skills, store: viewed, access: folder, log: () => {} })!;
    await run('owner', AT);
    const skill = skills.store.get('owner', id)!;
    folder.edit(skill.aetherDocumentId!, skill.body);
    expect(await run('owner', AT)).toMatchObject({ adopted: 0, unchanged: 1 });
    expect(skills.store.get('owner', id)).toMatchObject({ version: 1, madeBy: 'sleep', aetherVersion: 2 });
    store.close();
  });

  it('never restores a version that now carries what must never be in a skill: the skill retires', () => {
    const skills = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const pass = { carries: () => false };
    const id = (skills.create('owner', { draft: doc('club-day', `1. ${SECRET}日を避ける`), evidence: [] }, pass, AT) as { skillId: string }).skillId;
    skills.store.setStatus('owner', id, 'active', 'test', AT);
    expect(skills.revise('owner', id, 1, { replacements: [{ find: '避ける', replace: '休む' }], evidence: [] }, pass, AT)).toEqual({ version: 2 });
    for (const index of [0, 1, 2]) {
      skills.used('owner', 'club-day', { talk: `t${index}`, growth: 0 }, AT);
      skills.nextTurn('owner', `t${index}`, 0, AT);
    }
    const check = skillBodyCheck(keeping(SECRET), { experienceCandidates: () => [] }, 'owner');
    // The check cannot be read: it waits. Readable and failing: it retires instead of returning to the old body.
    expect(skills.lifecycle('owner', AT, null)).toMatchObject({ reverted: [], retired: [] });
    expect(skills.lifecycle('owner', AT, check)).toMatchObject({ reverted: [], retired: [id] });
    expect(skills.store.get('owner', id)).toMatchObject({ status: 'retired', statusReason: 'restore_unsafe', version: 2 });
    expect(skills.rollback('owner', id, 1, 'owner', AT, check)).toBe('unsafe');
    expect(encodeSkill(doc('x', '1. y'))).toContain('## 手順');
  });
});

describe('every source, and only what truly fails (N1, N2, N4, L3, the proposer\'s audit)', () => {
  const pass = { carries: () => false };

  it('keeps every source of a skill, so a forgotten 41st source still withdraws its copy; past the limit a change is refused', async () => {
    const { store, viewed, skills, overrides } = world();
    const thread = store.createThread('owner');
    const turns = Array.from({ length: 45 }, (_, index) => store.appendTurn('owner', thread, `ふりかえり${index}`, 'うん', new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 60_000).toISOString(),
      { capturedStateVersion: 0, messageEmotion: emotion }));
    const id = (skills.create('owner', { draft: doc('many-sources', '1. 三つ挙げる'), evidence: turns.map(turn => `experience:${turn.id}`) }, pass, AT) as { skillId: string }).skillId;
    expect(skills.store.get('owner', id)!.sources).toHaveLength(45);
    const folder = new FakeAetherFolder();
    const run = configuredSkillExport({}, { memory: skills, store: viewed, access: folder, log: () => {} })!;
    expect(await run('owner', AT)).toMatchObject({ created: 1 });
    overrides.state = forgetting(turns[40]!.id);
    expect(await run('owner', AT)).toMatchObject({ withdrawn: 1 });
    expect(folder.documents.get(skills.store.get('owner', id)!.aetherDocumentId!)!.body).toBe(WITHDRAWN_COPY_BODY);
    const tooMany = Array.from({ length: SKILL_SOURCES_LIMIT + 1 }, (_, index) => `choice:c${index}`);
    expect(skills.create('owner', { draft: doc('too-many', '1. 三つ挙げる'), evidence: tooMany }, pass, AT)).toEqual({ rejected: 'too_many_sources' });
    expect(skills.createPattern('owner', { kind: 'strategy', title: '多すぎる', body: '多すぎる。' }, tooMany, pass, AT)).toEqual({ rejected: 'too_many_sources' });
    store.close();
  });

  it('judges a note retired by consolidation by its own turns: only a turn that fails withdraws (N2)', async () => {
    const { store, viewed, skills, overrides } = world();
    const thread = store.createThread('owner');
    const turn = store.appendTurn('owner', thread, '写真整理の話', 'うん', '2026-09-20T00:00:00.000Z', { capturedStateVersion: 0, messageEmotion: emotion });
    const note = store.createShannonKnowledge('owner', { title: '写真整理', applicability: '写真の相談', bodyMarkdown: '## 行動\n小さく区切る。', status: 'confirmed', sourceExperienceIds: [turn.id] }, AT, 'test');
    const id = (skills.create('owner', { draft: doc('photo-sort', '1. 小さく区切る'), evidence: [`knowledge:${note.id}`] }, pass, AT) as { skillId: string }).skillId;
    const folder = new FakeAetherFolder();
    const run = configuredSkillExport({}, { memory: skills, store: viewed, access: folder, log: () => {} })!;
    await run('owner', AT);
    store.retireShannonKnowledge('owner', note.id, 'merged', AT);
    expect(await run('owner', AT)).toMatchObject({ withdrawn: 0 });
    overrides.state = forgetting(turn.id);
    expect(await run('owner', AT)).toMatchObject({ withdrawn: 1 });
    expect(skills.store.get('owner', id)!.exportHold).toBe('withdrawn');
    store.close();
  });

  it('withdraws the copy when a forget rule matches the note\'s own text, though not its source turns (R1)', async () => {
    const { store, viewed, skills, overrides } = world();
    const thread = store.createThread('owner');
    const turn = store.appendTurn('owner', thread, '週末の過ごし方の話', 'うん', '2026-09-20T00:00:00.000Z', { capturedStateVersion: 0, messageEmotion: emotion });
    const note = store.createShannonKnowledge('owner', { title: '週末の過ごし方', applicability: '週末の相談',
      bodyMarkdown: '## 行動\nウォンバット会の集まりのある週末は予定を空ける。', status: 'confirmed', sourceExperienceIds: [turn.id] }, '2026-09-21T00:00:00.000Z', 'test');
    const id = (skills.create('owner', { draft: doc('weekend-plan', '1. 予定を空ける'), evidence: [`knowledge:${note.id}`] }, pass, AT) as { skillId: string }).skillId;
    const folder = new FakeAetherFolder();
    const run = configuredSkillExport({}, { memory: skills, store: viewed, access: folder, log: () => {} })!;
    expect(await run('owner', AT)).toMatchObject({ created: 1 });
    overrides.state = { ...createInitialCompanionState('owner', AT), memoryControls: [{ memoryId: 'fact-wombat', kind: 'user-fact', status: 'forgotten', pinned: false,
      updatedAt: AT, changeReason: 'forget', withheldText: 'ウォンバット会の集まり' }] };
    // The source turn itself says nothing of it: only the note's own text matches the rule.
    expect(skillSeedSources(viewed, null).experiences('owner', '2026-09-01T00:00:00.000Z', AT).map(item => item.id)).toContain(turn.id);
    expect(await run('owner', AT)).toMatchObject({ withdrawn: 1 });
    expect(skills.store.get('owner', id)!.exportHold).toBe('withdrawn');
    store.close();
  });

  it('never shows the body of a skill built from something forgotten, or whose copy was withdrawn (N4)', async () => {
    const skills = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const id = (skills.create('owner', { draft: doc('weekly-review', '1. 三つ挙げる'), evidence: [] }, pass, AT) as { skillId: string }).skillId;
    const route = createSkillsRoute({ memory: skills, record: () => {}, ownerScopeKey: 'owner', now: () => AT });
    const read = async () => {
      let status = 0;
      let body = '';
      const response = { writeHead: (code: number) => { status = code; return response; }, setHeader: () => response, end: (text: string) => { body = text; } } as never;
      await route({ method: 'GET' } as never, response, { scopeKey: 'owner' }, `/v1/autonomy/skills/${id}`);
      return { status, body: JSON.parse(body) as Record<string, unknown> };
    };
    expect((await read()).body).toMatchObject({ bodyHidden: false, body: expect.stringContaining('三つ挙げる') });
    skills.holdExport('owner', id, 'withdrawn', AT);
    expect((await read()).body).toMatchObject({ bodyHidden: true, body: HIDDEN_BODY });
    skills.retire('owner', id, 'source_forgotten', AT);
    skills.store.setExportHold('owner', id, null);
    expect(JSON.stringify((await read()).body)).not.toContain('三つ挙げる');
  });

  it('never judges a pinned skill\'s trial (L3)', () => {
    const skills = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const id = (skills.create('owner', { draft: doc('weekly-review', '1. 三つ挙げる'), evidence: [] }, pass, AT) as { skillId: string }).skillId;
    skills.store.setPinned('owner', id, true);
    for (const index of [0, 1, 2]) { skills.used('owner', 'weekly-review', { talk: `t${index}`, growth: 0 }, AT); skills.nextTurn('owner', `t${index}`, 0, AT); }
    expect(skills.lifecycle('owner', AT, pass)).toEqual({ accepted: [], reverted: [], retired: [] });
    expect(skills.store.get('owner', id)).toMatchObject({ status: 'trial', pinned: true });
    skills.store.setPinned('owner', id, false);
    expect(skills.lifecycle('owner', AT, pass)).toMatchObject({ retired: [id] });
  });

  it('never shows the proposer a reverted change of a forgotten, withdrawn or no longer passing skill', async () => {
    const skills = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const page = (skills.createPattern('owner', { kind: 'strategy', title: '五つ', body: '五つ挙げる。' }, [], pass, AT) as { patternId: string }).patternId;
    const make = (name: string, evidence: string[]) => {
      const id = (skills.create('owner', { draft: doc(name, '1. 三つ挙げる'), evidence }, pass, AT) as { skillId: string }).skillId;
      skills.store.setStatus('owner', id, 'active', 'test', AT);
      skills.revise('owner', id, 1, { replacements: [{ find: '三つ', replace: '五つ' }], evidence: [], purposePatternIds: [page] }, pass, AT);
      for (const index of [0, 1, 2]) { skills.used('owner', name, { talk: `${name}${index}`, growth: 0 }, AT); skills.nextTurn('owner', `${name}${index}`, 0, AT); }
      return id;
    };
    const shown = make('shown-one', []);
    const forgotten = make('forgotten-one', []);
    const withdrawn = make('withdrawn-one', []);
    const failing = make('failing-one', ['experience:gone']);
    skills.lifecycle('owner', AT, pass);
    skills.retire('owner', forgotten, 'source_forgotten', AT);
    skills.holdExport('owner', withdrawn, 'withdrawn', AT);
    const inputs: Array<Record<string, unknown>> = [];
    const proposer: SkillSleepModel = { model: 'scripted', json: async (_s, _n, _i, input) => { inputs.push(input as Record<string, unknown>); return { action: 'none' }; } };
    await new ShannonSkillConsolidator(skills, { knowledge: () => [], experiences: () => [], choices: () => [], visible: () => () => true, check: () => pass,
      sourcesPass: () => sources => !sources.includes('experience:gone') }, { maintainer: null, proposer }, { skillBudgetUsd: 5, now: () => NEXT_DAY, log: () => {} })
      .consolidate('owner', AT, NEXT_DAY);
    const targets = (inputs[0]!.reverted as Array<{ target: string }>).map(item => item.target);
    expect(targets).toEqual([`skill:${shown}`]);
    expect([forgotten, withdrawn, failing].every(id => !targets.includes(`skill:${id}`))).toBe(true);
  });
});
