import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { bearerAuthorized, configuredApiToken, configuredAuthMode } from './apiAuth.js';
import { createLocalApiKernel } from './apiKernel.js';
import { DurableBackgroundDispatcher } from './backgroundUpdates.js';
import { createConfiguredChatModel } from './chatModel.js';
import {
  configuredAuthPepper,
  normalizePairingCode,
  SQLiteDeviceAuthStore,
  type ShannonDevicePrincipal,
} from './deviceAuth.js';
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
import {
  configuredRealtimeDailyAllowanceSeconds,
  createConfiguredRealtimeVoiceGateway,
  realtimeVoiceJapanDayKey,
  RealtimeVoiceError,
  SHANNON_REALTIME_SESSION_RESERVATION_SECONDS,
} from './realtimeVoice.js';
import {
  createConfiguredVoicePreviewGateway,
  isShannonRealtimeVoiceId,
  SQLiteVoiceIdentityStore,
  VoicePreviewError,
} from './voiceIdentity.js';

const now = () => new Date().toISOString();
const persistentStore = new SQLiteShannonStore({
  path: configuredDatabasePath(),
  now,
});
const worldStore = new SQLiteWorldStore(configuredDatabasePath(), now);
const initiativeStore = new SQLiteInitiativeStore(configuredDatabasePath(), now);
const pushStore = new SQLitePushNotificationStore(configuredDatabasePath(), now);
const agentTaskStore = new SQLiteAgentTaskStore(configuredDatabasePath());
const testFlightDeliveryStore = new SQLiteTestFlightDeliveryStore(configuredDatabasePath());
const dailyMindStore = new SQLiteDailyMindStore(configuredDatabasePath(), now);
const organizeStore = new SQLiteOrganizeStore(configuredDatabasePath());
const voiceTranscriber = createConfiguredVoiceTranscriber(process.env, persistentStore);
const realtimeVoiceGateway = createConfiguredRealtimeVoiceGateway(process.env);
const realtimeVoiceDailyAllowanceSeconds = configuredRealtimeDailyAllowanceSeconds(process.env);
const configuredRealtimeVoice = realtimeVoiceGateway?.defaultVoice;
const automaticRealtimeVoice = isShannonRealtimeVoiceId(configuredRealtimeVoice)
  ? configuredRealtimeVoice
  : 'marin';
const voiceIdentityStore = new SQLiteVoiceIdentityStore(configuredDatabasePath(), automaticRealtimeVoice);
const voicePreviewGateway = createConfiguredVoicePreviewGateway(process.env);
const kernel = createLocalApiKernel(now, {
  chatModel: createConfiguredChatModel(process.env, persistentStore),
  stateStore: persistentStore,
  conversationStore: persistentStore,
  background: new DurableBackgroundDispatcher(persistentStore, persistentStore),
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
  voiceIdentity: voiceIdentityStore,
});
const port = parsePort(process.env.SHANNON_API_PORT);
const host = parseHost(process.env.SHANNON_API_HOST);
const authMode = configuredAuthMode(host);
const apiToken = authMode === 'fixed' ? configuredApiToken(host, process.env.SHANNON_API_TOKEN) : null;
const deviceAuth = authMode === 'paired'
  ? new SQLiteDeviceAuthStore({ path: configuredDatabasePath(), pepper: configuredAuthPepper() })
  : null;
let pairingWindow = { startedAt: 0, count: 0 };
const deviceUsage = new Map<string, { startedAt: number; count: number }>();
let activeChats = 0;
const deviceVoiceUsage = new Map<string, { startedAt: number; count: number }>();
const activeVoiceScopes = new Set<string>();

const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'POST') {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/v1/pair') {
      await handlePairing(request, response);
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

    const principal = deviceAuth ? deviceAuth.authenticate(request.headers.authorization) : null;
    const authorized = authMode === 'paired'
      ? principal !== null
      : bearerAuthorized(request.headers.authorization, apiToken);
    if (!authorized) {
      sendJson(response, 401, { error: 'PAIRING_REQUIRED', message: '接続コードでシャノンと接続してください。' });
      return;
    }

    if (url.pathname === '/v1/voice/transcriptions') {
      await handleVoiceTranscription(request, response, principal);
      return;
    }
    if (url.pathname === '/v1/voice/realtime/calls') {
      await handleRealtimeVoiceCall(request, response, principal);
      return;
    }
    if (url.pathname === '/v1/voice/identity/preview') {
      await handleVoiceIdentityPreview(request, response, principal);
      return;
    }

    const body = request.method === 'POST' ? await readJson(request, 64 * 1024) : undefined;
    const query = new URLSearchParams(url.searchParams);
    if (principal) query.set('scopeKey', principal.scopeKey);
    if (url.pathname === '/v1/push/register') {
      handlePushRegistration(request, response, body, principal);
      return;
    }
    const isPairedChat = principal !== null && url.pathname === '/v1/chat';
    if (isPairedChat && !consumeDeviceChatAllowance(principal.deviceId)) {
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
    voiceIdentityStore.close();
    persistentStore.close();
    process.exitCode = 0;
  });
}

