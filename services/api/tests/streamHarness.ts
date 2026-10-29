import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInitialCompanionState } from '@shannon/cognition';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/infra/models/chatModelContract.js';
import type { ShannonDevicePrincipal } from '../src/infra/auth/deviceAuth.js';
import { handlePlatformBridgeRequest, isPlatformBridgePath } from '../src/surfaces/platform/serverPlatformBridgeRoute.js';
import type { PlatformBridgeRouteDependencies } from '../src/surfaces/platform/serverPlatformBridgeRoute.js';
import type { IncomingComment } from '../src/surfaces/stream/streamContract.js';
import { configuredStream, type StreamWiringParts } from '../src/wiring/streamWiring.js';
import { fakeAuxiliaryModel, fakeJev, fakeWriterModel } from '../scripts/stream-bench/fakeModels.js';

/** A stream place for the tests: a clock the test moves, fake models that record every request, and a small server with the real routes. */
export const BRIDGE_TOKEN = 'stream-test-bridge-token-0123456789abcdef';
export const OWNER = 'owner';
export const T0 = Date.parse('2026-10-29T10:00:00.000Z');
export const stamp = (ms: number): string => new Date(ms).toISOString();

export interface RecordedRequest { request: ShannonChatModelRequest; role: 'writer' | 'auxiliary' }

export function makePlace(options: Partial<StreamWiringParts> & { override?: (request: ShannonChatModelRequest, role: 'writer' | 'auxiliary') => string | null;
  jev?: StreamWiringParts['jev'] } = {}) {
  const clock = { t: T0 };
  const recorded: RecordedRequest[] = [];
  const seen = (request: ShannonChatModelRequest, role: 'writer' | 'auxiliary') => { recorded.push({ request, role }); };
  const fake = { seen, ...(options.override ? { override: options.override } : {}) };
  const parts: StreamWiringParts = {
    scopeKey: OWNER, now: () => clock.t, feeling: null, snapshot: scopeKey => createInitialCompanionState(scopeKey, stamp(T0)),
    model: fakeWriterModel(fake), auxiliary: fakeAuxiliaryModel(fake), jev: fakeJev() as never, tickMilliseconds: 0, ...options,
  };
  const stream = configuredStream(parts);
  const { service } = stream;
  /** Moves the clock, ticks, and waits for the work started. */
  const step = async (milliseconds: number): Promise<void> => {
    clock.t += milliseconds;
    service.tick();
    await service.settle();
  };
  /** The mouth's current line is said (a receipt), until none is left. Returns the lines said. */
  const drain = async (): Promise<string[]> => {
    const said: string[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const line = service.mouth.currentLine();
      if (!line) break;
      said.push(line.text);
      service.receipt(line.id, { outcome: 'spoken', startedAt: stamp(clock.t + 300), endedAt: stamp(clock.t + 2000) });
    }
    return said;
  };
  let serial = 0;
  const comment = (text: string, extra: Record<string, unknown> = {}): IncomingComment => {
    serial += 1;
    return { id: `c${serial}`, authorId: `u${serial}`, authorName: `視聴者${serial}`, text, publishedAt: stamp(clock.t), kind: 'text', roles: [], ...extra } as IncomingComment;
  };
  return { clock, recorded, stream, service, step, drain, comment, parts };
}

export type Place = ReturnType<typeof makePlace>;

/** The real routes on a local port: the desktop's (a paired owner device) and the ear's (the bridge token). */
export async function serveRoutes(place: Place, principal: ShannonDevicePrincipal | null = { deviceId: 'd1', scopeKey: OWNER, displayName: 'desk' }) {
  const bridge = { configuration: { token: BRIDGE_TOKEN }, stream: place.stream.bridge } as unknown as PlatformBridgeRouteDependencies;
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (isPlatformBridgePath(url.pathname)) return handlePlatformBridgeRequest(url.pathname, request, response, bridge);
    if (!(await place.stream.serve(request, response, principal, url))) { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token = BRIDGE_TOKEN) => {
    const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) as Record<string, any> : null };
  };
  return { base, call, close: () => { place.service.mouth.closeAll(); server.closeAllConnections(); server.close(); } };
}

/** The chat as the ear brings it: `n` ordinary comments from different people. */
export const fakeBackend = (): ShannonChatModel => fakeWriterModel();
