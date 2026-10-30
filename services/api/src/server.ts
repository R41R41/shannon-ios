import { createApiRequestHandler } from './wiring/serverRequestHandler.js';
import { configuredMinecraftLifecycle } from './wiring/minecraftLifecycleWiring.js';
import { configuredSkillImporter } from './wiring/skillImportWiring.js';
import { standardSkillPack } from './infra/config/standardSkillPack.js';
import { configuredServerFca } from './wiring/serverFcaWiring.js';
import { configuredMinecraftFeelings } from './mind/emotion/minecraftFeeling.js';
import { createServer } from 'node:http';
import { configuredServerObserver } from './wiring/serverObserverWiring.js';
import { parseHost,parsePort,VoiceRequestAllowances } from './infra/http/serverHttp.js';
import { bearerAuthorized,configuredApiToken,configuredAuthMode } from './infra/auth/apiAuth.js';
import { createPairingRoute } from './infra/auth/serverPairingRoute.js';
import { createConfiguredVoiceVisionGateway } from './surfaces/voice/voiceVision.js';
import { createGeminiSpeechRoute } from './surfaces/voice/serverGeminiSpeechRoute.js';
import { createGeminiLiveRoute } from './surfaces/voice/serverGeminiLiveRoute.js';
import { createLiveVoiceStreamRoute } from './surfaces/voice/serverLiveVoiceStreamRoute.js';
import { configuredOperationOutcomes,createLocalApiKernel } from './wiring/apiKernelWiring.js';
import { createConfiguredTurnMemoryRecall } from './mind/recall/turnMemoryRecall.js';
import { DurableBackgroundDispatcher } from './mind/sleep/backgroundUpdates.js';
import { startToolTraceSweep } from './mind/tools/shannonToolTraceSweep.js';
import { createConfiguredChatModel } from './infra/models/chatModel.js';
import { configuredVoiceDecision,startRewardMood } from './wiring/cognitionLedgerWiring.js';
import { configuredJevChooser,readToolPorts,skillRoutingParts } from './wiring/skillRoutingWiring.js';
import { configuredStream } from './wiring/streamWiring.js';
import { configuredTurnRouting } from './wiring/turnRoutingWiring.js';
import { configuredWithheldActions,gateRefusals } from './wiring/withheldWiring.js';
import { closeReplySonnet,configuredSonnet,withReplySonnet } from './wiring/sonnetWiring.js';
import { createModelModeWiring } from './wiring/modelModeWiring.js';
import { configuredSkillMemory,skillTurnPorts } from './wiring/skillMemoryWiring.js';
import { noteCopyWrite } from './mind/memory/memoryPorts.js';
import { installSalt } from './wiring/installSalt.js';
import { configuredFeeling } from './wiring/feelingWiring.js';
import { configuredTreeRecall } from './wiring/treeRecallWiring.js';
import { storyReacted,toolCallChoice,touchLedger } from './wiring/cognitionLedgerTaps.js';
import { createValuesRoute,ownerValueRecorder } from './infra/http/learningRoutes.js';
import { createSkillsRoute,ownerSkillRecorder } from './infra/http/skillRoutes.js';
import { configuredAuthPepper,configuredPreviousAuthPepper,SQLiteDeviceAuthStore } from './infra/auth/deviceAuth.js';
import { configuredDatabasePath,SQLiteShannonStore } from './infra/sqlite/sqliteStore.js';
import { ShannonMemoryService } from './mind/memory/memoryService.js';
import { SQLiteWorldStore } from './integrations/world/store/worldStore.js';
import { SQLiteInitiativeStore } from './surfaces/outreach/store/initiativeStore.js';
import { FileAetherContextReader } from './integrations/aether/aetherContext.js';
import { configuredNotionSource } from './integrations/notion/notionSource.js';
import { configuredAetherPorts } from './integrations/aether/aetherAccess.js';
import { SQLitePushNotificationStore } from './surfaces/outreach/pushNotifications.js';
import { configuredServerStage5 } from './wiring/serverStage5Wiring.js';
import { SQLiteTestFlightDeliveryStore } from './integrations/testflight/store/testflightDeliveryStore.js';
import { SQLiteDailyMindStore } from './mind/action/respond/dailyMind.js';
import {
SQLiteOrganizeStore,createConfiguredOrganizeExtractor,createConfiguredVoyagerCatalog,
createConfiguredVoyagerDestination
} from './integrations/voyager/organize.js';
import { createConfiguredVoiceTranscriber } from './infra/models/voiceTranscription.js';
import { createVoiceTranscriptionRoute } from './surfaces/voice/transcriptionRoute.js';
import { configuredAddressedVoice,configuredListening,configuredListenRoute,createConfiguredPlatformBridgeRoute } from './wiring/platformBridgeWiring.js';
import { configuredMiniPoses } from './wiring/miniPoseWiring.js';
import { SQLitePersonIdentityStore } from './mind/memory/store/personIdentity.js';
import { SQLitePeopleMemoryStore } from './mind/memory/store/peopleMemoryStore.js';
import { SQLiteCognitiveIntentStore } from './mind/action/respond/cognitiveIntent.js';
import { SQLiteConversationOrchestrationStore } from './mind/action/respond/store/conversationOrchestrationPersistence.js';
import { SQLiteAutonomyAnnouncer } from './mind/action/ownTime/autonomyAnnouncer.js';
import { configuredAutonomy } from './mind/inhibition/autonomyBudget.js';
import { SQLiteStudyShowing } from './wiring/studyShowingWiring.js';
import { ShannonAutonomyService } from './mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from './wiring/autonomyStoreWiring.js';
import { BODY_LIMITS,bodyIngestEnabled } from './contracts/bodyContract.js';
import { SQLiteBodyStore } from './surfaces/body/store/bodyStore.js';
import { isFullBody } from './surfaces/body/bodyTouchOnly.js';
import { closeBodyLookStores,configuredAppLookOptions,configuredBodyLookOptions } from './wiring/bodyLookWiring.js';
import { closeBodyReactionStores,configuredBodyReactionOptions,configuredInnerNote } from './wiring/bodyReactionWiring.js';
import { opsCommandsEnabled } from './contracts/opsCommandContract.js';
import { opsIngestEnabled } from './contracts/opsContract.js';
import { SQLiteOpsStore } from './infra/ops/store/opsStore.js';
import { freshWorldSettingRecorder } from './wiring/freshWorldWiring.js';
import { createOpsRoute } from './infra/ops/serverOpsRoutes.js';
import { configuredOwnerUpcoming } from './wiring/ownerUpcomingWiring.js';
import { SQLiteReachOutSpeaker } from './surfaces/outreach/reachOutDelivery.js';
import { SQLiteReachOutReports } from './mind/attention/store/reachOutReports.js';
import { shannonNowEnabled,shannonNowOwnerScope } from './contracts/shannonNowContract.js';
import { SQLiteShannonNowReader } from './mind/self/store/shannonNowReader.js';
import { createShannonNowRoute } from './infra/http/serverShannonNowRoute.js';
import { moodHistoryEnabled } from './contracts/moodHistoryContract.js';
import { SQLiteMoodHistoryReader } from './mind/emotion/store/moodHistoryReader.js';
import { createMoodHistoryRoute } from './infra/http/serverMoodHistoryRoute.js';
import { createPrivateListeningRoute } from './wiring/serverPrivateListeningRoute.js';
import { createIncomingCallRoute,type IncomingCallRoute } from './wiring/serverIncomingCallRoute.js';
import { SQLiteOwnOutreach } from './surfaces/outreach/ownOutreach.js';
import { ownerCallElsewhereEnabled } from './mind/perception/perceptionPorts.js';
import { SQLiteOwnerCallFacts } from './mind/perception/store/ownerCallFacts.js';
import { createServerSelfDiagnosis } from './infra/ops/serverSelfDiagnosis.js';
import { configuredOpsServer } from './wiring/opsServerWiring.js';
import { createMinecraftBodyWiring } from './wiring/serverMinecraftBodyWiring.js';
import { configuredMind } from './wiring/mindWiring.js';
import { configuredActionRoutes } from './wiring/serverActionThreadsWiring.js';
import { memoryPortsOf } from './wiring/memoryOutboxWiring.js';
import { peopleFactReaders } from './wiring/peopleFactsWiring.js';
import { stage5MemoryStoreOptions } from './wiring/stage5MemoryWiring.js';
import { configuredDeviceActions } from './wiring/deviceActionWiring.js';
const now = () => new Date().toISOString();
// ADR-0008 stage 3: the outbox (F5; the worker writes it), compaction (F7), people facts and the inert trust
// ledger (F6), by switch.
const persistentStore = new SQLiteShannonStore({ path: configuredDatabasePath(), now, ...stage5MemoryStoreOptions(process.env) });
const peopleFacts = peopleFactReaders(persistentStore, now);
const memoryPorts = memoryPortsOf(persistentStore, now);
const worldStore = new SQLiteWorldStore(configuredDatabasePath(), now);
const initiativeStore = new SQLiteInitiativeStore(configuredDatabasePath(), now);
const pushStore = new SQLitePushNotificationStore(configuredDatabasePath(), now);
const stage5 = configuredServerStage5(process.env, {path:configuredDatabasePath(),store:persistentStore,ownerScope:shannonNowOwnerScope(process.env),now});
const agentTaskStore = stage5.tasks;
const testFlightDeliveryStore = new SQLiteTestFlightDeliveryStore(configuredDatabasePath());
const dailyMindStore = new SQLiteDailyMindStore(configuredDatabasePath(), now);
const organizeStore = new SQLiteOrganizeStore(configuredDatabasePath());
const voiceTranscriber = createConfiguredVoiceTranscriber(process.env, persistentStore);
const voiceVisionGateway = createConfiguredVoiceVisionGateway(process.env, persistentStore);
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
const haiku = createConfiguredChatModel(process.env, persistentStore), sonnet = configuredSonnet(process.env, { usageStore: persistentStore,
   now, webSearch: haiku.searchWeb?.bind(haiku) });
