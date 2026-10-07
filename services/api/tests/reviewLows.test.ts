import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { JevChooser, type JevChoiceTrace } from '../src/infra/models/jev/jevChoice.js';
import { trialVerdict } from '../src/mind/memory/skillDocument.js';
import { ensureSkillSchema } from '../src/mind/memory/store/sqliteSkills.js';
import { TierCompetence } from '../src/mind/selectors/tierCompetence.js';
import { ensureTierOutcomeSchema } from '../src/mind/selectors/store/sqliteTierOutcomes.js';
import { installSalt } from '../src/wiring/installSalt.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';

/** The low findings of the stage-2 review (Syzygy ADR-0008): each as it is fixed. */
const directory = mkdtempSync(join(tmpdir(), 'shannon-review-lows-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const AT = '2026-10-07T03:00:00.000Z';
const minutes = (count: number) => new Date(Date.parse(AT) + count * 60_000).toISOString();

describe('the review\'s low findings', () => {
  it('judges a trial on its first three uses only', () => {
    expect(trialVerdict({ base: 1, baseline: 1, outcomes: [1, 1, 1, 0, 0] })).toBe('accept');
    expect(trialVerdict({ base: 1, baseline: 1, outcomes: [1, 0, 1, 1, 1] })).toBe('revert');
    expect(trialVerdict({ base: null, baseline: null, outcomes: [0, 0, 1, 1] })).toBe('revert');
  });

  it('settles a turn from the owner\'s next turn only within thirty minutes; later it expires from G alone', () => {
    const database = new DatabaseSync(':memory:');
    const competence = new TierCompetence({ database, createsSchema: true, defer: task => task() });
    competence.record('owner', { talkId: 'thread', surface: 'text', tier: 'luna', taskKind: 'chat', growth: 1 }, AT);
    competence.nextTurn('owner', 'thread', 0, minutes(31));
    expect(competence.rows('owner')[0]).toMatchObject({ outcome: 1, settleCode: 'turn_expired' });
    competence.record('owner', { talkId: 'thread', surface: 'text', tier: 'luna', taskKind: 'chat', growth: 1 }, minutes(40));
    competence.nextTurn('owner', 'thread', 0, minutes(45));
    expect(competence.rows('owner')[1]).toMatchObject({ outcome: 0, settleCode: 'next_turn' });
  });

  it('salts the digest of Jev\'s input with the install\'s secret, kept beside the database, never in the repository', async () => {
    const path = join(directory, 'shannon.sqlite');
    const salt = installSalt(path);
    expect(installSalt(path)).toBe(salt);
    expect(statSync(join(directory, '.shannon-install-salt')).mode & 0o777).toBe(0o600);
    const digest = async (value: string | undefined) => {
      const traces: JevChoiceTrace[] = [];
      const jev = new JevChooser({ model: 'm', ask: async () => ({ answers: { a: { type: 'noul', noul: 0.5 } } }) },
        { usdPerCall: null, trace: (_scope, trace) => { traces.push(trace); }, ...(value ? { salt: value } : {}) });
      await jev.decide({ scopeKey: 'owner', surface: 'text', decision: 'difficulty', sets: ['difficulty.v1'], state: { utterance: '秘密の話' },
        questions: { a: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } } }, parse: () => 1, fallback: () => 0, traceAnswers: () => ({}) });
      return traces[0]!.answers.h;
    };
    expect(await digest(salt)).toBe(await digest(salt));
    expect(await digest(salt)).not.toBe(await digest('0'.repeat(64)));
    expect(await digest(undefined)).not.toBe(await digest(undefined));
  });

  it('shows the skill sleep\'s spend as its own line of the usage summary, month to date against its budget, read-only (R2)', () => {
    const path = join(directory, 'usage.sqlite');
    const store = new SQLiteShannonStore({ path, now: () => AT });
    expect(store.llmUsageSummary('owner', '2026-10').some(row => row.lane === 'skill_sleep')).toBe(false);
    const memory = new SkillMemory({ database: new DatabaseSync(path), createsSchema: true, defer: task => task(), log: () => {} });
    memory.sleepUsage.call('owner', 'proposer', '2026-10-07', 'claude-sonnet-5-5', AT);
    memory.sleepUsage.cost('owner', '2026-10-07', 'claude-sonnet-5-5', 0.25, AT);
    memory.sleepUsage.cost('owner', '2026-09-30', 'claude-sonnet-5-5', 9, '2026-09-30T03:00:00.000Z');
    const row = store.llmUsageSummary('owner', '2026-10').find(item => item.lane === 'skill_sleep');
    expect(row).toMatchObject({ calls: 1, estimatedCostUsd: 0.25, budgetUsd: 5, remainingUsd: 4.75 });
    // Never the shared background budget.
    expect(store.backgroundLlmCostUsd('2026-10')).toBe(0);
    store.close();
  });

  it('adds the columns stage 2 added to its own tables when an older copy of a table is there', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`CREATE TABLE shannon_tier_outcomes (outcome_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, talk_id TEXT NOT NULL, surface TEXT NOT NULL, tier TEXT NOT NULL,
      task_kind TEXT NOT NULL, growth REAL NOT NULL, chosen_at TEXT NOT NULL, outcome INTEGER, settle_code TEXT, settled_at TEXT);
      CREATE TABLE shannon_skill_revisions (revision_id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, scope_key TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,
      body TEXT NOT NULL, body_hash TEXT NOT NULL, made_by TEXT NOT NULL, actor TEXT NOT NULL, evidence_json TEXT NOT NULL, before_sha256 TEXT, after_sha256 TEXT NOT NULL,
      pinned INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);`);
    ensureTierOutcomeSchema(database);
    ensureSkillSchema(database);
    const columns = (table: string) => (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
    expect(columns('shannon_tier_outcomes')).toContain('doing');
    expect(columns('shannon_skill_revisions')).toEqual(expect.arrayContaining(['parent_revision_id', 'variant_of', 'uses', 'successes']));
    // Twice is the same.
    ensureTierOutcomeSchema(database);
    ensureSkillSchema(database);
  });
});
