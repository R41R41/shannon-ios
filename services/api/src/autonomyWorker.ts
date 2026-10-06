import { setTimeout as delay } from 'node:timers/promises';
import { aetherStudyScope, configuredAetherAccess } from './integrations/aether/aetherAccess.js';
import { SQLiteAutonomyAnnouncer } from './autonomyAnnouncer.js';
import { configuredAwakeClock } from './autonomyAwakeClock.js';
import { moodHistoryRecording } from './contracts/moodHistoryContract.js';
import { autonomyDayKey, configuredAutonomy } from './autonomyBudget.js';
import { ShannonAutonomyLoop } from './autonomyLoop.js';
import { configuredAutonomyLoop } from './autonomyLoopConfig.js';
import { AutonomyToolResults } from './autonomyLoopToolStep.js';
import { configuredOwnerContext } from './autonomyOwnerContextWiring.js';
import { BoundedPublicReader } from './autonomyReader.js';
import { ShannonAutonomyService } from './autonomyService.js';
import { SQLiteStudyShowing } from './autonomyShowing.js';
import { SQLiteAutonomyStore } from './autonomyStore.js';
import { configuredAutonomyTextModel } from './autonomyTextModel.js';
import { BODY_LIMITS, bodyIngestEnabled } from './contracts/bodyContract.js';
import { ActivityRoomLooks } from './bodyLookActivity.js';
import { SQLiteBodyLookActivityStore } from './bodyLookActivityStore.js';
import { configuredBodyLook } from './contracts/bodyLookContract.js';
import { SQLiteBodyLookStore } from './bodyLookStore.js';
import { SQLiteBodyStore } from './bodyStore.js';
import { ownerDay } from './companionPresence.js';
import { notionLoopReader } from './integrations/notion/notionLoopReader.js';
import { configuredNotionSource } from './integrations/notion/notionSource.js';
import { configuredOwnerUpcoming, sqliteOwnerSnapshot } from './ownerUpcomingWiring.js';
import { SQLiteReachOutSpeaker } from './reachOutDelivery.js';
import { callGateContext } from './autonomyLoopPhoneStep.js';
import { IncomingCallRequests, incomingCallMinimumIntervalMilliseconds, incomingCallsConfigured } from './incomingCallRequests.js';
import { SQLiteIncomingCallStore } from './incomingCallStore.js';
import { SQLitePrivateListeningStore } from './privateListeningStore.js';
import { SQLiteReachOutClaims } from './reachOutClaims.js';
import { SQLiteReachOutReports, reachOutBodyFacts } from './reachOutReports.js';
import { ownToolsEnabled } from './shannonTools.js';
import { configuredDatabasePath } from './sqliteStore.js';
import { configuredPredictionShadow } from './predictionShadow.js';
import { configuredDecisionTraces } from './mind/inhibition/decisionTraces.js';
import { configuredPredictionLedger } from './mind/learning/predictionLedger.js';
import { ledgerPredictionTap, presenceOf } from './mind/learning/predictionLedgerTaps.js';

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
const incomingCalls = new SQLiteIncomingCallStore(databasePath);
// Phoning his iPhone is her own step (docs/incoming-call-contract.md). This process asks for the call and reads what became of
// it; the API process rings. It reads no key for Apple's push service. SHANNON_INCOMING_CALLS=off switches it off.
const reachOutClaims = new SQLiteReachOutClaims(databasePath);
const privateListening = new SQLitePrivateListeningStore(databasePath);
const phone = new IncomingCallRequests({
  store: incomingCalls, claims: reachOutClaims, listeners: (scopeKey, at) => privateListening.listeners(scopeKey, at),
  bodyVisible: (scopeKey, at) => bodyIngestEnabled(process.env) && reachOutReports.windowVisible(scopeKey, at),
  serverReady: incomingCallsConfigured(process.env), minimumIntervalMilliseconds: incomingCallMinimumIntervalMilliseconds(process.env),
});
const observer = {
  // A report of one of the owner's apps (her message said through his earphones) is read whatever the body switch says.
  delivery: (scopeKey: string, initiativeId: string) => (bodyIngestEnabled(process.env) || reachOutReports.deliverySurface(scopeKey, initiativeId)
    ? reachOutReports.delivery(scopeKey, initiativeId) : null),
  surface: (scopeKey: string, initiativeId: string) => reachOutReports.deliverySurface(scopeKey, initiativeId),
  // The call the API process placed with her message, when it rang his iPhone: only what became of it.
  call: (scopeKey: string, initiativeId: string) => incomingCalls.outcome(scopeKey, initiativeId),
  body: (scopeKey: string, at: string) => (bodyIngestEnabled(process.env)
    ? reachOutBodyFacts(reachOutReports, bodyStore, scopeKey, at, { freshMilliseconds: BODY_LIMITS.audienceFreshMilliseconds, eventWindowMilliseconds: BODY_LIMITS.audienceEventWindowMilliseconds })
    : { windowVisible: false, owner: 'unknown' as const, others: false }),
};
// The owner's upcoming items: calendar snapshots, promises with a due time, and the task snapshot the API process keeps. No Voyager credential here.
const ownerState = sqliteOwnerSnapshot(databasePath);
const ownerUpcoming = configuredOwnerUpcoming(process.env, databasePath, { snapshot: ownerState.read, now });
const loopConfig = configuredAutonomyLoop(process.env);
const service = new ShannonAutonomyService({
  store, config, now, announcer, roomLooks: (scopeKey, at) => looks.counts(scopeKey, at),
  reachOuts: (scopeKey, at) => ({ today: reachOuts.sentOn(scopeKey, autonomyDayKey(at, config)), maximumPerDay: config.maximumReachOutsPerDay }),
  reachOutFollowUps: (scopeKey, at) => ({ today: reachOuts.followUpsOn(scopeKey, autonomyDayKey(at, config)), maximumPerDay: config.maximumReachOutFollowUpsPerDay }),
  calls: (scopeKey, at) => callGateContext(phone, scopeKey, at),
  // Her study's text in Aether when it is configured (Syzygy ADR-0007); the proposal inbox is the conversation's, never her own time's.
  // The owner's documents only while SHANNON_AUTONOMY_OWNER_DOCUMENTS=on (owner decision 2026-10-06, ADR-0007).
  aether: { access: configuredAetherAccess(process.env), studyScopeKey: aetherStudyScope(process.env), ownerDocuments: loopConfig.ownerDocuments },
});
// Read-only Notion, only when the owner connected it; without a token the loop never plans a Notion step.
const notion = notionLoopReader(configuredNotionSource(process.env, { log: line => console.log(line) }));
// What she may see of the owner's in her own time (owner decision 2026-10-02, ADR-0003): one bounded block, read through the
// conversation's memory entry points. SHANNON_AUTONOMY_OWNER_CONTEXT=off opens none of it and every prompt is what it was.
const ownerContext = loopConfig.ownerContext
  ? configuredOwnerContext(databasePath, { now, characters: loopConfig.ownerContextCharacters, timeZone: config.timeZone }) : null;