const modelModes = createModelModeWiring(process.env, { path: configuredDatabasePath(), ownerScope: shannonNowOwnerScope(process.env), haiku, sonnet });
const minecraft = createMinecraftBodyWiring(process.env, configuredDatabasePath());
const aetherPorts = configuredAetherPorts(process.env, now); // Aether (Syzygy ADR-0007): unset SHANNON_AETHER_API_URL/_SHANNON_TOKEN, none of it.
// Syzygy ADR-0008 stage 1 (docs/cognition-ledger-contract.md): the prediction and choice ledgers; each null while switched off.
const predictionLedger = persistentStore.predictionLedger();
const choiceLedger = persistentStore.choiceLedger();
// Syzygy ADR-0008 §14: what a rule stopped, as closed facts (`shannon_withheld_actions`, created here).
// SHANNON_ADR8_STAGE2=off: none of it.
const withheldActions = configuredWithheldActions(process.env, { databasePath: configuredDatabasePath(), createsSchema: true, log: line => console.log(line) });
const autonomy = new ShannonAutonomyService({
  store: autonomyStore, config: autonomyConfig, now, ownerFirstActiveAfter: (scopeKey, after) => ownerTurns.ownerFirstActiveAfter(scopeKey, after),
  announcer: autonomyAnnouncer, agentTasks: agentTaskStore, defaultThread: scopeKey => persistentStore.threadId(scopeKey),
  defaultAgentHost: process.env.SHANNON_AGENT_DEFAULT_HOST?.trim() || null, aether: aetherPorts,
  ...(predictionLedger ? { storyReacted: (scopeKey, pieceId, reaction, at) => storyReacted(predictionLedger, scopeKey, pieceId, reaction,
     at, choiceLedger) } : {}),
  ...(withheldActions ? { withheld: gateRefusals(withheldActions.withheld, autonomyConfig) } : {}) });
