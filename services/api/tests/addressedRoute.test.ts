import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShannonDevicePrincipal } from '../src/infra/auth/deviceAuth.js';
import type { JevChooser } from '../src/infra/models/jev/jevChoice.js';
import { AddressedJudge } from '../src/mind/perception/addressed.js';
import { configuredAddressedJudge, configuredAddressedVoice } from '../src/wiring/addressedWiring.js';
import { ADDRESSED_PATH, createAddressedRoute } from '../src/surfaces/voice/serverAddressedRoute.js';

/** `POST /v1/voice/addressed` (owner 2026-10-21): the Windows resident asks the head whether the words with her name in them were said to her. */
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

const principal = { deviceId: 'desk-1', scopeKey: 'owner' } as unknown as ShannonDevicePrincipal;

async function serve(judge: AddressedJudge | null, device: ShannonDevicePrincipal | null = principal, now?: () => number) {
  const route = createAddressedRoute(judge, now);
  const server = createServer((request, response) => { void route(request, response, device); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ADDRESSED_PATH}`;
  return (body: unknown, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
}

function talkAboutIsNo() {
  const asked: Array<Record<string, unknown>> = [];
  const chooser = {
    decide: async (request: { state: unknown }) => {
      const state = request.state as Record<string, unknown>;
      asked.push(state);
      const about = /ってさ/u.test(String(state.utterance));
      return { value: { addressed: !about, target: about ? 'about_shannon' : 'shannon', noul: about ? 0.05 : 0.95, reason: about ? 'about_her' : /シャノン/u.test(String(state.utterance)) ? 'named' : 'continuation' }, source: 'jev' as const };
    },
  } as unknown as Pick<JevChooser, 'decide'>;
  return { asked, judge: new AddressedJudge({ chooser }) };
}

describe('POST /v1/voice/addressed', () => {
  it('answers whether the words were said to her, asking the one judge with the owner alone', async () => {
    const { asked, judge } = talkAboutIsNo();
    const call = await serve(judge);
    const yes = await call({ text: 'シャノン、今日の天気は？' });
    expect(yes.status).toBe(200);
    expect(await yes.json()).toMatchObject({ addressed: true, reason: 'named', source: 'jev', asked: true });
    const no = await call({ text: 'シャノンってさ、昨日エンドラで死んだんだって' });
    expect(await no.json()).toMatchObject({ addressed: false, reason: 'about_her', source: 'jev' });
    expect(asked[0]).toMatchObject({ people_present: 1, alone_with_shannon: true, speaker: 'owner', shannon_spoke_seconds_ago: null });
    // No name and not after her: no question, and not to her.
    const quiet = await call({ text: 'あー疲れた、今日は早く寝よう' });
    expect(await quiet.json()).toMatchObject({ addressed: false, reason: 'no_name', source: 'rule', asked: false });
    expect(asked).toHaveLength(2);
  });

  it('reads how long ago she spoke and whether others are listening', async () => {
    const { asked, judge } = talkAboutIsNo();
    const call = await serve(judge);
    expect(await (await call({ text: 'それってどういう意味？', shannonSpokeMsAgo: 4_000, lastLine: '次はネザーだね。' })).json()).toMatchObject({ addressed: true, reason: 'continuation' });
    expect(await (await call({ text: 'それってどういう意味？', shannonSpokeMsAgo: 40_000 })).json()).toMatchObject({ addressed: false, asked: false });
    await call({ text: 'シャノン、聞いて', guest: true });
    expect(asked[0]).toMatchObject({ shannon_spoke_seconds_ago: 4, shannon_last_line: '次はネザーだね。', follows_her_last_words: true });
    expect(asked[1]).toMatchObject({ people_present: 2, alone_with_shannon: false });
  });

  it('refuses what it cannot judge: no device, a bad body, the switch off, too many', async () => {
    const { judge } = talkAboutIsNo();
    expect((await (await serve(judge, null)) ({ text: 'シャノン' })).status).toBe(403);
    const call = await serve(judge);
    expect((await call({}, 'GET')).status).toBe(405);
    for (const bad of [{}, { text: '' }, { text: 'x'.repeat(1_001) }, { text: 'シャノン', shannonSpokeMsAgo: -1 }, { text: 'シャノン', guest: 'yes' }, [], 'text']) {
      expect((await call(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const off = await (await serve(null))({ text: 'シャノン、いる？' });
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: 'ADDRESSED_DISABLED' });
    let clock = 0;
    const limited = await serve(judge, principal, () => clock);
    for (let index = 0; index < 30; index += 1) expect((await limited({ text: 'シャノン、いる？' })).status).toBe(200);
    expect((await limited({ text: 'シャノン、いる？' })).status).toBe(429);
    clock += 61_000;
    expect((await limited({ text: 'シャノン、いる？' })).status).toBe(200);
  });
});

describe('configuredAddressedJudge', () => {
  it('is absent while the switch is off, and without a Jev key it still judges by the local rules', async () => {
    expect(configuredAddressedJudge({}, { trace: null })).toBeNull();
    const judge = configuredAddressedJudge({ SHANNON_ADDRESSED: 'on' }, { trace: null })!;
    expect(judge.timeoutMilliseconds).toBe(400);
    expect(judge.windowMilliseconds).toBe(20_000);
    expect(await judge.judge({ scopeKey: 'owner', transcript: 'シャノン、いる？', speaker: { id: 'a', name: 'ア' }, humans: 1 })).toMatchObject({ addressed: true, source: 'fallback' });
    const tuned = configuredAddressedJudge({ SHANNON_ADDRESSED: 'on', SHANNON_ADDRESSED_TIMEOUT_MS: '300', SHANNON_ADDRESSED_WINDOW_SECONDS: '15', TYPESAFE_API_KEY: 'k' }, { trace: null })!;
    expect([tuned.timeoutMilliseconds, tuned.windowMilliseconds]).toEqual([300, 15_000]);
    const bad = configuredAddressedJudge({ SHANNON_ADDRESSED: 'on', SHANNON_ADDRESSED_TIMEOUT_MS: '5', SHANNON_ADDRESSED_WINDOW_SECONDS: '9999' }, { trace: null })!;
    expect([bad.timeoutMilliseconds, bad.windowMilliseconds]).toEqual([400, 20_000]);
  });
});

describe('configuredAddressedVoice (what server.ts holds)', () => {
  it('serves only its own path for a paired device, and has no judge while the switch is off', async () => {
    const off = configuredAddressedVoice({}, { trace: null });
    expect(off.judge).toBeNull();
    const on = configuredAddressedVoice({ SHANNON_ADDRESSED: 'on' }, { trace: null });
    expect(on.judge).not.toBeNull();
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      void on.serve(request, response, principal, url).then(served => { if (!served) { response.statusCode = 404; response.end('not mine'); } });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const mine = await fetch(`${base}${ADDRESSED_PATH}`, { method: 'POST', body: JSON.stringify({ text: 'シャノン、いる？' }) });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ addressed: true, source: 'fallback' });
    expect((await fetch(`${base}/v1/voice/speech/stream`, { method: 'POST', body: '{}' })).status).toBe(404);
  });
});