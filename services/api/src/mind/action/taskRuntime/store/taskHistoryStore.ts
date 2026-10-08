import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { checkedTemplate, COMPACTION_SECTIONS } from '@shannon/mind';
import type { TaskHistoryCommit, TaskHistoryRound, TaskHistorySummary, TaskHistoryWindow } from '../taskHistoryPorts.js';
import type { TaskSource, TaskStatus } from '../taskRuntimePorts.js';

/** Derived summaries never replace the append-only native history. Caller owns the task transaction and lease fence. */
export class TaskHistoryStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS fca_task_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      step_id TEXT NOT NULL UNIQUE, entries_json TEXT NOT NULL, committed_at TEXT NOT NULL,
      committed_status TEXT NOT NULL DEFAULT 'unknown', sources_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS fca_task_history_summaries (
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id), revision INTEGER NOT NULL,
      from_sequence INTEGER NOT NULL, through_sequence INTEGER NOT NULL,
      template_json TEXT NOT NULL, sources_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      reset_through_sequence INTEGER NOT NULL DEFAULT 0, bootstrap_text TEXT NOT NULL DEFAULT '');`);
    const columns = new Set(db.prepare('PRAGMA table_info(fca_task_history)').all().map(row => row.name));
    if (!columns.has('committed_status')) db.exec("ALTER TABLE fca_task_history ADD COLUMN committed_status TEXT NOT NULL DEFAULT 'unknown'");
    if (!columns.has('sources_json')) db.exec("ALTER TABLE fca_task_history ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]'");
    const summaries = new Set(db.prepare('PRAGMA table_info(fca_task_history_summaries)').all().map(row => row.name));
    if (!summaries.has('reset_through_sequence')) db.exec('ALTER TABLE fca_task_history_summaries ADD COLUMN reset_through_sequence INTEGER NOT NULL DEFAULT 0');
    if (!summaries.has('bootstrap_text')) db.exec("ALTER TABLE fca_task_history_summaries ADD COLUMN bootstrap_text TEXT NOT NULL DEFAULT ''");
  }
  append(taskId: string, stepId: string, entries: string, at: string, status: TaskStatus, sources: readonly TaskSource[]): void {
    this.db.prepare(`INSERT INTO fca_task_history(task_id,step_id,entries_json,committed_at,committed_status,sources_json)
      VALUES(?,?,?,?,?,?)`).run(taskId, stepId, entries, at, status, JSON.stringify(sources));
  }
  window(taskId: string, sources: readonly TaskSource[]): TaskHistoryWindow {
    const row = this.db.prepare('SELECT * FROM fca_task_history_summaries WHERE task_id=?').get(taskId);
    const summary: TaskHistorySummary | null = row ? {
      revision: Number(row.revision), fromSequence: Number(row.from_sequence), throughSequence: Number(row.through_sequence),
      template: JSON.parse(String(row.template_json)), sources: JSON.parse(String(row.sources_json)),
      resetThroughSequence: Number(row.reset_through_sequence), bootstrapText: String(row.bootstrap_text),
    } : null;
    const rounds = this.db.prepare('SELECT * FROM fca_task_history WHERE task_id=? AND sequence>? ORDER BY sequence')
      .all(taskId, summary?.throughSequence ?? 0).map(entry => ({ sequence: Number(entry.sequence), stepId: String(entry.step_id),
        committedAt: String(entry.committed_at), entries: JSON.parse(String(entry.entries_json)) as unknown[],
        status: String(entry.committed_status) as TaskHistoryRound['status'], sources: JSON.parse(String(entry.sources_json)) as TaskSource[] }));
    return { revision: summary?.revision ?? 0, sourceRevision: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
      tailSequence: rounds.at(-1)?.sequence ?? summary?.throughSequence ?? 0, summary, rounds };
  }
  commit(taskId: string, request: TaskHistoryCommit, sources: readonly TaskSource[], at: string): boolean {
    const current = this.window(taskId, sources), count = request.sequences.length;
    if (request.baseRevision !== current.revision || request.sourceRevision !== current.sourceRevision
      || request.tailSequence !== current.tailSequence || !count || count >= current.rounds.length
      || request.sequences.some((sequence, index) => sequence !== current.rounds[index]?.sequence)
      || request.retained.length !== current.rounds.length - count
      || request.retained.some((round, index) => round.sequence !== current.rounds[index + count]?.sequence
        || round.stepId !== current.rounds[index + count]?.stepId)) return false;
    const first = current.summary?.fromSequence ?? request.sequences[0]!, last = request.sequences.at(-1)!;
    const template = checkedTemplate(request.template, { fromId: `fca-round:${first}`, toId: `fca-round:${last}` });
    if (!template || !COMPACTION_SECTIONS.some(section => template[section].length)) return false;
    const lineage = [...new Map([...current.summary?.sources ?? [], ...current.rounds.slice(0, count).flatMap(round => round.sources),
      ...sources].map(source => [source.stepId, source])).values()];
    const bootstrap = JSON.stringify({ kind: 'fca_public_history', summary: template, rounds: request.retained });
    this.db.prepare(`INSERT INTO fca_task_history_summaries(task_id,revision,from_sequence,through_sequence,template_json,sources_json,
      updated_at,reset_through_sequence,bootstrap_text) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
      revision=excluded.revision,through_sequence=excluded.through_sequence,template_json=excluded.template_json,sources_json=excluded.sources_json,
      updated_at=excluded.updated_at,reset_through_sequence=excluded.reset_through_sequence,bootstrap_text=excluded.bootstrap_text`)
      .run(taskId, current.revision + 1, first, last, JSON.stringify(template), JSON.stringify(lineage), at, current.tailSequence, bootstrap);
    return true;
  }
}
