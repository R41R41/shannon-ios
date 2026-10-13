import type { IncomingMessage, ServerResponse } from 'node:http';
import { VISION_FRAME_HEADER, VISION_LIMITS, VISION_ROUTE_PREFIX, checkedVisionFrame } from '../../contracts/visionContract.js';
import { readBytes, readJson, sendJson } from '../../infra/http/serverHttp.js';
import type { VisionPrincipal, VisionWatch } from '../../mind/vision/visionPorts.js';

/**
 * The vision worker's HTTP entrance (Syzygy ADR-0011 §9: `/v1/vision/*` under the existing reverse proxy, the existing device
 * token). Only a paired device of the owner's scope is served; her Minecraft body's token never is. A frame is a JPEG (or PNG)
 * body with its `vision.frame.v1` metadata in one header. Nothing of a request body is logged: errors name a closed code only.
 */
export interface VisionRouteDependencies {
  watch: VisionWatch;
  /** The device token's principal, or null. */
  authenticate(authorization: string | undefined): VisionPrincipal | null;
  /** The owner's scope, a device that is not his Minecraft body. */
  allowed(principal: VisionPrincipal): boolean;
  now(): number;
}

const METADATA_LIMIT = 2_048;

export function isVisionPath(pathname: string): boolean {
  return pathname.startsWith(VISION_ROUTE_PREFIX);
}

function frameMetadata(request: IncomingMessage): unknown {
  const raw = request.headers[VISION_FRAME_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.length > METADATA_LIMIT) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function mimeTypeOf(request: IncomingMessage): 'image/jpeg' | 'image/png' | null {
  const type = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  return type === 'image/jpeg' || type === 'image/png' ? type : null;
}

async function frameRoute(request: IncomingMessage, response: ServerResponse, principal: VisionPrincipal, dependencies: VisionRouteDependencies) {
  const mimeType = mimeTypeOf(request);
  const checked = checkedVisionFrame(frameMetadata(request));
  if (!mimeType || typeof checked === 'string') return sendJson(response, 400, { error: 'VISION_FRAME_INVALID' });
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(request, VISION_LIMITS.frameBytes);
  } catch {
    return sendJson(response, 413, { error: 'VISION_FRAME_TOO_LARGE' });
  }
  const meta = { ...checked, receivedAt: new Date(dependencies.now()).toISOString() };
  const result = await dependencies.watch.frame(principal, meta, bytes, mimeType);
  if (result.status === 200) return sendJson(response, 200, result.reply);
  return sendJson(response, result.status, { error: result.error, ...(result.nextFrameNotBefore ? { nextFrameNotBefore: result.nextFrameNotBefore } : {}) });
}

async function presenceRoute(request: IncomingMessage, response: ServerResponse, principal: VisionPrincipal, dependencies: VisionRouteDependencies) {
  let body: unknown;
  try {
    body = await readJson(request, 1_024);
  } catch {
    return sendJson(response, 400, { error: 'VISION_PRESENCE_INVALID' });
  }
  const row = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const count = row.personCount;
  const valid = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 64;
  if (!valid) return sendJson(response, 400, { error: 'VISION_PRESENCE_INVALID' });
  const at = typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) ? row.at : new Date(dependencies.now()).toISOString();
  await dependencies.watch.presence(principal, count, at);
  return sendJson(response, 200, { watch: count >= 2 ? 'stop' : 'continue' });
}

/** Serves a `/v1/vision/*` request. Answers false for any other path. */
export async function serveVisionRoute(request: IncomingMessage, response: ServerResponse, pathname: string,
  dependencies: VisionRouteDependencies): Promise<boolean> {
  if (!isVisionPath(pathname)) return false;
  const principal = dependencies.authenticate(request.headers.authorization);
  if (!principal) {
    sendJson(response, 401, { error: 'PAIRING_REQUIRED' });
    return true;
  }
  if (!dependencies.allowed(principal)) {
    sendJson(response, 403, { error: 'VISION_NOT_ALLOWED' });
    return true;
  }
  const route = `${request.method ?? ''} ${pathname}`;
  if (route === 'GET /v1/vision/status') sendJson(response, 200, await dependencies.watch.status(principal));
  else if (route === 'POST /v1/vision/frames') await frameRoute(request, response, principal, dependencies);
  else if (route === 'POST /v1/vision/presence') await presenceRoute(request, response, principal, dependencies);
  else sendJson(response, 404, { error: 'NOT_FOUND' });
  return true;
}
