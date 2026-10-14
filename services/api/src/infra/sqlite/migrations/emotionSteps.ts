import type { SchemaStep } from './schemaSteps.js';
import { INNER_NOTES_STEP } from './emotion/001_inner_notes.js';
import { INNER_NOTE_EPISODES_STEP } from './emotion/002_inner_note_episodes.js';
import { INNER_NOTE_ATTEMPTS_STEP } from './emotion/003_inner_note_attempts.js';
import { FEELING_EVENTS_STEP } from './emotion/004_feeling_events.js';
import { FEELING_SHADOW_STEP } from './emotion/005_feeling_shadow.js';

export { FEELING_EVENTS_STEP, FEELING_SHADOW_STEP, INNER_NOTES_STEP, INNER_NOTE_ATTEMPTS_STEP, INNER_NOTE_EPISODES_STEP };

/** Every schema step of her inner note (Syzygy ADR-0012), in order; its store applies them when it opens (switch on only). */
export const EMOTION_STEPS: readonly SchemaStep[] = Object.freeze([INNER_NOTES_STEP, INNER_NOTE_EPISODES_STEP, INNER_NOTE_ATTEMPTS_STEP]);

/** Her feeling events (Syzygy ADR-0013 stage 1); their store applies them when it opens (`SHANNON_FEELING_EVENTS` on only). */
export const FEELING_STEPS: readonly SchemaStep[] = Object.freeze([FEELING_EVENTS_STEP]);

/** The shadow of her fast layer (Syzygy ADR-0013 stage 2); applied only when `SHANNON_CORE_AFFECT` opens its store. */
export const FEELING_SHADOW_STEPS: readonly SchemaStep[] = Object.freeze([FEELING_SHADOW_STEP]);
