import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { historicalSkillImportState } from './support/historicalSkillImportState.js';

it('projects only the exact new empty table and null columns, and fails closed for real imported data', () => {
  const database = new DatabaseSync(':memory:');
  new SkillMemory({ database, createsSchema: true, log: () => {} });
  try {
    const sql = (name: string) => (database.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string }).sql;
    expect(historicalSkillImportState('shannon_skill_imports', sql('shannon_skill_imports'), [])).toBeNull();
    expect(() => historicalSkillImportState('shannon_skill_imports', sql('shannon_skill_imports'), [{ receipt_id: 'imported' }])).toThrow('HISTORICAL_SKILL_IMPORT_WRITTEN');
    const current = sql('shannon_skills');
    const projected = historicalSkillImportState('shannon_skills', current, [{ skill_id: 'old', made_by: 'sleep', provenance_json: null }]);
    expect(projected!.rows).toEqual([{ skill_id: 'old', made_by: 'sleep' }]);
    expect(projected!.sql).not.toContain('provenance_json');
    expect(projected!.sql).not.toContain('operator_authored');
    expect(() => historicalSkillImportState('shannon_skills', current, [{ provenance_json: '{}', made_by: 'operator_authored' }])).toThrow('HISTORICAL_SKILL_IMPORT_ANCESTRY_WRITTEN');
    expect(() => historicalSkillImportState('shannon_skill_revisions', sql('shannon_skill_revisions'), [{ provenance_json: null, made_by: 'sleep', actor: 'operator_authored' }])).toThrow('HISTORICAL_SKILL_IMPORT_ANCESTRY_WRITTEN');
    const unexpected = `${current} /* unexpected schema */`;
    expect(historicalSkillImportState('shannon_skills', unexpected, [{ provenance_json: null }])).toEqual({ sql: unexpected, rows: [{ provenance_json: null }] });
    expect(historicalSkillImportState('unrelated', current, [{ column: 1 }])).toEqual({ sql: current, rows: [{ column: 1 }] });
  } finally { database.close(); }
});
