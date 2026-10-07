import { createServer } from 'node:http';
import { handleDeviceManagement, handlePushRegistration } from './infra/auth/serverDeviceRoutes.js';
import { bindScope, consumeDeviceAllowance, parseHost, parsePort, readJson, sendJson, VoiceRequestAllowances } from './infra/http/serverHttp.js';
import { bearerAuthorized, configuredApiToken, configuredAuthMode } from './infra/auth/apiAuth.js';
import { handleVoiceVisionSnapshot } from './surfaces/voice/serverVoiceVisionRoute.js';
import { createPairingRoute } from './infra/auth/serverPairingRoute.js';
import { createConfiguredVoiceVisionGateway } from './surfaces/voice/voiceVision.js';
import { createGeminiSpeechRoute } from './surfaces/voice/serverGeminiSpeechRoute.js';
import { createGeminiLiveRoute } from './surfaces/voice/serverGeminiLiveRoute.js';
import { createLiveVoiceStreamRoute } from './surfaces/voice/serverLiveVoiceStreamRoute.js';
import { createLocalApiKernel } from './infra/http/apiKernel.js';
import { createConfiguredTurnMemoryRecall } from './mind/recall/turnMemoryRecall.js';
import { DurableBackgroundDispatcher } from './mind/sleep/backgroundUpdates.js';
import { startToolTraceSweep } from './mind/tools/shannonToolTraceSweep.js';
import { createConfiguredChatModel } from './infra/models/chatModel.js';
import { configuredVoiceDecision, startRewardMood } from './wiring/cognitionLedgerWiring.js';
import { readToolPorts, skillRoutingParts } from './wiring/skillRoutingWiring.js';
import { configuredTurnRouting } from './wiring/turnRoutingWiring.js';
import { configuredWithheldActions, gateRefusals } from './wiring/withheldWiring.js';
import { configuredSonnet, tieredChatModel } from './wiring/sonnetWiring.js';
import { configuredSkillMemory, skillTurnPorts } from './wiring/skillMemoryWiring.js';
import { configuredTreeRecall } from './wiring/treeRecallWiring.js';
import { storyReacted, toolCallChoice, touchLedger } from './wiring/cognitionLedgerTaps.js';
import { createValuesRoute, isValuesPath, ownerValueRecorder } from './infra/http/learningRoutes.js';
import { configuredAuthPepper, SQLiteDeviceAuthStore } from './infra/auth/deviceAuth.js';
import { configuredDatabasePath, SQLiteShannonStore } from './infra/sqlite/sqliteStore.js';
import { ShannonMemoryService } from './mind/memory/memoryService.js';
import { SQLiteWorldStore } from './integrations/world/store/worldStore.js';
import { SQLiteInitiativeStore } from './surfaces/outreach/store/initiativeStore.js';
import { FileAetherContextReader } from './integrations/aether/aetherContext.js';
import { configuredNotionSource } from './integrations/notion/notionSource.js';
import { configuredAetherPorts } from './integrations/aether/aetherAccess.js';
import { SQLitePushNotificationStore, type APNsEnvironment } from './surfaces/outreach/pushNotifications.js';
import { SQLiteAgentTaskStore } from './mind/action/agentTasks/agentTaskStore.js';
import { SQLiteTestFlightDeliveryStore } from './integrations/testflight/store/testflightDeliveryStore.js';
import { SQLiteDailyMindStore } from './mind/action/respond/dailyMind.js';
import {
  SQLiteOrganizeStore,
  createConfiguredOrganizeExtractor,
  createConfiguredVoyagerCatalog,
  createConfiguredVoyagerDestination,
} from './integrations/voyager/organize.js';
import { createConfiguredVoiceTranscriber } from './infra/models/voiceTranscription.js';
import { createVoiceTranscriptionRoute } from './surfaces/voice/transcriptionRoute.js';
import { createConfiguredPlatformBridgeRoute, handlePlatformBridgeRequest, isPlatformBridgePath } from './surfaces/platform/serverPlatformBridgeRoute.js';
import { SQLitePersonIdentityStore } from './mind/memory/store/personIdentity.js';
import { SQLitePeopleMemoryStore } from './mind/memory/store/peopleMemoryStore.js';
import { VOICE_CALL_MEMORY_PATH } from './infra/http/apiPeopleMemoryRoutes.js';
import { SQLiteCognitiveIntentStore } from './mind/action/respond/cognitiveIntent.js';
import { SQLiteConversationOrchestrationStore } from './mind/action/respond/store/conversationOrchestrationPersistence.js';
import { SQLiteAutonomyAnnouncer } from './mind/action/ownTime/autonomyAnnouncer.js';
import { configuredAutonomy } from './mind/inhibition/autonomyBudget.js';
import { SQLiteStudyShowing } from './mind/action/ownTime/autonomyShowing.js';
import { ShannonAutonomyService } from './mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from './mind/action/ownTime/store/autonomyStore.js';
import { BODY_CAPABILITIES_PATH, isBodyRoute } from './surfaces/body/apiBodyRoutes.js';
import { mayHaveDesktopBody, requestDeviceId } from './surfaces/body/desktopBodyIdentity.js';
import { bodyIngestEnabled } from './contracts/bodyContract.js';
import { SQLiteBodyStore } from './surfaces/body/store/bodyStore.js';
import { isFullBody } from './surfaces/body/bodyTouchOnly.js';
import { bodyLookRequestBytes, closeBodyLookStores, configuredAppLookOptions, configuredBodyLookOptions } from './wiring/bodyLookWiring.js';
import { closeBodyReactionStores, configuredBodyReactionOptions } from './wiring/bodyReactionWiring.js';
import { opsCommandsEnabled } from './contracts/opsCommandContract.js';
import { opsIngestEnabled } from './contracts/opsContract.js';
import { SQLiteOpsStore } from './infra/ops/store/opsStore.js';
import { createOpsRoute, isOpsPath } from './infra/ops/serverOpsRoutes.js';
import { dispatchWithChatSentences } from './surfaces/text/serverChatSentenceStream.js';
import { CALENDAR_UPCOMING_PATH, calendarRequestBytes } from './contracts/calendarContract.js';
import { HOST_STEP_CLAIM_PATH, closedSignal, hostStepRequestBytes } from './infra/http/apiAutonomyHostStepRoutes.js';
import { configuredOwnerUpcoming } from './wiring/ownerUpcomingWiring.js';
import { SQLiteReachOutSpeaker } from './surfaces/outreach/reachOutDelivery.js';
import { SQLiteReachOutReports } from './surfaces/outreach/store/reachOutReports.js';
import { SHANNON_NOW_PATH, shannonNowEnabled, shannonNowOwnerScope } from './contracts/shannonNowContract.js';
import { SQLiteShannonNowReader } from './mind/self/store/shannonNowReader.js';
import { createShannonNowRoute } from './infra/http/serverShannonNowRoute.js';
import { MOOD_HISTORY_PATH, moodHistoryEnabled } from './contracts/moodHistoryContract.js';
import { SQLiteMoodHistoryReader } from './mind/emotion/store/moodHistoryReader.js';
import { createMoodHistoryRoute } from './infra/http/serverMoodHistoryRoute.js';
import { createPrivateListeningRoute } from './surfaces/body/serverPrivateListeningRoute.js';
import { createIncomingCallRoute, type IncomingCallRoute } from './surfaces/outreach/serverIncomingCallRoute.js';
import { SQLiteOwnOutreach } from './surfaces/outreach/ownOutreach.js';
import { SQLiteOwnerCallFacts, ownerCallElsewhereEnabled } from './surfaces/voice/ownerCallElsewhere.js';
import { createServerSelfDiagnosis } from './infra/ops/serverSelfDiagnosis.js';
import { createMinecraftBodyWiring } from './wiring/serverMinecraftBodyWiring.js';
const now = () => new Date().toISOString();
const persistentStore = new SQLiteShannonStore({ path: configuredDatabasePath(), now });
const worldStore = new SQLiteWorldStore(configuredDatabasePath(), now);
const initiativeStore = new SQLiteInitiativeStore(configuredDatabasePath(), now);
const pushStore = new SQLitePushNotificationStore(configuredDatabasePath(), now);
const agentTaskStore = new SQLiteAgentTaskStore(configuredDatabasePath());
const testFlightDeliveryStore = new SQLiteTestFlightDeliveryStore(configuredDatabasePath());
const dailyMindStore = new SQLiteDailyMindStore(configuredDatabasePath(), now);
const organizeStore = new SQLiteOrganizeStore(configuredDatabasePath());
const voiceTranscriber = createConfiguredVoiceTranscriber(process.env, persistentStore);
const voiceVisionGateway = createConfiguredVoiceVisionGateway(process.env);
const personIdentityStore = new SQLitePersonIdentityStore(configuredDatabasePath());
const peopleMemoryStore = new SQLitePeopleMemoryStore(configuredDatabasePath());
const cognitiveIntentStore = new SQLiteCognitiveIntentStore(configuredDatabasePath());
const conversationOrchestrationStore = new SQLiteConversationOrchestrationStore(configuredDatabasePath());
const autonomyStore = new SQLiteAutonomyStore(configuredDatabasePath());
const autonomyAnnouncer = new SQLiteAutonomyAnnouncer(configuredDatabasePath());
const bodyStore = new SQLiteBodyStore(configuredDatabasePath());
// Bounded autonomy (ADR-0002): the gate, record, budget and stop switch. No activity loop runs in this process.
const autonomyConfig = configuredAutonomy(process.env, { databasePath: configuredDatabasePath() });
const ownerTurns = new SQLiteStudyShowing(configuredDatabasePath());
const minecraft = createMinecraftBodyWiring(process.env, configuredDatabasePath(), now); // Her Minecraft body (docs/minecraft-body-contract.md); unset SHANNON_MINECRAFT_BODY_JSON: none of it.
const aetherPorts = configuredAetherPorts(process.env, now); // Aether (Syzygy ADR-0007): unset SHANNON_AETHER_API_URL/_SHANNON_TOKEN, none of it.
// Syzygy ADR-0008 stage 1 (docs/cognition-ledger-contract.md): the prediction and choice ledgers; each null while switched off.
const predictionLedger = persistentStore.predictionLedger();
const choiceLedger = persistentStore.choiceLedger();
// Syzygy ADR-0008 §14: what a rule stopped, as closed facts (`shannon_withheld_actions`, created here). SHANNON_ADR8_STAGE2=off: none of it.
const withheldActions = configuredWithheldActions(process.env, { databasePath: configuredDatabasePath(), createsSchema: true, log: line => console.log(line) });
const autonomy = new ShannonAutonomyService({
  store: autonomyStore, config: autonomyConfig, now, ownerFirstActiveAfter: (scopeKey, after) => ownerTurns.ownerFirstActiveAfter(scopeKey, after),
  announcer: autonomyAnnouncer, agentTasks: agentTaskStore, defaultThread: scopeKey => persistentStore.threadId(scopeKey),
  defaultAgentHost: process.env.SHANNON_AGENT_DEFAULT_HOST?.trim() || null, minecraftBody: minecraft.requests, aether: aetherPorts,
  ...(predictionLedger ? { storyReacted: (scopeKey, pieceId, reaction, at) => storyReacted(predictionLedger, scopeKey, pieceId, reaction, at, choiceLedger) } : {}),
  ...(withheldActions ? { withheld: gateRefusals(withheldActions.withheld, autonomyConfig) } : {}) });
