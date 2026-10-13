import { createServer, request as httpRequest, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OPERATOR_LIMITS, OPERATOR_PATH, OPERATOR_SOCKET_DIRECTORY, OPERATOR_SOCKET_NAME } from '../../contracts/operatorContract.js';
import { readJson, sendJson } from '../http/serverHttp.js';

/**
 * The operator's channel to the running API (owner decision 2026-10-14). It is a Unix socket in a directory only the service
 * user can enter (0700, the socket 0600), beside the database: nginx's `/companion/` proxy forwards every TCP path of
 * 127.0.0.1:4319 to the internet-facing site, so a new TCP route would be reachable from outside, and a loopback secret would be
 * a new credential to mint, store and keep unprinted. The socket needs neither: who can open it is who can read the database.
 */
export function operatorSocketPath(databasePath: string): string {
  return join(dirname(databasePath), OPERATOR_SOCKET_DIRECTORY, OPERATOR_SOCKET_NAME);
}

export type OperatorHandler = (body: unknown) => Promise<{ status: number; body: unknown }>;

async function ownDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const directory = await lstat(path);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && directory.uid !== process.getuid())) {
    throw new Error('OPERATOR_SOCKET_DIRECTORY');
  }
  await chmod(path, 0o700);
}

/** Whether something still listens on the socket (a probe that times out counts as yes). */
function answers(path: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const probe = createConnection(path);
    const done = (active: boolean) => {
      clearTimeout(timer);
      probe.destroy();
      resolve(active);
    };
    const timer = setTimeout(() => done(true), 200);
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });
}

/** A socket left by a process that is gone is removed; one that still answers is another API and stops this one. */
async function clearStale(path: string): Promise<void> {
  try {
    const old = await lstat(path);
    if (!old.isSocket() || (process.getuid && old.uid !== process.getuid())) throw new Error('OPERATOR_SOCKET_PATH');
    if (await answers(path)) throw new Error('OPERATOR_SOCKET_IN_USE');
    await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Serves `POST /operator/v1/minecraft` on the socket; any other path or method is refused. */
export async function serveOperatorSocket(path: string, handle: OperatorHandler): Promise<{ close(): Promise<void> }> {
  await ownDirectory(dirname(path));
  await clearStale(path);
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== OPERATOR_PATH) return sendJson(response, 404, { error: 'NOT_FOUND' });
      // Nothing proxied ever reaches a Unix socket; a forwarded header means something is wrong, so it is refused.
      if (request.headers['x-forwarded-for'] !== undefined) return sendJson(response, 403, { error: 'OPERATOR_LOCAL_ONLY' });
      let body: unknown;
      try {
        body = await readJson(request, OPERATOR_LIMITS.bodyBytes);
      } catch {
        return sendJson(response, 400, { error: 'INVALID_REQUEST' });
      }
      const reply = await handle(body);
      sendJson(response, reply.status, reply.body);
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'OPERATOR_FAILED' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  await chmod(path, 0o600);
  return {
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/** The CLI's side: one request on the socket, its status and parsed JSON reply. */
export function requestOperatorSocket(path: string, body: unknown, timeoutMs = 30_000): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const outgoing = httpRequest({ socketPath: path, path: OPERATOR_PATH, method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        try {
          resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.once('timeout', () => outgoing.destroy(new Error('OPERATOR_SOCKET_TIMEOUT')));
    outgoing.once('error', reject);
    outgoing.end(payload);
  });
}
