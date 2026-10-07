import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createInitialCompanionState } from '@shannon/cognition';
import { encodeSkill, type SkillDocument } from '../src/mind/memory/skillDocument.js';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { exportSkills, skillCopyTitle } from '../src/integrations/aether/skillExport.js';
import { configuredSkillExport, skillBodyCheck } from '../src/wiring/skillMemoryWiring.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { FakeAetherFolder } from './support/fakeAetherFolder.js';

/** Syzygy ADR-0008 stage 2, step 7: every skill's readable copy in シャノン用フォルダ, and the owner's edits adopted, never overwritten. */
const scope = 'owner';
const at = '2026-10-07T18:00:00.000Z';
const minutes = (count: number) => new Date(Date.parse(at) + count * 60_000).toISOString();
const skill = (name: string, extra: Partial<SkillDocument> = {}): SkillDocument => ({
  name, description: '週のふりかえりをする時', steps: '1. 今週したことを三つ挙げる', aids: 'なし', references: 'なし', ...extra,
});
const pass = { carries: () => false };
const memory = () => new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
const make = (skills: SkillMemory, name: string, extra: Partial<SkillDocument> = {}) => (skills.create(scope, { draft: skill(name, extra), evidence: [] }, pass, at) as { skillId: string }).skillId;
const run = (skills: SkillMemory, folder: FakeAetherFolder, when: string, check = () => pass as { carries(text: string): boolean } | null) =>
  exportSkills({ scopeKey: scope, skills, access: folder, check, at: when, log: () => {} });

