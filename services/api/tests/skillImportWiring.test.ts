import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { configuredSkillImporter } from '../src/wiring/skillImportWiring.js';
import { skillArtifactSha256 } from '../src/mind/memory/skillImport.js';

it('dry-runs all app-owned artifacts through the real registry and current SQLite disclosure check without an import', () => {
  const database = new DatabaseSync(':memory:');
  const memory = new SkillMemory({ database, createsSchema: true, log: () => {} });
  const store = new SQLiteShannonStore({ path: ':memory:', now: () => '2026-10-09T00:00:00.000Z' });
  try {
    const importer = configuredSkillImporter(memory, { ownerScopeKey: 'owner', state: store, conversations: store })!;
    const candidate = standardSkillPack('standard10', 'draft-2')!;
    expect(importer.dryRun('owner', candidate).problems).toEqual([]);
    const lifecycle = standardSkillPack('minecraft-lifecycle', 'draft-1')!;
    expect(lifecycle.skills).toHaveLength(1);
    expect(importer.dryRun('owner', lifecycle).problems).toEqual([]);
    expect(standardSkillPack('minecraft-lifecycle', '../draft-1')).toBeNull();
    expect(standardSkillPack('minecraft-lifecycle/..', 'draft-1')).toBeNull();
    expect(memory.store.all('owner')).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) n FROM shannon_skill_imports').get()).toEqual({ n: 0 });
    const body = candidate.skills[0]!.body.replace('task.create', 'task.nonexistent');
    const wrong = { ...candidate, skills: [{ ...candidate.skills[0]!, body, sha256: skillArtifactSha256(body) }] };
    expect(importer.dryRun('owner', wrong).problems).toContainEqual({ name: candidate.skills[0]!.name, code: 'undeclared_tool:task.nonexistent' });
    expect(configuredSkillImporter(null, { ownerScopeKey: 'owner', state: store, conversations: store })).toBeNull();
  } finally { database.close(); store.close(); }
});
