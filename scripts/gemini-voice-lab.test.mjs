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
  voiceDesignPrompt,
  voiceDesignPresetsVerifiedAt,
  voiceDesignVariantIsVerified,
} from '../tools/gemini-voice-lab/voice-design-presets.js';
import {
  auditionJobs,
  auditionScripts,
  auditionStyles,
} from '../tools/gemini-voice-lab/voice-audition-presets.js';

test('voice design presets are original, bounded, and uniquely addressable', () => {
  assert.deepEqual(VOICE_LAB_STATIC_FILES.get('/voice-design-presets.js'), [
    'voice-design-presets.js',
    'text/javascript; charset=utf-8',
  ]);
  assert.deepEqual(VOICE_LAB_STATIC_FILES.get('/voice-audition-presets.js'), [
    'voice-audition-presets.js',
    'text/javascript; charset=utf-8',
  ]);
  assert.equal(voiceDesignPresets.length, 8);
  assert.equal(voiceDesignPresetsVerifiedAt, '2026-09-25');
  assert.equal(new Set(voiceDesignPresets.map(preset => preset.id)).size, voiceDesignPresets.length);
  for (const preset of voiceDesignPresets) {
    assert.ok(preset.label.length > 0);
    assert.ok(preset.name.length > 0 && preset.name.length <= 100);
    for (const language of ['en', 'ja']) {
      for (const detail of ['short', 'detailed']) {
        const prompt = voiceDesignPrompt(preset, language, detail);
        assert.ok(prompt.length > 70 && prompt.length <= 1000);
        assert.equal(voiceDesignVariantIsVerified(preset, language, detail), true);
        assert.doesNotMatch(prompt, /\b(?:Haruhi|Hayami|Rem|Hatsune|Miku|Nakano|Violet|Evergarden)\b/i);
        assert.doesNotMatch(prompt, /\b(?:imitate|imitation|performer|existing character|established virtual singer)\b/i);
      }
    }
  }
});

test('audition presets provide Japanese emotion scripts and bounded turn styles', () => {
  assert.equal(auditionScripts.length, 7);
  assert.equal(auditionStyles.length, 6);
  assert.equal(new Set(auditionScripts.map(item => item.id)).size, auditionScripts.length);
  assert.equal(new Set(auditionStyles.map(item => item.id)).size, auditionStyles.length);
  assert.ok(auditionScripts.some(item => item.id === 'joy' && item.text.includes('<gasp>')));
  assert.ok(auditionScripts.some(item => item.id === 'prickly' && item.text.includes('<short pause>')));
  for (const item of auditionScripts) assert.ok(item.text.length > 10 && item.text.length <= 5_000);
  for (const item of auditionStyles) assert.ok(item.value.length <= 500);
  assert.deepEqual(auditionJobs('both', 3), [
    { model: 'gemini-3.8-flash-tts', run: 1 },
    { model: 'gemini-3.8-flash-tts', run: 2 },
    { model: 'gemini-3.8-flash-tts', run: 3 },
    { model: 'gemini-3.8-flash-lite-tts', run: 1 },
    { model: 'gemini-3.8-flash-lite-tts', run: 2 },
    { model: 'gemini-3.8-flash-lite-tts', run: 3 },
  ]);
  assert.deepEqual(auditionJobs('gemini-3.8-flash-lite-tts', 1), [{ model: 'gemini-3.8-flash-lite-tts', run: 1 }]);
  assert.throws(() => auditionJobs('unknown', 1), /not supported/u);
  assert.throws(() => auditionJobs('both', 2), /1 or 3/u);
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
