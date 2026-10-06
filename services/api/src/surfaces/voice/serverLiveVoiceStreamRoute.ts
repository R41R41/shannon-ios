import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonApiKernel } from '../../infra/http/apiKernel.js';
import type { ShannonDevicePrincipal } from '../../infra/auth/deviceAuth.js';
import { bindScope, readJson, sendJson } from '../../infra/http/serverHttp.js';
import { SpokenSentenceSegmenter } from './spokenSentences.js';
import { VOICE_CONTENT_FILTERED } from '../../infra/models/chatModelVoiceStream.js';

export { SpokenSentenceSegmenter } from './spokenSentences.js';

type ConsumeAllowance = (deviceId: string) => boolean;

export function createLiveVoiceStreamRoute(
  kernel: ShannonApiKernel,
  consumeAllowance: ConsumeAllowance,
) {
  // A disconnected caller must not hold the owner's next turn while an
  // upstream model call is still unwinding. Tokens keep an older request's
  // finally block from releasing a newer request's lease.
  const activeScopes = new Map<string, symbol>();

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

    const scopeKey = principal.scopeKey;
    const lease = Symbol('live-voice-turn');
    activeScopes.set(scopeKey, lease);
    const release = () => {
      if (activeScopes.get(scopeKey) === lease) activeScopes.delete(scopeKey);
    };
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      release();
    };
    request.once('aborted', abort);
    response.once('close', abort);
    const segmenter = new SpokenSentenceSegmenter();
    let voicePlan: Record<string, unknown> | undefined;
    let receivedPlan = false;
    let receivedDelta = false;
    let spokenReplySegments = 0;
    try {
      const body = bindScope(await readJson(request, 64 * 1024), principal.scopeKey);
      const apiResponse = await kernel.streamLiveVoiceDelegation({
        method: 'POST',
        path: '/v1/voice/gemini/cascade/delegations',
        body, deviceId: principal.deviceId,
      }, {
        signal: controller.signal,
        onPlan: async plan => {
          if (controller.signal.aborted) return;
          const firstPlan = !receivedPlan;
          receivedPlan = true;
          voicePlan = plan;
          startStream(response);
          await writeEvent(response, { type: 'plan', voicePlan: plan });
          if (firstPlan && typeof plan.waitingPhrase === 'string' && plan.waitingPhrase.trim()) {
            await writeEvent(response, {
              type: 'segment', text: plan.waitingPhrase, voicePlan: waitingSegmentPlan(plan),
            });
          }
        },
        onTextDelta: async delta => {
          if (controller.signal.aborted) return;
          receivedDelta = true;
          for (const segment of segmenter.append(delta)) {
            startStream(response);
            spokenReplySegments += 1;
            await writeEvent(response, { type: 'segment', text: segment, voicePlan });
          }
        },
      });
      if (controller.signal.aborted) return;

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
      // A reply cut at its length limit ends at its last complete sentence (`truncated`, the
      // reply in the body is cut the same way); with no complete sentence yet, the words are kept.
      const truncated = bodyRecord?.truncated === true;
      if (truncated) {
        console.info('Shannon live voice reply reached its length limit', { segments: spokenReplySegments });
        if (spokenReplySegments > 0) segmenter.discard();
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
      // `code` (optional, additive) tells a client what to do with what she already said:
      // `content_filter` means drop it; without a code, sentences already said may be kept.
      const code = error instanceof Error && error.message === VOICE_CONTENT_FILTERED ? { code: 'content_filter' } : {};
      if (!response.headersSent) {
        sendJson(response, 502, { error: 'MODEL_UNAVAILABLE', message: '返答を生成できませんでした。', ...code });
      } else {
        await writeEvent(response, { type: 'error', status: 502, ...code }).catch(() => {});
        response.end();
      }
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
      release();
    }
  };
}

function waitingSegmentPlan(plan: Record<string, unknown>): Record<string, unknown> {
  const direction = record(plan.waitingPerformance);
  if (!direction) return plan;
  return {
    ...plan,
    affect: direction.affect ?? plan.affect,
    affectIntensity: direction.intensity ?? plan.affectIntensity,
    delivery: direction.delivery ?? plan.delivery,
  };
}

export function startStream(response: ServerResponse): void {
  if (response.headersSent) return;
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
  });
}

export async function writeEvent(response: ServerResponse, event: Record<string, unknown>): Promise<void> {
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