if (withheldActions) autonomy.tools.observeWithheld(withheldActions.withheld.sink, now);
// Syzygy ADR-0008 stage 2, step 6 (docs/skill-and-routing-contract.md): her skill memory, its tables created
// here. SHANNON_SKILLS=off: none of it.
const skillMemory = configuredSkillMemory(process.env, { databasePath: configuredDatabasePath(), createsSchema: true });
const skills = skillMemory ? skillTurnPorts(skillMemory.memory, scopeKey => persistentStore.snapshot(scopeKey), persistentStore) : null;
if (skillMemory) autonomy.tools.observeCopyWrites((scopeKey, documentId, write) => noteCopyWrite(skillMemory.memory, scopeKey, documentId,
   write, now())); // Her copy edits are hers (M2).
// Step 8: tree recall over her notes, and with the owner alone her skills and her Aether folder.
// SHANNON_TREE_RECALL=off: recall as it was.
const traceSalt = installSalt(configuredDatabasePath()); // The salt of Jev's input digests in the traces (never in the repository).
const treeRecall = configuredTreeRecall(process.env, { trace: persistentStore.decisionTraces()?.writer ?? null, salt: traceSalt, skills:
   skillMemory?.memory ?? null,
  snapshot: scopeKey => persistentStore.snapshot(scopeKey), aether: { access: aetherPorts.access, covers:
     scopeKey => scopeKey === aetherPorts.studyScopeKey } });
// ADR-0008 stage 2, step 4 (docs/skill-and-routing-contract.md): tier inputs, verifier, learning of her choices
// and skill uses. STAGE2=off: none.
const turnRouting = configuredTurnRouting(process.env, { databasePath: configuredDatabasePath(), choices: choiceLedger, usageStore:
   persistentStore, now, sonnet, skills, feedback:stage5.feedback?.ports });
// Her tool calls in conversations are choices too: stage 1's data only, unless stage 2's conversation reward
// scores them (owner answer I-3).
if (choiceLedger && !turnRouting?.routing.switches.conversationReward) autonomy.tools.observeChoices(toolCallChoice(choiceLedger), now);
// Step 7b (SHANNON_REWARD_MOOD): settled choices of hers move her mood once each, here only, within the hourly safeguard.
const rewardMood = startRewardMood(process.env, { choices: choiceLedger, shadow: persistentStore.predictionShadow(), state: persistentStore }, now);
// Her folder's operations (docs/host-folder-contract.md): stale ones are closed and results pruned also when no
// device or tool calls.
const stopFolderMaintenance = autonomy.folderOperations.startMaintenance();
const stopToolTraceSweep = startToolTraceSweep(persistentStore, now);
const backgroundDispatcher = new DurableBackgroundDispatcher(persistentStore, persistentStore);
const voyagerCatalog = createConfiguredVoyagerCatalog(process.env);
// The owner's upcoming items (docs/calendar-contract.md): calendar snapshots from the apps, promises, dated
// Voyager tasks when configured.
const ownerUpcoming = configuredOwnerUpcoming(process.env, configuredDatabasePath(), { snapshot: scopeKey => persistentStore.snapshot(
  scopeKey), now, tasks: voyagerCatalog });
