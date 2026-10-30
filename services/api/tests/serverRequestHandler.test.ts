import { createServer, get, IncomingMessage, ServerResponse, type Server } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiRequestHandler } from '../src/wiring/serverRequestHandler.js';
import type { ApiRequestPorts } from '../src/server.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function harness() {
  const no = async () => false;
  const principal = { scopeKey: 'owner', deviceId: 'owner-device' };
  const dispatch = vi.fn(async () => ({ status: 200, body: { handled: 'kernel' } }));
  const afterHost = vi.fn(async () => {});
  const ports = {
    pushStore: {}, stage5: { afterHost: async () => {}, serve: no }, voiceVisionGateway: {},
    bodyStore: { capabilities: () => null }, modelModes: {},
    minecraft: { refusesConsole: () => false, serve: no, isGameDevice: () => false }, reachOuts: {},
    privateListeningRoute: { handle: () => false }, incomingCallRoute: null, ownerCallFacts: { surface: () => null },
    externalActions: { filterHostEvents: async (request: unknown) => request, beforeHost: async () => null, afterHost },
    deviceActions: { serve: no }, innerNote: null, kernel: { dispatch }, addressed: { serve: no },
    platformBridge: null, serveListen: no, miniPoses: { serve: no }, authMode: 'paired', apiToken: 'unused',
    deviceAuth: { authenticate: () => principal }, pairingRoute: no, signalObserver: { asset: () => false },
    opsRoute: no, shannonNowRoute: no, moodHistoryRoute: no, skillsRoute: no, valuesRoute: no, fca: null,
    stream: { serve: no }, deviceUsage: new Map(), bodyUsage: new Map(), activeChats: 0,
    handleVoiceTranscription: no, geminiSpeechRoute: no, geminiLiveRoute: no, liveVoiceStreamRoute: no,
  } as unknown as ApiRequestPorts;
  return { ports, dispatch, afterHost };
}

async function request(ports: ApiRequestPorts, pathname: string, authorization?: string) {
  const escaped: unknown[] = [];
  let completed!: () => void;
  const done = new Promise<void>(resolve => { completed = resolve; });
  const handler = createApiRequestHandler(ports);
  const server = createServer((incoming, response) => {
    void Promise.resolve(handler(incoming, response)).catch(error => {
      escaped.push(error);
      if (!response.writableEnded) response.end();
    }).finally(completed);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const reply = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: pathname, agent: false,
      ...(authorization ? { headers: { authorization } } : {}) }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) }));
    }).on('error', reject);
  });
  await done;
  return { ...reply, escaped };
}

describe('HTTP受付で処理済みの経路は一度だけ応答する', () => {
  it.each(['deviceActions', 'innerNote', 'addressed', 'serveListen', 'miniPoses', 'stage5'] as const)(
    '%s が応答した後はkernelへ進まない', async name => {
      const { ports, dispatch } = harness();
      const serve = (_request: unknown, response: import('node:http').ServerResponse) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ handled: name }));
        return true;
      };
      if (name === 'serveListen') ports.serveListen = (async (...args: unknown[]) => serve(args[0], args[1] as import('node:http').ServerResponse)) as ApiRequestPorts['serveListen'];
      else (ports as unknown as Record<string, unknown>)[name] = { ...(ports[name] ?? {}), serve };
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const reply = await request(ports, '/v1/review/handled');
      expect(reply).toEqual({ status: 200, body: { handled: name }, escaped: [] });
      expect(dispatch).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(ports.activeChats).toBe(0);
    },
  );

  it.each([
    { name: 'Host未設定', token: '', auth: undefined, status: 503, code: 'AGENT_HOST_NOT_CONFIGURED' },
    { name: 'Host認証拒否', token: 'test-only-host-token-'.repeat(3), auth: 'Bearer wrong', status: 401, code: 'AGENT_HOST_UNAUTHORIZED' },
  ])('$name の応答後は機器認証へ進まない', async test => {
    vi.stubEnv('SHANNON_AGENT_HOST_TOKEN', test.token);
    const { ports, dispatch } = harness();
    const authenticate = vi.spyOn(ports.deviceAuth!, 'authenticate');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await request(ports, '/v1/agent/host/commands', test.auth)).toEqual({ status: test.status, body: { error: test.code }, escaped: [] });
    expect(authenticate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it('Hostに応答した後は機器認証へ進まず、後処理を一度だけ行う', async () => {
    const token = 'test-only-host-token-'.repeat(3);
    vi.stubEnv('SHANNON_AGENT_HOST_TOKEN', token);
    const { ports, dispatch, afterHost } = harness();
    const authenticate = vi.spyOn(ports.deviceAuth!, 'authenticate');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await request(ports, '/v1/agent/host/commands', `Bearer ${token}`)).toEqual({ status: 200, body: { handled: 'kernel' }, escaped: [] });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(afterHost).toHaveBeenCalledTimes(1);
    expect(authenticate).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });
});


describe('chat同時実行枠の受付は一度に確保する', () => {
  it('残り1枠への同時到着では片方だけを通し、終わると枠を返す', async () => {
    const { ports, dispatch } = harness();
    ports.activeChats = 1;
    let peak = ports.activeChats;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    dispatch.mockImplementation(async () => {
      peak = Math.max(peak, ports.activeChats);
      await gate;
      return { status: 200, body: { handled: 'kernel' } };
    });
    const handler = createApiRequestHandler(ports);
    const requests = [0, 1].map(() => {
      const socket = new Socket();
      const incoming = new IncomingMessage(socket);
      incoming.method = 'GET';
      incoming.url = '/v1/chat';
      return { socket, incoming, response: new ServerResponse(incoming) };
    });
    const running = requests.map(({ incoming, response }) => Promise.resolve(handler(incoming, response)));
    try {
      await vi.waitFor(() => expect(dispatch.mock.calls.length).toBeGreaterThan(0));
    } finally {
      finish();
      await Promise.all(running);
      for (const { socket } of requests) socket.destroy();
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(requests.map(({ response }) => response.statusCode).sort()).toEqual([200, 429]);
    expect(peak).toBe(2);
    expect(ports.activeChats).toBe(1);
  });
});
