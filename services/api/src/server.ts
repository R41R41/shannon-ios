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

const now = () => new Date().toISOString();
const persistentStore = new SQLiteShannonStore({
  path: configuredDatabasePath(),
  now,
});
const worldStore = new SQLiteWorldStore(configuredDatabasePath(), now);
const initiativeStore = new SQLiteInitiativeStore(configuredDatabasePath(), now);
const pushStore = new SQLitePushNotificationStore(configuredDatabasePath(), now);
const agentTaskStore = new SQLiteAgentTaskStore(configuredDatabasePath());
const kernel = createLocalApiKernel(now, {
  chatModel: createConfiguredChatModel(process.env, persistentStore),
  stateStore: persistentStore,
  conversationStore: persistentStore,
  background: new DurableBackgroundDispatcher(persistentStore, persistentStore),
  memoryStore: new ShannonMemoryService(persistentStore, persistentStore, now, persistentStore, worldStore, persistentStore, undefined, initiativeStore),
  knowledgeStore: persistentStore,
  initiativeInbox: initiativeStore,
  aetherContext: process.env.SHANNON_AETHER_CONTEXT_FILE?.trim()
    ? new FileAetherContextReader(process.env.SHANNON_AETHER_CONTEXT_FILE.trim())
    : undefined,
  aetherProposals: process.env.SHANNON_AETHER_PROPOSAL_DIR?.trim()
    ? new FileAetherProposalStore(process.env.SHANNON_AETHER_PROPOSAL_DIR.trim(), now)
    : undefined,
  agentTasks: agentTaskStore,
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
  const timestamp = Date.now();
  const previous = deviceUsage.get(deviceId);
  const window = previous && timestamp - previous.startedAt < 60_000
    ? previous
    : { startedAt: timestamp, count: 0 };
  window.count += 1;
  deviceUsage.set(deviceId, window);
  return window.count <= 20;
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += bytes.byteLength;
    if (size > maximumBytes) throw new Error('request body too large');
    chunks.push(bytes);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}