// A step of her own is time she is awake: her emotional clock runs through it, and through nothing else of the loop.
// What that write stores may add a point to her mood history (SHANNON_MOOD_HISTORY); the loop is handed nothing of it.
// Syzygy ADR-0006 stage 1 (影): what followed a message of hers, and each advance of the awake clock, is handed to the prediction
// shadow. It reads `companion_states` for closeness and the days they talked, writes only its own tables (once the API has created
// them), and hands the loop nothing; the loop and the clock get one function each, never the shadow. SHANNON_PREDICTION_SHADOW=off opens nothing.
const prediction = configuredPredictionShadow(process.env, databasePath);
const shadow = prediction?.shadow;
const awakeClock = configuredAwakeClock(databasePath, {
  now, moodHistory: moodHistoryRecording(process.env), ...(shadow ? { awake: (scopeKey: string, at: string) => shadow.awake(scopeKey, at) } : {}),
});
// Syzygy ADR-0008 stage 1: one content-free trace per thought of hers. Its own connection writes only `shannon_decision_traces` (once
// the API has created it); the loop is handed one function. SHANNON_DECISION_TRACES=off opens nothing.
const decisionTraces = configuredDecisionTraces(process.env, databasePath);
// Syzygy ADR-0008 stage 1: the prediction ledger. Its own connection writes only `shannon_predictions` (once the API has created it);
// the loop is handed functions beside the shadow's (opened at a message, a call, a story shown, a page read; settled by what
// followed). SHANNON_PREDICTION_LEDGER=off (and SHANNON_PREDICTION_SHADOW=off) opens nothing and the loop's tap is the shadow's alone.
const predictionLedger = configuredPredictionLedger(process.env, databasePath);
const shadowTap = shadow ? { reachOut: (...args: Parameters<typeof shadow.reachOut>) => shadow.reachOut(...args) } : null;
const loop = new ShannonAutonomyLoop({
  store, service, config, loop: loopConfig, model: configuredAutonomyTextModel(process.env, undefined, line => console.log(line)),
  reader: new BoundedPublicReader({
    maximumBytes: boundedInteger(process.env.SHANNON_AUTONOMY_READ_MAX_BYTES, 10_000, 5_000_000, 1_500_000),
    timeoutMilliseconds: boundedInteger(process.env.SHANNON_AUTONOMY_READ_TIMEOUT_MS, 1_000, 60_000, 10_000),
  }),
  showing, now, looks, ...(notion ? { notion } : {}),
  reachOuts, phone, upcoming: { lines: (scopeKey, at, present) => ownerUpcoming.upcoming.loopLines(scopeKey, at, present) }, observer,
  ...(ownerContext ? { ownerContext: ownerContext.context } : {}),
  // Her tools over her study and her folder (owner decision 2026-10-05); SHANNON_OWN_TOOLS=off offers none and every prompt is what it was.
  ...(ownToolsEnabled() ? { toolResults: new AutonomyToolResults() } : {}),
  // With the choice ledger (SHANNON_CHOICE_LEDGER) each step the gate allowed is a choice of hers, with who was around (closed facts of her body).
  ...(shadowTap ? { prediction: predictionLedger ? ledgerPredictionTap(predictionLedger.ledger, shadowTap, predictionLedger.choices
    ? { ledger: predictionLedger.choices, presence: (scopeKey: string, at: string) => presenceOf(observer.body(scopeKey, at)) } : null) : shadowTap } : {}),
  ...(decisionTraces ? { trace: decisionTraces.traces.writer } : {}),
  // Content-free: a step kind and a closed reason code.
  log: line => console.log(`Shannon autonomy step: ${line.replace(/[^a-z0-9_:., -]/giu, '_').slice(0, 300)}`),
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
    if (tick === 'stepped' || tick === 'cycle-ended') awakeClock.observe(loopConfig.scopeKey);
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
  awakeClock.close();
  prediction?.close();
  decisionTraces?.close();
  predictionLedger?.close();
  ownerContext?.close();
  ownerUpcoming.close();
  ownerState.close();
  reachOuts.close();
  reachOutReports.close();
  incomingCalls.close();
  reachOutClaims.close();
  privateListening.close();
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
