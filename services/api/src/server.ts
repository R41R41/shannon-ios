import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLocalApiKernel } from './apiKernel.js';

const kernel = createLocalApiKernel();
const port = parsePort(process.env.SHANNON_API_PORT);
const host = parseHost(process.env.SHANNON_API_HOST);

createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'POST') {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = request.method === 'POST' ? await readJson(request) : undefined;
    const result = kernel.dispatch({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body,
    });
    sendJson(response, result.status, result.body);
  } catch (error) {
    sendJson(response, 400, {
      error: 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : 'request failed',
    });
  }
}).listen(port, host, () => {
  console.log(`Shannon local API listening on http://${host}:${port}`);
});

function parsePort(value: string | undefined): number {
  if (!value) return 4317;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) throw new Error('SHANNON_API_PORT is invalid');
  return parsed;
}

function parseHost(value: string | undefined): '127.0.0.1' | '0.0.0.0' {
  if (!value) return '127.0.0.1';
  if (value === '127.0.0.1' || value === '0.0.0.0') return value;
  throw new Error('SHANNON_API_HOST must be 127.0.0.1 or 0.0.0.0');
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
