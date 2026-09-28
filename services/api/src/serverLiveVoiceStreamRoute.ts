import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonApiKernel } from './apiKernel.js';
import type { ShannonDevicePrincipal } from './deviceAuth.js';
import { bindScope, readJson, sendJson } from './serverHttp.js';

type ConsumeAllowance = (deviceId: string) => boolean;

export function createLiveVoiceStreamRoute(
  kernel: ShannonApiKernel,
  consumeAllowance: ConsumeAllowance,
) {
  const activeScopes = new Set<string>();

  return async function handleLiveVoiceStream(
    request: IncomingMessage,
    response: ServerResponse,
    principal: ShannonDevicePrincipal | null,
  ): Promise<void> {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    if (!consumeAllowance(principal.deviceId)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
    }
    if (activeScopes.has(principal.scopeKey)) {
      return sendJson(response, 429, { error: 'BUSY', message: 'いま返答を考えています。' });
    }

    activeScopes.add(principal.scopeKey);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    const segmenter = new SpokenSentenceSegmenter();
    let voicePlan: Record<string, unknown> | undefined;
    let receivedDelta = false;
    try {
      const body = bindScope(await readJson(request, 64 * 1024), principal.scopeKey);
      const apiResponse = await kernel.streamLiveVoiceDelegation({
        method: 'POST',
        path: '/v1/voice/gemini/cascade/delegations',
        body,
      }, {
        signal: controller.signal,
        onPlan: async plan => {
          voicePlan = plan;
          startStream(response);
          await writeEvent(response, { type: 'plan', voicePlan: plan });
        },
        onTextDelta: async delta => {
          receivedDelta = true;
          for (const segment of segmenter.append(delta)) {
            startStream(response);
            await writeEvent(response, { type: 'segment', text: segment, voicePlan });
          }
        },
      });

      if (apiResponse.status < 200 || apiResponse.status >= 300) {
        if (!response.headersSent) return sendJson(response, apiResponse.status, apiResponse.body);
        await writeEvent(response, { type: 'error', status: apiResponse.status });
        response.end();
        return;
      }
      const bodyRecord = record(apiResponse.body);
      const reply = typeof bodyRecord?.reply === 'string' ? bodyRecord.reply : '';
      if (!receivedDelta && reply) {
        for (const segment of segmenter.append(reply)) {
          startStream(response);
          await writeEvent(response, { type: 'segment', text: segment, voicePlan });
        }
      }
      for (const segment of segmenter.flush()) {
        startStream(response);
        await writeEvent(response, { type: 'segment', text: segment, voicePlan });
      }
      startStream(response);
      await writeEvent(response, { type: 'completed', response: apiResponse.body });
      response.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('Shannon live voice stream failed', {
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      if (!response.headersSent) {
        sendJson(response, 502, { error: 'MODEL_UNAVAILABLE', message: '返答を生成できませんでした。' });
      } else {
        await writeEvent(response, { type: 'error', status: 502 }).catch(() => {});
        response.end();
      }
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
      activeScopes.delete(principal.scopeKey);
    }
  };
}

export class SpokenSentenceSegmenter {
  private pending = '';

  append(delta: string): string[] {
    this.pending += delta.replace(/\r\n?/gu, '\n');
    const segments: string[] = [];
    while (this.pending) {
      const boundary = this.boundaryIndex();
      if (boundary < 0) break;
      const segment = normalizedSegment(this.pending.slice(0, boundary));
      this.pending = this.pending.slice(boundary);
      if (segment) segments.push(segment);
    }
    return segments;
  }

  flush(): string[] {
    const segment = normalizedSegment(this.pending);
    this.pending = '';
    return segment ? [segment] : [];
  }

  private boundaryIndex(): number {
    for (let index = 0; index < this.pending.length; index += 1) {
      const character = this.pending[index];
      if (character === '\n') return index + 1;
      if (!'。！？!?'.includes(character ?? '')) continue;
      const suffix = this.pending[index + 1];
      return index + (suffix && '」』）】”"'.includes(suffix) ? 2 : 1);
    }
    return -1;
  }
}

function normalizedSegment(value: string): string {
  return value.trim().replace(/\s*\n\s*/gu, ' ');
}

function startStream(response: ServerResponse): void {
  if (response.headersSent) return;
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
  });
}

async function writeEvent(response: ServerResponse, event: Record<string, unknown>): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  if (response.write(line)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', drained);
      response.off('error', failed);
      response.off('close', closed);
    };
    const drained = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => { cleanup(); reject(new Error('VOICE_STREAM_CLOSED')); };
    response.once('drain', drained);
    response.once('error', failed);
    response.once('close', closed);
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