if (withheldActions) autonomy.tools.observeWithheld(withheldActions.withheld.sink, now);
// Syzygy ADR-0008 stage 2, step 5: the Sonnet tier, only with the Anthropic key and SHANNON_SONNET_ROUTING=on (default off); else luna as it was.
const sonnet = configuredSonnet(process.env, { usageStore: persistentStore, now });
// Syzygy ADR-0008 stage 2, step 6 (docs/skill-and-routing-contract.md): her skill memory, its tables created here. SHANNON_SKILLS=off: none of it.
const skillMemory = configuredSkillMemory(process.env, { databasePath: configuredDatabasePath(), createsSchema: true });
const skills = skillMemory ? skillTurnPorts(skillMemory.memory, scopeKey => persistentStore.snapshot(scopeKey)) : null;
// Step 8: tree recall over her notes, and with the owner alone her skills and her Aether folder. SHANNON_TREE_RECALL=off: recall as it was.
const treeRecall = configuredTreeRecall(process.env, { trace: persistentStore.decisionTraces()?.writer ?? null, skills: skillMemory?.memory ?? null,
  snapshot: scopeKey => persistentStore.snapshot(scopeKey), aether: { access: aetherPorts.access, covers: scopeKey => scopeKey === aetherPorts.studyScopeKey } });
