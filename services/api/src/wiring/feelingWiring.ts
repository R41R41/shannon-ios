import type { DecisionTraceWriter } from '../contracts/decisionTraceContract.js';
import { FeelingEvents } from '../mind/emotion/feelingEvents.js';
import { feelingEventsEnabled, feelingTurnEnabled, singleFaceEnabled, type FeelingPort } from '../mind/emotion/feelingPorts.js';
import { SQLiteFeelingEventStore } from '../mind/emotion/store/feelingEventStore.js';
import { bodyTouchPartWord, bodyTouchRegionWord, isBodyTouchPart, isBodyTouchRegion } from '../surfaces/body/bodyTouchWords.js';
import { configuredJevChooser } from './skillRoutingWiring.js';
import type { JevChooser } from '../infra/models/jev/jevChoice.js';
import type { DatabaseSync } from 'node:sqlite';

export interface ConfiguredFeeling {
  port: FeelingPort;
  close(): void;
}

/** A touch without a part is named by what was done (the ledger line's 「今日のつつかれた件」 reads 「今日の体（つつく）の件」). */
const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({ pet: 'なでる', poke: 'つつく', tickle: 'くすぐる', carry: '持ち上げる', holdHand: '手をにぎる' });

/** A subject of the ledger in her words: a part (胸), a region (頭), or the body with what was done. */
export function feelingPartWord(subject: string): string {
  if (isBodyTouchPart(subject)) return bodyTouchPartWord(subject);
  if (isBodyTouchRegion(subject)) return bodyTouchRegionWord(subject);
  return KIND_WORDS[subject] ? `体（${KIND_WORDS[subject]}）` : '体';
}

/**
 * Her feeling events, the feeling turn and the one face (Syzygy ADR-0013 stage 1), composed for the API process: the table (schema
 * step `emotion/004_feeling_events`), the service, and Jev for the text feeling turn (the stage-2 Jev client with its trace writer;
 * none without `TYPESAFE_API_KEY`). `SHANNON_FEELING_EVENTS` off (the default): null, nothing is opened, no table is created, and
 * every prompt and face is what it was.
 */
export function configuredFeeling(environment: Readonly<Record<string, string | undefined>>, parts: {
  databasePath: string; timeZone: string; now: () => string; trace: DecisionTraceWriter | null; salt?: string; jevFetch?: typeof fetch;
}): ConfiguredFeeling | null {
  if (!feelingEventsEnabled(environment)) return null;
  const turn = feelingTurnEnabled(environment);
  const chooser = turn ? configuredJevChooser(environment, { trace: parts.trace, now: parts.now, ...(parts.salt ? { salt: parts.salt } : {}),
    ...(parts.jevFetch ? { jevFetch: parts.jevFetch } : {}) }) : null;
  const singleFace = singleFaceEnabled(environment);
  return composedFeeling({ database: parts.databasePath, now: parts.now, timeZone: parts.timeZone, chooser, turn, singleFace });
}

/** The composition itself (tests and the replay hand their own parts: an in-memory table, a fake or real chooser). */
export function composedFeeling(parts: { database: string | DatabaseSync; now: () => string; timeZone: string; chooser: JevChooser | null; turn: boolean;
  singleFace: boolean }): ConfiguredFeeling {
  const store = new SQLiteFeelingEventStore(parts.database);
  const events = new FeelingEvents({ store, now: parts.now, timeZone: parts.timeZone, partWord: feelingPartWord });
  return { port: { events, chooser: parts.chooser, turn: parts.turn, singleFace: parts.singleFace }, close: () => store.close() };
}
