import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonApiKernel } from '../src/infra/http/apiKernel.js';
import type { ShannonDevicePrincipal } from '../src/infra/auth/deviceAuth.js';
import { createLiveVoiceStreamRoute, SpokenSentenceSegmenter } from '../src/surfaces/voice/serverLiveVoiceStreamRoute.js';
import { WAITING_CUE_DELAY_MILLISECONDS } from '../src/surfaces/voice/voiceWaitingCue.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('live voice sentence streaming', () => {
  // Owner feedback 2026-10-13: the fixed line is a fallback for silence, said only when none of her words came within the delay.
  async function waitingRun(silenceMilliseconds: number) {
    const answerPlan = {
      shouldRespond: true, affect: 'focused', affectIntensity: 0.3, delivery: 'focused',
      waitingPhrase: '空模様を確かめますね。',
      waitingPerformance: { affect: 'caring', intensity: 0.6, delivery: 'gentle' },
    };
    const heardBeforeAnswer: boolean[] = [];
    const kernel = {
      streamLiveVoiceDelegation: async (_request: unknown, observer: {
        onPlan(plan: Record<string, unknown>): Promise<void>;
        onTextDelta(delta: string): Promise<void>;
        waitingSaid?(): boolean;
      }) => {
        await observer.onPlan(answerPlan);
        await observer.onPlan(answerPlan);
        await vi.advanceTimersByTimeAsync(silenceMilliseconds);
        heardBeforeAnswer.push(observer.waitingSaid?.() === true);
        await observer.onTextDelta('答えです。');
        await vi.advanceTimersByTimeAsync(WAITING_CUE_DELAY_MILLISECONDS * 2);
        return { status: 200, body: { threadId: 'thread', reply: '答えです。' } };
      },
    } as unknown as ShannonApiKernel;
    const request = Readable.from([JSON.stringify({ transcript: '今日の天気は？' })]) as IncomingMessage;
    request.method = 'POST';
    let output = '';
    const response = Object.assign(new EventEmitter(), {
      headersSent: false,
      writeHead() { this.headersSent = true; return this; },
      write(value: string) { output += value; return true; },
      end() {},
    }) as unknown as ServerResponse;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await createLiveVoiceStreamRoute(kernel, () => true)(
        request, response, { deviceId: 'device', scopeKey: 'owner' } as ShannonDevicePrincipal,
      );
    } finally { vi.useRealTimers(); }
    const segments = output.trim().split('\n').map(line => JSON.parse(line) as {
      type: string; text?: string; voicePlan?: Record<string, unknown>;
    }).filter(event => event.type === 'segment');
    return { segments, heardBeforeAnswer: heardBeforeAnswer[0] };
  }

  it('speaks one waiting line with its own acting plan only after a silence before the answer', async () => {
    const { segments, heardBeforeAnswer } = await waitingRun(WAITING_CUE_DELAY_MILLISECONDS + 100);
    expect(heardBeforeAnswer).toBe(true);
    expect(segments.map(segment => segment.text)).toEqual(['空模様を確かめますね。', '答えです。']);
    expect(segments[0]?.voicePlan).toMatchObject({
      affect: 'caring', affectIntensity: 0.6, delivery: 'gentle',
    });
    expect(segments[1]?.voicePlan).toMatchObject({
      affect: 'focused', affectIntensity: 0.3, delivery: 'focused',
    });
  });

  it('says no waiting line when her own words come first', async () => {
    const { segments, heardBeforeAnswer } = await waitingRun(WAITING_CUE_DELAY_MILLISECONDS - 500);
    expect(heardBeforeAnswer).toBe(false);
    expect(segments.map(segment => segment.text)).toEqual(['答えです。']);
  });

  it('ends a reply cut at its length limit as completed, after its last complete sentence', async () => {
    const run = async (deltas: string[], reply: string) => {
      const kernel = {
        streamLiveVoiceDelegation: async (_request: unknown, observer: {
          onPlan(plan: Record<string, unknown>): Promise<void>;
          onTextDelta(delta: string): Promise<void>;
        }) => {
          await observer.onPlan({ shouldRespond: true });
          for (const delta of deltas) await observer.onTextDelta(delta);
          return { status: 200, body: { threadId: 'thread', reply, truncated: true } };
        },
      } as unknown as ShannonApiKernel;
      const request = Readable.from([JSON.stringify({ transcript: '長いセリフを言って' })]) as IncomingMessage;
      request.method = 'POST';
      let output = '';
      const response = Object.assign(new EventEmitter(), {
        headersSent: false,
        writeHead() { this.headersSent = true; return this; },
        write(value: string) { output += value; return true; },
        end() {},
      }) as unknown as ServerResponse;
      await createLiveVoiceStreamRoute(kernel, () => true)(
        request, response, { deviceId: 'device', scopeKey: 'owner' } as ShannonDevicePrincipal,
      );
      return output.trim().split('\n').map(line => JSON.parse(line) as {
        type: string; text?: string; response?: Record<string, unknown>;
      });
    };

    const events = await run(['むかしむかし。', '灯台がありました。そ', 'して'], 'むかしむかし。灯台がありました。');
    expect(events.filter(event => event.type === 'segment').map(event => event.text))
      .toEqual(['むかしむかし。', '灯台がありました。']);
    // The same terminal event as always, so an app that predates the flag finishes the turn too.
    expect(events.at(-1)).toMatchObject({ type: 'completed', response: { reply: 'むかしむかし。灯台がありました。', truncated: true } });
    expect(events.some(event => event.type === 'error')).toBe(false);

    // Not one sentence finished: what she wrote is still said rather than nothing.
    const unfinished = await run(['とても長い一文が続いて'], 'とても長い一文が続いて');
    expect(unfinished.filter(event => event.type === 'segment').map(event => event.text)).toEqual(['とても長い一文が続いて']);
  });

  it('names a withheld reply in its error line, so the app drops what it was saying', async () => {
    const run = async (failure: Error) => {
      const kernel = {
        streamLiveVoiceDelegation: async (_request: unknown, observer: {
          onPlan(plan: Record<string, unknown>): Promise<void>;
          onTextDelta(delta: string): Promise<void>;
        }) => {
          await observer.onPlan({ shouldRespond: true });
          await observer.onTextDelta('途中まで話しました。');
          throw failure;
        },
      } as unknown as ShannonApiKernel;
      const request = Readable.from([JSON.stringify({ transcript: '話して' })]) as IncomingMessage;
      request.method = 'POST';
      let output = '';
      const response = Object.assign(new EventEmitter(), {
        headersSent: false,
        writeHead() { this.headersSent = true; return this; },
        write(value: string) { output += value; return true; },
        end() {},
      }) as unknown as ServerResponse;
      await createLiveVoiceStreamRoute(kernel, () => true)(
        request, response, { deviceId: 'device', scopeKey: 'owner' } as ShannonDevicePrincipal,
      );
      return JSON.parse(output.trim().split('\n').at(-1)!) as Record<string, unknown>;
    };
    expect(await run(new Error('OPENAI_RESPONSE_CONTENT_FILTERED'))).toEqual({ type: 'error', status: 502, code: 'content_filter' });
    // Any other failure keeps the line exactly as before.
    expect(await run(new Error('OPENAI_RESPONSE_IDLE_TIMEOUT'))).toEqual({ type: 'error', status: 502 });
  });

  it('emits complete Japanese sentences across arbitrary model deltas', () => {
    const segmenter = new SpokenSentenceSegmenter();

    expect(segmenter.append('聞こえて')).toEqual([]);
    expect(segmenter.append('るよ。「ここ')).toEqual(['聞こえてるよ。']);
    expect(segmenter.append('にいる！」次')).toEqual(['「ここにいる！」']);
    expect(segmenter.flush()).toEqual(['次']);
  });

  it('treats newlines as safe speech boundaries and removes layout whitespace', () => {
    const segmenter = new SpokenSentenceSegmenter();

    expect(segmenter.append('まず答えるね。\n  続き')).toEqual(['まず答えるね。']);
    expect(segmenter.flush()).toEqual(['続き']);
  });
});