describe('her skills in シャノン用フォルダ', () => {
  it('writes every skill once, by hash: a second night writes nothing, a new version is one update on the version she wrote', async () => {
    const skills = memory();
    const folder = new FakeAetherFolder();
    const id = make(skills, 'weekly-review');
    const retired = make(skills, 'old-way', { description: '古いやり方' });
    skills.retire(scope, retired, 'source_forgotten', at);
    // A retired skill never gets a new copy (privacy review B2).
    expect(await run(skills, folder, minutes(1))).toMatchObject({ created: 1, updated: 0 });
    const copy = skills.store.get(scope, id)!;
    expect(folder.documents.get(copy.aetherDocumentId!)).toMatchObject({ title: skillCopyTitle('weekly-review'), body: copy.body, version: 1 });
    expect(await run(skills, folder, minutes(2))).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(folder.writes).toHaveLength(1);
    // The skill is accepted and patched; its copy is updated on the version she last wrote.
    skills.used(scope, 'weekly-review', { talk: 't1', growth: 1 }, minutes(3));
    skills.used(scope, 'weekly-review', { talk: 't2', growth: 1 }, minutes(4));
    skills.nextTurn(scope, 't1', 1, minutes(5));
    skills.nextTurn(scope, 't2', 1, minutes(6));
    skills.lifecycle(scope, minutes(10), pass);
    expect(skills.revise(scope, id, 1, { replacements: [{ find: '三つ', replace: '五つ' }], evidence: [] }, pass, minutes(11))).toEqual({ version: 2 });
    expect(await run(skills, folder, minutes(12))).toMatchObject({ updated: 1 });
    expect(folder.documents.get(copy.aetherDocumentId!)).toMatchObject({ version: 2, body: expect.stringContaining('五つ') });
    expect(skills.store.get(scope, id)).toMatchObject({ aetherVersion: 2 });
  });

  it('adopts the owner\'s edit at the next sleep as a new version and never writes over it', async () => {
    const skills = memory();
    const folder = new FakeAetherFolder();
    const id = make(skills, 'weekly-review');
    await run(skills, folder, minutes(1));
    const documentId = skills.store.get(scope, id)!.aetherDocumentId!;
    const edited = encodeSkill(skill('weekly-review', { steps: '1. 散歩しながら三つ話す' }));
    folder.edit(documentId, edited);
    const writes = folder.writes.length;
    expect(await run(skills, folder, minutes(2))).toMatchObject({ adopted: 1, updated: 0 });
    expect(folder.writes).toHaveLength(writes);
    expect(skills.store.get(scope, id)).toMatchObject({ body: edited, madeBy: 'owner_edit', version: 2, aetherVersion: 2 });
    expect(skills.store.revisions(scope, id).at(-1)).toMatchObject({ actor: 'owner', reason: 'owner_edit' });
    // The sleep may not patch his version, and the next export finds nothing to write.
    expect(skills.revise(scope, id, 2, { replacements: [{ find: '三つ', replace: '五つ' }], evidence: [] }, pass, minutes(3))).toEqual({ rejected: 'owner_edited' });
    expect(await run(skills, folder, minutes(4))).toMatchObject({ unchanged: 1, updated: 0 });
    expect(folder.documents.get(documentId)!.body).toBe(edited);
  });

  it('holds an edit that cannot be adopted, and a copy the owner deleted, and writes neither again', async () => {
    const skills = memory();
    const folder = new FakeAetherFolder();
    const state = { ...createInitialCompanionState(scope, at), userFacts: [{ id: 's', statement: 'ユーザーはウォンバット会の集まりに毎月出ている', confidence: 0.9, observedAt: at, disclosure: { category: 'secret' as const } }] };
    const check = skillBodyCheck(state, { experienceCandidates: () => [] }, scope);
    const held = make(skills, 'weekly-review');
    const deleted = make(skills, 'morning-plan', { description: '朝の予定' });
    await run(skills, folder, minutes(1), () => check);
    const heldDocument = skills.store.get(scope, held)!.aetherDocumentId!;
    folder.edit(heldDocument, 'ウォンバット会の集まりに毎月出ている日は休む');
    folder.remove(skills.store.get(scope, deleted)!.aetherDocumentId!);
    expect(await run(skills, folder, minutes(2), () => check)).toMatchObject({ held: 1, deleted: 1 });
    expect(skills.store.get(scope, held)).toMatchObject({ version: 1, exportHold: 'owner_edit_unadopted' });
    expect(skills.store.get(scope, deleted)).toMatchObject({ exportHold: 'owner_deleted' });
    const writes = folder.writes.length;
    expect(await run(skills, folder, minutes(3), () => check)).toMatchObject({ created: 0, updated: 0 });
    expect(folder.writes).toHaveLength(writes);
    expect(folder.documents.get(heldDocument)!.body).toBe('ウォンバット会の集まりに毎月出ている日は休む');
    // A check that cannot be read writes, reads and adopts nothing (fail closed).
    folder.edit(heldDocument, '別の書き方');
    const before = folder.writes.length;
    expect(await run(skills, folder, minutes(4), () => null)).toMatchObject({ status: 'unavailable', adopted: 0 });
    expect(folder.writes).toHaveLength(before);
    expect(skills.store.get(scope, held)).toMatchObject({ version: 1 });
  });

  it('writes nothing when he changed the copy a moment before (STALE_VERSION); the next sleep adopts it', async () => {
    const skills = memory();
    const folder = new FakeAetherFolder();
    const id = make(skills, 'weekly-review');
    await run(skills, folder, minutes(1));
    const documentId = skills.store.get(scope, id)!.aetherDocumentId!;
    // Her version changes, and his edit lands between her list and her update.
    skills.adoptOwnerEdit(scope, id, encodeSkill(skill('weekly-review', { steps: '1. 彼の手順' })), { documentId, version: 1 }, pass, minutes(2));
    const update = folder.update.bind(folder);
    folder.update = async input => { folder.edit(documentId, '同時の編集'); return update(input); };
    skills.store.setExport(scope, id, { documentId, version: 1, hash: 'old' }, minutes(2));
    expect(await run(skills, folder, minutes(3))).toMatchObject({ updated: 0, unchanged: 1 });
    expect(folder.documents.get(documentId)!.body).toBe('同時の編集');
  });

  it('is wired only with SHANNON_SKILL_EXPORT, the skills, Aether configured, and for the owner\'s scope', async () => {
    const skills = memory();
    const store = Object.assign(new InMemoryConversationStore(), { snapshot: (key: string) => createInitialCompanionState(key, at) });
    const folder = new FakeAetherFolder();
    expect(configuredSkillExport({ SHANNON_SKILL_EXPORT: 'off' }, { memory: skills, store, access: folder })).toBeNull();
    expect(configuredSkillExport({ SHANNON_SKILLS: 'off' }, { memory: skills, store, access: folder })).toBeNull();
    expect(configuredSkillExport({ SHANNON_ADR8_STAGE2: 'off' }, { memory: skills, store, access: folder })).toBeNull();
    expect(configuredSkillExport({}, { memory: skills, store })).toBeNull();
    const exported = configuredSkillExport({}, { memory: skills, store, access: folder, log: () => {} })!;
    make(skills, 'weekly-review');
    expect(await exported('someone-else', at)).toBeNull();
    expect(await exported(scope, at)).toMatchObject({ created: 1 });
  });
});