function handlePushRegistration(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  principal: ShannonDevicePrincipal | null,
): void {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }
  if (!principal) {
    sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(response, 400, { error: 'INVALID_REQUEST' });
    return;
  }
  const value = body as Record<string, unknown>;
  const deviceToken = typeof value.deviceToken === 'string' ? value.deviceToken : '';
  const environment = value.environment;
  if (environment !== 'sandbox' && environment !== 'production') {
    sendJson(response, 400, { error: 'PUSH_ENVIRONMENT_INVALID' });
    return;
  }
  try {
    pushStore.register(principal, deviceToken, environment as APNsEnvironment);
    sendJson(response, 200, { registered: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'PUSH_DEVICE_TOKEN_INVALID') {
      sendJson(response, 400, { error: error.message });
      return;
    }
    throw error;
  }
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

async function handleRealtimeVoiceCall(
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
  if (!realtimeVoiceGateway) {
    sendJson(response, 503, { error: 'VOICE_REALTIME_NOT_CONFIGURED', message: 'ライブ音声は現在利用できません。' });
    return;
  }
  if (!consumeDeviceAllowance(deviceVoiceUsage, principal.deviceId, 10)) {
    sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
    return;
  }

  let reservationId: string | undefined;
  let upstreamCallCreated = false;
  try {
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/sdp') {
      sendJson(response, 415, { error: 'VOICE_REALTIME_INVALID_SDP', message: '音声接続の形式が正しくありません。' });
      return;
    }
    const offer = Buffer.from(await readBytes(request, 128 * 1024)).toString('utf8');
    const requestedThreadId = scalarHeader(request.headers['x-shannon-thread-id']);
    const session = kernel.realtimeVoiceSession(principal.scopeKey, requestedThreadId);
    const createdAt = now();
    const reservation = persistentStore.reserveRealtimeVoiceSession({
      scopeKey: principal.scopeKey,
      dayKey: realtimeVoiceJapanDayKey(new Date(createdAt)),
      reservedSeconds: SHANNON_REALTIME_SESSION_RESERVATION_SECONDS,
      dailyLimitSeconds: realtimeVoiceDailyAllowanceSeconds,
      createdAt,
    });
    if (!reservation) {
      sendJson(response, 429, {
        error: 'VOICE_REALTIME_DAILY_ALLOWANCE_EXHAUSTED',
        message: '今日はライブ音声を十分使いました。テキスト会話は引き続き使えます。',
      });
      return;
    }
    reservationId = reservation.reservationId;
    const result = await realtimeVoiceGateway.createCall({
      sdp: offer,
      instructions: session.instructions,
      voice: session.voice,
    });
    upstreamCallCreated = true;
    response.writeHead(200, {
      'content-type': 'application/sdp; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-shannon-thread-id': session.threadId,
      'x-shannon-realtime-model': result.model,
      'x-shannon-realtime-daily-remaining-seconds': String(reservation.remainingSeconds),
      ...(result.callId ? { 'x-shannon-realtime-call-id': result.callId } : {}),
    });
    response.end(result.answerSdp);
  } catch (error) {
    if (reservationId && !upstreamCallCreated) {
      persistentStore.releaseRealtimeVoiceSessionReservation(reservationId);
    }
    if (error instanceof RealtimeVoiceError) {
      console.warn('Shannon realtime voice call failed', {
        code: error.code,
        upstreamStatus: error.upstreamStatus,
        upstreamCode: error.upstreamCode,
        upstreamRequestId: error.upstreamRequestId,
        upstreamDetail: error.upstreamDetail,
      });
      const status = error.code === 'VOICE_REALTIME_INVALID_SDP' ? 400 : 502;
      sendJson(response, status, {
        error: error.code,
        message: 'ライブ音声に接続できませんでした。少し待ってもう一度お試しください。',
      });
      return;
    }
    throw error;
  }
}

