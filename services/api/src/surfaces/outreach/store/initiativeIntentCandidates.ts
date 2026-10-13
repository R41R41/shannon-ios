import { DatabaseSync } from 'node:sqlite';
import type { CandidateRow } from '../../../mind/action/respond/initiativeSelection.js';

const STALE_INTENT_MILLISECONDS = 24 * 60 * 60_000;

export interface IntentInitiativeCandidate extends CandidateRow {
  score: number;
  thread_id?: string;
}

export function intentInitiativeCandidates(
  database: DatabaseSync,
  scopeKey: string,
  at: string,
): IntentInitiativeCandidate[] {
  if (!tableExists(database, 'cognitive_intents')) return [];
  const staleCutoff = new Date(Date.parse(at) - STALE_INTENT_MILLISECONDS).toISOString();
  const hasTasks = tableExists(database, 'agent_tasks');
  const rows = database.prepare(hasTasks ? `
    SELECT ci.intent_id, ci.title, ci.thread_id, ci.next_step, ci.updated_at AS intent_updated_at,
      at.task_id, at.status AS task_status, at.summary AS task_summary,
      at.current_action, at.latest_sequence, at.updated_at AS task_updated_at,
      at.pending_approval_json
    FROM cognitive_intents ci
    LEFT JOIN agent_tasks at
      ON at.scope_key = ci.scope_key AND at.task_id = ci.linked_task_id
    WHERE ci.scope_key = ? AND ci.status = 'active' AND ci.thread_id IS NOT NULL
      AND (
        at.status IN ('waiting_approval','paused','failed','completed')
        OR (ci.linked_task_id IS NULL AND ci.updated_at <= ?)
      )
    ORDER BY
      CASE at.status WHEN 'waiting_approval' THEN 0 WHEN 'failed' THEN 1
        WHEN 'paused' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
      COALESCE(at.updated_at, ci.updated_at) ASC
    LIMIT 8
  ` : `
    SELECT ci.intent_id, ci.title, ci.thread_id, ci.next_step, ci.updated_at AS intent_updated_at,
      NULL AS task_id, NULL AS task_status, NULL AS task_summary, NULL AS current_action,
      0 AS latest_sequence, NULL AS task_updated_at, NULL AS pending_approval_json
    FROM cognitive_intents ci
    WHERE ci.scope_key = ? AND ci.status = 'active' AND ci.thread_id IS NOT NULL
      AND ci.linked_task_id IS NULL AND ci.updated_at <= ?
    ORDER BY ci.updated_at ASC LIMIT 8
  `).all(scopeKey, staleCutoff) as unknown as Array<Record<string, unknown>>;
  return rows.map(row => {
    const intentID = String(row.intent_id);
    const taskID = typeof row.task_id === 'string' ? row.task_id : '';
    const revision = taskID ? String(row.latest_sequence) : String(row.intent_updated_at);
    const status = typeof row.task_status === 'string' ? row.task_status : 'stale';
    const title = String(row.title);
    return {
      item_id: `intent:${intentID}:${taskID || 'none'}:${revision}`,
      source_id: 'intent', source_title: '継続中の目的', title, url: '',
      summary: intentInitiativeMessage(title, status, row),
      published_at: null,
      discovered_at: String(row.task_updated_at ?? row.intent_updated_at),
      thread_id: String(row.thread_id),
      score: status === 'waiting_approval' ? 0.92 : status === 'failed' ? 0.88 : 0.78,
    };
  });
}

export function intentInitiativeCandidateIsCurrent(
  database: DatabaseSync,
  scopeKey: string,
  itemID: string,
): boolean {
  const match = itemID.match(/^intent:([^:]{1,160}):([^:]{1,160}):(.+)$/u);
  if (!match) return false;
  const [, intentID, taskID, revision] = match;
  const intent = database.prepare(`SELECT status, linked_task_id, updated_at
    FROM cognitive_intents WHERE scope_key = ? AND intent_id = ?`).get(scopeKey, intentID) as Record<string, unknown> | undefined;
  if (!intent || intent.status !== 'active') return false;
  if (taskID === 'none') return !intent.linked_task_id && intent.updated_at === revision;
  if (!tableExists(database, 'agent_tasks') || intent.linked_task_id !== taskID) return false;
  const task = database.prepare(`SELECT latest_sequence, status FROM agent_tasks
    WHERE scope_key = ? AND task_id = ?`).get(scopeKey, taskID) as Record<string, unknown> | undefined;
  return Boolean(task && String(task.latest_sequence) === revision
    && ['waiting_approval', 'paused', 'failed', 'completed'].includes(String(task.status)));
}

/**
 * The state of a goal and its task, as neutral text (owner decision 2026-10-14): no fixed line in her voice. It is shown as text and
 * never said aloud by a body (`initiativeFreshness.ts`); how he is told of what he asked for is still his to decide.
 */
function intentInitiativeMessage(title: string, status: string, row: Record<string, unknown>): string {
  const current = typeof row.current_action === 'string' && row.current_action.trim()
    ? row.current_action.trim() : typeof row.next_step === 'string' ? row.next_step.trim() : '';
  const next = current ? `（次: ${current}）` : '';
  if (status === 'waiting_approval') {
    const approval = safeObject(row.pending_approval_json);
    const approvalTitle = typeof approval?.title === 'string' ? approval.title.trim() : '操作内容';
    return `「${title}」: 「${approvalTitle}」の確認待ち`;
  }
  if (status === 'failed') return `「${title}」: 作業で問題あり${current ? `（${current}）` : ''}`;
  if (status === 'paused') return `「${title}」: 一時停止中${next}`;
  if (status === 'completed') return `「${title}」: 作業は検証まで完了`;
  return `「${title}」: 続いている目的${next}`;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return Boolean(database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}
