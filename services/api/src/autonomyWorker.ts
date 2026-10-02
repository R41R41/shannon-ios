import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteAutonomyAnnouncer } from './autonomyAnnouncer.js';
import { autonomyDayKey, configuredAutonomy } from './autonomyBudget.js';
import { ShannonAutonomyLoop } from './autonomyLoop.js';
import { configuredAutonomyLoop } from './autonomyLoopConfig.js';
import { configuredOwnerContext } from './autonomyOwnerContextWiring.js';
import { BoundedPublicReader } from './autonomyReader.js';
import { ShannonAutonomyService } from './autonomyService.js';
import { SQLiteStudyShowing } from './autonomyShowing.js';
import { SQLiteAutonomyStore } from './autonomyStore.js';
import { configuredAutonomyTextModel } from './autonomyTextModel.js';
import { BODY_LIMITS, bodyIngestEnabled } from './bodyContract.js';
import { ActivityRoomLooks } from './bodyLookActivity.js';
import { SQLiteBodyLookActivityStore } from './bodyLookActivityStore.js';
import { configuredBodyLook } from './bodyLookContract.js';
import { SQLiteBodyLookStore } from './bodyLookStore.js';
import { SQLiteBodyStore } from './bodyStore.js';
import { ownerDay } from './companionPresence.js';
import { notionLoopReader } from './notionLoopReader.js';
import { configuredNotionSource } from './notionSource.js';
import { configuredOwnerUpcoming, sqliteOwnerSnapshot } from './ownerUpcomingWiring.js';
import { SQLiteReachOutSpeaker } from './reachOutDelivery.js';
import { SQLiteReachOutReports, reachOutBodyFacts } from './reachOutReports.js';
import { configuredDatabasePath } from './sqliteStore.js';

/**
 * Entry of the activity loop (Syzygy ADR-0002 step 3): its own process, so the API,
 * chat and voice never wait for it. It does nothing but keep its lease while
 * `SHANNON_AUTONOMY_ENABLED` is not `true`, while the owner has paused her, or while
 * no dedicated model credential is configured.
 *
 * She paces her own day in sessions (`SHANNON_AUTONOMY_PACING`, default `sessions`; `cycles` restores the fixed cycles).
 */
const databasePath = configuredDatabasePath();
const now = () => new Date().toISOString();
const store = new SQLiteAutonomyStore(databasePath);
const config = configuredAutonomy(process.env, { databasePath });
const announcer = new SQLiteAutonomyAnnouncer(databasePath);
// The same zone as the initiative loop, so both share one message slot per day.
const showing = new SQLiteStudyShowing(databasePath);
// Looking at the room in her own time (stage 2). This process opens the look row and reads its outcome;
// the body's answer, and the frame, go to the API process. SHANNON_AUTONOMY_MAX_ROOM_LOOKS=0 switches it off.
const bodyStore = new SQLiteBodyStore(databasePath);
const lookStore = new SQLiteBodyLookStore(databasePath);
const lookHand = new SQLiteBodyLookActivityStore(databasePath);
const looks = new ActivityRoomLooks({
  looks: lookStore, hand: lookHand, config: configuredBodyLook(process.env), ingestEnabled: bodyIngestEnabled(process.env),
  cameraDevices: scopeKey => bodyStore.devicesWithFlag(scopeKey, 'camera'), now, dayKey: ownerDay,
});
// Speaking up on her own (話しかける). Her message takes the initiative path; who is around her body decides how guarded its wording is.
// SHANNON_AUTONOMY_MAX_REACH_OUTS=0 switches it off.
const reachOuts = new SQLiteReachOutSpeaker(databasePath, (scopeKey, at) => bodyIngestEnabled(process.env)
  && bodyStore.othersPresent(scopeKey, at, BODY_LIMITS.audienceFreshMilliseconds, BODY_LIMITS.audienceEventWindowMilliseconds));
