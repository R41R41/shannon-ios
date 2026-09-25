import { randomBytes, timingSafeEqual } from 'node:crypto';

import { GEMINI_TTS_MODELS } from './gemini-tts-lab-core.mjs';
import { liveConversationExamples, liveProfile, liveSystemInstruction } from '../tools/gemini-voice-lab/voice-live-profiles.js';
import { CASCADE_EMOTION_IDS } from '../tools/gemini-voice-lab/cascade-response-stream.js';

export const GEMINI_LIVE_MODEL = 'gemini-3.8-live';
export const GEMINI_TRANSCRIBE_LIVE_MODEL = 'gemini-3.5-transcribe-live';
export const GEMINI_CASCADE_TEXT_MODELS = Object.freeze([
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
]);
export const VOICE_LAB_STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/file-mode-guard.js', ['file-mode-guard.js', 'text/javascript; charset=utf-8']],
  ['/voice-audition-presets.js', ['voice-audition-presets.js', 'text/javascript; charset=utf-8']],
  ['/voice-design-presets.js', ['voice-design-presets.js', 'text/javascript; charset=utf-8']],
  ['/voice-live-profiles.js', ['voice-live-profiles.js', 'text/javascript; charset=utf-8']],
  ['/cascade-audio-policy.js', ['cascade-audio-policy.js', 'text/javascript; charset=utf-8']],
  ['/cascade-response-stream.js', ['cascade-response-stream.js', 'text/javascript; charset=utf-8']],
  ['/capture-worklet.js', ['capture-worklet.js', 'text/javascript; charset=utf-8']],
]);
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

export function validateCascadeResponseInput(value) {
  const body = record(value);
  const model = choice(body.model ?? GEMINI_CASCADE_TEXT_MODELS[0], 'model', GEMINI_CASCADE_TEXT_MODELS);
  const text = boundedText(body.text, 'text', 1, 2_000);
  const profile = liveProfile(String(body.profile ?? 'neutral')).id;
  const history = Array.isArray(body.history) ? body.history : [];
  if (history.length > 12) throw new InputError('history must contain at most 12 turns');
  return Object.freeze({
    model,
    text,
    profile,
    history: history.map((turn, index) => {
      const item = record(turn);
      return Object.freeze({
        role: choice(item.role, `history[${index}].role`, ['user', 'model']),
        text: boundedText(item.text, `history[${index}].text`, 1, 2_000),
      });
    }),
  });
}

export function validateCascadeSpeechInput(value) {
  const body = record(value);
  return Object.freeze({
    model: choice(body.model, 'model', GEMINI_TTS_MODELS),
    voice: voiceIdentifier(body.voice),
    text: boundedText(body.text, 'text', 1, 1_000),
    style: boundedText(body.style ?? '', 'style', 0, 500),
  });
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

export function buildTranscribeTokenRequest({ expiresAt, newSessionExpiresAt }) {
  return {
    uses: 1,
    expireTime: expiresAt,
    newSessionExpireTime: newSessionExpiresAt,
    fieldMask: 'model,generationConfig.responseModalities',
    bidiGenerateContentSetup: {
      model: `models/${GEMINI_TRANSCRIBE_LIVE_MODEL}`,
      generationConfig: { responseModalities: ['TEXT'] },
    },
  };
}

export function buildTranscribeSetupMessage() {
  return {
    setup: {
      model: `models/${GEMINI_TRANSCRIBE_LIVE_MODEL}`,
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: { languageCodes: ['ja-JP'] },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
          prefixPaddingMs: 80,
          silenceDurationMs: 360,
        },
      },
    },
  };
}

export function buildCascadeResponseRequest({ model, text, history, profile }) {
  const input = validateCascadeResponseInput({ model, text, history, profile });
  const instruction = [
    liveSystemInstruction(input.profile),
    'あなたはShannonです。上記の選択された人格を保ち、一般的なAIアシスタントの口調へ戻らないでください。',
    '返答は音声で読み上げます。原則1〜2文、80文字程度までで、最初の文から要点を答えてください。',
    `各文の先頭に、その文の演技を示すタグを1個だけ付けてください。許可タグ: ${CASCADE_EMOTION_IDS.map(id => `[[${id}]]`).join(' ')}`,
    '例: [[proud]]当然です、天才AIですから！[[flustered]]べ、別に褒めてほしいわけじゃないですけど。',
    'タグは読み上げ本文ではありません。Markdown、箇条書き、括弧書きの演技指示、プロフィール説明は使わないでください。',
  ].join('\n');
  return {
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [
      ...liveConversationExamples(input.profile).map(turn => ({ role: turn.role, parts: [{ text: turn.text }] })),
      ...input.history.map(turn => ({ role: turn.role, parts: [{ text: turn.text }] })),
      { role: 'user', parts: [{ text: input.text }] },
    ],
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 220,
      ...(input.model === 'gemini-3.8-flash' ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
    },
  };
}

export function buildCascadeSpeechRequest(value) {
  const input = validateCascadeSpeechInput(value);
  return {
    contents: [{
      role: 'user',
      parts: [{
        text: input.text,
        speech_metadata: { style: input.style },
      }],
    }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      responseFormat: { audio: { mimeType: 'AUDIO_L16', sampleRate: 24_000 } },
      speechConfig: { voiceConfig: { voice: input.voice } },
    },
  };
}

export function generatedTextFromResponse(value) {
  const parts = value?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error('Gemini response did not contain text');
  const text = parts.map(part => typeof part?.text === 'string' ? part.text : '').join('').trim();
  if (!text) throw new Error('Gemini returned an empty text response');
  return text;
}

export function buildLiveSetupMessage({ voice, profile = 'neutral' }) {
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
          text: liveSystemInstruction(profile),
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
