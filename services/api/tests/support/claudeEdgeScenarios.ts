import { anthropicFixture, sse } from './anthropicFixtures.js';
import { providerError, type ScriptedReply } from './claudeRequestRecorder.js';
import {
  answer, cached, chat, HAIKU, SONNET, streamedText, text, voice, type ClaudeScenario,
} from './claudeForegroundScenarios.js';

/**
 * Edge scenarios of the request goldens (Syzygy ADR-0009 stage 1, review follow-ups of M2): what the conversation transport
 * sends and books when a stream fails after words went out, when Sonnet refuses before any word, when the caller had already
 * stopped, when the native web search meets a server error, and when a streamed request is refused once as overloaded.
 * Synthetic data only.
 */

/** Text deltas kept before the provider's error event: enough for the reply decoder to hand out the first words. */
const DELTAS_BEFORE_ERROR = 6;

/** A stream that starts the structured answer, hands out a few pieces of it, then ends with the provider's error event. */
function streamBrokenAfterText(): ScriptedReply {
  const events = sse(answer(HAIKU.model)).split('\n\n').filter(Boolean);
  const kept: string[] = [];
  let deltas = 0;
  for (const event of events) {
    if (event.includes('"text_delta"')) deltas += 1;
    if (deltas > DELTAS_BEFORE_ERROR || event.startsWith('event: message_delta')) break;
    kept.push(event);
  }
  const failure = { type: 'error', error: { type: 'overloaded_error', message: 'synthetic provider error' } };
  const body = [...kept, `event: error\ndata: ${JSON.stringify(failure)}`].map(event => `${event}\n\n`).join('');
  return () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

export const EDGE_SCENARIOS: readonly ClaudeScenario[] = [
  { name: 'text-stream-error-after-text', script: [streamBrokenAfterText()], run: c => streamedText(c, HAIKU, text) },
  { name: 'sonnet-text-refusal-before-word', script: [cached(anthropicFixture('refusal'), SONNET.model, 1_800, 0)],
    run: c => streamedText(c, SONNET, { ...text, tier: 'sonnet' }) },
  { name: 'voice-caller-pre-aborted', script: [cached(anthropicFixture('structured-answer'), HAIKU.model)],
    run: c => chat(c, HAIKU).generateVoiceStreaming(voice, () => {}, aborted()) },
  { name: 'text-web-search-server-error', script: [providerError(503, 'api_error'), providerError(503, 'api_error')],
    run: c => chat(c, HAIKU).generate({ ...text, message: '今日の天気は？', useWebSearch: true }) },
  { name: 'text-streamed-transient-retry', script: [providerError(529, 'overloaded_error', { 'retry-after': '0' }), answer(HAIKU.model)],
    run: c => streamedText(c, HAIKU, text) },
];