const reachOuts = new SQLiteReachOutSpeaker(configuredDatabasePath());
const reachOutReports = new SQLiteReachOutReports(configuredDatabasePath());
// Who can hear his apps and which surface says her own messages (docs/private-listening-contract.md).
// SHANNON_PRIVATE_LISTENING=off refuses it.
const privateListeningRoute = createPrivateListeningRoute(process.env, configuredDatabasePath(), now, {
  reports: reachOutReports, reportsEnabled: autonomyConfig.maximumReachOutFollowUpsPerDay > 0,
  isBody: (scopeKey, deviceId) => isFullBody(bodyStore.capabilities(scopeKey, deviceId)),
  calls: () => incomingCallRoute?.calls ?? null,
});
// A call from her own time rings his iPhone (docs/incoming-call-contract.md); SHANNON_INCOMING_CALLS=off, or no
// APNs key, rings nothing.
const incomingCallRoute: IncomingCallRoute | null = createIncomingCallRoute(process.env, configuredDatabasePath(), now, {
  isPaired: (scopeKey, deviceId) => deviceAuth?.listActiveDevicesForScope(scopeKey).some(device => device.deviceId === deviceId) ?? false,
});
// What she did on her own to reach the owner (ownOutreach.ts), and which app a device is
// (ownerCallElsewhere.ts): read-only connections.
const ownOutreach = new SQLiteOwnOutreach(configuredDatabasePath());
const ownerCallFacts = new SQLiteOwnerCallFacts(configuredDatabasePath());
const chatModel = withReplySonnet(process.env, modelModes.chatModel, { timeZone: autonomyConfig.timeZone, now, usageStore: persistentStore, haiku });
const voiceDecision = configuredVoiceDecision(process.env, persistentStore, persistentStore.decisionTraces()?.writer ?? null);
   // ADR-0008: traced; SHANNON_DECISION_TRACES=off: as it was.
// Read-only Notion (owner decision 2026-10-02). Without SHANNON_NOTION_TOKEN this is the "not connected" reader.
const notion = configuredNotionSource(process.env, { log: line => console.log(line) });
minecraft.connect({ stateStore: persistentStore, conversationStore: persistentStore, background: backgroundDispatcher, now, chatModel:
   haiku, peopleStore: peopleMemoryStore, conversation: { textTurn: input => kernel.textTurn(input) }, memory: memoryPorts?.proposals ?? null, peopleFacts });
const readTools = readToolPorts(process.env, { notion, voyagerCatalog, upcoming: ownerUpcoming.upcoming, chatModel: haiku });
   // Read-tool helpers remain auxiliary regardless of primary mode.
// ADR-0008 stage 3: what every surface perceived, and the notices of promises and tasks (off: none).
// docs/mind-workspace-contract.md.
const mind = configuredMind(process.env, { databasePath: configuredDatabasePath(), now, ticking: true, timeZone: autonomyConfig.timeZone,
   log: line => console.log(line),
  notices: { ownerScopeKey: shannonNowOwnerScope(process.env), snapshot: scopeKey => persistentStore.snapshot(scopeKey), tasks:
     scopeKey => agentTaskStore.list(scopeKey) } });
const externalActions=configuredActionRoutes(mind?.actions ?? null,agentTaskStore,shannonNowOwnerScope(process.env),now,(
  )=>bodyStore.othersPresent(shannonNowOwnerScope(process.env),now(),BODY_LIMITS.audienceFreshMilliseconds,
    BODY_LIMITS.audienceEventWindowMilliseconds),async target=>{await fca?.stopActions(target);});
const aetherContext = process.env.SHANNON_AETHER_CONTEXT_FILE?.trim() ? new FileAetherContextReader(process.env.SHANNON_AETHER_CONTEXT_FILE.trim()) : undefined;
const deviceActions = configuredDeviceActions(process.env, configuredDatabasePath(), now, autonomy.tools, ownerUpcoming.upcoming);
const memoryRecall = createConfiguredTurnMemoryRecall(persistentStore, process.env, undefined, treeRecall);
const innerNote = configuredInnerNote(process.env, persistentStore, autonomyConfig.timeZone, now); // ADR-0012 stage 1; SHANNON_INNER_NOTE=off: null.
const feeling = configuredFeeling(process.env, { databasePath: configuredDatabasePath(), timeZone: autonomyConfig.timeZone, now, // ADR-0013 stage 1; off: null.
  trace: persistentStore.decisionTraces()?.writer ?? null, salt: traceSalt, conversation: persistentStore, usageStore: persistentStore,
  webSearch: haiku.searchWeb?.bind(haiku), state: scopeKey => persistentStore.snapshot(scopeKey) });
