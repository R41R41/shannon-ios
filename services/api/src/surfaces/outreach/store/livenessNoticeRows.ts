import type { DatabaseSync } from 'node:sqlite';
import { LIVENESS_EPISODE_TABLE, LIVENESS_NOTICE_TITLE, livenessNoticeText } from '../../../contracts/livenessNoticeContract.js';
import type { APNsEnvironment, PendingPushNotification } from '../pushNotifications.js';

export interface LivenessNoticeQuery {
  at: string;
  /** Episodes opened before this are not announced any more. */
  cutoff: string;
  maximumAttempts: number;
  limit: number;
}

/**
 * The open liveness episodes (ADR-0009 §9) not yet delivered to each of the owner's registered devices: one notice per
 * episode and device, neutral status text, no thread to open. The table belongs to the ops liveness check; this reads it.
 */
export function pendingLivenessNotices(db: DatabaseSync, query: LivenessNoticeQuery): PendingPushNotification[] {
  if (!tableExists(db, LIVENESS_EPISODE_TABLE)) return [];
  // The badge counts her unread messages as the other notices do, plus this one.
  const unread = tableExists(db, 'initiative_messages')
    ? '(SELECT COUNT(*) FROM initiative_messages unread WHERE unread.scope_key = pr.scope_key AND unread.read_at IS NULL)' : '0';
  const rows = db.prepare(`
    SELECT e.episode_id, e.incident, e.opened_at, pr.device_id, pr.device_token, pr.environment, ${unread} AS unread
    FROM ${LIVENESS_EPISODE_TABLE} e
    JOIN push_registrations pr ON pr.invalidated_at IS NULL AND pr.scope_key = e.scope_key
    LEFT JOIN push_delivery_state delivery
      ON delivery.initiative_id = ('liveness:' || e.episode_id) AND delivery.device_id = pr.device_id
    WHERE e.closed_at IS NULL AND e.opened_at >= ?
      AND (delivery.initiative_id IS NULL OR (delivery.delivered_at IS NULL AND delivery.attempts < ?
        AND delivery.next_attempt_at <= ? AND (delivery.leased_until IS NULL OR delivery.leased_until <= ?)))
    ORDER BY e.opened_at ASC
    LIMIT ?
  `).all(query.cutoff, query.maximumAttempts, query.at, query.at, query.limit);
  return rows.flatMap(row => {
    const content = livenessNoticeText(String(row.incident));
    if (!content) return [];
    return [{
      kind: 'liveness_incident' as const,
      initiativeId: `liveness:${String(row.episode_id)}`,
      title: LIVENESS_NOTICE_TITLE,
      deviceId: String(row.device_id),
      deviceToken: String(row.device_token),
      environment: String(row.environment) as APNsEnvironment,
      threadId: '',
      content,
      expression: 'neutral',
      createdAt: String(row.opened_at),
      badgeCount: Math.max(1, Math.min(99, Number(row.unread) + 1)),
    }];
  });
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
