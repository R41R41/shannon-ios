import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from '../../infra/auth/deviceAuth.js';
import { wavDurationMs } from '../../infra/models/groqTranscription.js';
import { readJson, sendJson } from '../../infra/http/serverHttp.js';
import type { AddressedInput, AddressedJudge, AddressedVerdict } from '../../mind/perception/addressed.js';
import { nameMatch } from '../../mind/perception/addressedName.js';
import { decodedAudio, LISTEN_MAXIMUM_MS, type Listening, type ListenResult } from '../../infra/models/listening.js';
import type { ListenUsageToday } from '../../infra/models/listenUsage.js';

/**
 * `POST /v1/voice/listen` (owner 2026-10-26, docs/listening-contract.md): the Windows resident listens all the time and sends each
 * utterance its own voice activity detection cut out. The head transcribes it (Groq, `listening.ts`) and asks the same judge the
 * Discord voice channel uses whether it was said to her (`AddressedJudge`: her name, her follow-up window, and with the owner alone a
 * question or request without her name). Only an utterance she will answer comes back with its words, as the first turn of her call.
 *
 * Request (JSON, at most 1.5 MB): `{ audio, durationMs?, shannonSpokeMsAgo?, lastLine?, guest?, speaking? }`. `audio` is a base64 WAV,
 * 16 kHz mono 16-bit, at most 30 s; the other fields mean what they mean for `POST /v1/voice/addressed`.
 * Answer 200: `{ heard, respond, reason?, text?, sttMs, judgeMs?, usage, limited? }`. `heard`: words were made out; `respond`: she
 * answers (then `text` is the transcript); `limited`: the shared allowance is spent (the resident goes back to waiting for her name on
 * the PC until the next UTC day); `degraded: 'stt_error'`: Groq failed this time (the resident falls back for this utterance only).
 * `degraded: 'groq_unavailable'` with `retryAfterSeconds`: Groq's free tier or limit is used up, or it does not answer; the resident listens
 * the way it did (her name on the PC) and asks again after that many seconds. `limited` comes with `retryAfterSeconds` too.
 * 503 `LISTEN_NOT_CONFIGURED` without `GROQ_API_KEY`. The words are used for this request only and are written nowhere here.
 */
export const LISTEN_PATH = '/v1/voice/listen';

const PER_MINUTE = 40;
const MAXIMUM_AUDIO_BYTES = 16_000 * 2 * 31 + 1_024;

interface Context {
  spokeAgoMs: number | null;
  lastLine: string;
  guest: boolean;
  speaking: boolean;
}

const isMilliseconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 3_600_000;

function contextOf(row: Record<string, unknown>): Context | null {
  if (row.shannonSpokeMsAgo !== undefined && !isMilliseconds(row.shannonSpokeMsAgo)) return null;
  if (row.lastLine !== undefined && (typeof row.lastLine !== 'string' || row.lastLine.length > 400)) return null;
  if ((row.guest !== undefined && typeof row.guest !== 'boolean') || (row.speaking !== undefined && typeof row.speaking !== 'boolean')) return null;
  return {
    spokeAgoMs: isMilliseconds(row.shannonSpokeMsAgo) ? row.shannonSpokeMsAgo : null,
    lastLine: typeof row.lastLine === 'string' ? row.lastLine.trim() : '', guest: row.guest === true, speaking: row.speaking === true,
  };
}

/** What the judge is shown: the owner alone unless others are listening (`guest`), as for `POST /v1/voice/addressed`. */
function judgedInput(text: string, context: Context, scopeKey: string, bodyRunning: boolean): AddressedInput {
  const { spokeAgoMs } = context;
  return {
    scopeKey, transcript: text, speaker: { id: 'owner', name: 'owner' }, humans: context.guest ? 2 : 1,
    owner: !context.guest, shannonSpeaking: context.speaking || spokeAgoMs === 0, bodyRunning,
    shannon: { spokeAgoMs, toSpeaker: spokeAgoMs === null ? null : true, ...(context.lastLine ? { line: context.lastLine } : {}) },
  };
}