const operationOutcomes = configuredOperationOutcomes(configuredDatabasePath(), { env: process.env, usageStore: persistentStore, now, body: bodyStore });
const kernel = createLocalApiKernel(now, {
  conversationExtras: () => stage5.conversationExtras.ports, ownOutreach, fcaConversation: () => fca?.conversation ?? null, fcaVoice: () => fca?.voice ?? null,
  ...(stage5.feedback ? {feedback:stage5.feedback.ports} : {}), ...(stage5.capabilities ? {stage5Capabilities:stage5.capabilities} : {}),
  chatModel: feeling?.wrap(chatModel) ?? chatModel, // ADR-0013: strong feeling turns on Sonnet, only with its switch.
  auxiliaryChatModel: haiku,
  voiceDecision,
  stateStore: persistentStore,
  conversationStore: persistentStore,
  background: backgroundDispatcher,
  memoryStore: new ShannonMemoryService(
    persistentStore, persistentStore, now, persistentStore, worldStore,
    persistentStore, undefined, initiativeStore, dailyMindStore,
  ),
  knowledgeStore: persistentStore,
  initiativeInbox: privateListeningRoute.freshInbox(initiativeStore),
  aetherContext,
  aetherProposals: aetherPorts.proposals ?? undefined,
  agentTasks: agentTaskStore,
  testFlightDelivery: testFlightDeliveryStore,
  defaultAgentHost: process.env.SHANNON_AGENT_DEFAULT_HOST,
  dailyMind: dailyMindStore,
  organizeStore,
  organizeExtractor: createConfiguredOrganizeExtractor(process.env, persistentStore),
  voyagerCatalog, upcoming: ownerUpcoming.upcoming,
  voyagerDestination: createConfiguredVoyagerDestination(process.env),
  personIdentities: personIdentityStore,
  peopleMemory: peopleMemoryStore,
  ...(memoryPorts ? { memory: memoryPorts } : {}),
  worldSubscriptions: worldStore,
  cognitiveIntents: cognitiveIntentStore,
  conversationOrchestration: conversationOrchestrationStore, memoryRecall, ...(innerNote ? { innerNote: innerNote.port } : {}),
  ...(feeling ? { feeling: feeling.port } : {}), autonomy, ...(minecraft.live ? { minecraftLive: minecraft.live } : {}),
  // Her body (docs/body-contract.md). SHANNON_BODY_INGEST=off refuses its events and keeps them out of conversation.
  body: { fcaTouch: () => fca?.touch ?? null, store: bodyStore, ingestEnabled: bodyIngestEnabled(process.env), look:
     configuredBodyLookOptions(process.env, configuredDatabasePath(), persistentStore), appLook: configuredAppLookOptions(process.env,
        configuredDatabasePath(), persistentStore), reachOuts: (scopeKey, deviceId) => privateListeningRoute.reachOuts.bodyPresence(
          scopeKey, deviceId, reachOuts.pending(scopeKey)), reachOutReports: privateListeningRoute.bodyReports, reachOutReportsEnabled:
             autonomyConfig.maximumReachOutFollowUpsPerDay > 0, reactions: configuredBodyReactionOptions(process.env,
                configuredDatabasePath(), persistentStore, persistentStore.predictionShadow(), predictionLedger ? touchLedger(predictionLedger) : null),
    // The owner in a call on another of his apps: the presence field and the 409 for her body.
// SHANNON_OWNER_CALL_ELSEWHERE=off switches both off.
    ownerCalls: { enabled: ownerCallElsewhereEnabled(process.env), surface: (scopeKey, deviceId) => { try { return ownerCallFacts.surface(
      scopeKey, deviceId); } catch { return undefined; } },
      answered: (scopeKey, since) => { try { return ownerCallFacts.answered(scopeKey, since); } catch { return []; } } }, game: minecraft.game },
  notion, minecraftRequests: deviceActions.reports(), // Reminders, timers, events and music (docs/device-actions-contract.md).
  // Syzygy ADR-0008 stage 2 (docs/skill-and-routing-contract.md): the turn's Jev call. SHANNON_ADR8_STAGE2=off: none of it.
  ...skillRoutingParts(process.env, { trace: persistentStore.decisionTraces()?.writer ?? null, salt: traceSalt }),
  ...(readTools ? { readTools } : {}), ...(turnRouting ? { turnRouting: turnRouting.routing } : {}), ...(skills ? { skills } : {}),
  ...(mind ? { mind: mind.mind } : {}), operationOutcomes: operationOutcomes.read,
});
stage5.attach({reportVisible:taskId => fca?.reportCardVisible(taskId) ?? false,ownerAlone:scope => kernel.ownerAloneForFeedback(scope),
  presence:scope => kernel.ownerPresenceForFeedback(scope),actions:mind?.actions ?? null,autonomy,autonomyStore,config:autonomyConfig});
