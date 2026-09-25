import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCascadeResponseRequest,
  buildCascadeSpeechRequest,
  buildLiveSetupMessage,
  buildLiveTokenRequest,
  buildTranscribeSetupMessage,
  buildTranscribeTokenRequest,
  generatedTextFromResponse,
  GEMINI_TRANSCRIBE_LIVE_MODEL,
  isAllowedBrowserRequest,
  requestTokenMatches,
  validateCascadeResponseInput,
  validateCascadeSpeechInput,
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
  voiceDesignVariantVerifiedAt,
} from '../tools/gemini-voice-lab/voice-design-presets.js';
import {
  auditionJobs,
  auditionScripts,
  auditionStyles,
} from '../tools/gemini-voice-lab/voice-audition-presets.js';
import {
  liveConversationExamples,
  liveProfile,
  liveProfiles,
  liveSystemInstruction,
  liveTTSStyle,
} from '../tools/gemini-voice-lab/voice-live-profiles.js';

test('voice design presets are original, bounded, and uniquely addressable', () => {
  assert.deepEqual(VOICE_LAB_STATIC_FILES.get('/file-mode-guard.js'), [
    'file-mode-guard.js',
    'text/javascript; charset=utf-8',
  ]);
  assert.deepEqual(VOICE_LAB_STATIC_FILES.get('/voice-design-presets.js'), [
    'voice-design-presets.js',
    'text/javascript; charset=utf-8',
  ]);
  assert.deepEqual(VOICE_LAB_STATIC_FILES.get('/voice-audition-presets.js'), [
    'voice-audition-presets.js',
    'text/javascript; charset=utf-8',
  ]);
  assert.deepEqual(VOICE_LAB_STATIC_FILES.get('/voice-live-profiles.js'), [
    'voice-live-profiles.js',
    'text/javascript; charset=utf-8',
  ]);
  assert.equal(voiceDesignPresets.length, 9);
  assert.equal(voiceDesignPresetsVerifiedAt, '2026-09-25');
  assert.equal(voiceDesignVariantVerifiedAt(voiceDesignPresets.find(preset => preset.id === 'shannon-maid')), '2026-09-26');
  assert.equal(voiceDesignVariantVerifiedAt(voiceDesignPresets.find(preset => preset.id === 'shannon-crystal')), '2026-09-25');
  assert.equal(new Set(voiceDesignPresets.map(preset => preset.id)).size, voiceDesignPresets.length);
  for (const preset of voiceDesignPresets) {
    assert.ok(preset.label.length > 0);
    assert.ok(preset.name.length > 0 && preset.name.length <= 100);
    for (const language of ['en', 'ja']) {
      for (const detail of ['short', 'detailed']) {
        const prompt = voiceDesignPrompt(preset, language, detail);
        assert.ok(prompt.length > 70 && prompt.length <= 1000);
        assert.equal(
          voiceDesignVariantIsVerified(preset, language, detail),
          preset.id === 'shannon-maid' ? language === 'ja' && detail === 'detailed' : true,
        );
        assert.doesNotMatch(prompt, /\b(?:Haruhi|Hayami|Rem|Hatsune|Miku|Nakano|Violet|Evergarden)\b/i);
        assert.doesNotMatch(prompt, /\b(?:imitate|imitation|performer|existing character|established virtual singer)\b/i);
      }
    }
  }
});

test('Live profiles preserve all voice concepts and provide distinct bounded instructions', () => {
  assert.equal(liveProfiles.length, 10);
  assert.equal(new Set(liveProfiles.map(item => item.id)).size, liveProfiles.length);
  for (const expected of voiceDesignPresets.map(item => item.id)) {
    assert.ok(liveProfiles.some(item => item.id === expected), `missing Live profile: ${expected}`);
  }
  for (const item of liveProfiles) {
    assert.ok(item.label.length > 0);
    assert.ok(item.summary.length > 20);
    const instruction = liveSystemInstruction(item.id);
    assert.ok(instruction.length > 150 && instruction.length < 2_000);
    assert.ok(liveTTSStyle(item.id).length > 20 && liveTTSStyle(item.id).length <= 500);
    assert.doesNotMatch(instruction, /過剰な演技や長い説明は避けて/u);
  }
  assert.equal(liveProfile('unknown').id, 'neutral');
  assert.match(liveSystemInstruction('tsundere-leader'), /照れた時だけ/u);
  assert.match(liveSystemInstruction('shannon-maid'), /話し相手はあなたを開発した「ライ」/u);
  assert.match(liveSystemInstruction('shannon-maid'), /例文はそのまま反復せず/u);
  assert.match(liveTTSStyle('shannon-maid'), /声に笑顔/u);
  assert.deepEqual(liveConversationExamples('shannon-maid').map(turn => turn.role), ['user', 'model', 'user', 'model']);
  assert.equal(liveConversationExamples('neutral').length, 0);
});

