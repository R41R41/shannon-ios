import type { SchemaStep } from './schemaSteps.js';
import { INNER_NOTES_STEP } from './emotion/001_inner_notes.js';
import { INNER_NOTE_EPISODES_STEP } from './emotion/002_inner_note_episodes.js';
import { INNER_NOTE_ATTEMPTS_STEP } from './emotion/003_inner_note_attempts.js';
import { FEELING_EVENTS_STEP } from './emotion/004_feeling_events.js';
import { FEELING_SHADOW_STEP } from './emotion/005_feeling_shadow.js';
import { FEELING_DAYS_STEP } from './emotion/006_feeling_days.js';
import { REPLY_DRAFTS_STEP } from './emotion/007_reply_drafts.js';
import { REPLY_SONNET_DAYS_STEP } from './emotion/008_reply_sonnet_days.js';

export { FEELING_DAYS_STEP, FEELING_EVENTS_STEP, FEELING_SHADOW_STEP, INNER_NOTES_STEP, INNER_NOTE_ATTEMPTS_STEP, INNER_NOTE_EPISODES_STEP, REPLY_DRAFTS_STEP };
export { REPLY_SONNET_DAYS_STEP };

/** Every schema step of her inner note (Syzygy ADR-0012), in order; its store applies them when it opens (switch on only). */
export const EMOTION_STEPS: readonly SchemaStep[] = Object.freeze([INNER_NOTES_STEP, INNER_NOTE_EPISODES_STEP, INNER_NOTE_ATTEMPTS_STEP]);

/** Her feeling events (Syzygy ADR-0013 stage 1); their store applies them when it opens (`SHANNON_FEELING_EVENTS` on only). */
export const FEELING_STEPS: readonly SchemaStep[] = Object.freeze([FEELING_EVENTS_STEP]);

/** The shadow of her fast layer (Syzygy ADR-0013 stage 2); applied only when `SHANNON_CORE_AFFECT` opens its store. */
export const FEELING_SHADOW_STEPS: readonly SchemaStep[] = Object.freeze([FEELING_SHADOW_STEP]);

/** Her closed days (Syzygy ADR-0013 stage 3); applied only when a stage-3 switch opens their store. */
export const FEELING_DAYS_STEPS: readonly SchemaStep[] = Object.freeze([FEELING_DAYS_STEP]);

/** Her rewritten drafts (owner 2026-10-20); applied only when `SHANNON_NATURAL_TALK` opens their store. */
export const REPLY_DRAFTS_STEPS: readonly SchemaStep[] = Object.freeze([REPLY_DRAFTS_STEP]);

/** Her replies on Sonnet, counted per day (owner 2026-10-21); applied only when `SHANNON_REPLY_SONNET` opens their store. */
export const REPLY_SONNET_DAYS_STEPS: readonly SchemaStep[] = Object.freeze([REPLY_SONNET_DAYS_STEP]);