const listening = configuredListening(process.env, configuredDatabasePath()), bodyRunning = () => (fca?.minecraft?.voice?.state(
  ).running ?? null) !== null, addressed = configuredAddressedVoice(process.env, { trace: persistentStore.decisionTraces()?.writer ?? null,
     salt: traceSalt, bodyRunning }), platformBridge = createConfiguredPlatformBridgeRoute(process.env, persistentStore, persistentStore,
        backgroundDispatcher, now, haiku, peopleMemoryStore, { conversation: { textTurn: input => kernel.textTurn(input), seatedVoiceTurn: (
          turn, observer) => kernel.seatedVoiceTurn(turn, observer) }, databasePath: configuredDatabasePath(), voiceMinecraft: (
            ) => fca?.minecraft?.voice ?? null, listening }, memoryPorts?.proposals ?? null, peopleFacts, addressed.judge), serveListen =
               configuredListenRoute(listening, addressed.judge, bodyRunning);
// The mini Shannon's pictures (owner 2026-10-28): `/v1/mini/*` for the residents.
const miniPoses = configuredMiniPoses(process.env, { databasePath: configuredDatabasePath(), ownerScope: shannonNowOwnerScope(process.env),
   trace: persistentStore.decisionTraces()?.writer ?? null, salt: traceSalt });
// What this server resolved (docs/ops-contract.md, `server`): model names, persona hash, tools, revision,
// integrations as booleans. Owner only.
const selfDiagnosis = createServerSelfDiagnosis({ environment: process.env, startedAt: now(), chatModel, voiceDecision, dictation:
   voiceTranscriber, vision: voiceVisionGateway, voyagerCatalog, notion, platformBridge, autonomy: { enabled: autonomyConfig.enabled,
      preferences: scopeKey => autonomyStore.modelPreferences(scopeKey) } });
const port = parsePort(process.env.SHANNON_API_PORT);
const host = parseHost(process.env.SHANNON_API_HOST);
const authMode = configuredAuthMode(host);
const apiToken = authMode === 'fixed' ? configuredApiToken(host, process.env.SHANNON_API_TOKEN) : null;
const deviceAuth = authMode === 'paired'
  ? new SQLiteDeviceAuthStore({ path: configuredDatabasePath(), pepper: configuredAuthPepper(), previousPepper: configuredPreviousAuthPepper() })
  : null;
const pairingRoute = createPairingRoute(authMode, deviceAuth);
const signalObserver = configuredServerObserver(configuredDatabasePath(),kernel,shannonNowOwnerScope(process.env),principal=>minecraft.isGameDevice(principal));
// Operations console (docs/ops-contract.md): the store is the ops route's only; opsServer composes the owner's server view.
const opsStore = new SQLiteOpsStore(configuredDatabasePath());
const opsServer = configuredOpsServer({ environment: process.env, databasePath: configuredDatabasePath(), ownerScope: shannonNowOwnerScope(process.env),
  ownTime: autonomyConfig, describe: scope => selfDiagnosis.forScope(scope), mind: () => mind, outbox: persistentStore.memoryOutbox(), now });
const opsRoute = createOpsRoute({
  store: opsStore, bridge: platformBridge?.configuration ?? null, ingestEnabled: () => opsIngestEnabled(process.env), now,
  commandsEnabled: () => opsCommandsEnabled(process.env), minecraftLifecycle: () => lifecycle?.ops ?? null,
  server: scopeKey => opsServer.view(scopeKey),
  recordSetting: freshWorldSettingRecorder(autonomyStore.activity, autonomyConfig),
  device: authorization => deviceAuth ? deviceAuth.authenticate(authorization)
    : bearerAuthorized(authorization, apiToken) ? { scopeKey: null } : null,
});
// 「シャノンのいま」 for the owner's own app (docs/shannon-now-contract.md): a read-only connection, held by this route only.
const shannonNowReader = new SQLiteShannonNowReader(configuredDatabasePath());
const shannonNowRoute = createShannonNowRoute({
  reader: shannonNowReader, snapshot: scopeKey => (shannonNowReader.hasState(scopeKey) ? persistentStore.snapshot(scopeKey) : null), now,
  enabled: () => shannonNowEnabled(process.env), ownerScopeKey: shannonNowOwnerScope(process.env),
});
const moodHistoryReader = new SQLiteMoodHistoryReader(configuredDatabasePath());
const moodHistoryRoute = createMoodHistoryRoute({
  reader: moodHistoryReader, now, enabled: () => moodHistoryEnabled(process.env), ownerScopeKey: shannonNowOwnerScope(process.env),
});
// Her value table for the owner (docs/cognition-ledger-contract.md): view, rollback and resume, each control in
// the activity record.
const skillImporter = configuredSkillImporter(skillMemory?.memory ?? null, { ownerScopeKey: shannonNowOwnerScope(process.env), state:
   persistentStore, conversations: persistentStore });
