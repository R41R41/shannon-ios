import type { AppLookOptions } from './appLook.js';
import { appLookRequestBytes, configuredAppLook } from './contracts/appLookContract.js';
import { SQLiteAppLookSpeaker } from './appLookDelivery.js';
import { SQLiteAppLookStore } from './appLookStore.js';
import type { BodyLookOptions } from './bodyLook.js';
import { SQLiteBodyLookActivityStore } from './bodyLookActivityStore.js';
import { createConfiguredActivityRoomLookViewer } from './bodyLookActivityVision.js';
import { BODY_LOOK_REQUEST_BYTES, bodyLookResultId, configuredBodyLook } from './contracts/bodyLookContract.js';
import { SQLiteBodyLookSpeaker } from './bodyLookDelivery.js';
import { SQLiteBodyLookStore } from './bodyLookStore.js';
import { createConfiguredRoomLookViewer } from './bodyLookVision.js';
import type { LlmUsageEvent } from './llmUsage.js';

/**
 * What the API process gives the kernel for looking at the room: the small table, the
 * switch and limits from the environment, the conversation model as the viewer, and the
 * initiative path as the way her message reaches the apps. For a look her activity loop
 * opened (stage 2) it adds the hand-off table and a viewer that uses the dedicated autonomy key.
 */
export function configuredBodyLookOptions(
  environment: Readonly<Record<string, string | undefined>>,
  databasePath: string,
  usageStore: { recordLlmUsage(event: LlmUsageEvent): void },
): BodyLookOptions {
  const store = new SQLiteBodyLookStore(databasePath);
  const speaker = new SQLiteBodyLookSpeaker(databasePath);
  const hand = new SQLiteBodyLookActivityStore(databasePath);
  opened.push(store, speaker, hand);
  return {
    store, config: configuredBodyLook(environment), viewer: createConfiguredRoomLookViewer(environment, usageStore), speaker,
    activity: { hand, viewer: createConfiguredActivityRoomLookViewer(environment, (scopeKey, lookId, usage) => hand.recordUsage(scopeKey, lookId, usage)) },
  };
}

/**
 * The same for a look through the camera of the owner's app (`appLook.ts`): its own small table and switch, the
 * conversation model as the viewer, and her message stored in the Talk without an initiative or a push.
 */
export function configuredAppLookOptions(
  environment: Readonly<Record<string, string | undefined>>,
  databasePath: string,
  usageStore: { recordLlmUsage(event: LlmUsageEvent): void },
): AppLookOptions {
  const store = new SQLiteAppLookStore(databasePath);
  const speaker = new SQLiteAppLookSpeaker(databasePath);
  opened.push(store, speaker);
  return { store, config: configuredAppLook(environment), viewer: createConfiguredRoomLookViewer(environment, usageStore), speaker };
}

const opened: Array<{ close(): void }> = [];

/** Closes the look's own database handles at shutdown. */
export function closeBodyLookStores(): void {
  for (const handle of opened.splice(0)) handle.close();
}

/** The JSON body limit of a look answer (from her body or from an app), the routes that carry a frame; null for every other path. */
export function bodyLookRequestBytes(path: string): number | null {
  return bodyLookResultId(path) ? BODY_LOOK_REQUEST_BYTES : appLookRequestBytes(path);
}