// Syzygy ADR-0008 stage 2, step 4 (docs/skill-and-routing-contract.md): the tier policy's inputs, the verifier, and the learning of her
// conversation choices (and, step 6, the uses of her skills). SHANNON_ADR8_STAGE2=off: none of it.
const turnRouting = configuredTurnRouting(process.env, { databasePath: configuredDatabasePath(), choices: choiceLedger, usageStore: persistentStore, now, sonnet, skills });
// Her tool calls in conversations are choices too: stage 1's data only, unless stage 2's conversation reward scores them (owner answer I-3).
if (choiceLedger && !turnRouting?.routing.switches.conversationReward) autonomy.tools.observeChoices(toolCallChoice(choiceLedger), now);
// Step 7b (SHANNON_REWARD_MOOD): settled choices of hers move her mood once each, here only, within the hourly safeguard.
const rewardMood = startRewardMood(process.env, { choices: choiceLedger, shadow: persistentStore.predictionShadow(), state: persistentStore }, now);
// Her folder's operations (docs/host-folder-contract.md): stale ones are closed and results pruned also when no device or tool calls.
const stopFolderMaintenance = autonomy.folderOperations.startMaintenance();
// What her tools did in conversations (shannonToolTrace.ts): retention, forgetting and secrets reach stored traces too.
const stopToolTraceSweep = startToolTraceSweep(persistentStore, now);
const backgroundDispatcher = new DurableBackgroundDispatcher(persistentStore, persistentStore);
const voyagerCatalog = createConfiguredVoyagerCatalog(process.env);
// The owner's upcoming items (docs/calendar-contract.md): calendar snapshots from the apps, promises, dated Voyager tasks when configured.
const ownerUpcoming = configuredOwnerUpcoming(process.env, configuredDatabasePath(), { snapshot: scopeKey => persistentStore.snapshot(scopeKey), now, tasks: voyagerCatalog });
const reachOuts = new SQLiteReachOutSpeaker(configuredDatabasePath());
const reachOutReports = new SQLiteReachOutReports(configuredDatabasePath());
// Whether only the owner can hear one of his apps now, and which surface then says a message she started on her own
// (docs/private-listening-contract.md). SHANNON_PRIVATE_LISTENING=off refuses it; ..._REACH_OUTS=off keeps the state and stops the speaking.
const privateListeningRoute = createPrivateListeningRoute(process.env, configuredDatabasePath(), now, {
  reports: reachOutReports, reportsEnabled: autonomyConfig.maximumReachOutFollowUpsPerDay > 0,
  isBody: (scopeKey, deviceId) => isFullBody(bodyStore.capabilities(scopeKey, deviceId)),
  calls: () => incomingCallRoute?.calls ?? null,
});
// A call from her (docs/incoming-call-contract.md): when she chooses to phone him from her own activity, this process rings the owner's iPhone.
// SHANNON_INCOMING_CALLS=off, or no APNs key, and nothing is rung.
const incomingCallRoute: IncomingCallRoute | null = createIncomingCallRoute(process.env, configuredDatabasePath(), now, {
  isPaired: (scopeKey, deviceId) => deviceAuth?.listActiveDevicesForScope(scopeKey).some(device => device.deviceId === deviceId) ?? false,
});
// What she did on her own to reach the owner (ownOutreach.ts), and which app a device is (ownerCallElsewhere.ts): read-only connections.
const ownOutreach = new SQLiteOwnOutreach(configuredDatabasePath());
const ownerCallFacts = new SQLiteOwnerCallFacts(configuredDatabasePath());
const chatModel = tieredChatModel(createConfiguredChatModel(process.env, persistentStore), sonnet);
const voiceDecision = configuredVoiceDecision(process.env, persistentStore, persistentStore.decisionTraces()?.writer ?? null); // ADR-0008: traced; SHANNON_DECISION_TRACES=off: as it was.
// Read-only Notion (owner decision 2026-10-02). Without SHANNON_NOTION_TOKEN this is the "not connected" reader.
const notion = configuredNotionSource(process.env, { log: line => console.log(line) });
minecraft.connect({ stateStore: persistentStore, conversationStore: persistentStore, background: backgroundDispatcher, now, chatModel, peopleStore: peopleMemoryStore, conversation: { textTurn: input => kernel.textTurn(input) } });
// Syzygy ADR-0008 stage 2, step 3 (SHANNON_READ_TOOLS): her read tools over the same reads as the projections; off, none.
const readTools = readToolPorts(process.env, { notion, voyagerCatalog, upcoming: ownerUpcoming.upcoming, chatModel });
const kernel = createLocalApiKernel(now, {
  ownOutreach,
  chatModel,
  voiceDecision,
  stateStore: persistentStore,
  conversationStore: persistentStore,
  background: backgroundDispatcher,
  memoryStore: new ShannonMemoryService(
    persistentStore, persistentStore, now, persistentStore, worldStore,
    persistentStore, undefined, initiativeStore, dailyMindStore,
  ),
  knowledgeStore: persistentStore,
  initiativeInbox: initiativeStore,
  aetherContext: process.env.SHANNON_AETHER_CONTEXT_FILE?.trim()
    ? new FileAetherContextReader(process.env.SHANNON_AETHER_CONTEXT_FILE.trim())
    : undefined,
  aetherProposals: aetherPorts.proposals ?? undefined,
  agentTasks: agentTaskStore,
  testFlightDelivery: testFlightDeliveryStore,
  defaultAgentHost: process.env.SHANNON_AGENT_DEFAULT_HOST,
  dailyMind: dailyMindStore,
  organizeStore,
  organizeExtractor: createConfiguredOrganizeExtractor(process.env),
  voyagerCatalog, upcoming: ownerUpcoming.upcoming,
  voyagerDestination: createConfiguredVoyagerDestination(process.env),
  personIdentities: personIdentityStore,
  peopleMemory: peopleMemoryStore,
  worldSubscriptions: worldStore,
  cognitiveIntents: cognitiveIntentStore,
  conversationOrchestration: conversationOrchestrationStore,
  memoryRecall: createConfiguredTurnMemoryRecall(persistentStore, process.env, undefined, treeRecall),
  autonomy,
  // Her body (docs/body-contract.md). SHANNON_BODY_INGEST=off refuses its events and keeps them out of conversation.
  body: { store: bodyStore, ingestEnabled: bodyIngestEnabled(process.env), look: configuredBodyLookOptions(process.env, configuredDatabasePath(), persistentStore), appLook: configuredAppLookOptions(process.env, configuredDatabasePath(), persistentStore), reachOuts: (scopeKey, deviceId) => privateListeningRoute.reachOuts.bodyPresence(scopeKey, deviceId, reachOuts.pending(scopeKey)), reachOutReports: privateListeningRoute.bodyReports, reachOutReportsEnabled: autonomyConfig.maximumReachOutFollowUpsPerDay > 0, reactions: configuredBodyReactionOptions(process.env, configuredDatabasePath(), persistentStore, persistentStore.predictionShadow(), predictionLedger ? touchLedger(predictionLedger) : null),
    // The owner in a call on another of his apps: the presence field and the 409 for her body. SHANNON_OWNER_CALL_ELSEWHERE=off switches both off.
    ownerCalls: { enabled: ownerCallElsewhereEnabled(process.env), surface: (scopeKey, deviceId) => { try { return ownerCallFacts.surface(scopeKey, deviceId); } catch { return undefined; } },
      answered: (scopeKey, since) => { try { return ownerCallFacts.answered(scopeKey, since); } catch { return []; } } }, game: minecraft.game },
  notion, minecraftRequests: minecraft.requests,
  // Syzygy ADR-0008 stage 2 (docs/skill-and-routing-contract.md): the turn's Jev call. SHANNON_ADR8_STAGE2=off: none of it.
  ...skillRoutingParts(process.env, { trace: persistentStore.decisionTraces()?.writer ?? null }),
  ...(readTools ? { readTools } : {}), ...(turnRouting ? { turnRouting: turnRouting.routing } : {}), ...(skills ? { skills } : {}),
});
const platformBridge = createConfiguredPlatformBridgeRoute(process.env, persistentStore, persistentStore, backgroundDispatcher, now, chatModel, peopleMemoryStore, { conversation: { textTurn: input => kernel.textTurn(input) }, databasePath: configuredDatabasePath() });
// What this server resolved (docs/ops-contract.md, `server`): model names, persona hash, tools, revision, integrations as booleans. Owner only.
const selfDiagnosis = createServerSelfDiagnosis({ environment: process.env, startedAt: now(), chatModel, voiceDecision, dictation: voiceTranscriber, vision: voiceVisionGateway,
  voyagerCatalog, notion, platformBridge, autonomy: { enabled: autonomyConfig.enabled, preferences: scopeKey => autonomyStore.modelPreferences(scopeKey) } });
