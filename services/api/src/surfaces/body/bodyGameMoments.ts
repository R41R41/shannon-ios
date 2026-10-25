import type { CompanionStateStore } from '@shannon/cognition';
import type { BodyEvent } from '../../contracts/bodyContract.js';
import { gameDeathExperience, gameMilestoneExperience, type GameExperienceWriter } from '../../mind/memory/memoryPorts.js';
import { GAME_FEELING_FRESH_MILLISECONDS, gameMomentOf } from '../../mind/emotion/gameFeeling.js';
import type { BodyEventResult } from './shannonBody.js';

/**
 * A stored game event becomes an experience in the server's words (dying, and a first on the way to the dragon). After the
 * store's own transaction, as a touch; a failure loses the memory of one event, never the receipt.
 * (Moved out of `shannonBody.ts` with `feelGame`, the 500-line ceiling.)
 */
export function rememberGame(writer: GameExperienceWriter | null | undefined, scopeKey: string, deviceId: string, events: readonly BodyEvent[],
  results: readonly BodyEventResult[]): void {
  if (!writer) return;
  for (const [index, event] of events.entries()) {
    if (!event.cause || results[index]?.status !== 'stored') continue;
    const experience = event.type === 'game.died' ? gameDeathExperience(scopeKey, deviceId, { ...event, cause: event.cause })
      : event.type === 'game.milestone' ? gameMilestoneExperience(scopeKey, deviceId, { ...event, cause: event.cause }) : null;
    if (!experience) continue;
    try { writer.write(scopeKey, experience); } catch (error) {
      console.error('Shannon game memory failed', error instanceof Error ? error.message : 'unknown');
    }
  }
}

/**
 * Phase 2 (owner 2026-10-26): a stored game event moves her feeling through the one game table (`game-felt`), as a touch moves
 * it through the touch table. After the store's own transaction; a failure loses the feeling of one moment, never the receipt.
 * One sent long after it happened (`GAME_FEELING_FRESH_MILLISECONDS`) is remembered, not felt. Nothing is read back by the body.
 */
export function feelGame(stateStore: Pick<CompanionStateStore, 'apply'>, scopeKey: string, events: readonly BodyEvent[],
  results: readonly BodyEventResult[], now: number): void {
  for (const [index, event] of events.entries()) {
    if (results[index]?.status !== 'stored' || now - Date.parse(event.occurredAt) > GAME_FEELING_FRESH_MILLISECONDS) continue;
    const moment = gameMomentOf(event);
    if (!moment) continue;
    try { stateStore.apply(scopeKey, { type: 'game-felt', moment }); } catch (error) {
      console.error('Shannon game feeling failed', error instanceof Error ? error.message : 'unknown');
    }
  }
}
