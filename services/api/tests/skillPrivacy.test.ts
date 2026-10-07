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
import { FakeAetherFolder } from './support/fakeAetherFolder.js';

/**
 * Privacy review B1 and B2 of Syzygy ADR-0008 stage 2 (`docs/skill-and-routing-contract.md`, 「スキル記憶」): what a skill may be
 * built from, and the check of every body at build, restore, adoption and export, with a copy withdrawn when its skill may no
 * longer be shown.
 */
const AT = '2026-10-07T03:00:00.000Z';
const SECRET = 'ウォンバット会の集まりに毎月出ている';
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
