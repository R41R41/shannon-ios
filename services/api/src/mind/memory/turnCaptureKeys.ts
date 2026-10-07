/** The keys and the owner-facing words of a turn's captures (Syzygy ADR-0008 stage 3, S2: moved unchanged out of the captures store). */
import type { TurnCaptureKind } from './store/turnCaptures.js';
import { createHash } from 'node:crypto';

export function turnCaptureId(turnId: string, kind: TurnCaptureKind, key: string): string {
  return `capture-${createHash('sha256').update(`${turnId}\u0000${kind}\u0000${key}`).digest('hex').slice(0, 24)}`;
}

/** Same normalization the intention ledger uses to deduplicate a restated goal. */
export function intentCaptureKey(title: string): string {
  return title.toLocaleLowerCase('ja-JP').replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 160);
}

/** The owner reads their own fact, not the internal third-person sentence. */
export function ownerFacingStatement(statement: string): string {
  return statement.replace(/^ユーザー(?:は|の|が)(?:シャノンに)?/u, '').trim() || statement;
}
