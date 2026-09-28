import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleDeviceManagement, handlePushRegistration } from './serverDeviceRoutes.js';
import { bindScope, consumeDeviceAllowance, parseHost, parsePort, readBytes, readJson, sendJson } from './serverHttp.js';
import { bearerAuthorized, configuredApiToken, configuredAuthMode } from './apiAuth.js';
import { handleVoiceVisionSnapshot } from './serverVoiceVisionRoute.js';
import { createPairingRoute } from './serverPairingRoute.js';
import { createConfiguredVoiceVisionGateway } from './voiceVision.js';
import { createGeminiSpeechRoute } from './serverGeminiSpeechRoute.js';
import { createGeminiLiveRoute } from './serverGeminiLiveRoute.js';
import { createLiveVoiceStreamRoute } from './serverLiveVoiceStreamRoute.js';
import { createLocalApiKernel } from './apiKernel.js';
import { DurableBackgroundDispatcher } from './backgroundUpdates.js';
import { createConfiguredChatModel } from './chatModel.js';
import { createConfiguredVoiceDecisionGateway } from './voiceDecision.js';
import { configuredAuthPepper, SQLiteDeviceAuthStore, type ShannonDevicePrincipal } from './deviceAuth.js';
import { configuredDatabasePath, SQLiteShannonStore } from './sqliteStore.js';
import { ShannonMemoryService } from './memoryService.js';
import { SQLiteWorldStore } from './worldStore.js';
import { SQLiteInitiativeStore } from './initiativeStore.js';
import { FileAetherContextReader } from './aetherContext.js';
import { FileAetherProposalStore } from './aetherProposal.js';
import { SQLitePushNotificationStore, type APNsEnvironment } from './pushNotifications.js';
import { SQLiteAgentTaskStore } from './agentTaskStore.js';
import { SQLiteTestFlightDeliveryStore } from './testflightDeliveryStore.js';
import { SQLiteDailyMindStore } from './dailyMind.js';
import {
  SQLiteOrganizeStore,
  createConfiguredOrganizeExtractor,
  createConfiguredVoyagerCatalog,
  createConfiguredVoyagerDestination,
} from './organize.js';
import {
  createConfiguredVoiceTranscriber,
  normalizedVoiceMimeType,
  parsedVoiceDurationSeconds,
  SHANNON_VOICE_MAXIMUM_BYTES,
  VoiceTranscriptionError,
} from './voiceTranscription.js';
import { createConfiguredPlatformBridgeRoute, handlePlatformBridgeRequest, isPlatformBridgePath } from './serverPlatformBridgeRoute.js';
import { SQLitePersonIdentityStore } from './personIdentity.js';
import { SQLiteCognitiveIntentStore } from './cognitiveIntent.js';
import { SQLiteConversationOrchestrationStore } from './conversationOrchestrationPersistence.js';
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
const cognitiveIntentStore = new SQLiteCognitiveIntentStore(configuredDatabasePath());
const conversationOrchestrationStore = new SQLiteConversationOrchestrationStore(configuredDatabasePath());
const backgroundDispatcher = new DurableBackgroundDispatcher(persistentStore, persistentStore);
const kernel = createLocalApiKernel(now, {
  chatModel: createConfiguredChatModel(process.env, persistentStore),
  voiceDecision: createConfiguredVoiceDecisionGateway(process.env, persistentStore),
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
  aetherProposals: process.env.SHANNON_AETHER_PROPOSAL_DIR?.trim()
    ? new FileAetherProposalStore(process.env.SHANNON_AETHER_PROPOSAL_DIR.trim(), now)
    : undefined,
  agentTasks: agentTaskStore,
  testFlightDelivery: testFlightDeliveryStore,
  defaultAgentHost: process.env.SHANNON_AGENT_DEFAULT_HOST,
  dailyMind: dailyMindStore,
  organizeStore,
  organizeExtractor: createConfiguredOrganizeExtractor(process.env),
  voyagerCatalog: createConfiguredVoyagerCatalog(process.env),
  voyagerDestination: createConfiguredVoyagerDestination(process.env),
  personIdentities: personIdentityStore,
  worldSubscriptions: worldStore,
  cognitiveIntents: cognitiveIntentStore,
  conversationOrchestration: conversationOrchestrationStore,
});
const platformBridge = createConfiguredPlatformBridgeRoute(process.env, persistentStore, persistentStore, backgroundDispatcher, now);
const port = parsePort(process.env.SHANNON_API_PORT);
const host = parseHost(process.env.SHANNON_API_HOST);
const authMode = configuredAuthMode(host);
const apiToken = authMode === 'fixed' ? configuredApiToken(host, process.env.SHANNON_API_TOKEN) : null;
const deviceAuth = authMode === 'paired'
  ? new SQLiteDeviceAuthStore({ path: configuredDatabasePath(), pepper: configuredAuthPepper() })
  : null;
