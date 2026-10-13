import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import type { TaskProgress } from '../src/mind/action/taskRuntime/taskProgressPorts.js';
import type { TaskRuntime, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { fcaReportWiring } from '../src/wiring/fcaReportWiring.js';

const night = Date.parse('2026-10-12T20:20:00.000Z'); // 5:20 in Tokyo.
const morning = Date.parse('2026-10-12T22:00:00.000Z'); // 7:00 in Tokyo.
const minutes = (value: number) => value * 60_000;
const iso = (value: number) => new Date(value).toISOString();

let directory = '';
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); rmSync(directory, { recursive: true, force: true }); });

function task(id: string, goal: string, createdAt: number, phase = 'completed'): TaskView {
  return { id, scopeKey: 'owner', parentId: 'conversation', kind: 'research', origin: 'owner_request', title: goal, goal, completionCriteria: '',
    status: phase === 'completed' ? 'completed' : 'active', pauseReason: null, summary: '', revision: 1, createdAt: iso(createdAt),
    updatedAt: iso(createdAt + minutes(1)), phase, childIds: [] } as unknown as TaskView;
}
function report(text: string, at: number, status: TaskProgress['status'] = 'received'): TaskProgress {
  return { currentStep: 'fca.result', status, startedAt: iso(at), updatedAt: iso(at), findings: [], report: { id: `r-${at}`, text, updatedAt: iso(at), spoken: text } };
}

/** The server's composition (`fcaReportWiring`, as `serverFcaWiring.ts` calls it) over a real store; `seen` stands for the visibility walk. */
function served() {
  directory = mkdtempSync(join(tmpdir(), 'shannon-report-wiring-'));
  const path = join(directory, 'shannon.sqlite');
  const clock = { at: night };
  const store = new SQLiteShannonStore({ path, now: () => iso(clock.at) });
  closers.push(() => store.close());
  const asked = store.createThread('owner', '調べもの');
  store.appendTurn('owner', asked, 'アベンジャーズの最新作の公開日を調べて', '調べてみますね。', iso(night - minutes(40)));
  const other = store.createThread('owner', 'ふだん');
  store.appendTurn('owner', other, 'おやすみ', 'おやすみなさい。', iso(night - minutes(35)));
  const entries: Array<[TaskView, TaskProgress]> = [
    [task('held', 'アベンジャーズの最新作の公開日', night - minutes(40)), report('12月18日公開です。', night - minutes(10))],
    [task('stale', '太宰府天満宮の語源', night - minutes(400), 'failed'), report('調べきれませんでした。', night - minutes(390), 'failed')],
  ];
  const parent = { id: 'conversation', kind: 'conversation', parentId: null } as unknown as TaskView;
  const find = (id: string) => entries.find(([item]) => item.id === id);
  const runtime = {
    get: (_scope: string, id: string) => id === parent.id ? parent : find(id)?.[0] ?? null,
    list: (_scope: string, options?: { parentId?: string }) => entries.map(([item]) => item).filter(item => !options?.parentId || item.parentId === options.parentId),
    progress: (_scope: string, id: string) => find(id)?.[1] ?? null,
    taskSources: () => [{ kind: 'conversation', stepId: 's', experienceId: 'e', threadId: asked, observedAt: iso(night - minutes(40)), recalledMemoryIds: [] }],
  } as unknown as TaskRuntime;
  const walked: string[] = [];
  const reports = fcaReportWiring({ runtime, ownerScope: 'owner', timeZone: 'Asia/Tokyo', conversations: store, ownerAlone: () => true,
    now: () => clock.at, seen: id => { walked.push(id); return find(id)?.[1] ?? null; } });
  const reader = new DatabaseSync(path);
  closers.unshift(() => reader.close());
  const dataVersion = () => Number((reader.prepare('PRAGMA data_version').get() as { data_version: number }).data_version);
  const cards = () => store.conversationHistory('owner', asked).filter(message => message.reportCard).map(message => message.reportCard!.taskId);
  return { clock, store, asked, other, reports, walked, dataVersion, cards };
}

describe('the server\'s report wiring (review of 90bffd77)', () => {
  it('holds a night report and drops a stale failure through the production composition, walking neither', () => {
    const s = served();
    for (let scan = 0; scan < 120; scan++) { s.reports.cards!.tick(); s.clock.at += 5_000; } // Ten minutes of scans, 5:20 to 5:30.
    expect(s.walked).toEqual([]);
    expect(s.cards()).toEqual([]);
    // The call's view applies the drops only: the held report is there for a call, the stale failure is not.
    expect(s.reports.call('held')?.report?.text).toBe('12月18日公開です。');
    expect(s.reports.call('stale')?.report).toBeUndefined();
    s.walked.length = 0;
    s.clock.at = morning;
    s.reports.cards!.tick();
    expect(s.walked).toEqual(['held']);
    expect(s.cards()).toEqual(['held']);
  });

  it('watches a held report\'s Talk without writing anything or moving the default Talk (Low-2)', () => {
    const s = served();
    expect(s.store.threadId('owner')).toBe(s.other); // The newest Talk is the default (her own time writes there).
    const before = s.dataVersion();
    for (let scan = 0; scan < 120; scan++) { s.reports.cards!.tick(); s.clock.at += 5_000; }
    expect(s.dataVersion()).toBe(before); // Nothing committed: no thread created, nothing written.
    expect(s.store.threadId('owner')).toBe(s.other);
    expect(s.store.listThreads('owner').map(thread => thread.threadId).sort()).toEqual([s.asked, s.other].sort());
  });
});
