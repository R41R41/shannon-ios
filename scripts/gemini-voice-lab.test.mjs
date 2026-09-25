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
  VOICE_LAB_STATIC_FILES,
} from './gemini-voice-lab-core.mjs';
import {
  voiceDesignPresets,
  voiceDesignPresetsVerifiedAt,
} from '../tools/gemini-voice-lab/voice-design-presets.js';

test('voice design presets are original, bounded, and uniquely addressable', () => {
  assert.deepEqual(VOICE_LAB_STATIC_FILES.get('/voice-design-presets.js'), [
    'voice-design-presets.js',
    'text/javascript; charset=utf-8',
  ]);
  assert.equal(voiceDesignPresets.length, 8);
  assert.equal(voiceDesignPresetsVerifiedAt, '2026-09-25');
  assert.equal(new Set(voiceDesignPresets.map(preset => preset.id)).size, voiceDesignPresets.length);
  for (const preset of voiceDesignPresets) {
    assert.ok(preset.label.length > 0);
    assert.ok(preset.name.length > 0 && preset.name.length <= 100);
    assert.ok(preset.prompt.length > 100 && preset.prompt.length <= 1000);
    assert.match(preset.prompt, /original/i);
    assert.doesNotMatch(preset.prompt, /\b(?:Haruhi|Hayami|Rem|Hatsune|Miku|Nakano|Violet|Evergarden)\b/i);
    assert.doesNotMatch(preset.prompt, /\b(?:imitate|imitation|performer|existing character|established virtual singer)\b/i);
  }
});

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
  assert.deepEqual(validateDesignInput({
    model: 'gemini-3.8-flash-lite-tts',
    name: 'Shannon bright',
    prompt: 'A clear and warm young adult Japanese voice.',
    confirmStore: true,
  }), {
    name: 'Shannon bright',
    prompt: 'A clear and warm young adult Japanese voice.',
    language: 'ja-JP',
    gender: 'female',
  });
  assert.throws(() => validateDeleteInput({ id: 'voice_ABC', confirm: 'voice_OTHER' }), /exactly match/u);
  assert.equal(validateDeleteInput({ id: 'voice_ABC', confirm: 'voice_ABC' }).id, 'voice_ABC');
});

test('Live remains constrained to the audio model and accepts catalog or designed voices', () => {
  const token = buildLiveTokenRequest({
    expiresAt: '2026-09-25T10:20:00.000Z',
    newSessionExpiresAt: '2026-09-25T10:01:00.000Z',
  });
  assert.equal(token.bidiGenerateContentSetup.model, 'models/gemini-3.8-live');
  assert.deepEqual(token.bidiGenerateContentSetup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(validateLiveTokenInput({ voice: 'Leda' }).voice, 'Leda');
  assert.equal(validateLiveTokenInput({ voice: 'ja-jp-assistant-7' }).voice, 'ja-jp-assistant-7');
  assert.equal(validateLiveTokenInput({ voice: 'voice_Custom' }).voice, 'voice_Custom');
  assert.throws(() => validateLiveTokenInput({ voice: '../bad' }), /identifier/u);
  const setup = buildLiveSetupMessage({ voice: 'Aoede' });
  assert.equal(setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
  const customSetup = buildLiveSetupMessage({ voice: 'voice_Custom' });
  assert.equal(customSetup.setup.generationConfig.speechConfig.voiceConfig.voice, 'voice_Custom');
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
