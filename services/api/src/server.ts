import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { bearerAuthorized, configuredApiToken } from './apiAuth.js';
import { createLocalApiKernel } from './apiKernel.js';
import { createConfiguredChatModel } from './chatModel.js';
import { configuredDatabasePath, SQLiteShannonStore } from './sqliteStore.js';

const now = () => new Date().toISOString();
const persistentStore = new SQLiteShannonStore({
  path: configuredDatabasePath(),
  now,
});
const kernel = createLocalApiKernel(now, {
  chatModel: createConfiguredChatModel(),
  stateStore: persistentStore,
  conversationStore: persistentStore,
});
const port = parsePort(process.env.SHANNON_API_PORT);
const host = parseHost(process.env.SHANNON_API_HOST);
const apiToken = configuredApiToken(host, process.env.SHANNON_API_TOKEN);

const server = createServer(async (request, response) => {
  try {
    if (!bearerAuthorized(request.headers.authorization, apiToken)) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = request.method === 'POST' ? await readJson(request) : undefined;
    const result = await kernel.dispatch({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body,
    });
    sendJson(response, result.status, result.body);
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.message === 'request body too large')) {
      sendJson(response, 400, { error: 'INVALID_REQUEST', message: error.message });
      return;
    }
    console.error('Shannon request failed', error);
    sendJson(response, 502, {
      error: 'MODEL_UNAVAILABLE',
      message: 'Shannonの言語モデルに接続できませんでした。',
    });
  }
});

server.listen(port, host, () => {
  console.log(`Shannon local API listening on http://${host}:${port}`);
  console.log('Shannon persistence ready: sqlite');
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    persistentStore.close();
    process.exitCode = 0;
  });
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += bytes.byteLength;
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(bytes);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}