const pairingRoute = createPairingRoute(authMode, deviceAuth);
const deviceUsage = new Map<string, { startedAt: number; count: number }>();
let activeChats = 0;
const deviceVoiceUsage = new Map<string, { startedAt: number; count: number }>();
const activeVoiceScopes = new Set<string>();
const geminiSpeechRoute = createGeminiSpeechRoute(
  process.env, persistentStore, (deviceId) => consumeDeviceAllowance(deviceVoiceUsage, deviceId, 10),
);
const geminiLiveRoute = createGeminiLiveRoute(
  process.env, kernel, (deviceId) => consumeDeviceAllowance(deviceVoiceUsage, deviceId, 10),
);
const liveVoiceStreamRoute = createLiveVoiceStreamRoute(
  kernel, (deviceId) => consumeDeviceAllowance(deviceVoiceUsage, deviceId, 10),
);
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'POST') {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
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
    if (url.pathname === '/v1/voice/gemini/speech' || url.pathname === '/v1/voice/gemini/speech/stream') {
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
    const body = request.method === 'POST' ? await readJson(request, 64 * 1024) : undefined;
    const query = new URLSearchParams(url.searchParams);
    if (principal) query.set('scopeKey', principal.scopeKey);
    if (url.pathname === '/v1/devices') {
      handleDeviceManagement(request, response, body, principal, { deviceAuth, pushStore });
      return;
    }
    if (url.pathname === '/v1/push/register') {
      handlePushRegistration(request, response, body, principal, { deviceAuth, pushStore });
      return;
    }
    const isPairedChat = principal !== null && url.pathname === '/v1/chat';
    if (isPairedChat && !consumeDeviceAllowance(deviceUsage, principal.deviceId, 20)) {
      sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度話しかけてください。' });
      return;
    }
    if (isPairedChat && activeChats >= 2) {
      sendJson(response, 429, { error: 'BUSY', message: 'いま少し混み合っています。' });
      return;
    }
    if (isPairedChat) activeChats += 1;
    try {
      const result = await kernel.dispatch({
        method: request.method,
        path: url.pathname,
        query,
        body: principal ? bindScope(body, principal.scopeKey) : body,
      });
      sendJson(response, result.status, result.body);
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
  console.log(`Shannon API listening on http://${host}:${port}`);
  console.log(`Shannon authentication: ${authMode}`);
  console.log('Shannon persistence ready: sqlite');
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
    cognitiveIntentStore.close();
    conversationOrchestrationStore.close();
    persistentStore.close();
    process.exitCode = 0;
  });
}

async function handleVoiceTranscription(
  request: IncomingMessage,
  response: ServerResponse,
  principal: ShannonDevicePrincipal | null,
): Promise<void> {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }
  if (!principal) {
    sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    return;
  }
  if (!voiceTranscriber) {
    sendJson(response, 503, { error: 'VOICE_NOT_CONFIGURED', message: '音声入力は現在利用できません。' });
    return;
  }
  if (!consumeDeviceAllowance(deviceVoiceUsage, principal.deviceId, 10)) {
    sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
    return;
  }
  if (activeVoiceScopes.has(principal.scopeKey)) {
    sendJson(response, 429, { error: 'BUSY', message: 'いまの音声を聞き取っています。少しお待ちください。' });
    return;
  }

  activeVoiceScopes.add(principal.scopeKey);
  try {
    const mimeType = normalizedVoiceMimeType(request.headers['content-type']);
    const durationSeconds = parsedVoiceDurationSeconds(request.headers['x-shannon-audio-duration-ms']);
    const audio = await readBytes(request, SHANNON_VOICE_MAXIMUM_BYTES);
    const result = await voiceTranscriber.transcribe({
      scopeKey: principal.scopeKey,
      audio,
      mimeType,
      durationSeconds,
    });
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof VoiceTranscriptionError) {
      console.warn('Shannon voice transcription failed', {
        code: error.code,
        upstreamStatus: error.upstreamStatus,
        upstreamCode: error.upstreamCode,
      });
      const status = error.code === 'VOICE_DAILY_BUDGET_EXHAUSTED' ? 429
        : error.code === 'VOICE_TRANSCRIPTION_FAILED' ? 502
          : 400;
      const message = error.code === 'VOICE_DAILY_BUDGET_EXHAUSTED'
        ? '今日は音声入力を十分使いました。テキスト入力は引き続き使えます。'
        : '音声を文字にできませんでした。もう一度お試しください。';
      sendJson(response, status, { error: error.code, message });
      return;
    }
    throw error;
  } finally {
    activeVoiceScopes.delete(principal.scopeKey);
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
