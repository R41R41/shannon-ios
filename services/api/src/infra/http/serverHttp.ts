import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';

export function parsePort(value: string | undefined): number {
  if (!value) return 4317;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) throw new Error('SHANNON_API_PORT is invalid');
  return parsed;
}

export function parseHost(value: string | undefined): string {
  if (!value) return '127.0.0.1';
  if (value === '127.0.0.1') return value;
  if (value === 'lan') return privateLanAddress();
  throw new Error('SHANNON_API_HOST must be 127.0.0.1 or lan');
}

export function privateLanAddress(): string {
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

export function isPrivateIPv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 10
    || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function bindScope(body: unknown, scopeKey: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), scopeKey };
}

export function consumeDeviceAllowance(
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

// A voice turn can synthesize several sentences, including one prefetched sentence.
// Keep that budget separate from session/delegation requests so a long spoken reply
// cannot exhaust the allowance needed to finish its own audio.
export class VoiceRequestAllowances {
  private readonly controlUsage = new Map<string, { startedAt: number; count: number }>();
  private readonly speechUsage = new Map<string, { startedAt: number; count: number }>();

  consumeControl(deviceId: string): boolean {
    return consumeDeviceAllowance(this.controlUsage, deviceId, 30);
  }

  consumeSpeech(deviceId: string): boolean {
    return consumeDeviceAllowance(this.speechUsage, deviceId, 60);
  }
}

export async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const body = await readBytes(request, maximumBytes);
  if (!body.byteLength) return undefined;
  return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
}

export async function readBytes(request: IncomingMessage, maximumBytes: number): Promise<Uint8Array> {
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

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

export function scalarHeader(value: string | string[] | undefined): string | undefined {
  const scalar = Array.isArray(value) ? value[0] : value;
  const normalized = scalar?.trim();
  return normalized && normalized.length <= 160 ? normalized : undefined;
}
