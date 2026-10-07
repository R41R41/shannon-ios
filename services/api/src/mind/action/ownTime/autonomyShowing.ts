import { SHANNON_OWNER_NAME } from '@shannon/cognition';

/**
 * Telling the owner that a piece is ready to read, through the same initiative path
 * as everything else Shannon says unprompted.
 *
 * It uses the day's one initiative slot (the unique day key of `initiative_messages`),
 * so it never adds a second message to a day, and it keeps the same quiet hours and the
 * same cooldown after the owner's last message. A promise that is due, or becomes due
 * later today, keeps the slot. A version of a piece is announced at most once.
 * The message is the only thing the activity loop ever sends, and only to the owner.
 */
export type ShowingOutcome =
  | 'sent' | 'already-told' | 'quiet-hours' | 'recent-conversation' | 'today-is-enough' | 'reserved-for-commitment' | 'unavailable' | 'held';

export interface ShowablePiece {
  id: string;
  title: string;
  version: number;
  /** An earlier version was already shown. */
  revised: boolean;
}

export interface StudyShowing {
  /** Whether she may message the owner at this moment at all (quiet hours, cooldown, the day's slot). */
  mayMessageNow(scopeKey: string, at: string): ShowingOutcome | 'ok';
  tell(scopeKey: string, piece: ShowablePiece, at: string): ShowingOutcome;
  /** Whether the owner wrote or spoke since the given instant. A yes or no; no content leaves. */
  ownerActiveSince(scopeKey: string, since: string): boolean;
  /** When the owner first wrote or spoke after the given instant, in any Talk, or null. A timestamp; no content leaves. */
  ownerFirstActiveAfter?(scopeKey: string, after: string): string | null;
}

/** Sentence presented as Shannon speaking (です・ます, ボク, ライ氏). */
export function studyShowingMessage(piece: ShowablePiece): string {
  const title = piece.title.replace(/\s+/gu, ' ').trim().slice(0, 80);
  return piece.revised
    ? `${SHANNON_OWNER_NAME}、「${title}」を直しました。前の稿より、ボクは好きなものになったと思います。もう一度読んでもらえると嬉しいです。`
    : `${SHANNON_OWNER_NAME}、短い物語を書きました。「${title}」です。読んだら、どう思ったか聞かせてください。ボクは、けっこう気に入っています。`;
}

/**
 * The proactive gate as the showing desk is handed it (Syzygy ADR-0008 stage 3 review M1): `tell` is the point `share`, its subject
 * the piece. Declared here by its shape, so her own time imports nothing of attention; wiring hands the gate (`autonomyWorker.ts`).
 * The budget request (`autonomyAnnouncer.ts`) is a system notice, not a message she starts, and stays outside the gate.
 */
export interface ShowingGate {
  decide(scopeKey: string, intent: ShowingIntent, at: string, connection: ShowingConnection): { verdict: 'deliver' } | { verdict: 'hold'; code: string; retryAt: string | null };
  hold(scopeKey: string, intent: ShowingIntent, decision: { verdict: 'hold'; code: string; retryAt: string | null }, at: string): unknown;
  deliveredWithin(scopeKey: string, intent: ShowingIntent, at: string, connection: ShowingConnection): void;
}
export interface ShowingIntent { point: 'share'; reason: 'share'; subject: string; arisenAt: string; text: string }

export class DisabledStudyShowing implements StudyShowing {
  mayMessageNow(): ShowingOutcome { return 'unavailable'; }
  tell(): ShowingOutcome { return 'unavailable'; }
  ownerActiveSince(): boolean { return false; }
  ownerFirstActiveAfter(): string | null { return null; }
}

/** Only transaction query operations cross the gate boundary. */
export interface ShowingConnection {
  prepare(sql: string): { run(...values: never[]): unknown; get(...values: never[]): unknown; all(...values: never[]): unknown[] };
}