test('cascade transcription is locked to Japanese streaming text', () => {
  const token = buildTranscribeTokenRequest({
    expiresAt: '2026-09-25T10:20:00.000Z',
    newSessionExpiresAt: '2026-09-25T10:01:00.000Z',
  });
  assert.equal(GEMINI_TRANSCRIBE_LIVE_MODEL, 'gemini-3.5-transcribe-live');
  assert.equal(token.bidiGenerateContentSetup.model, `models/${GEMINI_TRANSCRIBE_LIVE_MODEL}`);
  assert.deepEqual(token.bidiGenerateContentSetup.generationConfig.responseModalities, ['TEXT']);
  const setup = buildTranscribeSetupMessage();
  assert.equal(setup.setup.model, `models/${GEMINI_TRANSCRIBE_LIVE_MODEL}`);
  assert.deepEqual(setup.setup.inputAudioTranscription.languageCodes, ['ja-JP']);
  assert.equal(setup.setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 450);
});

test('cascade response keeps a short history and uses the selected profile', () => {
  const input = validateCascadeResponseInput({
    model: 'gemini-3.5-flash-lite',
    text: '今日はどうだった？',
    profile: 'tsundere-leader',
    history: [{ role: 'user', text: 'こんにちは' }, { role: 'model', text: 'こんにちは！' }],
  });
  assert.equal(input.profile, 'tsundere-leader');
  const request = buildCascadeResponseRequest(input);
  assert.equal(request.contents.length, 3);
  assert.deepEqual(request.contents.at(-1), { role: 'user', parts: [{ text: '今日はどうだった？' }] });
  assert.match(request.systemInstruction.parts[0].text, /鋭い語尾/u);
  assert.doesNotMatch(request.systemInstruction.parts[0].text, /親しみやすい相棒/u);
  assert.equal(request.generationConfig.maxOutputTokens, 160);
  assert.throws(() => validateCascadeResponseInput({
    model: 'gemini-3.5-flash-lite', text: 'test', history: Array(13).fill({ role: 'user', text: 'x' }),
  }), /at most 12/u);
});

test('Shannon maid cascade sends dialogue examples before conversation history', () => {
  const request = buildCascadeResponseRequest({
    model: 'gemini-3.5-flash-lite',
    text: '自己紹介して',
    profile: 'shannon-maid',
    history: [{ role: 'user', text: '初めまして' }, { role: 'model', text: '初めまして、ライ！' }],
  });
  assert.equal(request.contents.length, 7);
  assert.deepEqual(request.contents.slice(0, 4).map(turn => turn.role), ['user', 'model', 'user', 'model']);
  assert.match(request.contents[1].parts[0].text, /天才AI/u);
  assert.equal(request.contents.at(-1).parts[0].text, '自己紹介して');
});

test('cascade speech streams a designed voice with a bounded TTS style', () => {
  const input = validateCascadeSpeechInput({
    model: 'gemini-3.8-flash-lite-tts',
    voice: 'voice_8hj0yjm1cckv',
    text: 'それ、面白そうじゃない。詳しく聞かせて。',
    style: liveTTSStyle('tsundere-leader'),
  });
  const request = buildCascadeSpeechRequest(input);
  assert.equal(request.generationConfig.speechConfig.voiceConfig.voice, 'voice_8hj0yjm1cckv');
  assert.deepEqual(request.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(request.generationConfig.responseFormat.audio.sampleRate, 24_000);
  assert.match(request.contents[0].parts[0].speech_metadata.style, /きびきび/u);
  assert.equal(generatedTextFromResponse({
    candidates: [{ content: { parts: [{ text: ' こんにちは' }, { text: '！ ' }] } }],
  }), 'こんにちは！');
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
  const setup = buildLiveSetupMessage({ voice: 'Aoede', profile: 'tsundere-leader' });
  assert.equal(setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
  const customSetup = buildLiveSetupMessage({ voice: 'voice_Custom' });
  assert.equal(customSetup.setup.generationConfig.speechConfig.voiceConfig.voice, 'voice_Custom');
  assert.deepEqual(setup.setup.inputAudioTranscription, {});
  assert.match(setup.setup.systemInstruction.parts[0].text, /鋭い語尾/u);
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
