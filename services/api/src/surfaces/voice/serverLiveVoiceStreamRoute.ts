import { startStream, writeEvent } from '../../infra/http/ndjsonStream.js';
export { startStream, writeEvent } from '../../infra/http/ndjsonStream.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonApiKernel } from '../../infra/http/apiKernel.js';
import type { ShannonDevicePrincipal } from '../../infra/auth/deviceAuth.js';
import { bindScope, readJson, sendJson } from '../../infra/http/serverHttp.js';
import { SpokenSentenceSegmenter } from './spokenSentences.js';
import { VOICE_CONTENT_FILTERED } from '../../infra/models/chatModelVoiceStream.js';
import { withObserverRun } from '../../infra/observer/observerContext.js';
import { voiceObservationOptions, writeObservedVoiceSegment } from './voiceObservation.js';
import { TurnTiming, turnOutcome, turnTimingId } from '../../infra/observer/turnTiming.js';

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
    // One content-free line per turn (`turnTiming.ts`): written when the last sentence is out, or when the turn fails.
    let timing: TurnTiming | null = null;
    let outcome = 'error';
    const firstSegment = () => timing?.mark('firstSegment'); // Only the first mark counts; the waiting phrase is not a reply sentence.
    try {
      const body = bindScope(await readJson(request, 64 * 1024), principal.scopeKey);
      timing = new TurnTiming('voice', turnTimingId(record(record(record(body)?.deviceContext)?.userUtterance)?.id));
      await withObserverRun(voiceObservationOptions(scopeKey, body), async () => {
        const apiResponse = await kernel.streamLiveVoiceDelegation({
          method: 'POST',
          path: '/v1/voice/gemini/cascade/delegations',
          body, deviceId: principal.deviceId,
        }, {
          signal: controller.signal, timing: timing!,
          onPlan: async plan => {
            if (controller.signal.aborted) return;
            const firstPlan = !receivedPlan;
            receivedPlan = true;
            voicePlan = plan;
            startStream(response);
            await writeEvent(response, { type: 'plan', voicePlan: plan });
            if (firstPlan && typeof plan.waitingPhrase === 'string' && plan.waitingPhrase.trim()) {
              await writeObservedVoiceSegment(response, plan.waitingPhrase, waitingSegmentPlan(plan), 'plan');
            }
          },
          onTextDelta: async delta => {
            if (controller.signal.aborted) return;
            receivedDelta = true;
            for (const segment of segmenter.append(delta)) {
              startStream(response);
              firstSegment();
              spokenReplySegments += 1;
              await writeObservedVoiceSegment(response, segment, voicePlan, 'llm');
            }
          },
        });
        outcome = controller.signal.aborted ? 'aborted' : turnOutcome(apiResponse);
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
            firstSegment();
            await writeObservedVoiceSegment(response, segment, voicePlan);
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
          firstSegment();
          await writeObservedVoiceSegment(response, segment, voicePlan);
        }
        startStream(response);
        await writeEvent(response, { type: 'completed', response: apiResponse.body });
        response.end();
      });
    } catch (error) {
      outcome = controller.signal.aborted ? 'aborted' : turnOutcome(null, error);
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
      timing?.finish(outcome);
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