const skillsRoute = createSkillsRoute({ importer: skillImporter, pack: standardSkillPack, memory: skillMemory?.memory ?? null, record:
   ownerSkillRecorder(autonomyStore.activity, autonomyConfig), now, ownerScopeKey: shannonNowOwnerScope(process.env) });
const valuesRoute = createValuesRoute({
  values: persistentStore.valueVersions(), calibration: scopeKey => predictionLedger?.calibration(scopeKey) ?? null, now, ownerScopeKey:
     shannonNowOwnerScope(process.env),
  choices: scopeKey => choiceLedger?.store.counts(scopeKey) ?? {}, record: ownerValueRecorder(autonomyStore.activity, autonomyConfig),
});
const lifecycle = configuredMinecraftLifecycle(process.env, { path: configuredDatabasePath(), autonomy, actions: mind?.actions ?? null, now,
   freshWorld: { policy: opsStore.worldPolicy, activity: autonomyStore.activity, config: autonomyConfig, bodyTasksOpen: (
     ) => fca?.minecraftTasksOpen() ?? null },...(operationOutcomes.tell ? { told: operationOutcomes.tell } : {}), ops: mind?.actions ? {
        commands: opsStore.commands, actions: mind.actions, enabled: () => opsCommandsEnabled(process.env) } : undefined, ownerAlone: (
          ) => kernel.ownerAloneForFeedback(shannonNowOwnerScope(process.env)), taskAllowed: executionId => fca?.lifecycleTaskAllowed(
            executionId) ?? false, taskSources: executionId => fca?.lifecycleTaskSources(executionId) ?? null });
if (lifecycle) minecraft.connectLifecycle(lifecycle.service);
const operatorSkillImport = { importer: skillImporter, pack: standardSkillPack, memory: skillMemory?.memory ?? null, now }; // opsCli skills import
const fca = configuredServerFca(process.env, { live: minecraft.live ?? undefined, minecraftFeelings: configuredMinecraftFeelings(
  process.env, { state: persistentStore, usageStore: persistentStore }), ownTime: { store: autonomyStore, config: autonomyConfig },
     sleepStore: persistentStore, minecraftLifecycle: lifecycle?.service, minecraftConfiguration: minecraft.configuration, touchAllowed: (
       scope, device, gesture) => kernel.touchReflexAllowed(scope, device, gesture), path: configuredDatabasePath(), skills:
          skillMemory?.memory ?? null, ...(skills ? { skillOpen: skills.open } : {}), operator: { lifecycle, actions: mind?.actions ?? null,
             activity: autonomyStore.activity, config: autonomyConfig, conversation: persistentStore, skillImport: operatorSkillImport },
                ownerScope: shannonNowOwnerScope(process.env), ownerAlone: () => kernel.ownerAloneForFeedback(shannonNowOwnerScope(
                  process.env)), usage: persistentStore, affect: persistentStore, memory: memoryPorts?.proposals, enrich: memoryRecall,
                     state: persistentStore, conversations: persistentStore, tools: autonomy.tools, trace: persistentStore.decisionTraces(
                       )?.writer ?? null, traceSalt, readSources: { aetherContext, study: autonomyStore.study, upcoming:
                          ownerUpcoming.upcoming, aetherAvailable: () => Boolean(aetherPorts.access), notionAvailable: (
                            ) => notion.connected, voyagerAvailable: () => Boolean(voyagerCatalog.upcomingTasks), folderAvailable: (_scope,
                               host) => autonomy.folderOperations.boundHosts().includes(host), skill: (scope, id,
                                  revision) => skills?.readSource?.(scope, id, revision) ?? null, skillChecks: (scope,
                                     renew) => skills?.readSourceChecks?.(scope, renew) ?? null } }); if (
                                       fca?.minecraft) minecraft.connectControl(fca.minecraft);
minecraft.startLive({ model: haiku, innerNote: innerNote?.port, feeling: feeling?.port, store: persistentStore, bridge: platformBridge?.configuration });
// The YouTube stream's place (docs/stream-contract.md): no switch; nothing runs until a stream is started from the desktop.
const stream = configuredStream({ scopeKey: shannonNowOwnerScope(process.env), now: () => Date.now(), feeling: feeling?.port ?? null,
  snapshot: scopeKey => persistentStore.snapshot(scopeKey),
  model: chatModel, auxiliary: haiku, jev: configuredJevChooser(process.env, { trace: persistentStore.decisionTraces()?.writer ?? null, salt: traceSalt }),
  innerNote: innerNote?.port ?? null, live: () => minecraft.streamLive(), salt: traceSalt, log: line => console.info(line) });
