import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { textPerception, inboxPerception } from '../src/mind/perception/perceptionPorts.js';
import { MIND_HOST_LIMITS, createMindHost, type MindHost } from '../src/mind/workspace/workspacePorts.js';
import { SQLiteWorkspaceJournal } from '../src/mind/workspace/store/workspaceJournalStore.js';
import { SQLiteMindInbox } from '../src/mind/workspace/store/mindInboxStore.js';
import { configuredMindInbox } from '../src/wiring/mindWiring.js';
import { MIND_WORLD_START, mindWorld } from './support/mindWorld.js';

/**
 * Syzygy ADR-0008 stage 3, step F3 (`docs/mind-workspace-contract.md`): restore is a snapshot and the journal after it. A new
 * process holds the same workspace; snapshots come every 200 operations, every 10 minutes and on SIGTERM; the journal keeps 7
 * days and no text; the words of an item come back only from its reference, read through the withholding at render.
 */
const MINUTE = 60_000;
const directory = mkdtempSync(join(tmpdir(), 'shannon-workspace-restore-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const ON = { SHANNON_ADR8_STAGE3: 'on' };

function hostOn(path: string, clock: { at: number }): { host: MindHost; database: DatabaseSync } {
  const database = new DatabaseSync(path);
  const host = createMindHost({
    switches: { attention: true, workspace: true, dataFrames: true }, now: () => new Date(clock.at).toISOString(), schedule: task => task(),
    journal: new SQLiteWorkspaceJournal(database, { createSchema: true }), inbox: new SQLiteMindInbox(database, { createSchema: true }),
  });
  return { host, database };
}

const said = (message: string, at: string, threadId = 'thread') =>
  textPerception({ threadId, message, present: { kind: 'owner' }, alone: true, at });

describe('the workspace after a restart', () => {
  it('is the same workspace in a new process: what attention holds, in order, its references, the notices and the summary', async () => {
    const world = mindWorld(ON, 'restore');
    await world.registerBody();
    await world.speak('シャノン、木材を集めておいてね');
    world.advance(MINUTE);
    await world.touch('touch-1');
    world.advance(MINUTE);
    await world.chat('ただいま、シャノン');
    world.advance(MINUTE);
    await world.chat('今日は何をしていたの？', { threadId: 'other' });
    const before = world.mind!.host!.view('owner', world.now());
    expect(before.held.length).toBeGreaterThanOrEqual(4);
    expect(before.notices).toHaveLength(1);
    expect(before.held.filter(item => item.ref?.startsWith('experience:'))).toHaveLength(2);
    world.restart();
    expect(world.mind!.host!.view('owner', world.now())).toEqual(before);
    // The next turn renders from the restored workspace: the voice line (its words were held in memory only, so they are gone),
    // the notice of the touch, and the other thread's words, read again from the stored turn.
    world.advance(MINUTE);
    await world.chat('さっきの続きだけど');
    const context = world.lastContext();
    expect(context).toContain('[いまの場]');
    expect(context).toMatch(/・声の会話：ライ氏が話した\n|・声の会話：ライ氏が話した$/mu);
    expect(context).not.toContain('木材を集めておいて');
    expect(context).toContain('ライ氏が話した「今日は何をしていたの？」');
    expect(context).toContain('【知らせ:触れた】');
    await world.close();
  });

  it('applies a forget after the restart: the words are read from the stored turn through the withholding', async () => {
    const world = mindWorld(ON, 'restore-forget');
    await world.chat('合鍵は植木鉢の下にあるよ', { threadId: 'other' });
    world.advance(MINUTE);
    world.restart();
    await world.chat('ねえ、シャノン');
    expect(world.lastContext()).toContain('「合鍵は植木鉢の下にあるよ」');
    // The owner has her forget that turn: the next render no longer has its words, though the line stays.
    const turnId = world.store.conversationHistory('owner', 'other').find(message => message.role === 'user')!.sourceExperienceId!;
    world.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: turnId, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: world.now(), changeReason: 'user' } });
    world.advance(MINUTE);
    await world.chat('もう一度だけど');
    expect(world.lastContext()).not.toContain('植木鉢');
    expect(world.lastContext()).toContain('・アプリの文字：ライ氏が話した');
    await world.close();
  });

  it('takes a snapshot every 200 operations, after 10 minutes, and on SIGTERM; restore replays only what came after it', () => {
    const path = join(directory, 'cadence.sqlite');
    const clock = { at: Date.parse(MIND_WORLD_START) };
    const first = hostOn(path, clock);
    const journal = new SQLiteWorkspaceJournal(first.database, { createSchema: false });
    for (let index = 0; index < 199; index += 1) {
      clock.at += 1_000;
      first.host.perceive('owner', said(`話 ${index}`, new Date(clock.at).toISOString()));
    }
    first.host.turnEnded();
    // 199 perceptions and the day's flush: 200 operations, one snapshot.
    expect(journal.snapshot('owner')?.journalSeq).toBe(200);
    clock.at += 1_000;
    first.host.perceive('owner', said('もうひとつ', new Date(clock.at).toISOString()));
    first.host.turnEnded();
    expect(journal.snapshot('owner')?.journalSeq).toBe(200);
    // Ten minutes later any operation is enough.
    clock.at += MIND_HOST_LIMITS.snapshotEveryMilliseconds;
    first.host.perceive('owner', said('十分後', new Date(clock.at).toISOString()));
    first.host.turnEnded();
    expect(journal.snapshot('owner')?.journalSeq).toBe(202);
    clock.at += 1_000;
    first.host.perceive('owner', said('最後', new Date(clock.at).toISOString()));
    first.host.turnEnded();
    const before = first.host.view('owner', new Date(clock.at).toISOString());
    // The new process reads the snapshot and the one operation after it.
    expect(journal.after('owner', journal.snapshot('owner')!.journalSeq, '')).toHaveLength(1);
    const second = hostOn(path, clock);
    expect(second.host.view('owner', new Date(clock.at).toISOString())).toEqual(before);
    // SIGTERM: a snapshot of everything.
    second.host.perceive('owner', said('閉じる前', new Date(clock.at + 1_000).toISOString()));
    second.host.close();
    expect(journal.snapshot('owner')?.journalSeq).toBe(journal.lastSeq());
    first.database.close(); second.database.close();
  });

  it('keeps the journal 7 days, and never a word in it', () => {
    const path = join(directory, 'keep.sqlite');
    const clock = { at: Date.parse(MIND_WORLD_START) };
    const { host, database } = hostOn(path, clock);
    host.perceive('owner', said('誕生日のプレゼントは万年筆にする', new Date(clock.at).toISOString()));
    host.turnEnded();
    const journal = new SQLiteWorkspaceJournal(database, { createSchema: false });
    const all = () => database.prepare('SELECT * FROM mind_workspace_journal').all() as Array<Record<string, unknown>>;
    expect(JSON.stringify(all())).not.toContain('万年筆');
    expect(JSON.stringify(database.prepare('SELECT * FROM mind_workspace_snapshots').all())).not.toContain('万年筆');
    expect(all().length).toBeGreaterThan(0);
    clock.at += 8 * 24 * 60 * MINUTE;
    host.perceive('owner', said('一週間後', new Date(clock.at).toISOString()));
    host.tick();
    expect(all().every(row => Date.parse(String(row.at)) >= clock.at - 7 * 24 * 60 * MINUTE)).toBe(true);
    expect(journal.lastSeq()).toBeGreaterThan(0);
    database.close();
  });

  it('tails the inbox once: a row other processes wrote is perceived, and a restart does not perceive it again', () => {
    const path = join(directory, 'inbox.sqlite');
    const clock = { at: Date.parse(MIND_WORLD_START) };
    const first = hostOn(path, clock);
    const emit = configuredMindInbox(ON, { databasePath: path })!;
    emit.emit('owner', { kind: 'notice', code: 'withheld', audience: 'owner', source: 'own_time', sourceId: 'withheld-1', tool: 'owner.reach_out', reason: 'intent_repeat' }, new Date(clock.at).toISOString());
    first.host.tick();
    const at = new Date(clock.at + MINUTE).toISOString();
    expect(first.host.view('owner', at).notices).toEqual(['inbox:1']);
    first.host.close();
    const second = hostOn(path, clock);
    second.host.tick();
    expect(second.host.view('owner', at).notices).toEqual(['inbox:1']);
    expect(second.host.view('owner', at).held.filter(item => item.id === 'inbox:1')).toHaveLength(1);
    // A row of anything but closed values is refused by the writer.
    expect(() => new SQLiteMindInbox(second.database, { createSchema: false }).append('owner', { kind: 'notice', code: 'withheld', audience: 'owner', source: 'own_time', sourceId: 'x', tool: 'ライ氏に話しかける' }, at)).toThrow('MIND_INBOX_SYMBOL');
    expect(inboxPerception({ draft: { kind: 'notice', code: 'withheld', audience: 'owner', source: 'own_time', sourceId: 'x' }, at })).not.toBeNull();
    emit.close(); first.database.close(); second.database.close();
  });
});
