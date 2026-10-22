import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { checkedTemplate, COMPACTION_BODY_ITEM_CHARACTERS, COMPACTION_SECTIONS } from '@shannon/mind';
import type { TaskHistoryCommit, TaskHistoryRound, TaskHistorySummary, TaskHistoryWindow } from '../taskHistoryPorts.js';
import type { TaskSource, TaskStatus, TaskStep } from '../taskRuntimePorts.js';
import { namedWork } from '../../../../infra/observer/eventLoopWatch.js';
import { enableFcaProvenanceSets, requireStoredSources, storedSourcesJson } from '../../../../infra/sqlite/fcaProvenanceSets.js';

/** Derived summaries never replace the append-only native history. Caller owns the task transaction and lease fence. */
export class TaskHistoryStore {
  /** `byReference`: a round's sources are stored as a provenance set when they can be (`fcaProvenanceSets.ts`), else copied. */
  constructor(private readonly db: DatabaseSync, private readonly byReference = false) {
    if (byReference) enableFcaProvenanceSets(db);
  }
  append(scopeKey: string, taskId: string, stepId: string, entries: string, at: string, status: TaskStatus, sources: readonly TaskSource[]): void {
    this.db.prepare(`INSERT INTO fca_task_history(task_id,step_id,entries_json,committed_at,committed_status,sources_json)
      VALUES(?,?,?,?,?,?)`).run(taskId, stepId, entries, at, status, storedSourcesJson(this.db, scopeKey, sources, this.byReference));
  }
  /**
   * A committed step's round. A step closed as `continue` with nothing in its history (a retry after a provider 5xx, a held step: nothing
   * ran) adds no round: an empty round is not a native round, `FcaHistoryCodec.project` cannot project it, and every later replay
   * would stop at FCA_HISTORY_INCOMPLETE_ROUND. Any other disposition still writes its row even when empty (a fail row is needed by the
   * evidence JOINs on step_id and for `committed_status`); `window()` leaves every empty row out, so no reader sees it as a round.
   */
  appendStep(step: TaskStep, entries: string, disposition: string, at: string, status: TaskStatus): void {
    if (disposition === 'continue' && entries === '[]') return;
    // r9: named, so that a block of the loop at a commit says whether it was the round's sources (the reference to them) or the rest.
    namedWork('commit_history', () => this.append(step.scopeKey, step.taskId, step.id, entries, at, status, step.snapshot.sources));
  }
  /** A round's stored sources (a copy, or a reference read now); an unresolved reference stops the read (`FCA_PROVENANCE_UNRESOLVED`). */
  window(scopeKey: string, taskId: string, sources: readonly TaskSource[]): TaskHistoryWindow {
    const row = this.db.prepare('SELECT * FROM fca_task_history_summaries WHERE task_id=?').get(taskId);
    const summary: TaskHistorySummary | null = row ? {
      revision: Number(row.revision), fromSequence: Number(row.from_sequence), throughSequence: Number(row.through_sequence),
      template: JSON.parse(String(row.template_json)), sources: JSON.parse(String(row.sources_json)),
      resetThroughSequence: Number(row.reset_through_sequence), bootstrapText: String(row.bootstrap_text),
    } : null;
    // Rows stored with no entries (written by a retried step before `appendStep`) are not rounds: every reader sees the window without them.
    const rounds = this.db.prepare(`SELECT * FROM fca_task_history WHERE task_id=? AND sequence>? AND entries_json<>'[]' ORDER BY sequence`)
      .all(taskId, summary?.throughSequence ?? 0).map(entry => ({ sequence: Number(entry.sequence), stepId: String(entry.step_id),
        committedAt: String(entry.committed_at), entries: JSON.parse(String(entry.entries_json)) as unknown[],
        status: String(entry.committed_status) as TaskHistoryRound['status'],
        sources: [...requireStoredSources(this.db, scopeKey, String(entry.sources_json))] }))
      .filter(round => round.entries.length > 0);
    return { revision: summary?.revision ?? 0, sourceRevision: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
      tailSequence: rounds.at(-1)?.sequence ?? summary?.throughSequence ?? 0, summary, rounds };
  }
  commit(scopeKey: string, taskId: string, request: TaskHistoryCommit, sources: readonly TaskSource[], at: string): boolean {
    const current = this.window(scopeKey, taskId, sources), count = request.sequences.length;
    if (request.baseRevision !== current.revision || request.sourceRevision !== current.sourceRevision
      || request.tailSequence !== current.tailSequence || !count || count >= current.rounds.length
      || request.sequences.some((sequence, index) => sequence !== current.rounds[index]?.sequence)
      || request.retained.length !== current.rounds.length - count
      || request.retained.some((round, index) => round.sequence !== current.rounds[index + count]?.sequence
        || round.stepId !== current.rounds[index + count]?.stepId)) return false;
    const first = current.summary?.fromSequence ?? request.sequences[0]!, last = request.sequences.at(-1)!;
    // The ceiling is a body summary's item length; every other summarizer already cut its items to 80 (`checkedTemplate`).
    const template = checkedTemplate(request.template, { fromId: `fca-round:${first}`, toId: `fca-round:${last}` }, COMPACTION_BODY_ITEM_CHARACTERS);
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
