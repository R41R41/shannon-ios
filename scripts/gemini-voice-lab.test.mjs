import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLiveSetupMessage,
  buildLiveTokenRequest,
  isAllowedBrowserRequest,
  requestTokenMatches,
  validateDeleteInput,
  validateDesignInput,
  validateLiveTokenInput,
  validateSampleInput,
} from './gemini-voice-lab-core.mjs';

test('sample input accepts a prebuilt or designed voice without changing text and style', () => {
  assert.deepEqual(validateSampleInput({
    model: 'gemini-3.8-flash-lite-tts',
    voice: 'voice_Custom_1',
    text: ' こんにちは。 ',
    style: ' warm ',
  }), {
    model: 'gemini-3.8-flash-lite-tts',
    voice: 'voice_Custom_1',
    text: 'こんにちは。',
    style: 'warm',
  });
});

test('voice design and deletion require explicit confirmation', () => {
  assert.throws(() => validateDesignInput({}), /confirmStore/u);
  assert.throws(() => validateDeleteInput({ id: 'voice_ABC', confirm: 'voice_OTHER' }), /exactly match/u);
  assert.equal(validateDeleteInput({ id: 'voice_ABC', confirm: 'voice_ABC' }).id, 'voice_ABC');
});

test('Live remains constrained to the audio model and prebuilt comparison voices', () => {
  const token = buildLiveTokenRequest({
    expiresAt: '2026-09-25T10:20:00.000Z',
    newSessionExpiresAt: '2026-09-25T10:01:00.000Z',
  });
  assert.equal(token.bidiGenerateContentSetup.model, 'models/gemini-3.8-live');
  assert.deepEqual(token.bidiGenerateContentSetup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(validateLiveTokenInput({ voice: 'Leda' }).voice, 'Leda');
  assert.throws(() => validateLiveTokenInput({ voice: 'voice_Custom' }), /not supported/u);
  const setup = buildLiveSetupMessage({ voice: 'Aoede' });
  assert.equal(setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
  assert.deepEqual(setup.setup.inputAudioTranscription, {});
});

test('browser boundary accepts only loopback same-origin requests', () => {
  assert.equal(isAllowedBrowserRequest({ host: '127.0.0.1:4322', origin: 'http://127.0.0.1:4322', secFetchSite: 'same-origin' }), true);
  assert.equal(isAllowedBrowserRequest({ host: 'localhost:4322', origin: undefined, secFetchSite: 'none' }), true);
  assert.equal(isAllowedBrowserRequest({ host: 'sh4nnon.com', origin: 'https://sh4nnon.com', secFetchSite: 'same-origin' }), false);
  assert.equal(isAllowedBrowserRequest({ host: '127.0.0.1:4322', origin: 'https://attacker.example', secFetchSite: 'cross-site' }), false);
});

test('request token comparison is exact', () => {
  assert.equal(requestTokenMatches('abc', 'abc'), true);
  assert.equal(requestTokenMatches('abc', 'abd'), false);
  assert.equal(requestTokenMatches('', ''), false);
});