describe('live voice request ownership', () => {
  it('releases a disconnected turn immediately without letting its late completion release the next turn', async () => {
    const first = deferred<{ status: number; body: object }>();
    const second = deferred<{ status: number; body: object }>();
    const starts = [deferred<void>(), deferred<void>(), deferred<void>()];
    let calls = 0;
    const kernel = {
      streamLiveVoiceDelegation: async () => {
        const index = calls++;
        starts[index]?.resolve(undefined);
        return index === 0 ? first.promise : index === 1 ? second.promise
          : { status: 200, body: { threadId: 'thread', reply: '返答。' } };
      },
    } as unknown as ShannonApiKernel;
    const handle = createLiveVoiceStreamRoute(kernel, () => true);
    const principal = { deviceId: 'device', scopeKey: 'owner' } as ShannonDevicePrincipal;
    const transport = () => {
      const request = Readable.from([JSON.stringify({ transcript: 'テスト' })]) as IncomingMessage;
      request.method = 'POST';
      let status = 0;
      let body = '';
      const response = Object.assign(new EventEmitter(), {
        headersSent: false,
        writeHead(code: number) { status = code; this.headersSent = true; return this; },
        write(value: string) { body += value; return true; },
        end(value?: string) { body += value ?? ''; },
      }) as unknown as ServerResponse;
      return { request, response, get status() { return status; }, get body() { return body; } };
    };

    const old = transport();
    const oldRun = handle(old.request, old.response, principal);
    await starts[0]!.promise;
    old.request.emit('aborted');

    const current = transport();
    const currentRun = handle(current.request, current.response, principal);
    await starts[1]!.promise;
    first.resolve({ status: 200, body: { threadId: 'old', reply: '古い返答。' } });
    await oldRun;
    expect(old.status).toBe(0);

    const blocked = transport();
    await handle(blocked.request, blocked.response, principal);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toContain('BUSY');

    current.request.emit('aborted');
    const next = transport();
    await handle(next.request, next.response, principal);
    await starts[2]!.promise;
    expect(next.status).toBe(200);
    second.resolve({ status: 200, body: { threadId: 'second', reply: '古い返答。' } });
    await currentRun;
    expect(current.status).toBe(0);
  });
});
