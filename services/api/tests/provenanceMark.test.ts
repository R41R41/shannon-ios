import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { memoryWorld } from './support/memoryWorld.js';
import { PROVENANCE_TABLES, provenanceMark, sourceRowsMark } from '../src/infra/sqlite/provenanceMark.js';
import { SkillMemory, versionRevisionId } from '../src/mind/memory/memoryPorts.js';
import { skillTurnPorts } from '../src/wiring/skillMemoryWiring.js';
import { createFcaReadSources } from '../src/wiring/fcaReadSources.js';
import { MemoryWithholding } from '../src/mind/memory/memoryVisibilityPorts.js';
import { conversationSecrets } from '../src/mind/inhibition/disclosurePorts.js';

/**
 * The source rows' mark (`provenanceMark.ts`): what a receipt's answer and a moment of the source guard are kept under (production run
 * 19: under the whole database's mark, which every lease renewal moved, nothing was kept). It must move with every row they are read
 * from, written by any connection, and with nothing else; and it must cover every table they read.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });

function world() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const w = memoryWorld();
  cleanups.push(() => w.close());
  const turns = Array.from({ length: 6 }, (_, index) => w.store.appendTurn('owner', 'thread', `質問${index}`, `返答${index}`, w.now()).id);
  const knowledge = w.store.createShannonKnowledge('owner', { title: '知識', bodyMarkdown: '本文', status: 'confirmed', applicability: '全般',
    sourceExperienceIds: turns.slice(0, 2) } as never, w.now(), 'test').id;
  // Her skills in the same database, on their own connection, as production keeps them.
  const skillDb = new DatabaseSync(w.path);
  cleanups.push(() => skillDb.close());
  const memory = new SkillMemory({ database: skillDb, createsSchema: true, defer: work => work() });
  const created = memory.create('owner', { draft: { name: 'skill-a', description: '手順', steps: `手順の本文${'う'.repeat(200)}`, aids: '- 確認',
    references: '- 元資料' }, evidence: [`experience:${turns[2]}`, `knowledge:${knowledge}`] }, { carries: () => false }, w.now());
  if ('rejected' in created) throw new Error(created.rejected);
  const skills = skillTurnPorts(memory, scope => w.store.snapshot(scope), w.store);
  const reader = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state: w.store, conversations: w.store,
    skill: (scope, id, revision) => skills.readSource!(scope, id, revision), skillChecks: (scope, renew) => skills.readSourceChecks!(scope, renew) });
  w.store.readSourceVisible = reader;
  const skillId = created.skillId;
  const receipt = `shannon-skill://${encodeURIComponent(skillId)}/revision/${encodeURIComponent(versionRevisionId(skillId, 1))}`;
  const db = w.store.fcaDatabase();
  return { w, turns, knowledge, skillDb, memory, skillId, reader, receipt, db, mark: () => provenanceMark(db) };
}

describe('the source rows\' mark', () => {
  it('moves with a write to every kind of source row, from any connection, and with no other write', () => {
    const f = world();
    f.db.exec('CREATE TABLE unrelated (x INTEGER)');
    const start = f.mark();
    expect(start).toMatch(/^p\d+:\d+$/u);
    // Writes no source's visibility is read from: another table, and a skill's use counts.
    f.db.prepare('INSERT INTO unrelated (x) VALUES (1)').run();
    f.skillDb.prepare("UPDATE shannon_skills SET uses_json = '[]', successes = successes + 1").run();
    expect(f.mark()).toBe(start);
    const moves: Array<[string, () => void]> = [
      ['a turn', () => f.w.store.appendTurn('owner', 'thread', '次', '次の返答', f.w.now())],
      ['a turn rewritten in place', () => f.db.prepare("UPDATE experience_events SET payload_json = payload_json WHERE event_id = ?").run(f.turns[0]!)],
      ['the state', () => f.w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: f.turns[1]!, kind: 'experience',
        status: 'forgotten', pinned: false, updatedAt: f.w.now(), changeReason: 'owner' } })],
      ['a knowledge document removed', () => f.db.prepare('DELETE FROM shannon_knowledge_documents WHERE knowledge_id = ?').run(f.knowledge)],
      ['a correction\'s evidence', () => f.db.prepare("INSERT INTO knowledge_evidence (evidence_id, scope_key, answer_id, quote, source, observed_at) VALUES ('e1', 'owner', 'a1', '引用', 'user', ?)").run(f.w.now())],
      ['a skill\'s status alone', () => f.skillDb.prepare("UPDATE shannon_skills SET status = 'trial' WHERE skill_id = ?").run(f.skillId)],
      ['a skill retired, on her skills\' connection', () => f.memory.retire('owner', f.skillId, 'test', f.w.now())],
      ['a skill\'s export withdrawn', () => f.memory.holdExport('owner', f.skillId, 'withdrawn', f.w.now())],
      ['a skill revision removed', () => f.skillDb.prepare('DELETE FROM shannon_skill_revisions WHERE skill_id = ?').run(f.skillId)],
    ];
    let previous = f.mark();
    for (const [what, write] of moves) {
      write();
      const now = f.mark();
      expect(now, what).not.toBe(previous);
      previous = now;
    }
    // Every watched table that exists has its three triggers.
    const triggers = (f.db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'shannon_provenance_counter_%'").all() as Array<{ tbl_name: string }>)
      .map(row => row.tbl_name);
    for (const table of Object.keys(PROVENANCE_TABLES)) expect(triggers.filter(name => name === table), table).toHaveLength(3);
  });

  it('is none while a trigger is missing (the database\'s own mark then), and none inside a transaction', () => {
    const f = world();
    expect(sourceRowsMark(f.db)).toMatch(/^p/u);
    const name = (f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'experience_events' AND name LIKE 'shannon_provenance_counter_%_insert'").get() as { name: string }).name;
    f.db.exec(`DROP TRIGGER ${name}`);
    expect(f.mark()).toBeNull();
    expect(sourceRowsMark(f.db)).toMatch(/^d/u);
    // The database's own mark moves with any write, as before.
    const whole = sourceRowsMark(f.db);
    f.db.exec('CREATE TABLE IF NOT EXISTS unrelated (x INTEGER); INSERT INTO unrelated (x) VALUES (1);');
    expect(sourceRowsMark(f.db)).not.toBe(whole);
    // Made again (the API's start): narrow again.
    f.w.store.prepareProvenanceMark();
    expect(sourceRowsMark(f.db)).toMatch(/^p/u);
    f.db.exec('BEGIN');
    try {
      expect(f.mark()).toBeNull();
      expect(sourceRowsMark(f.db)).toBeNull();
    } finally { f.db.exec('ROLLBACK'); }
  });

  it('keeps the remembered turns across other writes, and reads them again once one changes', () => {
    const f = world();
    f.db.exec('CREATE TABLE unrelated (x INTEGER)');
    const before = f.w.store.experienceCandidates('owner');
    f.db.prepare('INSERT INTO unrelated (x) VALUES (1)').run();
    expect(f.w.store.experienceCandidates('owner')).toBe(before);
    const turn = f.w.store.appendTurn('owner', 'thread', '新しい質問', '新しい返答', f.w.now()).id;
    const after = f.w.store.experienceCandidates('owner');
    expect(after).not.toBe(before);
    expect(after.map(item => item.id)).toContain(turn);
    // A turn rewritten in place by another connection is read again too.
    const other = new DatabaseSync(f.w.path);
    try {
      other.prepare("UPDATE experience_events SET payload_json = json_set(payload_json, '$.summary', '書き直した要約') WHERE event_id = ?").run(turn);
    } finally { other.close(); }
    expect(f.w.store.experienceCandidates('owner').find(item => item.id === turn)?.summary).toBe('書き直した要約');
  });

  it('covers every table a receipt\'s answer and a moment of the guard read', () => {
    const f = world();
    // A correction of a fact with no evidence of its own: the state reads it from `knowledge_evidence` (`hydrateMemoryBoundaries`).
    f.w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: 'fact-x', kind: 'user-fact', status: 'forgotten', pinned: false,
      updatedAt: f.w.now(), changeReason: 'owner' } });
    const read = new Set<string>();
    for (const db of [f.db, f.skillDb]) db.setAuthorizer((action, table) => { if (action === 20 && table) read.add(String(table)); return 0; });
    // Every statement is compiled again after a schema change, so the authorizer sees each one.
    f.db.exec('CREATE TABLE schema_touch (x INTEGER); DROP TABLE schema_touch;');
    try {
      const state = f.w.store.snapshot('owner'), candidates = f.w.store.experienceCandidates('owner');
      const withholding = new MemoryWithholding(state, f.w.store, 'owner', candidates);
      withholding.withheldExperiences();
      conversationSecrets(state, f.w.store, 'owner').carries('手順');
      withholding.withholdsReply({ text: '手順', observedAt: f.w.now(), recalledMemoryIds: [...f.turns, `knowledge:${f.knowledge}`, f.receipt] });
      withholding.withReadSnapshot(() => f.reader('owner', f.receipt, f.w.now(), { state, withholding, walk: {} }));
    } finally {
      for (const db of [f.db, f.skillDb]) db.setAuthorizer(null);
    }
    expect([...read].filter(table => !(table in PROVENANCE_TABLES) && table !== 'sqlite_master' && table !== 'shannon_provenance_counter')).toEqual([]);
    for (const table of ['companion_states', 'experience_events', 'knowledge_evidence', 'shannon_knowledge_documents', 'shannon_skills']) expect(read).toContain(table);
  });
});
