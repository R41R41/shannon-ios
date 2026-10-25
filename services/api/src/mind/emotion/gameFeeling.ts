import { isShannonGameDanger, isShannonGameMilestone, type ShannonGameMoment } from '@shannon/cognition';
import type { BodyEvent } from '../../contracts/bodyContract.js';

/**
 * Her Minecraft body's stored game events as moments of the one game table (`gameEmotion.ts`; owner 2026-10-26: 「出来事はコードで」).
 * A plain mapping of closed fields: nothing the body sends becomes words, and nothing here reads the feeling back into what the body does.
 */

/** A moment older than this when it arrives (a body that reconnected and sent what it kept) is remembered but no longer felt. */
export const GAME_FEELING_FRESH_MILLISECONDS = 2 * 60_000;

export function gameMomentOf(event: Pick<BodyEvent, 'type' | 'cause' | 'strength'>): ShannonGameMoment | null {
  const kind = (event.cause ?? '').split(':', 2)[1];
  switch (event.type) {
    case 'game.died': return { kind: 'died' };
    case 'game.hurt': return { kind: 'hurt', strength: event.strength ?? 0 };
    case 'game.danger': return isShannonGameDanger(kind) ? { kind: 'danger', danger: kind } : null;
    case 'game.milestone': return isShannonGameMilestone(kind) ? { kind: 'milestone', milestone: kind } : null;
    case 'game.night_survived': return { kind: 'nightSurvived' };
    case 'game.owner_near': return { kind: 'ownerNear' };
    default: return null;
  }
}
