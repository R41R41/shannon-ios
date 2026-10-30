import { afterEach, describe, expect, it } from 'vitest';
import { StreamMouth } from '../src/surfaces/stream/streamMouth.js';
import { handlePlatformBridgeRequest, isPlatformBridgePath } from '../src/surfaces/platform/serverPlatformBridgeRoute.js';
import { BRIDGE_TOKEN, T0, makePlace, serveRoutes, stamp, type Place } from './streamHarness.js';

/**
 * The stream's routes over a real local server: the desktop's (a paired owner device) and the ear's (the bridge token), and the lines as
 * Server-Sent Events. Nothing is switched on anywhere: a started stream is all it takes.
 */
const opened: Array<() => void> = [];
afterEach(() => { while (opened.length) opened.pop()!(); });

const ready = async (options: Parameters<typeof makePlace>[0] & { keepalive?: number } = {}) => {
  const place = makePlace(options);
  const server = await serveRoutes(place);
  opened.push(() => { place.service.stop(); server.close(); });
  return { place, ...server };
};

interface SseEvent { event: string; data: string }

/** Reads the event stream until `until` is true (or a timeout), then closes it. */
async function readSse(base: string, path: string, until: (events: SseEvent[], raw: string) => boolean, milliseconds = 3000): Promise<{ events: SseEvent[]; raw: string }> {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, { signal: controller.signal, headers: { authorization: 'Bearer x' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  const events: SseEvent[] = [];
  const stopAt = Date.now() + milliseconds;
  while (Date.now() < stopAt) {
    const read = await Promise.race([reader.read(), new Promise<null>(resolve => setTimeout(() => resolve(null), 50))]);
    if (read && read.value) raw += decoder.decode(read.value);
    events.length = 0;
    for (const block of raw.split('\n\n')) {
      const event = /^event: (.+)$/mu.exec(block)?.[1], data = /^data: (.+)$/mu.exec(block)?.[1];
      if (event && data) events.push({ event, data });
    }
    if (until(events, raw) || read?.done) break;
  }
  controller.abort();
  return { events, raw };
}

describe('the ear\'s routes (contract §2)', () => {
  it('refuse without the bridge token, and answer as if nothing happened while no stream is started', async () => {
    const { call } = await ready();
    expect((await call('GET', '/v1/platform/stream/state', undefined, 'wrong')).status).toBe(401);
    expect((await call('POST', '/v1/platform/stream/comments', { streamId: 'x', comments: [] }, 'wrong')).status).toBe(401);
    expect(await call('GET', '/v1/platform/stream/state')).toMatchObject({ status: 200, json: { stream: null, chatPosts: [] } });
    expect(await call('POST', '/v1/platform/stream/comments', { streamId: 'st-none', comments: [] })).toMatchObject({ status: 409, json: { error: 'STREAM_NOT_LIVE' } });
    expect(await call('POST', '/v1/platform/stream/broadcast', { streamId: 'st-none', videoId: 'v', liveChatId: 'l' })).toMatchObject({ status: 409 });
    expect(await call('GET', '/v1/stream')).toMatchObject({ status: 200, json: { stream: null, comments: [] } });
  });

  it('is part of the bridge paths, and answers 503 without a bridge configuration or without a stream', async () => {
    expect(isPlatformBridgePath('/v1/platform/stream/state')).toBe(true);
    const response = { status: 0, body: '' };
    const fake = { writeHead(status: number) { response.status = status; }, end(body: string) { response.body = body; } };
    await handlePlatformBridgeRequest('/v1/platform/stream/state', { method: 'GET', headers: {} } as never, fake as never, null);
    expect(response.status).toBe(503);
    await handlePlatformBridgeRequest('/v1/platform/stream/state', { method: 'GET', headers: { authorization: `Bearer ${BRIDGE_TOKEN}` } } as never, fake as never,
      { configuration: { token: BRIDGE_TOKEN }, stream: null } as never);
    expect(response.status).toBe(503);
    expect(response.body).toContain('STREAM_NOT_CONFIGURED');
  });

  it('takes the broadcast, the comments (repeats ignored), and says what the ear should poll', async () => {
    const { place, call } = await ready();
    const { json: started } = await call('POST', '/v1/stream/start', { title: 'テスト', minecraft: false });
    const streamId = started!.stream.streamId as string;
    expect(await call('GET', '/v1/platform/stream/state')).toMatchObject({ json: { stream: { streamId, phase: 'waiting_for_chat', chatWrites: false, broadcast: null } } });
    const broadcast = await call('POST', '/v1/platform/stream/broadcast', { streamId, videoId: 'vid', liveChatId: 'lc', title: 'T', channelId: 'ch', onAir: true });
    expect(broadcast).toMatchObject({ status: 200, json: { stream: { phase: 'live', broadcast: { videoId: 'vid', liveChatId: 'lc' } } } });
    const body = { streamId, comments: [place.comment('こんにちは'), place.comment('シャノン、元気？'), place.comment('こんにちは', { id: 'c1' })] };
    const first = await call('POST', '/v1/platform/stream/comments', body);
    expect(first).toMatchObject({ status: 202, json: { accepted: 2, duplicates: 1, chatPosts: [] } });
    expect((await call('POST', '/v1/platform/stream/comments', body)).json).toMatchObject({ accepted: 0, duplicates: 3 });
    expect(await call('POST', '/v1/platform/stream/comments', { streamId: 'other', comments: [] })).toMatchObject({ status: 409, json: { error: 'STREAM_NOT_LIVE' } });
    expect(await call('POST', '/v1/platform/stream/comments', { streamId, comments: 'x' })).toMatchObject({ status: 400 });
    const many = Array.from({ length: 201 }, (_, index) => place.comment(`ひとこと${index}`));
    expect(await call('POST', '/v1/platform/stream/comments', { streamId, comments: many })).toMatchObject({ status: 400, json: { error: 'STREAM_TOO_MANY_COMMENTS' } });
  });

  it('cuts a comment\'s words to 300 characters and leaves a malformed one out', async () => {
    const { place, call } = await ready();
    const streamId = (await call('POST', '/v1/stream/start', {})).json!.stream.streamId as string;
    await call('POST', '/v1/platform/stream/comments', { streamId, comments: [place.comment('あ'.repeat(400)), { id: 'bad' }] });
    const comments = (await call('GET', '/v1/stream')).json!.comments as { text: string }[];
    expect(comments).toHaveLength(1);
    expect(comments[0]!.text).toHaveLength(300);
  });

  it('ends the stream when the ear says the chat ended, and posts chat replies only with chatWrites', async () => {
    const { place, call } = await ready();
    const streamId = (await call('POST', '/v1/stream/start', { chatWrites: true })).json!.stream.streamId as string;
    await onAir(place);
    await call('POST', '/v1/platform/stream/comments', { streamId, comments: [place.comment('こんにちは')] });
    await place.step(100);
    await place.drain();
    const state = (await call('GET', '/v1/platform/stream/state')).json!;
    expect(state.chatPosts).toHaveLength(1);
    expect(await call('POST', `/v1/platform/stream/chat-posts/${state.chatPosts[0].id}/receipt`, { outcome: 'posted' })).toMatchObject({ status: 204 });
    expect((await call('GET', '/v1/platform/stream/state')).json!.chatPosts).toEqual([]);
    expect(await call('POST', '/v1/platform/stream/broadcast', { streamId, ended: true })).toMatchObject({ status: 200, json: { stream: { phase: 'ended' } } });
    expect((await call('GET', '/v1/platform/stream/state')).json).toEqual({ stream: null, chatPosts: [] });
  });
});

describe('the desktop\'s routes (contract §1)', () => {
  it('start (201, then 200 with the same stream), the console view, controls, and end with its summary', async () => {
    const { place, call } = await ready();
    const first = await call('POST', '/v1/stream/start', { title: 'T', minecraft: true, chatWrites: false });
    expect(first.status).toBe(201);
    expect(first.json!.stream).toMatchObject({ title: 'T', minecraft: true, chatWrites: false, phase: 'waiting_for_chat', paused: false });
    expect(await call('POST', '/v1/stream/start', {})).toMatchObject({ status: 200, json: { stream: { streamId: first.json!.stream.streamId } } });
    expect((await call('POST', '/v1/stream/start', { title: 5 })).status).toBe(400);
    const streamId = first.json!.stream.streamId as string;
    await call('POST', '/v1/platform/stream/comments', { streamId, comments: [place.comment('ふつうのコメント')] });
    const view = (await call('GET', '/v1/stream')).json!;
    expect(view).toMatchObject({ stream: { streamId }, notices: [], comments: [{ authorName: '視聴者1', status: 'new', tags: [] }] });
    expect(view.stats).toMatchObject({ comments: 1, answered: 0, waiting: 0, inFlight: 0, modelCallsLastMinute: 0, firstSoundMedianMs: null, lineMedianMs: null });
    expect(await call('POST', '/v1/stream/controls', { action: 'pause' })).toMatchObject({ status: 200, json: { ok: true } });
    expect((await call('GET', '/v1/stream')).json!.stream.paused).toBe(true);
    expect((await call('POST', '/v1/stream/controls', { action: 'dance' })).status).toBe(400);
    expect((await call('POST', '/v1/stream/controls', { action: 'ignore' })).status).toBe(400);
    const end = await call('POST', '/v1/stream/end', { streamId });
    expect(end).toMatchObject({ status: 200, json: { stream: { phase: 'ended' }, summary: { comments: 1, answered: 0, lines: 0, notices: 0, declined: 0 } } });
    expect(await call('POST', '/v1/stream/end', { streamId })).toMatchObject({ status: 409, json: { error: 'STREAM_NOT_LIVE' } });
    expect((await call('GET', '/v1/stream')).json!).toMatchObject({ stream: { phase: 'ended' }, comments: [] });
  });

  it('is for the owner\'s paired device only', async () => {
    const place = makePlace();
    const none = await serveRoutes(place, null);
    opened.push(() => none.close());
    expect(await none.call('GET', '/v1/stream')).toMatchObject({ status: 401, json: { error: 'STREAM_PAIRING_REQUIRED' } });
    const other = await serveRoutes(place, { deviceId: 'd2', scopeKey: 'someone-else', displayName: 'x' });
    opened.push(() => other.close());
    expect(await other.call('POST', '/v1/stream/start', {})).toMatchObject({ status: 403, json: { error: 'STREAM_OWNER_ONLY' } });
    expect(place.service.liveView()).toBeNull();
  });

  it('takes the receipt of a line, any reason the desktop gives, and answers 404 for a line it never made', async () => {
    const { place, call } = await ready();
    await call('POST', '/v1/stream/start', {});
    await onAir(place);
    const line = place.service.mouth.currentLine()!;
    expect((await call('POST', `/v1/stream/lines/${line.id}/receipt`, { outcome: 'maybe' })).status).toBe(400);
    expect(await call('POST', `/v1/stream/lines/${line.id}/receipt`, { outcome: 'failed', reason: 'output_blocked' })).toMatchObject({ status: 204 });
    expect(await call('POST', `/v1/stream/lines/${line.id}/receipt`, { outcome: 'failed', reason: 'output_blocked' })).toMatchObject({ status: 204 });
    expect((await call('POST', '/v1/stream/lines/ln-never/receipt', { outcome: 'spoken' })).status).toBe(404);
    expect(place.service.stats().measure.lineEnds).toMatchObject({ 'failed:output_blocked': 1 });
    for (const reason of ['output_off', 'output_lost', 'nothing_to_say', 'internal_error', 'a reason with spaces!', 'x'.repeat(200)]) {
      const next = place.service.mouth.currentLine();
      if (!next) break;
      expect(await call('POST', `/v1/stream/lines/${next.id}/receipt`, { outcome: 'skipped', reason })).toMatchObject({ status: 204 });
    }
  });
});

describe('her mouth as Server-Sent Events (contract §1)', () => {
  const lineEvents = (events: SseEvent[]) => events.filter(item => item.event === 'line').map(item => JSON.parse(item.data) as Record<string, any>);

  it('sends the state on connect and then the greeting line, one at a time, the next after the receipt', async () => {
    const { place, base, call } = await ready();
    await call('POST', '/v1/stream/start', { title: 'T' });
    await onAir(place);
    const { events } = await readSse(base, '/v1/stream/lines', list => lineEvents(list).length >= 1);
    expect(events[0]!.event).toBe('state');
    expect(JSON.parse(events[0]!.data)).toMatchObject({ stream: { phase: 'live', title: 'T' } });
    const [greeting] = lineEvents(events);
    expect(greeting).toMatchObject({ seq: 1, kind: 'greeting', streamId: expect.any(String), answering: [], plan: { affect: expect.any(String), delivery: expect.any(String) } });
    expect(greeting!.text.length).toBeLessThanOrEqual(120);
    expect(Date.parse(greeting!.expiresAt)).toBeGreaterThan(Date.parse(greeting!.createdAt));
    const streamId = greeting!.streamId as string;
    place.service.ingest(streamId, [place.comment('こんにちは'), place.comment('やあ')]);
    await place.step(100);
    const second = await readSse(base, '/v1/stream/lines?after=1', list => list.some(item => item.event === 'state'), 400);
    expect(lineEvents(second.events)).toEqual([]);
    await call('POST', `/v1/stream/lines/${greeting!.id}/receipt`, { outcome: 'spoken', startedAt: stamp(place.clock.t), endedAt: stamp(place.clock.t + 1000) });
    const third = await readSse(base, '/v1/stream/lines?after=1', list => lineEvents(list).length >= 1);
    expect(lineEvents(third.events)[0]).toMatchObject({ seq: 2, kind: 'reply', answering: [{ authorName: '視聴者1', kind: 'text' }] });
  });

  it('sends a keepalive comment, and the state again on every phase change', async () => {
    const mouth = new StreamMouth({ now: () => T0, keepaliveMilliseconds: 30 });
    const { place, base, call } = await ready({ mouth });
    const streamId = (await call('POST', '/v1/stream/start', {})).json!.stream.streamId as string;
    const reading = readSse(base, '/v1/stream/lines', (events, raw) => raw.includes(': keepalive') && events.filter(item => item.event === 'state').length >= 2, 2000);
    await new Promise(resolve => setTimeout(resolve, 100));
    await place.service.broadcast({ streamId, videoId: 'v', liveChatId: 'l', title: '', channelId: '', onAir: true });
    const { events, raw } = await reading;
    expect(raw).toContain(': keepalive');
    expect(events.filter(item => item.event === 'state').map(item => JSON.parse(item.data).stream.phase)).toEqual(['waiting_for_chat', 'live']);
  });

  it('keeps taking connections after the end, and hands the closing line for 25 s', async () => {
    const { place, base, call } = await ready();
    const streamId = (await call('POST', '/v1/stream/start', {})).json!.stream.streamId as string;
    await onAir(place);
    await place.drain();
    expect(await call('POST', '/v1/stream/end', { streamId })).toMatchObject({ status: 200 });
    place.clock.t += 20_000;
    const { events } = await readSse(base, '/v1/stream/lines', list => lineEvents(list).length >= 1);
    expect(JSON.parse(events[0]!.data)).toMatchObject({ stream: { phase: 'ended' } });
    expect(lineEvents(events)[0]).toMatchObject({ kind: 'closing' });
  });
});

async function onAir(place: Place): Promise<void> {
  const streamId = place.service.liveView()!.streamId;
  await place.service.broadcast({ streamId, videoId: 'v', liveChatId: 'lc', title: 'T', channelId: 'ch', onAir: true });
  await place.service.settle();
  place.service.control({ action: 'program_next' });
  place.service.control({ action: 'program_next' });
}