// After a message of hers she stays with it for a short while (SHANNON_AUTONOMY_REACH_OUT_WAIT_SECONDS): what her body reported about
// showing it and what the server knows of the body are read here as closed facts. SHANNON_AUTONOMY_MAX_FOLLOW_UPS=0 switches all of it off.
const reachOutReports = new SQLiteReachOutReports(databasePath);
const observer = {
  // A report of one of the owner's apps (her message said through his earphones) is read whatever the body switch says.
  delivery: (scopeKey: string, initiativeId: string) => (bodyIngestEnabled(process.env) || reachOutReports.deliverySurface(scopeKey, initiativeId)
    ? reachOutReports.delivery(scopeKey, initiativeId) : null),
  surface: (scopeKey: string, initiativeId: string) => reachOutReports.deliverySurface(scopeKey, initiativeId),
  body: (scopeKey: string, at: string) => (bodyIngestEnabled(process.env)
    ? reachOutBodyFacts(reachOutReports, bodyStore, scopeKey, at, { freshMilliseconds: BODY_LIMITS.audienceFreshMilliseconds, eventWindowMilliseconds: BODY_LIMITS.audienceEventWindowMilliseconds })
    : { windowVisible: false, owner: 'unknown' as const, others: false }),
};
// The owner's upcoming items: calendar snapshots, promises with a due time, and the task snapshot the API process keeps. No Voyager credential here.
const ownerState = sqliteOwnerSnapshot(databasePath);
const ownerUpcoming = configuredOwnerUpcoming(process.env, databasePath, { snapshot: ownerState.read, now });
const service = new ShannonAutonomyService({
  store, config, now, announcer, roomLooks: (scopeKey, at) => looks.counts(scopeKey, at),
  reachOuts: (scopeKey, at) => ({ today: reachOuts.sentOn(scopeKey, autonomyDayKey(at, config)), maximumPerDay: config.maximumReachOutsPerDay }),
  reachOutFollowUps: (scopeKey, at) => ({ today: reachOuts.followUpsOn(scopeKey, autonomyDayKey(at, config)), maximumPerDay: config.maximumReachOutFollowUpsPerDay }),
});
// Read-only Notion, only when the owner connected it; without a token the loop never plans a Notion step.
const notion = notionLoopReader(configuredNotionSource(process.env, { log: line => console.log(line) }));
const loopConfig = configuredAutonomyLoop(process.env);
// What she may see of the owner's in her own time (owner decision 2026-10-02, ADR-0003): one bounded block, read through the
// conversation's memory entry points. SHANNON_AUTONOMY_OWNER_CONTEXT=off opens none of it and every prompt is what it was.
const ownerContext = loopConfig.ownerContext
  ? configuredOwnerContext(databasePath, { now, characters: loopConfig.ownerContextCharacters, timeZone: config.timeZone }) : null;
const loop = new ShannonAutonomyLoop({
  store, service, config, loop: loopConfig, model: configuredAutonomyTextModel(process.env),
  reader: new BoundedPublicReader({
    maximumBytes: boundedInteger(process.env.SHANNON_AUTONOMY_READ_MAX_BYTES, 10_000, 5_000_000, 1_500_000),
    timeoutMilliseconds: boundedInteger(process.env.SHANNON_AUTONOMY_READ_TIMEOUT_MS, 1_000, 60_000, 10_000),
  }),
  showing, now, looks, ...(notion ? { notion } : {}),
  reachOuts, upcoming: { lines: (scopeKey, at, present) => ownerUpcoming.upcoming.loopLines(scopeKey, at, present) }, observer,
  ...(ownerContext ? { ownerContext: ownerContext.context } : {}),
});
const pollMilliseconds = boundedInteger(process.env.SHANNON_AUTONOMY_POLL_SECONDS, 5, 3_600, 60) * 1_000;
const once = process.argv.includes('--once');
const shutdown = new AbortController();
let stopping = false;
const requestStop = () => { stopping = true; shutdown.abort(); };
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);

console.log(`Shannon autonomy worker started (${loop.workerId}, ${loop.readiness()})`);
let last = '';
try {
  do {
    let tick: string;
    try {
      tick = await loop.tick(shutdown.signal);
    } catch (error) {
      tick = `failed:${error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/giu, '_').slice(0, 80) : 'UNKNOWN'}`;
    }
    // Content-free: only the state of the loop is logged, and only when it changes.
    if (tick !== last && tick !== 'stepped') console.log(`Shannon autonomy loop: ${tick}`);
    last = tick;
    if (once) break;
    try {
      await delay(tick === 'stepped' || tick === 'cycle-ended' ? 2_000 : pollMilliseconds, undefined, { signal: shutdown.signal });
    } catch (error) {
      if (!stopping) throw error;
    }
  } while (!stopping);
} finally {
  try { loop.release(); } catch { /* the lease runs out by itself */ }
  ownerContext?.close();
  ownerUpcoming.close();
  ownerState.close();
  reachOuts.close();
  reachOutReports.close();
  lookHand.close();
  lookStore.close();
  bodyStore.close();
  showing.close();
  announcer.close();
  store.close();
}

function boundedInteger(value: string | undefined, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return value?.trim() && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