const port = parsePort(process.env.SHANNON_API_PORT);
const host = parseHost(process.env.SHANNON_API_HOST);
const authMode = configuredAuthMode(host);
const apiToken = authMode === 'fixed' ? configuredApiToken(host, process.env.SHANNON_API_TOKEN) : null;
const deviceAuth = authMode === 'paired'
  ? new SQLiteDeviceAuthStore({ path: configuredDatabasePath(), pepper: configuredAuthPepper() })
  : null;
const pairingRoute = createPairingRoute(authMode, deviceAuth);
// Operations console (docs/ops-contract.md). This store is held by the ops route only, never by the kernel.
const opsStore = new SQLiteOpsStore(configuredDatabasePath());
const opsRoute = createOpsRoute({
  store: opsStore, bridge: platformBridge?.configuration ?? null, ingestEnabled: () => opsIngestEnabled(process.env), now,
  commandsEnabled: () => opsCommandsEnabled(process.env),
  server: scopeKey => selfDiagnosis.forScope(scopeKey),
  device: authorization => deviceAuth ? deviceAuth.authenticate(authorization)
    : bearerAuthorized(authorization, apiToken) ? { scopeKey: null } : null,
});
// 「シャノンのいま」 for the owner's own app (docs/shannon-now-contract.md): a read-only connection, held by this route only.
const shannonNowReader = new SQLiteShannonNowReader(configuredDatabasePath());
const shannonNowRoute = createShannonNowRoute({
  reader: shannonNowReader, snapshot: scopeKey => (shannonNowReader.hasState(scopeKey) ? persistentStore.snapshot(scopeKey) : null), now,
  enabled: () => shannonNowEnabled(process.env), ownerScopeKey: shannonNowOwnerScope(process.env),
});
// Her mood over time for the owner's own apps (docs/mood-history-contract.md): a read-only connection, held by this route only.
const moodHistoryReader = new SQLiteMoodHistoryReader(configuredDatabasePath());
const moodHistoryRoute = createMoodHistoryRoute({
  reader: moodHistoryReader, now, enabled: () => moodHistoryEnabled(process.env), ownerScopeKey: shannonNowOwnerScope(process.env),
});
// Her value table for the owner (docs/cognition-ledger-contract.md): view, rollback and resume, each control in the activity record.
const valuesRoute = createValuesRoute({
  values: persistentStore.valueVersions(), calibration: scopeKey => predictionLedger?.calibration(scopeKey) ?? null, now, ownerScopeKey: shannonNowOwnerScope(process.env),
  choices: scopeKey => choiceLedger?.store.counts(scopeKey) ?? {}, record: ownerValueRecorder(autonomyStore.activity, autonomyConfig),
});
const deviceUsage = new Map<string, { startedAt: number; count: number }>();
const bodyUsage = new Map<string, { startedAt: number; count: number }>();
let activeChats = 0;
const voiceAllowances = new VoiceRequestAllowances();
const handleVoiceTranscription = createVoiceTranscriptionRoute({ transcriber: voiceTranscriber, allowances: voiceAllowances });
const geminiSpeechRoute = createGeminiSpeechRoute(
  process.env, persistentStore, (deviceId) => voiceAllowances.consumeSpeech(deviceId),
);
const geminiLiveRoute = createGeminiLiveRoute(
  process.env, kernel, (deviceId) => voiceAllowances.consumeControl(deviceId),
);
const liveVoiceStreamRoute = createLiveVoiceStreamRoute(
  kernel, (deviceId) => voiceAllowances.consumeControl(deviceId),
);
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'DELETE') {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    // DELETE exists for one path: a device taking its calendar snapshot away. It carries no body.
    const calendarDelete = request.method === 'DELETE';
    if ((calendarDelete && url.pathname !== CALENDAR_UPCOMING_PATH)
      || (request.method === 'PUT' && url.pathname !== BODY_CAPABILITIES_PATH && url.pathname !== CALENDAR_UPCOMING_PATH)) {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    if (url.pathname === '/v1/pair') {
      await pairingRoute(request, response);
      return;
    }
    if (url.pathname.startsWith('/v1/agent/host/')) {
      const hostToken = process.env.SHANNON_AGENT_HOST_TOKEN?.trim();
      if (!hostToken || hostToken.length < 32) {
        sendJson(response, 503, { error: 'AGENT_HOST_NOT_CONFIGURED' });
        return;
      }
      if (!bearerAuthorized(request.headers.authorization, hostToken)) {
        sendJson(response, 401, { error: 'AGENT_HOST_UNAUTHORIZED' });
        return;
      }
      const hostBody = request.method === 'POST' ? await readJson(request, 256 * 1024) : undefined;
      const result = await kernel.dispatch({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body: hostBody,
      });
      sendJson(response, result.status, result.body);
      return;
    }
    if (isOpsPath(url.pathname)) {
      if (!minecraft.refusesConsole(request, response, deviceAuth)) await opsRoute(url.pathname, request, response, url.searchParams); // Never her Minecraft body's token.
      return;
    }
    if (isPlatformBridgePath(url.pathname)) {
      await handlePlatformBridgeRequest(url.pathname, request, response, platformBridge);
      return;
    }
    const principal = deviceAuth ? deviceAuth.authenticate(request.headers.authorization) : null;
    const authorized = authMode === 'paired'
      ? principal !== null
      : bearerAuthorized(request.headers.authorization, apiToken);
    if (!authorized) {
      sendJson(response, 401, { error: 'PAIRING_REQUIRED', message: '接続コードでシャノンと接続してください。' });
      return;
    }
    if (await minecraft.serve(request, response, url.pathname, principal)) return; // Her Minecraft body's token reaches its own routes only.
    if (url.pathname === SHANNON_NOW_PATH) {
      shannonNowRoute(request, response, principal);
      return;
    }
    if (url.pathname === MOOD_HISTORY_PATH) {
      moodHistoryRoute(request, response, principal);
      return;
    }
    if (isValuesPath(url.pathname)) {
      await valuesRoute(request, response, principal, url.pathname);
      return;
    }
    if (
      url.pathname.startsWith('/v1/voice/realtime/')
      || url.pathname.startsWith('/v1/voice/identity')
      || url.pathname.startsWith('/v1/voice/live/')
    ) {
      sendJson(response, 410, {
        error: 'VOICE_PROVIDER_RETIRED',
        message: 'この音声方式は廃止されました。Gemini音声会話をご利用ください。',
      });
      return;
    }
    if (url.pathname === '/v1/voice/transcriptions') {
      await handleVoiceTranscription(request, response, principal);
      return;
    }
    if (url.pathname === '/v1/voice/gemini/speech' ||
        url.pathname === '/v1/voice/gemini/speech/stream' ||
        url.pathname === '/v1/voice/speech/stream') {
      await geminiSpeechRoute(
        request,
        response,
        principal,
        url.pathname.endsWith('/stream') ? 'stream' : 'unary',
      );
      return;
    }
    if (url.pathname === '/v1/voice/gemini/cascade/sessions') {
      await geminiLiveRoute(request, response, principal);
      return;
    }
    if (url.pathname === '/v1/voice/gemini/cascade/delegations/stream') {
      await liveVoiceStreamRoute(request, response, principal);
      return;
    }
    if (url.pathname === '/v1/voice/vision/snapshots') {
      await handleVoiceVisionSnapshot(request, response, principal, { gateway: voiceVisionGateway, kernel });
      return;
    }
    // One ended 「友人も一緒」 period carries up to sixty turns of text.
    const body = request.method !== 'GET' && !calendarDelete ? await readJson(request, url.pathname === VOICE_CALL_MEMORY_PATH ? 192 * 1024 : bodyLookRequestBytes(url.pathname) ?? calendarRequestBytes(url.pathname) ?? hostStepRequestBytes(url.pathname) ?? 64 * 1024) : undefined;
    const query = new URLSearchParams(url.searchParams);
    if (principal) query.set('scopeKey', principal.scopeKey);
    const deviceId = principal ? requestDeviceId(principal.deviceId, request.headers['x-shannon-body'], request.method, url.pathname, () => mayHaveDesktopBody({ isGame: minecraft.isGameDevice(principal), registration: () => bodyStore.capabilities(principal.scopeKey, principal.deviceId), appSurface: () => ownerCallFacts.surface(principal.scopeKey, principal.deviceId) })) : undefined; // Her desktop body in an app speaks for a device of its own (desktopBodyIdentity.ts).
    if (principal && deviceId !== principal.deviceId) response.setHeader('x-shannon-body', 'desktop'); // Says to the app that its body was heard as one.
    if (url.pathname === '/v1/devices') {
      handleDeviceManagement(request, response, body, principal, { deviceAuth, pushStore, revoked: deviceId => incomingCallRoute?.invalidateDevice(deviceId) });
      return;
    }
    if (url.pathname === '/v1/push/register') {
      handlePushRegistration(request, response, body, principal, { deviceAuth, pushStore });
      return;
    }
    if (privateListeningRoute.handle(request, response, url, body, principal)) return;
    if (incomingCallRoute?.handle(request, response, url, body, principal)) return;
    const isPairedChat = principal !== null && url.pathname === '/v1/chat';
    if (isPairedChat && !consumeDeviceAllowance(deviceUsage, principal.deviceId, 20)) {
      sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度話しかけてください。' });
      return;
    }
    if (isPairedChat && activeChats >= 2) { sendJson(response, 429, { error: 'BUSY', message: 'いま少し混み合っています。' }); return; }
    // The body polls presence and reports touches; this keeps one device from flooding either.
    if (deviceId && isBodyRoute(url.pathname) && !consumeDeviceAllowance(bodyUsage, deviceId, 120)) {
      sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many body requests; retry after a minute.' });
      return;
    }
    if (isPairedChat) activeChats += 1;
    try {
      const result = await dispatchWithChatSentences(kernel, response, {
        method: request.method,
        path: url.pathname,
        query,
        body: principal ? bindScope(body, principal.scopeKey) : body,
        ...(deviceId ? { deviceId } : {}),
        // A held long-poll claim of her folder's device ends when the device goes away, so no step is handed to nobody.
        ...(url.pathname === HOST_STEP_CLAIM_PATH ? { signal: closedSignal(response) } : {}),
      });
      const forBody = result && principal && deviceId && request.method === 'GET' && url.pathname === '/v1/initiatives'; // Her body is not handed a message an app says through his earphones.
      if (result) sendJson(response, result.status, forBody ? privateListeningRoute.reachOuts.bodyInitiatives(principal.scopeKey, deviceId, result.body) : result.body);
    } finally {
      if (isPairedChat) activeChats -= 1;
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'request body too large') {
      sendJson(response, 413, { error: 'REQUEST_TOO_LARGE', message: 'リクエストが大きすぎます。' });
      return;
    }
    if (error instanceof SyntaxError) {
      sendJson(response, 400, { error: 'INVALID_REQUEST', message: error.message });
      return;
    }
    console.error('Shannon request failed', error instanceof Error ? error.name : 'UnknownError');
    sendJson(response, 502, {
      error: 'MODEL_UNAVAILABLE',
      message: 'Shannonの言語モデルに接続できませんでした。',
    });
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.setTimeout(120_000);

server.listen(port, host, () => {
  incomingCallRoute?.start();
  console.log(`Shannon API listening on http://${host}:${port}`);
  console.log(`Shannon authentication: ${authMode}`);
  console.log('Shannon persistence ready: sqlite');
  console.log(selfDiagnosis.startupLine());
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    deviceAuth?.close();
    pushStore.close();
    worldStore.close();
    initiativeStore.close();
    agentTaskStore.close();
    testFlightDeliveryStore.close();
    dailyMindStore.close();
    organizeStore.close();
    turnRouting?.close();
    withheldActions?.close();
    skillMemory?.close();
    cognitiveIntentStore.close();
    conversationOrchestrationStore.close();
    peopleMemoryStore.close();
    stopFolderMaintenance();
    stopToolTraceSweep();
    rewardMood.stop();
    autonomyAnnouncer.close();
    bodyStore.close();
    minecraft.close(); platformBridge?.close?.();
    reachOuts.close();
    reachOutReports.close();
    privateListeningRoute.close();
    incomingCallRoute?.close();
    ownerTurns.close();
    ownerUpcoming.close();
    closeBodyLookStores(); closeBodyReactionStores();
    opsStore.close();
    shannonNowReader.close();
    moodHistoryReader.close();
    ownOutreach.close();
    ownerCallFacts.close();
    autonomyStore.close();
    persistentStore.close();
    process.exitCode = 0;
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
