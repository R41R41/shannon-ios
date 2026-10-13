import type { SchemaStep } from './schemaSteps.js';
import { INNER_NOTES_STEP } from './emotion/001_inner_notes.js';
import { INNER_NOTE_EPISODES_STEP } from './emotion/002_inner_note_episodes.js';

export { INNER_NOTES_STEP, INNER_NOTE_EPISODES_STEP };

/** Every schema step of her inner note (Syzygy ADR-0012), in order; its store applies them when it opens (switch on only). */
export const EMOTION_STEPS: readonly SchemaStep[] = Object.freeze([INNER_NOTES_STEP, INNER_NOTE_EPISODES_STEP]);
