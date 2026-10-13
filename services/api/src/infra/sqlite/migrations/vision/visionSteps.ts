import type { SchemaStep } from '../schemaSteps.js';
import { VISION_BUDGET_STEP } from './001_vision_budget.js';
import { VISION_CHOICES_STEP } from './002_vision_choices.js';

/** The vision worker's schema steps (Syzygy ADR-0011 stage 1), applied by the worker when it opens the shared file. */
export const VISION_STEPS: readonly SchemaStep[] = Object.freeze([VISION_BUDGET_STEP, VISION_CHOICES_STEP]);