/** Without the judge (`SHANNON_ADDRESSED` off): her name alone opens a call, as the resident's name waiting did. */
function nameOnlyVerdict(text: string): Pick<AddressedVerdict, 'addressed' | 'reason'> {
  return nameMatch(text) ? { addressed: true, reason: 'named' } : { addressed: false, reason: 'no_name' };
}

/** The request's audio, its length and its context, or null when it is not one this route takes. */
function validatedListen(body: unknown): { audio: Uint8Array; durationMs: number; context: Context } | null {
  const row = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  const audio = row ? decodedAudio(row.audio, MAXIMUM_AUDIO_BYTES) : null;
  const context = row ? contextOf(row) : null;
  const durationMs = audio ? wavDurationMs(audio) : null;
  if (!audio || !context || durationMs === null || durationMs > LISTEN_MAXIMUM_MS) return null;
  return { audio, durationMs, context };
}

/** The answer for an utterance Groq did not make into words: the allowance, Groq away, an error, or silence. */
function unheard(heard: Exclude<ListenResult, { status: 'ok' }>, usage: ListenUsageToday): Record<string, unknown> {
  if (heard.status === 'limited') return { heard: false, respond: false, limited: heard.limited, retryAfterSeconds: heard.retryAfterSeconds, sttMs: 0, usage };
  if (heard.status === 'unavailable') {
    const { reason, retryAfterSeconds, sttMs } = heard;
    return { heard: false, respond: false, degraded: 'groq_unavailable', reason, retryAfterSeconds, sttMs, usage };
  }
  if (heard.status === 'error') return { heard: false, respond: false, degraded: 'stt_error', sttMs: heard.sttMs, usage };
  return { heard: false, respond: false, reason: heard.status, sttMs: heard.sttMs, usage };
}

export function createListenRoute(dependencies: {
  listening: Listening | null;
  judge: AddressedJudge | null;
  bodyRunning?: () => boolean;
  now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;
  const times = new Map<string, number[]>();
  const allowed = (deviceId: string): boolean => {
    const at = now();
    const recent = (times.get(deviceId) ?? []).filter(time => at - time < 60_000);
    if (recent.length >= PER_MINUTE) return false;
    recent.push(at);
    times.set(deviceId, recent);
    if (times.size > 64) times.delete(times.keys().next().value!);
    return true;
  };

  return async function handleListen(request: IncomingMessage, response: ServerResponse, principal: ShannonDevicePrincipal | null): Promise<void> {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    const listening = dependencies.listening;
    if (!listening) return sendJson(response, 503, { error: 'LISTEN_NOT_CONFIGURED', message: '聴き流しの文字起こしは設定されていません。' });
    if (!allowed(principal.deviceId)) return sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
    let body: unknown;
    try {
      body = await readJson(request, 1_500_000);
    } catch {
      return sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'body is invalid.' });
    }
    const asked = validatedListen(body);
    if (!asked) return sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'audio must be a WAV of 30 s at most.' });
    const { context } = asked;
    const heard = await listening.transcribe(asked.audio, asked.durationMs, 'windows');
    const usage = listening.usage.today();
    if (heard.status !== 'ok') return sendJson(response, 200, unheard(heard, usage));
    const judge = dependencies.judge;
    const verdict = judge
      ? await judge.judge(judgedInput(heard.text, context, principal.scopeKey, dependencies.bodyRunning?.() ?? false))
      : { ...nameOnlyVerdict(heard.text), ms: 0 };
    sendJson(response, 200, {
      heard: true, respond: verdict.addressed, reason: verdict.reason, ...(verdict.addressed ? { text: heard.text } : {}),
      sttMs: heard.sttMs, judgeMs: verdict.ms, usage,
    });
  };
}
