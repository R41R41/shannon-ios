import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from '../../infra/auth/deviceAuth.js';
import { readJson, sendJson } from '../../infra/http/serverHttp.js';
import { STREAM_LIMITS, StreamError } from './streamContract.js';
import {
  bad, parseBroadcast, parseComments, parseControlInput, parseReceiptInput, parseStartInput, record, text,
} from './streamParse.js';
import type { StreamService } from './streamService.js';

/**
 * The stream's routes (`docs/stream-contract.md` §1 and §2).
 * - For the owner's paired device (the desktop, her mouth and the console): `POST /v1/stream/start`, `POST /v1/stream/end`, `GET /v1/stream`,
 *   `GET /v1/stream/lines` (Server-Sent Events), `POST /v1/stream/lines/{id}/receipt`, `POST /v1/stream/controls`.
 * - For the ear (the bridge token, checked by the caller): `GET /v1/platform/stream/state`, `POST /v1/platform/stream/broadcast`,
 *   `POST /v1/platform/stream/comments`, `POST /v1/platform/stream/chat-posts/{id}/receipt`.
 * Neither is behind a switch; with no stream started they answer as if nothing happened (state null, comments 409).
 */
export const STREAM_PATH = '/v1/stream';
export const STREAM_BRIDGE_PREFIX = '/v1/platform/stream/';

export const isStreamPath = (path: string): boolean => path === STREAM_PATH || path.startsWith(`${STREAM_PATH}/`);
export const isStreamBridgePath = (path: string): boolean => path.startsWith(STREAM_BRIDGE_PREFIX);

async function guarded(response: ServerResponse, work: () => Promise<void> | void): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof StreamError) {
      return sendJson(response, error.status, { error: error.code, ...(error.message !== error.code ? { message: error.message } : {}) });
    }
    if (error instanceof SyntaxError) return sendJson(response, 400, { error: 'BAD_REQUEST', message: 'JSON body is invalid.' });
    if (error instanceof Error && error.message === 'request body too large') return sendJson(response, 413, { error: 'STREAM_BODY_TOO_LARGE' });
    throw error;
  }
}

function noContent(response: ServerResponse): void {
  response.writeHead(204, { 'cache-control': 'no-store' });
  response.end();
}

const small = (request: IncomingMessage): Promise<unknown> => readJson(request, STREAM_LIMITS.controlBodyBytes);
const RECEIPT_PATH = /^\/v1\/stream\/lines\/([A-Za-z0-9_-]{1,80})\/receipt$/u;
const CHAT_POST_PATH = /^\/v1\/platform\/stream\/chat-posts\/([A-Za-z0-9_-]{1,100})\/receipt$/u;

type Answer = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void> | void;

/** The desktop's routes by path: each takes one method and answers 405 to any other. */
function desktopRoutes(service: StreamService): Record<string, { method: 'GET' | 'POST'; answer: Answer }> {
  return {
    [STREAM_PATH]: { method: 'GET', answer: (_request, response) => sendJson(response, 200, service.view()) },
    [`${STREAM_PATH}/lines`]: {
      method: 'GET',
      answer: (_request, response, url) => {
        const after = Number(url.searchParams.get('after'));
        service.mouth.subscribe(response, Number.isInteger(after) && after > 0 ? after : 0);
      },
    },
    [`${STREAM_PATH}/start`]: {
      method: 'POST',
      answer: async (request, response) => {
        const { created, stream } = service.start(parseStartInput(await small(request)));
        sendJson(response, created ? 201 : 200, { stream });
      },
    },
    [`${STREAM_PATH}/end`]: {
      method: 'POST',
      answer: async (request, response) => {
        const streamId = text(record(await small(request))?.streamId, 80) ?? bad('STREAM_INPUT_INVALID');
        sendJson(response, 200, await service.end(streamId));
      },
    },
    [`${STREAM_PATH}/controls`]: {
      method: 'POST',
      answer: async (request, response) => {
        service.control(parseControlInput(await small(request)));
        sendJson(response, 200, { ok: true });
      },
    },
  };
}

async function lineReceipt(service: StreamService, id: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const result = service.receipt(id, parseReceiptInput(await small(request)));
  if (result === 'unknown') return sendJson(response, 404, { error: 'STREAM_LINE_UNKNOWN' });
  noContent(response);
}

/** The desktop's routes. True when the path was one of them (answered). */
export function createStreamRoute(parts: { service: StreamService; ownerScope: string }) {
  const { service } = parts;
  const routes = desktopRoutes(service);
  return async (request: IncomingMessage, response: ServerResponse, principal: ShannonDevicePrincipal | null, url: URL): Promise<boolean> => {
    const path = url.pathname;
    if (!isStreamPath(path)) return false;
    if (!principal) sendJson(response, 401, { error: 'STREAM_PAIRING_REQUIRED' });
    else if (principal.scopeKey !== parts.ownerScope) sendJson(response, 403, { error: 'STREAM_OWNER_ONLY' });
    else {
      const receipt = RECEIPT_PATH.exec(path);
      const route = routes[path];
      const method = receipt ? 'POST' : route?.method;
      await guarded(response, async () => {
        if (!method) return sendJson(response, 404, { error: 'NOT_FOUND' });
        if (request.method !== method) return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        if (receipt) return lineReceipt(service, receipt[1]!, request, response);
        await route!.answer(request, response, url);
      });
    }
    return true;
  };
}

function bridgeMethod(path: string): 'GET' | 'POST' | null {
  if (path === `${STREAM_BRIDGE_PREFIX}state`) return 'GET';
  const posts = [`${STREAM_BRIDGE_PREFIX}broadcast`, `${STREAM_BRIDGE_PREFIX}comments`];
  return posts.includes(path) || CHAT_POST_PATH.test(path) ? 'POST' : null;
}

async function bridgePost(service: StreamService, path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const post = CHAT_POST_PATH.exec(path);
  if (post) {
    const outcome = record(await small(request))?.outcome;
    if (outcome !== 'posted' && outcome !== 'failed') bad('STREAM_INPUT_INVALID');
    service.chatPostReceipt(post[1]!, outcome);
    return noContent(response);
  }
  if (path.endsWith('/broadcast')) return sendJson(response, 200, { stream: await service.broadcast(parseBroadcast(await small(request))) });
  const { streamId, comments } = parseComments(await readJson(request, STREAM_LIMITS.bridgeBodyBytes));
  sendJson(response, 202, service.ingest(streamId, comments));
}

/** The ear's routes, after the bridge token was checked. */
export async function handleStreamBridge(path: string, request: IncomingMessage, response: ServerResponse, service: StreamService): Promise<void> {
  const method = bridgeMethod(path);
  await guarded(response, async () => {
    if (!method) return sendJson(response, 404, { error: 'NOT_FOUND' });
    if (request.method !== method) return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (method === 'GET') return sendJson(response, 200, service.bridgeState());
    await bridgePost(service, path, request, response);
  });
}
