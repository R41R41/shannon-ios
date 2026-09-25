import { randomBytes, timingSafeEqual } from 'node:crypto';

import { GEMINI_TTS_MODELS } from './gemini-tts-lab-core.mjs';

export const GEMINI_LIVE_MODEL = 'gemini-3.8-live';
export const DEFAULT_LIVE_VOICES = Object.freeze([
  'Leda',
  'Aoede',
  'Zephyr',
  'Achernar',
  'Laomedeia',
  'Achird',
  'Vindemiatrix',
  'Sadachbia',
]);

export function validateSampleInput(value) {
  const body = record(value);
  const model = choice(body.model, 'model', GEMINI_TTS_MODELS);
  const voice = voiceIdentifier(body.voice);
  const text = boundedText(body.text, 'text', 1, 5_000);
  const style = boundedText(body.style ?? '', 'style', 0, 500);
  return Object.freeze({ model, voice, text, style });
}

export function validateDesignInput(value) {
  const body = record(value);
  if (body.confirmStore !== true) {
    throw new InputError('confirmStore must be true because Voice Design stores a voice in the Google project');
  }
  return Object.freeze({
    name: boundedText(body.name, 'name', 1, 100),
    prompt: boundedText(body.prompt, 'prompt', 1, 1_000),
    language: choice(body.language ?? 'ja-JP', 'language', ['ja-JP']),
    gender: choice(body.gender ?? 'female', 'gender', ['female', 'male', 'neutral']),
  });
}

export function validateDeleteInput(value) {
  const body = record(value);
  const id = boundedText(body.id, 'id', 8, 200);
  if (!/^voice_[A-Za-z0-9_-]+$/u.test(id)) throw new InputError('id must be an exact voice_... identifier');
  if (body.confirm !== id) throw new InputError('confirm must exactly match the voice ID');
  return Object.freeze({ id });
}

export function validateLiveTokenInput(value) {
  const body = record(value);
  const voice = voiceIdentifier(body.voice);
  return Object.freeze({ voice });
}

export function buildLiveTokenRequest({ expiresAt, newSessionExpiresAt }) {
  return {
    uses: 1,
    expireTime: expiresAt,
    newSessionExpireTime: newSessionExpiresAt,
    fieldMask: 'model,generationConfig.responseModalities',
    bidiGenerateContentSetup: {
      model: `models/${GEMINI_LIVE_MODEL}`,
      generationConfig: { responseModalities: ['AUDIO'] },
    },
  };
}

export function buildLiveSetupMessage({ voice }) {
  const selectedVoice = voiceIdentifier(voice);
  return {
    setup: {
      model: `models/${GEMINI_LIVE_MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: liveVoiceConfig(selectedVoice),
        },
      },
      systemInstruction: {
        parts: [{
          text: 'あなたはShannonの声を試聴する短時間の会話相手です。日本語で、自然で短い返答をしてください。声質を評価しやすいよう、過剰な演技や長い説明は避けてください。',
        }],
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
          prefixPaddingMs: 80,
          silenceDurationMs: 600,
        },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      },
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

export function liveVoiceConfig(voice) {
  const selectedVoice = voiceIdentifier(voice);
  return selectedVoice.startsWith('voice_')
    ? { voice: selectedVoice }
    : { prebuiltVoiceConfig: { voiceName: selectedVoice } };
}

export function createRequestToken() {
  return randomBytes(24).toString('base64url');
}

export function requestTokenMatches(expected, received) {
  const left = Buffer.from(String(expected ?? ''));
  const right = Buffer.from(String(received ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function isAllowedLoopbackHost(host) {
  const value = String(host ?? '').toLowerCase();
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/u.test(value);
}

export function isAllowedBrowserRequest({ host, origin, secFetchSite }) {
  if (!isAllowedLoopbackHost(host)) return false;
  if (secFetchSite && !['same-origin', 'none'].includes(secFetchSite)) return false;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && isAllowedLoopbackHost(url.host);
  } catch {
    return false;
  }
}

export function safeUpstreamError(text) {
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message ?? parsed?.error?.status ?? 'request failed')
      .replace(/AIza[A-Za-z0-9_-]+/gu, '[redacted-key]')
      .slice(0, 500);
  } catch {
    return 'request failed';
  }
}

export class InputError extends Error {}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('request body must be a JSON object');
  return value;
}

function boundedText(value, name, minimum, maximum) {
  const result = String(value ?? '').trim();
  if (result.length < minimum || result.length > maximum) {
    throw new InputError(`${name} must be ${minimum}-${maximum} characters`);
  }
  return result;
}

function choice(value, name, allowed) {
  const result = String(value ?? '').trim();
  if (!allowed.includes(result)) throw new InputError(`${name} is not supported`);
  return result;
}

function voiceIdentifier(value) {
  const result = boundedText(value, 'voice', 1, 200);
  if (!/^(?:[A-Za-z][A-Za-z0-9._-]{0,79}|voice_[A-Za-z0-9_-]+)$/u.test(result)) {
    throw new InputError('voice must be a prebuilt name or exact voice_... identifier');
  }
  return result;
}
