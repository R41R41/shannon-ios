import type { DatabaseSync } from 'node:sqlite';
import { innerNoteCurrent } from '@shannon/cognition';
import { openDatabase } from '../infra/sqlite/sqliteOpen.js';
import { switchOn } from '@shannon/switches';
import { noteForgotten } from '../mind/emotion/innerNoteLineage.js';
import { readLatestInnerNote } from '../mind/emotion/store/innerNoteStore.js';
import { momentInnerNoteBlock, type AutonomyMomentSpeech } from '../mind/action/ownTime/ownMomentSpeech.js';
import { proactiveSelfEnabled } from './proactiveMomentsWiring.js';
import { sqliteOwnerSnapshot } from './ownerUpcomingWiring.js';

/**
 * What her own time's process opens for her moment speech (owner decision 2026-10-14, by form: 「シャノン本人が決める」;
 * `ownMomentSpeech.ts`): her inner note (Syzygy ADR-0012), read on a read-only connection and checked against what the owner had
 * her forget (the API's own check, `noteForgotten`, on the stored state), handed to her loop as one finished block for the owner
 * alone. The loop is handed the interface, never a store. Nothing is written: no table is created, no note is changed (the API's
 * sweep deletes a forgotten note; until then it is simply not read here).
 *
 * Null while `SHANNON_PROACTIVE_SELF` (or moments, or her own time) is off. With `SHANNON_INNER_NOTE` off nothing of the note is
 * opened and the block is always empty: she still decides herself, from her core, her day and their talk.
 */
export function configuredMomentSpeech(
  environment: Readonly<Record<string, string | undefined>>,
  options: { databasePath: string; ownerScope: string; timeZone: string },
): { speech: AutonomyMomentSpeech; close(): void } | null {
  if (!proactiveSelfEnabled(environment)) return null;
  let notes: DatabaseSync | null = null;
  let state: ReturnType<typeof sqliteOwnerSnapshot> | null = null;
  if (switchOn(environment, 'SHANNON_INNER_NOTE')) {
    try {
      notes = openDatabase(options.databasePath, 'readOnly');
      state = sqliteOwnerSnapshot(options.databasePath);
    } catch {
      if (notes?.isOpen) notes.close();
      notes = null;
      state = null;
    }
  }
  return {
    speech: {
      innerNote(scopeKey, at) {
        // ADR-0012: only the owner's scope has a note, and only the owner alone is given it (the caller asks only then).
        if (!notes || !state || scopeKey !== options.ownerScope) return null;
        try {
          const note = readLatestInnerNote(notes, scopeKey);
          if (!note || !innerNoteCurrent(note, at)) return null;
          const snapshot = state.read(scopeKey, at);
          if (!snapshot || noteForgotten(snapshot, note)) return null;
          return momentInnerNoteBlock(note, at, options.timeZone) || null;
        } catch { return null; }
      },
    },
    close() {
      if (notes?.isOpen) notes.close();
      state?.close();
    },
  };
}