if (platformBridge) platformBridge.stream = stream.bridge;
const deviceUsage = new Map<string, { startedAt: number; count: number }>();
const bodyUsage = new Map<string, { startedAt: number; count: number }>();
let activeChats = 0;
const voiceAllowances = new VoiceRequestAllowances();
const handleVoiceTranscription = createVoiceTranscriptionRoute({ transcriber: voiceTranscriber, allowances: voiceAllowances });
const geminiSpeechRoute = createGeminiSpeechRoute(process.env, persistentStore, (deviceId) => voiceAllowances.consumeSpeech(deviceId));
const geminiLiveRoute = createGeminiLiveRoute(process.env, kernel, (deviceId) => voiceAllowances.consumeControl(deviceId));
const liveVoiceStreamRoute = createLiveVoiceStreamRoute(kernel, (deviceId) => voiceAllowances.consumeControl(deviceId));
const server = createServer(createApiRequestHandler({
  pushStore, stage5, voiceVisionGateway, bodyStore, modelModes,
  minecraft, reachOuts, privateListeningRoute, incomingCallRoute, ownerCallFacts,
  externalActions, deviceActions, innerNote, kernel, addressed,
  platformBridge, serveListen, miniPoses, authMode, apiToken,
  deviceAuth, pairingRoute, signalObserver, opsRoute, shannonNowRoute,
  moodHistoryRoute, skillsRoute, valuesRoute, fca, stream,
  deviceUsage, bodyUsage, get activeChats() { return activeChats; }, set activeChats(value) { activeChats = value; }, handleVoiceTranscription, geminiSpeechRoute,
  geminiLiveRoute, liveVoiceStreamRoute
}));
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
  server.close(async () => {
    await fca?.close();
    signalObserver?.close();
      deviceAuth?.close();
    pushStore.close();
      worldStore.close();
      initiativeStore.close();
    stage5.close();
    testFlightDeliveryStore.close();
      dailyMindStore.close();
    organizeStore.close();
    turnRouting?.close();
    mind?.close();
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
    operationOutcomes.close();
      await lifecycle?.close();
      minecraft.close();
      stream.stop();
      platformBridge?.close?.(); // Telling closes before the lifecycle.
    reachOuts.close();
      reachOutReports.close();
    privateListeningRoute.close();
      incomingCallRoute?.close();
    ownerTurns.close();
    ownerUpcoming.close();
    closeBodyLookStores();
      closeBodyReactionStores();
      await innerNote?.close();
      feeling?.close();
      closeReplySonnet();
    opsStore.close();
    shannonNowReader.close();
      moodHistoryReader.close();
      opsServer.close();
    ownOutreach.close();
      ownerCallFacts.close();
      deviceActions.close();
    autonomyStore.close();
      modelModes.close();
    persistentStore.close();
    process.exitCode = 0;
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

export type ApiRequestPorts = {
  pushStore: typeof pushStore;
  stage5: typeof stage5;
  voiceVisionGateway: typeof voiceVisionGateway;
  bodyStore: typeof bodyStore;
  modelModes: typeof modelModes;
  minecraft: typeof minecraft;
  reachOuts: typeof reachOuts;
  privateListeningRoute: typeof privateListeningRoute;
  incomingCallRoute: typeof incomingCallRoute;
  ownerCallFacts: typeof ownerCallFacts;
  externalActions: typeof externalActions;
  deviceActions: typeof deviceActions;
  innerNote: typeof innerNote;
  kernel: typeof kernel;
  addressed: typeof addressed;
  platformBridge: typeof platformBridge;
  serveListen: typeof serveListen;
  miniPoses: typeof miniPoses;
  authMode: typeof authMode;
  apiToken: typeof apiToken;
  deviceAuth: typeof deviceAuth;
  pairingRoute: typeof pairingRoute;
  signalObserver: typeof signalObserver;
  opsRoute: typeof opsRoute;
  shannonNowRoute: typeof shannonNowRoute;
  moodHistoryRoute: typeof moodHistoryRoute;
  skillsRoute: typeof skillsRoute;
  valuesRoute: typeof valuesRoute;
  fca: typeof fca;
  stream: typeof stream;
  deviceUsage: typeof deviceUsage;
  bodyUsage: typeof bodyUsage;
  activeChats: typeof activeChats;
  handleVoiceTranscription: typeof handleVoiceTranscription;
  geminiSpeechRoute: typeof geminiSpeechRoute;
  geminiLiveRoute: typeof geminiLiveRoute;
  liveVoiceStreamRoute: typeof liveVoiceStreamRoute;
};
