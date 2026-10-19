import type { DatabaseSync } from 'node:sqlite';
import type { ShannonTouchKind } from '@shannon/cognition';
import { BODY_TOUCH_EVENT_TYPES, validatedTouchDetail, type BodyAudience, type BodyTouchGesture, type BodyTouchSide } from '../../../contracts/bodyContract.js';
import { isBodyTouchRegion, type BodyTouchPart, type BodyTouchRegion } from '../bodyTouchWords.js';
import { isBodyTouchStance, type BodyTouchStance } from '../bodyTouchReflex.js';

/**
 * Two reads of the touch tables (`bodyReactionStore.ts`) for what a later turn is told of her body (2026-10-14): the owner's recent
 * touches with how she took each and the line she said, for a voice turn; and how often each part was touched, for her inner note.
 * Closed values, numbers, identifiers and her own words only. The caller leaves out what the owner had her forget (by burst).
 */

/** One touch as a voice turn is told it: what, where, how she took it, and her line if she said one. */
export interface TouchFact {
  touchId: string;
  burstId: string;
  type: ShannonTouchKind;
  occurredAt: string;
  region?: BodyTouchRegion;
  part?: BodyTouchPart;
  side?: BodyTouchSide;
  gesture?: BodyTouchGesture;
  stance: BodyTouchStance | null;
  line: string | null;
}

/** How many touches of one burst named one part (the finer part, else the region; null for neither). */
export interface PartCount { burstId: string; part: string | null; count: number }

interface TouchFactRow {
  touch_id: string; burst_id: string; touch_type: string; occurred_at: string; region: string | null; part: string | null; side: string | null;
  gesture: string | null; stance: string | null; line_text: string | null;
}

/** The touches of one audience between two instants, newest first, each with her stance and the line she said (a said line only). */
export function recentTouchFacts(database: DatabaseSync, scopeKey: string, audience: BodyAudience, since: string, until: string, limit: number): TouchFact[] {
  const rows = database.prepare(`
    SELECT t.touch_id AS touch_id, t.burst_id AS burst_id, t.touch_type AS touch_type, t.occurred_at AS occurred_at, t.region AS region,
      t.part AS part, t.side AS side, t.gesture AS gesture, o.stance AS stance, r.line_text AS line_text
    FROM body_touches t
    LEFT JOIN body_touch_outcomes o ON o.scope_key = t.scope_key AND o.touch_id = t.touch_id
    LEFT JOIN body_reactions r ON r.scope_key = t.scope_key AND r.reaction_id = t.touch_id AND r.status = 'said'
    WHERE t.scope_key = ? AND t.audience = ? AND t.occurred_at >= ? AND t.occurred_at <= ?
    ORDER BY t.occurred_at DESC LIMIT ?
  `).all(scopeKey, audience, since, until, Math.max(1, Math.min(20, Math.trunc(limit)))) as unknown as TouchFactRow[];
  return rows.flatMap((row): TouchFact[] => {
    const type = BODY_TOUCH_EVENT_TYPES.find(value => value === row.touch_type);
    if (!type) return [];
    const region = isBodyTouchRegion(row.region) ? row.region : undefined;
    const detail = validatedTouchDetail({ part: row.part ?? undefined, side: row.side ?? undefined, gesture: row.gesture ?? undefined }, type, region);
    return [{ touchId: row.touch_id, burstId: row.burst_id, type, occurredAt: row.occurred_at, ...(region ? { region } : {}),
      ...(detail.part ? { part: detail.part } : {}), ...(detail.side ? { side: detail.side } : {}), ...(detail.gesture ? { gesture: detail.gesture } : {}),
      stance: isBodyTouchStance(row.stance) ? row.stance : null, line: row.line_text }];
  });
}

/** How often each part was touched with this audience between two instants, by burst. */
/** Owner 2026-10-19: being carried on the screen (`carry`) is no touch of a part: it is not counted here (`isMovedTouch`). */
export function partCounts(database: DatabaseSync, scopeKey: string, audience: BodyAudience, since: string, until: string): PartCount[] {
  return (database.prepare(`
    SELECT burst_id, COALESCE(part, region) AS part, COUNT(*) AS count FROM body_touches
    WHERE scope_key = ? AND audience = ? AND occurred_at >= ? AND occurred_at <= ? AND touch_type <> 'carry' GROUP BY burst_id, COALESCE(part, region)
  `).all(scopeKey, audience, since, until) as unknown as Array<{ burst_id: string; part: string | null; count: number }>)
    .map(row => ({ burstId: row.burst_id, part: row.part, count: Number(row.count) }));
}
