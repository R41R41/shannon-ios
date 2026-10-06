import { configuredBodyReactions } from './contracts/bodyReactionContract.js';
import { createConfiguredBodyReactionSpeaker } from './bodyReactionModel.js';
import { SQLiteBodyReactionStore } from './bodyReactionStore.js';
import { SQLiteTouchExperiences } from './bodyTouchMemory.js';
import { touchPredictionEnabled } from './bodyTouchPrediction.js';
import type { LlmUsageEvent } from './llmUsage.js';
import type { ShannonBodyOptions } from './shannonBody.js';

/**
 * What the API process gives the kernel for a touch: the three small tables, the switch and
 * timings from the environment, the conversation model as the fast speaker (its tokens in
 * the conversation's `chat` lane), and the experience table as where a touch is remembered.
 */
export function configuredBodyReactionOptions(
  environment: Readonly<Record<string, string | undefined>>,
  databasePath: string,
  usageStore: { recordLlmUsage(event: LlmUsageEvent): void },
  prediction: NonNullable<ShannonBodyOptions['reactions']>['prediction'] = null,
  /** Syzygy ADR-0008 stage 1: the prediction ledger's touch port; null while the ledger is switched off. */
  ledger: NonNullable<ShannonBodyOptions['reactions']>['ledger'] = null,
): NonNullable<ShannonBodyOptions['reactions']> {
  const store = new SQLiteBodyReactionStore(databasePath);
  const experiences = new SQLiteTouchExperiences(databasePath);
  opened.push(store, experiences);
  return { store, experiences, config: configuredBodyReactions(environment), speaker: createConfiguredBodyReactionSpeaker(environment, usageStore), prediction,
    stage2: touchPredictionEnabled(environment), ledger };
}

const opened: Array<{ close(): void }> = [];

/** Closes the reaction's own database handles at shutdown. */
export function closeBodyReactionStores(): void {
  for (const handle of opened.splice(0)) handle.close();
}
