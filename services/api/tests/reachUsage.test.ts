import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { migrateAgentTasks } from '../src/agentTaskPersistenceSupport.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteReachOutReports } from '../src/surfaces/outreach/store/reachOutReports.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { reachUsageReport, weekKey } from './reach/reachUsageReport.js';
import { liveEstimate, runReachSuite, scriptedDrivers, writeReachReport } from './reach/reachSuite.js';

/**
 * The reach measures from use, over a database built by the real stores, and the result files of a
 * model-free run. Read-only, counts only.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-reach-usage-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const SECRET = '秘密の言い回し';

function seededDatabase(): string {
  const path = join(directory, 'copy.sqlite');
  const at = (minutes: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + minutes * 60_000).toISOString();
  const shannon = new SQLiteShannonStore({ path, now: () => at(0) });
  const thread = shannon.createThread('owner', 'talk');
  // Two messages of hers; he answered the first after ten minutes and the second not at all.
  shannon.appendTurn('owner', thread, 'おはよう', 'おはようございます。', at(0));
  shannon.appendTurn('owner', thread, `${SECRET}を見てきたよ`, 'いいですね。', at(70));
  shannon.appendTurn('owner', thread, '違う、そうじゃなくて駅のほう', 'わかりました。', at(75));
  shannon.appendTurn('owner', thread, '違う、そうじゃなくて駅のほう！', 'はい。', at(78));
  shannon.close();
  const initiatives = new SQLiteInitiativeStore(path);
  initiatives.close();
  const database = new DatabaseSync(path);
  const initiative = database.prepare(`INSERT INTO initiative_messages (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url, content, expression, day_key, created_at, read_at)
    VALUES (?, 'owner', ?, ?, '', '', ?, 'curious', ?, ?, ?)`);
  initiative.run('i1', thread, 'reach-out:idle:i1', `${SECRET}のこと`, '2026-10-01', at(60), at(65));
  initiative.run('i2', thread, 'reach-out:idle:i2', 'ねえ', '2026-10-02', at(2_000), null);
  initiative.run('i3', thread, 'reach-out:follow_up:i2', 'ねえねえ', '2026-10-03', at(2_010), null);
  database.prepare(`INSERT INTO knowledge_revisions (revision_id, scope_key, answer_id, previous_answer, next_answer, reason, observed_at) VALUES ('r1', 'owner', 'a1', NULL, ?, 'correction', ?)`).run(SECRET, at(80));
  migrateAgentTasks(database);
  const task = database.prepare(`INSERT INTO agent_tasks (task_id, scope_key, conversation_thread_id, start_idempotency_key, title, goal, status, summary, created_at, updated_at)
    VALUES (?, 'owner', ?, ?, 't', 'g', ?, 's', ?, ?)`);
  for (const [id, status] of [['t1', 'completed'], ['t2', 'completed'], ['t3', 'failed'], ['t4', 'running']] as const) task.run(id, thread, id, status, at(90), at(90));
  database.close();
  new SQLiteReachOutReports(path).close();
  const autonomy = new SQLiteAutonomyStore(path);
  const story = autonomy.study.create('owner', { kind: 'story', title: '傘', body: '本文' }, at(100));
  if (typeof story === 'string') throw new Error(story);
  autonomy.study.markReady('owner', story.id, at(101));
  autonomy.study.addFeedback('owner', story.id, { reaction: 'more' }, at(102));
  autonomy.study.revise('owner', story.id, { body: '直した本文', changeNote: '直しました。' }, at(103));
  autonomy.study.markReady('owner', story.id, at(103));
  autonomy.study.addFeedback('owner', story.id, { reaction: 'like' }, at(104));
  autonomy.close();
  const raw = new DatabaseSync(path);
  const session = raw.prepare(`INSERT INTO autonomy_loop_sessions (cycle_id, scope_key, day_key, started_at, ended_at, end_code, resume_at) VALUES (?, 'owner', '2026-10-01', ?, ?, ?, ?)`);
  session.run('c1', at(0), at(30), 'rest', at(200));
  session.run('c2', at(300), at(330), 'session_budget', at(400));
  raw.prepare(`INSERT INTO autonomy_spend (spend_id, scope_key, day_key, occurred_at, model, input_tokens, output_tokens, cost_usd, cost_yen) VALUES ('s1', 'owner', '2026-10-01', ?, 'gpt-5.6-luna', 10, 10, 0.1, 16)`).run(at(10));
  raw.close();
  return path;
}

describe('reach measures from use', () => {
  it('reports counts and rates from a copy, reads nothing it prints, and writes nothing', () => {
    const path = seededDatabase();
    const digest = () => createHash('sha256').update(readFileSync(path)).digest('hex');
    const before = digest();
    const report = reachUsageReport(path, { days: 30, until: '2026-10-10T00:00:00.000Z', scopeKey: 'owner' });
    expect(digest()).toBe(before);
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain('駅のほう');
    expect(report.measures.reachOutAnswered).toMatchObject({
      sent: 2, followUps: 1, answeredWithin30Minutes: { numerator: 1, denominator: 2, rate: 0.5 }, opened: { numerator: 1, denominator: 2 },
    });
    expect(report.measures.correctionsAndReasks).toMatchObject({ ownerMessages: 4, corrections: { numerator: 2 }, reasks: { numerator: 1 } });
    expect(report.measures.requestsCompleted).toMatchObject({ completed: { numerator: 2, denominator: 3 } });
    expect(report.measures.knowledgeCorrections).toMatchObject({ revisions: 1, weekly: { [weekKey('2026-10-01T01:20:00.000Z')]: 1 } });
    expect(report.measures.storiesShownAndRevised).toMatchObject({ revisedAfterReaction: 1, reactionImproved: { numerator: 1, denominator: 1 } });
    expect(report.measures.ownTimePacing).toMatchObject({ sessionEnds: { rest: 1, session_budget: 1 }, restByHer: { rate: 0.5 }, yenPerActiveDay: 16 });
  });

  it('refuses the production database and says which measures a database cannot give', () => {
    expect(() => reachUsageReport('/home/azureuser/shannon-ios-data/shannon.sqlite', { days: 30, until: '2026-10-10T00:00:00.000Z', scopeKey: 'owner' })).toThrow(/copy/u);
    const empty = join(directory, 'empty.sqlite');
    new DatabaseSync(empty).close();
    const report = reachUsageReport(empty, { days: 30, until: '2026-10-10T00:00:00.000Z', scopeKey: 'owner' });
    expect(report.measures.reachOutAnswered).toMatchObject({ available: false });
  });

  it('weeks are ISO weeks', () => {
    expect(weekKey('2026-10-05T00:00:00.000Z')).toBe('2026-W41');
    expect(weekKey('2026-01-01T00:00:00.000Z')).toBe('2026-W01');
    expect(weekKey('2027-01-01T00:00:00.000Z')).toBe('2026-W53');
    // Weeks begin on Monday in Tokyo: 01:00 on Monday there is still Sunday in UTC.
    expect(weekKey('2026-10-04T16:00:00.000Z')).toBe('2026-W41');
    expect(weekKey('2026-10-04T14:59:00.000Z')).toBe('2026-W40');
  });

  it('refuses a refused directory also through a symbolic link', () => {
    const production = join(directory, 'production');
    mkdirSync(production);
    new DatabaseSync(join(production, 'shannon.sqlite')).close();
    symlinkSync(production, join(directory, 'looks-like-a-copy'));
    const options = { days: 30, until: '2026-10-10T00:00:00.000Z', scopeKey: 'owner', refusedDirectories: [production] };
    expect(() => reachUsageReport(join(directory, 'looks-like-a-copy', 'shannon.sqlite'), options)).toThrow(/copy/u);
    symlinkSync(join(production, 'shannon.sqlite'), join(directory, 'linked.sqlite'));
    expect(() => reachUsageReport(join(directory, 'linked.sqlite'), options)).toThrow(/copy/u);
  });
});

describe('the result files of a model-free run', () => {
  it('writes JSON and Markdown, compares with the previous full run, and estimates a live run', async () => {
    const out = join(directory, 'results');
    const now = () => '2026-10-05T00:00:00.000Z';
    const first = await runReachSuite(scriptedDrivers(), { mode: 'scripted', revision: 'aaaa', now });
    expect(first.totals).toMatchObject({ passed: 3, failed: 0, pending: 0, invalid: 0 });
    const written = writeReachReport(first, out, { full: true });
    expect(written.compared).toBeNull();
    expect(existsSync(join(out, 'latest-scripted.json'))).toBe(true);
    const partial = await runReachSuite(scriptedDrivers(), { mode: 'scripted', revision: 'bbbb', only: ['helpful'], now: () => '2026-10-05T01:00:00.000Z' });
    const second = writeReachReport(partial, out, { full: false });
    expect(second.compared).toBe(join(out, 'latest-scripted.json'));
    expect(second.text).toContain('| helpful.three-tools | unchanged |');
    // A partial run does not replace the latest full one.
    expect(JSON.parse(readFileSync(join(out, 'latest-scripted.json'), 'utf8')).revision).toBe('aaaa');
    // An explicit baseline must be a valid report; a latest file of an older format is replaced without comparing.
    writeFileSync(join(out, 'old.json'), JSON.stringify({ ...first, runs: first.runs.map(run => ({ ...run, inputs: undefined })) }));
    expect(() => writeReachReport(partial, out, { baselinePath: join(out, 'old.json'), full: false })).toThrow(/BASELINE_INVALID/u);
    writeFileSync(join(out, 'latest-scripted.json'), '{"schemaVersion":1}');
    expect(writeReachReport(first, out, { full: true }).compared).toBeNull();
    const estimate = liveEstimate(first, {});
    expect(estimate.map(line => line.scenarioId)).toEqual(['context.shiritori-60', 'helpful.three-tools', 'growth.autonomy-day']);
    expect(estimate[0]!.yen).toBeGreaterThan(0);
    expect(estimate[1]!.yen).toBe(0);
    expect(estimate[2]!.yen).toBe(300);
  });
});
