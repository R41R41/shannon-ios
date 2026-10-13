/**
 * Syzygy ADR-0012 stage 1: her character core and her inner note are core (ADR-0002): who she is is persona, the note and its
 * writer are her emotion source. Applying a change to any of these needs the owner's approval.
 */
export const INNER_NOTE_CORE_PATHS = Object.freeze({
  persona: Object.freeze([
    'packages/cognition/src/characterCore.ts',
    'packages/cognition/src/innerNotePrompt.ts',
  ]),
  emotion: Object.freeze([
    'packages/cognition/src/innerNote.ts',
    'services/api/src/mind/emotion/innerNotePorts.ts',
    'services/api/src/mind/emotion/innerNoteService.ts',
    'services/api/src/mind/emotion/innerNoteReflection.ts',
    'services/api/src/mind/emotion/store/innerNoteStore.ts',
    'services/api/src/infra/sqlite/migrations/emotion/001_inner_notes.ts',
    'services/api/src/wiring/innerNoteWiring.ts',
  ]),
});