async function handleVoiceIdentityPreview(
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
  if (!voicePreviewGateway) {
    sendJson(response, 503, { error: 'VOICE_PREVIEW_NOT_CONFIGURED', message: '声の試聴は現在利用できません。' });
    return;
  }
  const body = await readJson(request, 1_024);
  const voice = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).voice
    : undefined;
  if (!isShannonRealtimeVoiceId(voice)) {
    sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'voice is invalid' });
    return;
  }
  if (!consumeDeviceAllowance(deviceVoiceUsage, principal.deviceId, 10)) {
    sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
    return;
  }
  if (!voiceIdentityStore.consumePreviewAllowance(principal.scopeKey)) {
    sendJson(response, 429, { error: 'VOICE_PREVIEW_DAILY_LIMIT', message: '今日の声の試聴回数に達しました。' });
    return;
  }
  try {
    const preview = await voicePreviewGateway.preview(voice);
    response.writeHead(200, {
      'content-type': preview.contentType,
      'content-length': preview.audio.byteLength,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    response.end(preview.audio);
  } catch (error) {
    if (error instanceof VoicePreviewError) {
      sendJson(response, 502, { error: error.code, message: '声を試聴できませんでした。' });
      return;
    }
    throw error;
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

function parsePort(value: string | undefined): number {
  if (!value) return 4317;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) throw new Error('SHANNON_API_PORT is invalid');
  return parsed;
}

function parseHost(value: string | undefined): string {
  if (!value) return '127.0.0.1';
  if (value === '127.0.0.1') return value;
  if (value === 'lan') return privateLanAddress();
  throw new Error('SHANNON_API_HOST must be 127.0.0.1 or lan');
}

function privateLanAddress(): string {
  const interfaces = networkInterfaces();
  const preferred = interfaces.en0?.find(address => address.family === 'IPv4' && !address.internal);
  if (preferred && isPrivateIPv4(preferred.address)) return preferred.address;

  for (const addresses of Object.values(interfaces)) {
    const address = addresses?.find(candidate => (
      candidate.family === 'IPv4' && !candidate.internal && isPrivateIPv4(candidate.address)
    ));
    if (address) return address.address;
  }
  throw new Error('No private LAN IPv4 address is available for the iPhone API');
}

function isPrivateIPv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 10
    || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

async function handlePairing(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!deviceAuth || authMode !== 'paired') {
    sendJson(response, 404, { error: 'NOT_FOUND' });
    return;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }
  const timestamp = Date.now();
  if (timestamp - pairingWindow.startedAt >= 60_000) pairingWindow = { startedAt: timestamp, count: 0 };
  pairingWindow.count += 1;
  if (pairingWindow.count > 20) {
    sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
    return;
  }
  const body = await readJson(request, 1_024);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(response, 400, { error: 'INVALID_REQUEST' });
    return;
  }
  const requestBody = body as Record<string, unknown>;
  const normalizedCode = normalizePairingCode(requestBody.code);
  if (!normalizedCode) {
    sendJson(response, 400, { error: 'INVALID_PAIRING_CODE', message: '12桁の接続コードを入力してください。' });
    return;
  }
  const deviceName = typeof requestBody.deviceName === 'string' ? requestBody.deviceName : 'iPhone';
  const result = deviceAuth.pair(normalizedCode, deviceName);
  if (!result) {
    sendJson(response, 401, { error: 'PAIRING_REJECTED', message: '接続コードが無効・期限切れです。' });
    return;
  }
  sendJson(response, 200, result);
}

function bindScope(body: unknown, scopeKey: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), scopeKey };
}

function consumeDeviceChatAllowance(deviceId: string): boolean {
  return consumeDeviceAllowance(deviceUsage, deviceId, 20);
}

function consumeDeviceAllowance(
  usage: Map<string, { startedAt: number; count: number }>,
  deviceId: string,
  maximumPerMinute: number,
): boolean {
  const timestamp = Date.now();
  const previous = usage.get(deviceId);
  const window = previous && timestamp - previous.startedAt < 60_000
    ? previous
    : { startedAt: timestamp, count: 0 };
  window.count += 1;
  usage.set(deviceId, window);
  return window.count <= maximumPerMinute;
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const body = await readBytes(request, maximumBytes);
  if (!body.byteLength) return undefined;
  return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
}

async function readBytes(request: IncomingMessage, maximumBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += bytes.byteLength;
    if (size > maximumBytes) throw new Error('request body too large');
    chunks.push(bytes);
  }
  if (!chunks.length) return new Uint8Array();
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function scalarHeader(value: string | string[] | undefined): string | undefined {
  const scalar = Array.isArray(value) ? value[0] : value;
  const normalized = scalar?.trim();
  return normalized && normalized.length <= 160 ? normalized : undefined;
}
