import { auditionJobs, auditionScript, auditionScripts, auditionStyle } from './voice-audition-presets.js';
import {
  decodePCM16WAV,
  encodeMonoFloat32WAV,
  normalizeVoiceEffects,
  processVoiceEffects,
  voiceEffectPresets,
} from './voice-effects.js';
import {
  voiceDesignPresets,
  voiceDesignPrompt,
  voiceDesignVariantIsVerified,
  voiceDesignVariantVerifiedAt,
} from './voice-design-presets.js';
import { liveProfile, liveProfiles, liveSystemInstruction, liveTTSStyle } from './voice-live-profiles.js';
import {
  CASCADE_PLAYBACK_LEAD_SECONDS,
  adaptiveCascadeFinalizeDelay,
  cascadeBargeInAction,
  cascadeBargeTuning,
  nextCascadePlaybackLead,
  shouldRestoreCascadeVolume,
  shouldSendCascadeAudio,
} from './cascade-audio-policy.js';
import {
  cascadeEmotionLabel,
  cascadeEmotionStyle,
  streamedTextFromGeminiEvent,
  takeCascadeSpeechSegments,
} from './cascade-response-stream.js';

const knownVoices = ['Leda', 'Aoede', 'Zephyr', 'Achernar', 'Laomedeia', 'Achird', 'Vindemiatrix', 'Sadachbia'];
const state = {
  config: null,
  samples: [],
  voices: knownVoices.map(id => ({ id, label: id, type: 'prebuilt' })),
  selectedVoiceIds: new Set(['Leda']),
  designedVoices: [],
  live: null,
  cascade: null,
  cascadeHistory: [],
};
let effectRenderTimer;

const sampleForm = document.querySelector('#sample-form');
const voiceFilter = document.querySelector('#voice-filter');
const voiceOptions = document.querySelector('#voice-options');
const voiceCount = document.querySelector('#voice-count');
const pitchCents = document.querySelector('#pitch-cents');
const pitchOutput = document.querySelector('#pitch-output');
const robotAmount = document.querySelector('#robot-amount');
const robotOutput = document.querySelector('#robot-output');
const effectPresets = document.querySelector('.effect-presets');
const scriptPreset = document.querySelector('#script-preset');
const sampleText = document.querySelector('#sample-text');
const textCount = document.querySelector('#text-count');
const stylePreset = document.querySelector('#style-preset');
const customStyleField = document.querySelector('#custom-style-field');
const customStyle = document.querySelector('#custom-style');
const experimentSummary = document.querySelector('#experiment-summary');
const sampleStatus = document.querySelector('#sample-status');
const sampleList = document.querySelector('#sample-list');
const sampleEmpty = document.querySelector('#sample-empty');
const generateButton = document.querySelector('#generate-button');
const designForm = document.querySelector('#design-form');
const designPreset = document.querySelector('#design-preset');
const designPresetHelp = document.querySelector('#design-preset-help');
const designName = document.querySelector('#design-name');
const designPrompt = document.querySelector('#design-prompt');
const promptLanguages = [...document.querySelectorAll('input[name="prompt-language"]')];
const promptDetails = [...document.querySelectorAll('input[name="prompt-detail"]')];
const designButton = document.querySelector('#design-button');
const confirmStore = document.querySelector('#confirm-store');
const designStatus = document.querySelector('#design-status');
const designResults = document.querySelector('#design-results');
const designEmpty = document.querySelector('#design-empty');
const liveToggle = document.querySelector('#live-toggle');
const liveVoice = document.querySelector('#live-voice');
const liveProfileSelect = document.querySelector('#live-profile');
const liveProfileSummary = document.querySelector('#live-profile-summary');
const liveStatus = document.querySelector('#live-status');
const liveOrb = document.querySelector('#live-orb');
const transcriptEmpty = document.querySelector('#transcript-empty');
const transcriptList = document.querySelector('#transcript-list');
const cascadeToggle = document.querySelector('#cascade-toggle');
const cascadeVoice = document.querySelector('#cascade-voice');
const cascadeProfileSelect = document.querySelector('#cascade-profile');
const cascadeBargeIn = document.querySelector('#cascade-barge-in');
const cascadeProfileSummary = document.querySelector('#cascade-profile-summary');
const cascadeStatus = document.querySelector('#cascade-status');
const cascadeOrb = document.querySelector('#cascade-orb');
const cascadeTranscriptEmpty = document.querySelector('#cascade-transcript-empty');
const cascadeTranscriptList = document.querySelector('#cascade-transcript-list');
const cascadeInterim = document.querySelector('#cascade-interim');
const cascadeTextLatency = document.querySelector('#cascade-text-latency');
const cascadeTTSLatency = document.querySelector('#cascade-tts-latency');
const cascadeTotalLatency = document.querySelector('#cascade-total-latency');
const cascadeEndpointTuning = document.querySelector('#cascade-endpoint-tuning');
const cascadeBargeTuningOutput = document.querySelector('#cascade-barge-tuning');
const cascadePlaybackTuning = document.querySelector('#cascade-playback-tuning');

sampleText.value = auditionScript('everyday').text;
liveProfileSelect.replaceChildren(...liveProfiles.map(item => option(item.id, item.label)));
liveProfileSelect.value = 'shannon-maid';
cascadeProfileSelect.replaceChildren(...liveProfiles.map(item => option(item.id, item.label)));
cascadeProfileSelect.value = 'shannon-maid';
applyDesignPreset(designPreset.value);
updateLiveProfileSummary();
updateCascadeProfileSummary();
updateTextCount();
renderEffectPresets();
renderVoiceOptions();
updateEffectLabels();
updateExperimentSummary();
initialize();

scriptPreset.addEventListener('change', () => {
  if (scriptPreset.value !== 'custom') sampleText.value = auditionScript(scriptPreset.value).text;
  sampleText.focus();
  updateTextCount();
  updateExperimentSummary();
});
sampleText.addEventListener('input', () => {
  if (!auditionScripts.some(script => script.text === sampleText.value)) scriptPreset.value = 'custom';
  updateTextCount();
  updateExperimentSummary();
});
voiceFilter.addEventListener('input', renderVoiceOptions);
voiceOptions.addEventListener('change', updateSelectedVoices);
for (const input of [pitchCents, robotAmount]) {
  input.addEventListener('input', () => {
    updateEffectLabels();
    scheduleSampleReprocessing();
  });
}
stylePreset.addEventListener('change', () => {
  customStyleField.classList.toggle('hidden', stylePreset.value !== 'custom');
  if (stylePreset.value === 'custom') customStyle.focus();
  updateExperimentSummary();
});
customStyle.addEventListener('input', updateExperimentSummary);
for (const input of document.querySelectorAll('input[name="model-mode"], input[name="repetitions"]')) {
  input.addEventListener('change', updateExperimentSummary);
}
designPreset.addEventListener('change', () => {
  if (designPreset.value !== 'custom') applyDesignPreset(designPreset.value, true);
  else updateDesignPresetHelp();
});
for (const input of [...promptLanguages, ...promptDetails]) {
  input.addEventListener('change', () => {
    if (designPreset.value !== 'custom') applyDesignPreset(designPreset.value);
    else updateDesignPresetHelp();
  });
}
designPrompt.addEventListener('input', () => {
  const current = voiceDesignPresets.find(preset => preset.id === designPreset.value);
  const { language, detail } = selectedDesignVariant();
  if (!current || designPrompt.value !== voiceDesignPrompt(current, language, detail)) {
    designPreset.value = 'custom';
    updateDesignPresetHelp();
  }
});
confirmStore.addEventListener('change', () => { designButton.disabled = !confirmStore.checked; });
document.querySelector('#clear-samples').addEventListener('click', clearSamples);
sampleForm.addEventListener('submit', generateSample);
designForm.addEventListener('submit', designVoice);
liveToggle.addEventListener('click', () => state.live ? stopLive('停止しました。') : startLive());
liveProfileSelect.addEventListener('change', updateLiveProfileSummary);
cascadeToggle.addEventListener('click', () => state.cascade ? stopCascade('停止しました。') : startCascade());
cascadeProfileSelect.addEventListener('change', updateCascadeProfileSummary);
cascadeBargeIn.addEventListener('change', updateCascadeBargeInMode);
window.addEventListener('beforeunload', () => {
  stopLive();
  stopCascade();
  for (const sample of state.samples) if (sample.url) URL.revokeObjectURL(sample.url);
  for (const voice of state.designedVoices) URL.revokeObjectURL(voice.url);
});

async function initialize() {
  try {
    state.config = await getJSON('/api/config');
    await loadVoices();
  } catch (error) {
    setStatus(sampleStatus, `ラボの初期化に失敗しました: ${message(error)}`, 'error');
    generateButton.disabled = true;
  }
}

async function loadVoices() {
  try {
    const result = await getJSON('/api/voices');
    const voices = new Map(knownVoices.map(name => [name, { id: name, label: name, type: 'prebuilt' }]));
    for (const item of result.voices ?? []) {
      const id = String(item.id ?? item.name ?? item.voice ?? '').replace(/^voices\//u, '');
      if (!id) continue;
      const label = String(item.display_name ?? item.displayName ?? item.name ?? id);
      voices.set(id, { id, label, type: String(item.type ?? '') });
    }
    const liveSelected = liveVoice.value;
    const cascadeSelected = cascadeVoice.value;
    state.voices = [...voices.values()];
    state.selectedVoiceIds = new Set([...state.selectedVoiceIds].filter(id => voices.has(id)));
    if (!state.selectedVoiceIds.size) state.selectedVoiceIds.add(voices.has('Leda') ? 'Leda' : state.voices[0]?.id);
    renderVoiceOptions();
    liveVoice.replaceChildren(...[...voices.values()].map(({ id, label, type }) => option(id, voiceLabel(id, label, type))));
    cascadeVoice.replaceChildren(...[...voices.values()].map(({ id, label, type }) => option(id, voiceLabel(id, label, type))));
    if (voices.has(liveSelected)) liveVoice.value = liveSelected;
    else liveVoice.value = firstSelectedVoice() ?? 'Aoede';
    const shannon = [...voices.values()].find(item => item.label.trim().toLowerCase() === 'shannon maid')
      ?? [...voices.values()].find(item => item.label.trim().toLowerCase() === 'shannon');
    if (shannon) cascadeVoice.value = shannon.id;
    else if (voices.has(cascadeSelected)) cascadeVoice.value = cascadeSelected;
    else cascadeVoice.value = firstSelectedVoice() ?? 'Aoede';
  } catch (error) {
    setStatus(sampleStatus, `声一覧は既定候補を使います: ${message(error)}`);
  }
}

function renderVoiceOptions() {
  const query = voiceFilter.value.trim().toLocaleLowerCase('ja');
  const visible = state.voices.filter(({ id, label }) => `${label} ${id}`.toLocaleLowerCase('ja').includes(query));
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'no-results';
    empty.textContent = '一致する声がありません。';
    voiceOptions.replaceChildren(empty);
  } else {
    voiceOptions.replaceChildren(...visible.map(({ id, label, type }) => {
      const row = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = id;
      input.checked = state.selectedVoiceIds.has(id);
      const text = document.createElement('span');
      text.textContent = voiceLabel(id, label, type);
      row.append(input, text);
      return row;
    }));
  }
  updateVoiceCount();
}

function updateSelectedVoices(event) {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;
  if (input.checked && state.selectedVoiceIds.size >= 4 && !state.selectedVoiceIds.has(input.value)) {
    input.checked = false;
    setStatus(sampleStatus, '一度に比較できる声は4つまでです。', 'error');
    return;
  }
  if (input.checked) state.selectedVoiceIds.add(input.value);
  else state.selectedVoiceIds.delete(input.value);
  updateVoiceCount();
  updateExperimentSummary();
  const primary = firstSelectedVoice();
  if (primary && liveVoice.querySelector(`option[value="${CSS.escape(primary)}"]`)) liveVoice.value = primary;
  if (primary && cascadeVoice.querySelector(`option[value="${CSS.escape(primary)}"]`)) cascadeVoice.value = primary;
}

function updateVoiceCount() {
  voiceCount.textContent = `${state.selectedVoiceIds.size} / 4`;
}

function firstSelectedVoice() { return state.selectedVoiceIds.values().next().value ?? null; }

async function generateSample(event) {
  event.preventDefault();
  if (!state.config) return;
  const selectedVoices = [...state.selectedVoiceIds];
  if (!selectedVoices.length) {
    setStatus(sampleStatus, '比較する声を1つ以上選んでください。', 'error');
    return;
  }
  generateButton.disabled = true;
  const form = new FormData(sampleForm);
  const modelMode = form.get('model-mode');
  const repetitions = Number(form.get('repetitions')) || 1;
  const modelJobs = auditionJobs(modelMode, repetitions);
  const jobs = selectedVoices.flatMap(voice => modelJobs.map(job => ({ ...job, voice })));
  const selectedStyle = stylePreset.value === 'custom' ? null : auditionStyle(stylePreset.value);
  const style = stylePreset.value === 'custom' ? customStyle.value : selectedStyle?.value ?? '';
  const script = auditionScript(scriptPreset.value);
  const batchId = crypto.randomUUID();
  let completed = 0;
  let failures = 0;
  let totalCost = 0;
  for (const job of jobs) {
    setStatus(sampleStatus, `${completed + failures + 1} / ${jobs.length} を生成中 · ${job.voice} · ${shortModelName(job.model)} ${job.run}/${repetitions}`);
    try {
      const response = await post('/api/sample', { model: job.model, voice: job.voice, text: sampleText.value, style });
      if (!response.ok) throw await responseError(response);
      const blob = await response.blob();
      const durationMilliseconds = Number(response.headers.get('x-shannon-duration-ms')) || 0;
      const elapsedMilliseconds = Number(response.headers.get('x-shannon-elapsed-ms')) || 0;
      totalCost += ttsCost(job.model, durationMilliseconds);
      const sample = {
        id: crypto.randomUUID(), batchId, model: job.model, voice: job.voice, style,
        styleName: stylePreset.value === 'custom' ? '自由入力' : selectedStyle?.label,
        scriptName: script?.label ?? '自由入力', text: sampleText.value, sourceBlob: blob,
        url: null, durationMilliseconds, elapsedMilliseconds,
        run: job.run, repetitions,
      };
      await prepareSampleAudio(sample);
      state.samples.unshift(sample);
      completed += 1;
      while (state.samples.length > 24) {
        const removed = state.samples.pop();
        if (removed.url) URL.revokeObjectURL(removed.url);
      }
      renderSamples();
    } catch (error) {
      failures += 1;
      setStatus(sampleStatus, `${job.voice} · ${shortModelName(job.model)} ${job.run}/${repetitions} を生成できませんでした: ${message(error)}`, 'error');
    }
  }
  generateButton.disabled = false;
  const result = `${completed}/${jobs.length}件を生成 · 合計約${usd(totalCost)}`;
  setStatus(sampleStatus, failures ? `${result} · ${failures}件は失敗しました。成功分は比較できます。` : result, failures ? 'error' : 'success');
}

function renderSamples() {
  sampleEmpty.classList.toggle('hidden', state.samples.length > 0);
  sampleList.replaceChildren(...state.samples.map((sample, index) => {
    const item = document.createElement('li');
    item.className = 'sample-card';
    const shortModel = shortModelName(sample.model);
    item.innerHTML = `<header><div><h4>${escapeHTML(sample.voice)}</h4><div class="meta">${shortModel} · ${escapeHTML(sample.scriptName)} · ${escapeHTML(sample.styleName ?? '指定なし')}</div></div><small>${sample.run}/${sample.repetitions}</small></header>`;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    if (sample.url) audio.src = sample.url;
    const footer = document.createElement('footer');
    const metrics = document.createElement('span');
    metrics.textContent = `${formatDuration(sample.durationMilliseconds)} · 生成${formatDuration(sample.elapsedMilliseconds)} · ${effectDescription(sample.effects)} · 約${usd(ttsCost(sample.model, sample.durationMilliseconds))}`;
    const actions = document.createElement('span');
    const download = document.createElement('a');
    download.href = sample.url ?? '#';
    download.download = `shannon-${safeFilename(sample.voice)}-${shortModel.toLowerCase()}-${effectFilename(sample.effects)}.wav`;
    download.textContent = '保存';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '消す';
    remove.addEventListener('click', () => removeSample(sample.id));
    actions.append(download, remove);
    footer.append(metrics, actions);
    item.append(audio, footer);
    return item;
  }));
}

function removeSample(id) {
  const index = state.samples.findIndex(sample => sample.id === id);
  if (index < 0) return;
  if (state.samples[index].url) URL.revokeObjectURL(state.samples[index].url);
  state.samples.splice(index, 1);
  renderSamples();
}

function clearSamples() {
  for (const sample of state.samples) if (sample.url) URL.revokeObjectURL(sample.url);
  state.samples = [];
  renderSamples();
  setStatus(sampleStatus, '比較トレイを空にしました。');
}

async function prepareSampleAudio(sample) {
  if (!sample.sourceSamples) {
    const decoded = decodePCM16WAV(await sample.sourceBlob.arrayBuffer());
    sample.sourceSamples = decoded.samples;
    sample.sampleRate = decoded.sampleRate;
  }
  const effects = currentEffectSettings();
  const processed = processVoiceEffects(sample.sourceSamples, sample.sampleRate, effects);
  const wav = encodeMonoFloat32WAV(processed, sample.sampleRate);
  if (sample.url) URL.revokeObjectURL(sample.url);
  sample.url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  sample.effects = effects;
  sample.processedDurationMilliseconds = Math.round(processed.length / sample.sampleRate * 1_000);
}

function scheduleSampleReprocessing() {
  clearTimeout(effectRenderTimer);
  effectRenderTimer = setTimeout(async () => {
    try {
      for (const sample of state.samples) await prepareSampleAudio(sample);
      renderSamples();
      if (state.samples.length) setStatus(sampleStatus, '高さとロボ感を、生成済みサンプルへ掛け直しました。', 'success');
    } catch (error) {
      setStatus(sampleStatus, `音声加工を更新できませんでした: ${message(error)}`, 'error');
    }
  }, 120);
}

function renderEffectPresets() {
  effectPresets.replaceChildren(...voiceEffectPresets.map(preset => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.effectPreset = preset.id;
    button.textContent = preset.label;
    button.addEventListener('click', () => {
      pitchCents.value = String(preset.pitchCents);
      robotAmount.value = String(Math.round(preset.robotAmount * 100));
      updateEffectLabels();
      scheduleSampleReprocessing();
    });
    return button;
  }));
}

function currentEffectSettings() {
  return normalizeVoiceEffects({
    pitchCents: Number(pitchCents.value),
    robotAmount: Number(robotAmount.value) / 100,
  });
}

function updateEffectLabels() {
  const effects = currentEffectSettings();
  pitchOutput.value = `${effects.pitchCents > 0 ? '+' : ''}${Math.round(effects.pitchCents)} cent`;
  robotOutput.value = `${Math.round(effects.robotAmount * 100)}%`;
  for (const button of effectPresets.querySelectorAll('button')) {
    const preset = voiceEffectPresets.find(item => item.id === button.dataset.effectPreset);
    button.classList.toggle('active', preset?.pitchCents === effects.pitchCents && preset?.robotAmount === effects.robotAmount);
  }
}

function updateExperimentSummary() {
  const form = new FormData(sampleForm);
  const models = form.get('model-mode') === 'both' ? 2 : 1;
  const repetitions = Number(form.get('repetitions')) || 1;
  const voices = state.selectedVoiceIds.size;
  const calls = models * repetitions * voices;
  const style = stylePreset.value === 'custom'
    ? (customStyle.value.trim() ? '自由入力の演技' : '演技指定なし')
    : auditionStyle(stylePreset.value)?.label ?? '演技指定なし';
  experimentSummary.innerHTML = `<strong>${calls}件を順番に生成</strong> · ${voices}声 × ${models === 2 ? 'Flash / Flash-Lite' : '1モデル'} × ${repetitions}回 · ${escapeHTML(style)} · 加工は再課金なし`;
}

async function designVoice(event) {
  event.preventDefault();
  if (!confirmStore.checked) return;
  designButton.disabled = true;
  setStatus(designStatus, '声を設計しています。通常の試聴より時間がかかります…');
  try {
    const variant = selectedDesignVariant();
    const response = await post('/api/design', {
      name: designName.value,
      prompt: designPrompt.value,
      language: 'ja-JP',
      gender: 'female',
      confirmStore: true,
    });
    if (!response.ok) throw await responseError(response);
    const result = await response.json();
    const blob = base64Blob(result.audioBase64, result.mimeType);
    state.designedVoices.unshift({
      ...result,
      localId: crypto.randomUUID(),
      url: URL.createObjectURL(blob),
      presetLabel: voiceDesignPresets.find(item => item.id === designPreset.value)?.label ?? '自由入力',
      language: variant.language,
      detail: variant.detail,
    });
    addDesignedVoiceOption(result.id, result.name);
    renderDesignResults();
    setStatus(designStatus, `新しい声を作りました。候補は${state.designedVoices.length}件です。比較欄でも選べます。`, 'success');
  } catch (error) {
    setStatus(designStatus, `声を作れませんでした: ${designErrorMessage(error)}`, 'error');
  } finally {
    designButton.disabled = !confirmStore.checked;
  }
}

function applyDesignPreset(id, focus = false) {
  const preset = voiceDesignPresets.find(item => item.id === id);
  if (!preset) return;
  const { language, detail } = selectedDesignVariant();
  designName.value = preset.name;
  designPrompt.value = voiceDesignPrompt(preset, language, detail);
  updateDesignPresetHelp();
  if (focus) designPrompt.focus();
}

function updateDesignPresetHelp() {
  if (designPreset.value === 'custom') {
    designPresetHelp.textContent = '自由入力は実API未確認です。年齢の数値指定や、人物・既存キャラクターの模倣表現は安全判定で拒否される場合があります。';
    return;
  }
  const preset = voiceDesignPresets.find(item => item.id === designPreset.value);
  const { language, detail } = selectedDesignVariant();
  const variant = `${language === 'ja' ? '日本語' : '英語'}・${detail === 'short' ? '短文' : '詳細'}`;
  designPresetHelp.textContent = voiceDesignVariantIsVerified(preset, language, detail)
    ? `${variant}版は${voiceDesignVariantVerifiedAt(preset)}にGemini実APIで作成確認済みです。`
    : `${variant}版は実API未確認です。作成前に内容を確認してください。`;
}

function designErrorMessage(error) {
  const detail = message(error);
  if (/blocked by safety policies/iu.test(detail)) {
    return 'Geminiの安全ポリシーで設計文が拒否されました。実API確認済みプリセットへ戻すか、年齢の数値指定と人物・既存キャラクターの模倣表現を外してください。';
  }
  return detail;
}

function renderDesignResults() {
  designEmpty.classList.toggle('hidden', state.designedVoices.length > 0);
  for (const card of designResults.querySelectorAll('[data-designed-voice]')) card.remove();
  for (const result of state.designedVoices) {
    const card = document.createElement('article');
    card.className = 'design-result';
    card.dataset.designedVoice = result.localId;
    const title = document.createElement('h3');
    title.textContent = result.name;
    const note = document.createElement('p');
    note.className = 'meta';
    note.textContent = `${result.presetLabel} · ${result.language === 'ja' ? '日本語' : '英語'} · ${result.detail === 'short' ? '短文' : '詳細'} · ${result.creationModel ?? 'default model'}`;
    const code = document.createElement('code');
    code.textContent = result.id;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = result.url;
    const deletion = document.createElement('div');
    deletion.className = 'delete-row';
    const label = document.createElement('label');
    label.className = 'field';
    label.textContent = '破棄する場合はVoice IDを正確に入力';
    const input = document.createElement('input');
    input.placeholder = result.id;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'この候補をGoogleから削除';
    button.disabled = true;
    input.addEventListener('input', () => { button.disabled = input.value !== result.id; });
    button.addEventListener('click', () => deleteDesignedVoice(result.localId, input, button));
    label.append(input);
    deletion.append(label, button);
    card.append(title, note, code, audio, deletion);
    designResults.append(card);
  }
}

async function deleteDesignedVoice(localId, input, button) {
  const result = state.designedVoices.find(item => item.localId === localId);
  const id = result?.id;
  if (!id || input.value !== id) return;
  button.disabled = true;
  setStatus(designStatus, '保存済み音声を削除しています…');
  try {
    const response = await post('/api/delete', { id, confirm: id });
    if (!response.ok) throw await responseError(response);
    state.voices = state.voices.filter(item => item.id !== id);
    state.selectedVoiceIds.delete(id);
    if (!state.selectedVoiceIds.size && state.voices.some(item => item.id === 'Leda')) state.selectedVoiceIds.add('Leda');
    renderVoiceOptions();
    updateExperimentSummary();
    liveVoice.querySelector(`option[value="${CSS.escape(id)}"]`)?.remove();
    cascadeVoice.querySelector(`option[value="${CSS.escape(id)}"]`)?.remove();
    if (liveVoice.value === id) liveVoice.value = 'Aoede';
    if (cascadeVoice.value === id) cascadeVoice.value = 'Aoede';
    URL.revokeObjectURL(result.url);
    state.designedVoices = state.designedVoices.filter(item => item.localId !== localId);
    renderDesignResults();
    setStatus(designStatus, '保存済み音声を削除しました。', 'success');
  } catch (error) {
    button.disabled = false;
    setStatus(designStatus, `削除できませんでした: ${message(error)}`, 'error');
  }
}

function selectedDesignVariant() {
  return {
    language: document.querySelector('input[name="prompt-language"]:checked')?.value ?? 'ja',
    detail: document.querySelector('input[name="prompt-detail"]:checked')?.value ?? 'detailed',
  };
}

function addDesignedVoiceOption(id, name) {
  state.voices = [{ id, label: name, type: 'prompted' }, ...state.voices.filter(item => item.id !== id)];
  state.selectedVoiceIds = new Set([id]);
  voiceFilter.value = '';
  renderVoiceOptions();
  updateExperimentSummary();
  for (const select of [liveVoice, cascadeVoice]) {
    select.querySelector(`option[value="${CSS.escape(id)}"]`)?.remove();
    select.prepend(option(id, `${name} · 作成した声`));
  }
  liveVoice.value = id;
  cascadeVoice.value = id;
}

async function startLive() {
  if (!state.config) return;
  if (state.cascade) stopCascade('Liveへ切り替えました。');
  liveToggle.disabled = true;
  setStatus(liveStatus, 'マイク権限を確認しています…');
  let pendingStream;
  let pendingContext;
  try {
    pendingStream = await requestMicrophone();
    setStatus(liveStatus, '短命トークンと音声処理を準備しています…');
    const tokenResponse = await post('/api/live-token', { voice: liveVoice.value });
    if (!tokenResponse.ok) throw await responseError(tokenResponse);
    const session = await tokenResponse.json();
    const stream = pendingStream;
    const context = new AudioContext({ latencyHint: 'interactive' });
    pendingContext = context;
    await context.audioWorklet.addModule('/capture-worklet.js');
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, 'shannon-capture');
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(capture).connect(mute).connect(context.destination);

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(session.token)}`;
    const socket = new WebSocket(url);
    const profileId = liveProfileSelect.value;
    state.live = { socket, session, profileId, stream, context, source, capture, mute, ready: false, nextPlaybackTime: 0, sources: new Set() };
    pendingStream = null;
    pendingContext = null;
    capture.port.onmessage = ({ data }) => sendMicrophoneChunk(data);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(liveSetup(session.model, session.voice, profileId)));
      setStatus(liveStatus, '接続済み · セッションを設定しています…');
    });
    socket.addEventListener('message', event => handleLiveMessage(event.data));
    socket.addEventListener('error', () => stopLive('Live接続でエラーが発生しました。', 'error'));
    socket.addEventListener('close', () => {
      if (state.live?.socket === socket) stopLive('Live接続が終了しました。', 'error');
    });
  } catch (error) {
    for (const track of pendingStream?.getTracks() ?? []) track.stop();
    pendingContext?.close().catch(() => {});
    stopLive(`開始できませんでした: ${liveStartMessage(error)}`, 'error');
  } finally {
    liveToggle.disabled = false;
  }
}

function sendMicrophoneChunk(buffer) {
  if (!state.live?.ready || state.live.socket.readyState !== WebSocket.OPEN) return;
  state.live.socket.send(JSON.stringify({
    realtimeInput: { audio: { data: arrayBufferBase64(buffer), mimeType: 'audio/pcm;rate=16000' } },
  }));
}

async function handleLiveMessage(data) {
  try {
    if (!state.live) return;
    const text = data instanceof Blob ? await data.text() : String(data);
    const event = JSON.parse(text);
    if (event.setupComplete) {
      state.live.ready = true;
      liveToggle.disabled = false;
      liveToggle.innerHTML = '<span aria-hidden="true">■</span> 会話を止める';
      liveToggle.classList.add('secondary');
      liveVoice.disabled = true;
      liveProfileSelect.disabled = true;
      liveOrb.classList.add('active');
      const profile = liveProfile(state.live.profileId);
      appendSessionMarker(`${voiceDisplayName(state.live.session.voice)} × ${profile.shortLabel}`);
      setStatus(liveStatus, `会話中 · ${profile.shortLabel}で応答しています。`, 'success');
    }
    const content = event.serverContent;
    if (!content) return;
    if (content.interrupted) stopPlayback();
    const inputText = content.inputTranscription?.text;
    const outputText = content.outputTranscription?.text;
    if (inputText) appendTranscript('user', 'あなた', inputText);
    if (outputText) appendTranscript('model', 'Shannon', outputText);
    for (const part of content.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (inline?.data && String(inline.mimeType ?? '').toLowerCase().startsWith('audio/pcm')) {
        playPCM24k(inline.data);
      }
    }
  } catch (error) {
    setStatus(liveStatus, `Live応答を処理できませんでした: ${message(error)}`, 'error');
  }
}

function playPCM24k(encoded) {
  const live = state.live;
  if (!live) return;
  const bytes = base64Bytes(encoded);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  const buffer = live.context.createBuffer(1, count, 24_000);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < count; index += 1) channel[index] = view.getInt16(index * 2, true) / 32768;
  const source = live.context.createBufferSource();
  source.buffer = buffer;
  source.connect(live.context.destination);
  live.sources.add(source);
  source.addEventListener('ended', () => live.sources.delete(source));
  const start = Math.max(live.context.currentTime + .025, live.nextPlaybackTime);
  source.start(start);
  live.nextPlaybackTime = start + buffer.duration;
}

function stopPlayback() {
  const live = state.live;
  if (!live) return;
  for (const source of live.sources) { try { source.stop(); } catch {} }
  live.sources.clear();
  live.nextPlaybackTime = live.context.currentTime;
}

function stopLive(status, kind) {
  const live = state.live;
  state.live = null;
  if (live) {
    stopPlaybackFor(live);
    if (live.socket.readyState === WebSocket.OPEN) {
      try { live.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch {}
    }
    try { live.socket.close(); } catch {}
    for (const track of live.stream.getTracks()) track.stop();
    live.capture.disconnect();
    live.source.disconnect();
    live.context.close().catch(() => {});
  }
  liveToggle.disabled = false;
  liveToggle.innerHTML = '<span aria-hidden="true">●</span> 会話を始める';
  liveToggle.classList.remove('secondary');
  liveVoice.disabled = false;
  liveProfileSelect.disabled = false;
  liveOrb.classList.remove('active');
  if (status) setStatus(liveStatus, status, kind);
}

function stopPlaybackFor(live) {
  for (const source of live.sources) { try { source.stop(); } catch {} }
  live.sources.clear();
}

function liveSetup(model, voice, profileId) {
  const voiceConfig = voice.startsWith('voice_')
    ? { voice }
    : { prebuiltVoiceConfig: { voiceName: voice } };
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig } },
      systemInstruction: { parts: [{ text: liveSystemInstruction(profileId) }] },
      inputAudioTranscription: {}, outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { disabled: false, startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', prefixPaddingMs: 80, silenceDurationMs: 600 }, activityHandling: 'START_OF_ACTIVITY_INTERRUPTS' },
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

function updateLiveProfileSummary() {
  const profile = liveProfile(liveProfileSelect.value);
  liveProfileSummary.innerHTML = `<strong>${escapeHTML(profile.shortLabel)}</strong><span>${escapeHTML(profile.summary)}</span>`;
}

async function startCascade() {
  if (!state.config) return;
  if (state.live) stopLive('カスケード会話へ切り替えました。');
  cascadeToggle.disabled = true;
  setStatus(cascadeStatus, 'マイク権限を確認しています…');
  let pendingStream;
  let pendingContext;
  try {
    pendingStream = await requestMicrophone();
    setStatus(cascadeStatus, '音声認識と再生処理を準備しています…');
    const tokenResponse = await post('/api/transcribe-token', {});
    if (!tokenResponse.ok) throw await responseError(tokenResponse);
    const session = await tokenResponse.json();
    const stream = pendingStream;
    const context = new AudioContext({ latencyHint: 'interactive' });
    pendingContext = context;
    await context.audioWorklet.addModule('/capture-worklet.js');
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, 'shannon-capture');
    const mute = context.createGain();
    const playbackGain = context.createGain();
    mute.gain.value = 0;
    playbackGain.gain.value = 1;
    source.connect(capture).connect(mute).connect(context.destination);
    playbackGain.connect(context.destination);

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(session.token)}`;
    const socket = new WebSocket(url);
    const profileId = cascadeProfileSelect.value;
    const track = stream.getAudioTracks()[0];
    const trackSettings = track?.getSettings?.() ?? {};
    const audioTuning = cascadeBargeTuning({ trackLabel: track?.label, settings: trackSettings });
    state.cascade = {
      socket, session, profileId, stream, context, source, capture, mute, playbackGain,
      ready: false, busy: false, speaking: false, nextPlaybackTime: 0,
      sources: new Set(), controllers: new Set(), transcriptBuffer: '', finalizeTimer: null,
      activeTurn: null, turnSerial: 0, bargeInCandidate: null,
      trackLabel: track?.label ?? '', trackSettings, audioTuning, falsePositiveCount: 0,
      remoteLevel: 0, playbackLeadSeconds: CASCADE_PLAYBACK_LEAD_SECONDS,
      playbackUnderruns: 0, playbackStarted: false, lastFinalizeDelay: null,
    };
    pendingStream = null;
    pendingContext = null;
    capture.port.onmessage = ({ data }) => sendCascadeMicrophoneChunk(data);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(transcribeSetup(session.model)));
      setStatus(cascadeStatus, '接続済み · 音声認識を設定しています…');
    });
    socket.addEventListener('message', event => handleCascadeTranscription(event.data));
    socket.addEventListener('error', () => stopCascade('音声認識の接続でエラーが発生しました。', 'error'));
    socket.addEventListener('close', () => {
      if (state.cascade?.socket === socket) stopCascade('音声認識の接続が終了しました。', 'error');
    });
  } catch (error) {
    for (const track of pendingStream?.getTracks() ?? []) track.stop();
    pendingContext?.close().catch(() => {});
    stopCascade(`開始できませんでした: ${liveStartMessage(error)}`, 'error');
  } finally {
    cascadeToggle.disabled = false;
  }
}

function transcribeSetup(model) {
  return {
    setup: {
      model: `models/${model}`,
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

function sendCascadeMicrophoneChunk(buffer) {
  const cascade = state.cascade;
  if (!cascade || !shouldSendCascadeAudio({
    ready: cascade.ready,
    socketOpen: cascade.socket.readyState === WebSocket.OPEN,
    activeTurn: Boolean(cascade.activeTurn),
    bargeIn: cascadeBargeIn.checked,
  })) return;
  cascade.socket.send(JSON.stringify({
    realtimeInput: { audio: { data: arrayBufferBase64(buffer), mimeType: 'audio/pcm;rate=16000' } },
  }));
}

async function handleCascadeTranscription(data) {
  try {
    const cascade = state.cascade;
    if (!cascade) return;
    const text = data instanceof Blob ? await data.text() : String(data);
    const event = JSON.parse(text);
    if (event.setupComplete) {
      cascade.ready = true;
      cascadeToggle.disabled = false;
      cascadeToggle.innerHTML = '<span aria-hidden="true">■</span> カスケード会話を止める';
      cascadeToggle.classList.add('secondary');
      setCascadeControlsDisabled(true);
      cascadeOrb.classList.add('active');
      appendCascadeSessionMarker(`${cascadeVoice.options[cascadeVoice.selectedIndex]?.textContent ?? cascadeVoice.value} × ${liveProfile(cascade.profileId).shortLabel}`);
      updateCascadeTuningOutputs(cascade);
      setStatus(cascadeStatus, '聞いています · 話し終わると返答を作ります。', 'success');
    }
    const content = event.serverContent;
    if (!content) return;
    const interim = String(content.interimInputTranscription?.text ?? '').trim();
    const finalText = String(content.inputTranscription?.text ?? '');
    if (cascade.activeTurn && !cascadeBargeIn.checked) return;
    handleCascadeBargeIn(cascade, interim, finalText);
    if (interim) showCascadeInterim(interim);
    if (finalText) {
      cascade.transcriptBuffer = mergeStreamingText(cascade.transcriptBuffer, finalText);
      showCascadeInterim(cascade.transcriptBuffer);
      clearTimeout(cascade.finalizeTimer);
      const delay = adaptiveCascadeFinalizeDelay(cascade.transcriptBuffer);
      cascade.lastFinalizeDelay = delay;
      updateCascadeTuningOutputs(cascade);
      cascade.finalizeTimer = setTimeout(() => finalizeCascadeTranscript(cascade), delay);
    }
    if (content.turnComplete && cascade.transcriptBuffer.trim()) {
      cascade.lastFinalizeDelay = adaptiveCascadeFinalizeDelay(cascade.transcriptBuffer, { turnComplete: true });
      updateCascadeTuningOutputs(cascade);
      finalizeCascadeTranscript(cascade);
    }
  } catch (error) {
    setStatus(cascadeStatus, `音声認識を処理できませんでした: ${message(error)}`, 'error');
  }
}

function finalizeCascadeTranscript(cascade) {
  if (state.cascade !== cascade) return;
  if (cascade.activeTurn) {
    if (!cascadeBargeIn.checked) return;
    interruptCascadeTurn(cascade);
  }
  clearTimeout(cascade.finalizeTimer);
  cascade.finalizeTimer = null;
  const text = cascade.transcriptBuffer.trim();
  cascade.transcriptBuffer = '';
  showCascadeInterim('');
  if (text) handleCascadeTurn(text, cascade);
}

async function handleCascadeTurn(text, cascade) {
  if (state.cascade !== cascade || cascade.activeTurn) return;
  cascade.busy = true;
  const finalizedAt = performance.now();
  appendCascadeTranscript('user', 'あなた', text);
  setStatus(cascadeStatus, '返答を考えています · 最初の文から話し始めます…');
  const controller = new AbortController();
  const turn = {
    id: ++cascade.turnSerial,
    controller,
    transcriptItem: null,
    interrupted: false,
    responseText: '',
    firstSentenceAt: null,
    firstAudioAt: null,
    speechChain: Promise.resolve(),
    speechSegments: 0,
  };
  cascade.activeTurn = turn;
  cascade.controllers.add(controller);
  try {
    const response = await post('/api/cascade-response', {
      model: selectedCascadeModel('cascade-text-model'),
      text,
      profile: cascade.profileId,
      history: state.cascadeHistory,
    }, { signal: controller.signal });
    if (!response.ok) throw await responseError(response);
    let responseBuffer = '';
    for await (const event of browserServerSentEvents(response.body, 'Geminiの返答')) {
      if (!isActiveCascadeTurn(cascade, turn)) return;
      responseBuffer += streamedTextFromGeminiEvent(event);
      const parsed = takeCascadeSpeechSegments(responseBuffer);
      responseBuffer = parsed.remainder;
      for (const segment of parsed.segments) enqueueCascadeSpeechSegment(segment, cascade, turn, finalizedAt);
    }
    const finalSegments = takeCascadeSpeechSegments(responseBuffer, { flush: true }).segments;
    for (const segment of finalSegments) enqueueCascadeSpeechSegment(segment, cascade, turn, finalizedAt);
    if (!turn.responseText) throw new Error('Geminiから読み上げ可能な返答が返りませんでした');
    state.cascadeHistory = [
      ...state.cascadeHistory,
      { role: 'user', text },
      { role: 'model', text: turn.responseText },
    ].slice(-12);
    await turn.speechChain;
    if (!turn.firstAudioAt) throw new Error('Gemini TTSから音声が返りませんでした');
    const remainingMilliseconds = Math.max(0, (cascade.nextPlaybackTime - cascade.context.currentTime) * 1_000) + 160;
    await wait(remainingMilliseconds);
    if (isActiveCascadeTurn(cascade, turn)) setStatus(cascadeStatus, '聞いています · 続けて話しかけられます。', 'success');
  } catch (error) {
    if (error?.name !== 'AbortError' && isActiveCascadeTurn(cascade, turn)) {
      setStatus(cascadeStatus, `返答できませんでした: ${message(error)}`, 'error');
    }
  } finally {
    cascade.controllers.delete(controller);
    if (isActiveCascadeTurn(cascade, turn)) {
      clearCascadeBargeInCandidate(cascade, { restore: true });
      cascade.activeTurn = null;
      cascade.busy = false;
      cascade.speaking = false;
    }
  }
}

function enqueueCascadeSpeechSegment(segment, cascade, turn, finalizedAt) {
  if (!isActiveCascadeTurn(cascade, turn)) return;
  turn.speechSegments += 1;
  turn.responseText += segment.text;
  if (!turn.transcriptItem) turn.transcriptItem = appendCascadeTranscript('model', 'Shannon', turn.responseText);
  else updateCascadeTranscript(turn.transcriptItem, turn.responseText);
  if (!turn.firstSentenceAt) {
    turn.firstSentenceAt = performance.now();
    cascadeTextLatency.textContent = formatDuration(Math.round(turn.firstSentenceAt - finalizedAt));
  }
  const style = cascadeEmotionStyle(liveTTSStyle(cascade.profileId), segment.emotion);
  turn.speechChain = turn.speechChain.then(() => speakCascadeSegment({
    cascade,
    turn,
    segment,
    style,
    finalizedAt,
  }));
  turn.speechChain.catch(() => {});
  setStatus(cascadeStatus, `文${turn.speechSegments}を音声化中 · ${cascadeEmotionLabel(segment.emotion)}`);
}

async function speakCascadeSegment({ cascade, turn, segment, style, finalizedAt }) {
  if (!isActiveCascadeTurn(cascade, turn)) return;
  const speechResponse = await post('/api/cascade-speech', {
    model: selectedCascadeModel('cascade-tts-model'),
    voice: cascadeVoice.value,
    text: segment.text,
    style,
  }, { signal: turn.controller.signal });
  if (!speechResponse.ok) throw await responseError(speechResponse);
  cascade.speaking = true;
  let audioChunks = 0;
  for await (const event of browserServerSentEvents(speechResponse.body, 'Gemini TTS')) {
    if (!isActiveCascadeTurn(cascade, turn)) return;
    for (const part of event?.candidates?.[0]?.content?.parts ?? []) {
      if (!part?.inlineData?.data) continue;
      if (!turn.firstAudioAt) {
        turn.firstAudioAt = performance.now();
        cascadeTTSLatency.textContent = formatDuration(Math.round(turn.firstAudioAt - turn.firstSentenceAt));
        cascadeTotalLatency.textContent = formatDuration(Math.round(turn.firstAudioAt - finalizedAt));
      }
      audioChunks += 1;
      playCascadePCM24k(part.inlineData.data, cascade);
      setStatus(cascadeStatus, cascadeBargeIn.checked
        ? `Shannonが話しています · ${cascadeEmotionLabel(segment.emotion)} · 話せば割り込めます。`
        : `Shannonが話しています · ${cascadeEmotionLabel(segment.emotion)} · 交互会話モードです。`, 'success');
    }
  }
  if (audioChunks === 0) throw new Error('Gemini TTSから音声が返りませんでした');
}

function isActiveCascadeTurn(cascade, turn) {
  return state.cascade === cascade && cascade.activeTurn === turn && !turn.interrupted;
}

function handleCascadeBargeIn(cascade, interimText, finalText) {
  const now = performance.now();
  cascade.audioTuning = cascadeBargeTuning({
    trackLabel: cascade.trackLabel,
    settings: cascade.trackSettings,
    remoteLevel: cascade.remoteLevel,
    falsePositiveCount: cascade.falsePositiveCount,
  });
  const action = cascadeBargeInAction({
    bargeIn: cascadeBargeIn.checked,
    activeTurn: Boolean(cascade.activeTurn),
    candidateStartedAt: cascade.bargeInCandidate?.startedAt,
    now,
    interimText,
    finalText,
    confirmAfterMs: cascade.audioTuning.confirmAfterMs,
  });
  if (action === 'ignore') return;
  if (action === 'interrupt') {
    cascade.falsePositiveCount = Math.max(0, cascade.falsePositiveCount - 1);
    updateCascadeTuningOutputs(cascade);
    interruptCascadeTurn(cascade);
    return;
  }
  if (action === 'duck') {
    cascade.bargeInCandidate = {
      turn: cascade.activeTurn,
      startedAt: now,
      lastHeardAt: now,
      releaseTimer: null,
    };
    setCascadePlaybackGain(cascade, cascade.audioTuning.duckGain);
    setStatus(cascadeStatus, '話し声を確認中 · Shannonの音量を下げています…', 'success');
  } else if (cascade.bargeInCandidate) {
    cascade.bargeInCandidate.lastHeardAt = now;
  }
  scheduleCascadeDuckRelease(cascade);
}

function scheduleCascadeDuckRelease(cascade) {
  const candidate = cascade.bargeInCandidate;
  if (!candidate) return;
  clearTimeout(candidate.releaseTimer);
  candidate.releaseTimer = setTimeout(() => {
    if (state.cascade !== cascade || cascade.bargeInCandidate !== candidate) return;
    if (!shouldRestoreCascadeVolume({
      candidateLastHeardAt: candidate.lastHeardAt,
      now: performance.now(),
      releaseAfterMs: cascade.audioTuning.releaseAfterMs,
    })) {
      scheduleCascadeDuckRelease(cascade);
      return;
    }
    clearCascadeBargeInCandidate(cascade, { restore: true });
    cascade.falsePositiveCount = Math.min(4, cascade.falsePositiveCount + 1);
    cascade.audioTuning = cascadeBargeTuning({
      trackLabel: cascade.trackLabel,
      settings: cascade.trackSettings,
      remoteLevel: cascade.remoteLevel,
      falsePositiveCount: cascade.falsePositiveCount,
    });
    updateCascadeTuningOutputs(cascade);
    if (!isActiveCascadeTurn(cascade, candidate.turn)) return;
    setStatus(cascadeStatus, cascade.speaking
      ? 'Shannonが話しています · 誤検知だったため音量を戻しました。'
      : '返答を考えています · 誤検知だったため処理を続けます。', 'success');
  }, cascade.audioTuning.releaseAfterMs);
}

function clearCascadeBargeInCandidate(cascade, { restore = false } = {}) {
  const candidate = cascade.bargeInCandidate;
  if (candidate) clearTimeout(candidate.releaseTimer);
  cascade.bargeInCandidate = null;
  if (restore) setCascadePlaybackGain(cascade, 1);
}

function setCascadePlaybackGain(cascade, value) {
  const gain = cascade.playbackGain?.gain;
  if (!gain) return;
  const now = cascade.context.currentTime;
  if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(now);
  else {
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
  }
  gain.linearRampToValueAtTime(value, now + .08);
}

function interruptCascadeTurn(cascade) {
  const turn = cascade.activeTurn;
  if (!turn) return;
  turn.interrupted = true;
  turn.controller.abort();
  cascade.controllers.delete(turn.controller);
  clearCascadeBargeInCandidate(cascade, { restore: true });
  stopCascadePlayback(cascade);
  cascade.activeTurn = null;
  cascade.busy = false;
  cascade.speaking = false;
  markCascadeTranscriptInterrupted(turn.transcriptItem);
  setStatus(cascadeStatus, '割り込みを認識中 · Shannonの発話を止めました。', 'success');
}

function stopCascadePlayback(cascade) {
  for (const source of cascade.sources) { try { source.stop(); } catch {} }
  cascade.sources.clear();
  cascade.nextPlaybackTime = cascade.context.currentTime;
  cascade.playbackStarted = false;
  cascade.remoteLevel = 0;
  updateCascadeTuningOutputs(cascade);
}

function playCascadePCM24k(encoded, cascade) {
  const bytes = base64Bytes(encoded);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  const buffer = cascade.context.createBuffer(1, count, 24_000);
  const channel = buffer.getChannelData(0);
  let energy = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = view.getInt16(index * 2, true) / 32768;
    channel[index] = sample;
    energy += sample * sample;
  }
  const rms = Math.sqrt(energy / Math.max(1, count));
  cascade.remoteLevel = cascade.remoteLevel * 0.72 + rms * 0.28;
  const source = cascade.context.createBufferSource();
  const sourceGain = cascade.context.createGain();
  source.buffer = buffer;
  source.connect(sourceGain).connect(cascade.playbackGain);
  cascade.sources.add(source);
  source.addEventListener('ended', () => {
    cascade.sources.delete(source);
    try { sourceGain.disconnect(); } catch {}
  });
  const now = cascade.context.currentTime;
  const currentLeadSeconds = Math.max(0, cascade.nextPlaybackTime - now);
  const underrun = cascade.playbackStarted && cascade.nextPlaybackTime < now + 0.008;
  if (underrun) cascade.playbackUnderruns += 1;
  cascade.playbackLeadSeconds = nextCascadePlaybackLead({
    currentLeadSeconds,
    targetSeconds: cascade.playbackLeadSeconds,
    underrun,
  });
  const crossfade = Math.min(0.004, buffer.duration / 4);
  const queuedStart = cascade.playbackStarted ? cascade.nextPlaybackTime - crossfade : cascade.nextPlaybackTime;
  const start = Math.max(now + cascade.playbackLeadSeconds, queuedStart);
  sourceGain.gain.setValueAtTime(0, start);
  sourceGain.gain.linearRampToValueAtTime(1, start + crossfade);
  sourceGain.gain.setValueAtTime(1, Math.max(start + crossfade, start + buffer.duration - crossfade));
  sourceGain.gain.linearRampToValueAtTime(0, start + buffer.duration);
  source.start(start);
  cascade.nextPlaybackTime = start + buffer.duration;
  cascade.playbackStarted = true;
  updateCascadeTuningOutputs(cascade);
}

function stopCascade(status, kind) {
  const cascade = state.cascade;
  state.cascade = null;
  if (cascade) {
    clearTimeout(cascade.finalizeTimer);
    clearCascadeBargeInCandidate(cascade);
    for (const controller of cascade.controllers) controller.abort();
    stopCascadePlayback(cascade);
    if (cascade.socket.readyState === WebSocket.OPEN) {
      try { cascade.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch {}
    }
    try { cascade.socket.close(); } catch {}
    for (const track of cascade.stream.getTracks()) track.stop();
    cascade.capture.disconnect();
    cascade.source.disconnect();
    cascade.playbackGain.disconnect();
    cascade.context.close().catch(() => {});
  }
  cascadeToggle.disabled = false;
  cascadeToggle.innerHTML = '<span aria-hidden="true">●</span> カスケード会話を始める';
  cascadeToggle.classList.remove('secondary');
  setCascadeControlsDisabled(false);
  cascadeOrb.classList.remove('active');
  showCascadeInterim('');
  if (status) setStatus(cascadeStatus, status, kind);
}

function setCascadeControlsDisabled(disabled) {
  cascadeVoice.disabled = disabled;
  cascadeProfileSelect.disabled = disabled;
  for (const input of document.querySelectorAll('input[name="cascade-text-model"], input[name="cascade-tts-model"]')) {
    input.disabled = disabled;
  }
}

function updateCascadeBargeInMode() {
  const cascade = state.cascade;
  if (!cascade) return;
  clearCascadeBargeInCandidate(cascade, { restore: true });
  updateCascadeTuningOutputs(cascade);
  if (!cascade.activeTurn) {
    setStatus(cascadeStatus, '聞いています · 話し終わると返答を作ります。', 'success');
    return;
  }
  setStatus(cascadeStatus, cascadeBargeIn.checked
    ? '割り込みON · Shannonの発話中も聞き続けます。'
    : '交互会話モード · Shannonの発話中はマイク送信を止めます。', 'success');
}

function updateCascadeProfileSummary() {
  const profile = liveProfile(cascadeProfileSelect.value);
  cascadeProfileSummary.innerHTML = `<strong>${escapeHTML(profile.shortLabel)}</strong><span>${escapeHTML(profile.summary)}</span>`;
}

function appendCascadeTranscript(kind, speaker, text) {
  cascadeTranscriptEmpty.classList.add('hidden');
  const item = document.createElement('li');
  item.className = kind;
  const title = document.createElement('strong');
  title.textContent = speaker;
  const content = document.createElement('span');
  content.className = 'turn-text';
  content.textContent = text;
  item.append(title, content);
  cascadeTranscriptList.append(item);
  cascadeTranscriptList.scrollTop = cascadeTranscriptList.scrollHeight;
  return item;
}

function updateCascadeTranscript(item, text) {
  const content = item?.querySelector('.turn-text');
  if (content) content.textContent = text;
  cascadeTranscriptList.scrollTop = cascadeTranscriptList.scrollHeight;
}

function updateCascadeTuningOutputs(cascade) {
  if (!cascade) return;
  cascadeEndpointTuning.textContent = cascade.lastFinalizeDelay === null
    ? '自動 80–420ms'
    : `${cascade.lastFinalizeDelay}ms`;
  cascadeBargeTuningOutput.textContent = cascadeBargeIn.checked
    ? `${cascade.audioTuning.mode} ${cascade.audioTuning.confirmAfterMs}ms`
    : '交互会話';
  cascadePlaybackTuning.textContent = `${Math.round(cascade.playbackLeadSeconds * 1_000)}ms · 補正${cascade.playbackUnderruns}`;
}

function markCascadeTranscriptInterrupted(item) {
  if (!item || item.classList.contains('interrupted')) return;
  item.classList.add('interrupted');
  const stateLabel = document.createElement('span');
  stateLabel.className = 'turn-state';
  stateLabel.textContent = '割り込みで中断';
  item.append(stateLabel);
}

function appendCascadeSessionMarker(text) {
  cascadeTranscriptEmpty.classList.add('hidden');
  const item = document.createElement('li');
  item.className = 'session';
  item.textContent = text;
  cascadeTranscriptList.append(item);
}

function showCascadeInterim(text) {
  cascadeInterim.textContent = text ? `認識中: ${text}` : '';
  cascadeInterim.classList.toggle('hidden', !text);
}

function selectedCascadeModel(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value ?? '';
}

function mergeStreamingText(current, incoming) {
  const next = String(incoming).trim();
  if (!current || next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  return `${current}${next}`;
}

async function* browserServerSentEvents(stream, label = 'Geminiのストリーム') {
  if (!stream) throw new Error(`${label}を開始できませんでした`);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/gu, '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const payload = block.split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!payload || payload === '[DONE]') continue;
      yield JSON.parse(payload);
    }
    if (done) break;
  }
  if (pending.trim() && !pending.includes('[DONE]')) throw new Error(`${label}が途中で終了しました`);
}

function voiceDisplayName(id) {
  return liveVoice.querySelector(`option[value="${CSS.escape(id)}"]`)?.textContent ?? id;
}

async function requestMicrophone() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('このブラウザではマイクを安全に利用できません。127.0.0.1のラボをChromeまたはSafariで開いてください。');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
}

function liveStartMessage(error) {
  const detail = message(error);
  if (error?.name === 'NotAllowedError' || /permission denied|permission dismissed|notallowed/i.test(detail)) {
    return 'マイクがOSまたはブラウザで拒否されています。macOSの「システム設定 → プライバシーとセキュリティ → マイク」で使用中のブラウザを許可し、ブラウザを完全に終了して開き直してください。サイト側で拒否した場合は、アドレスバー左の設定からマイクを「許可」に変更します。';
  }
  return detail;
}

function appendTranscript(kind, speaker, text) {
  transcriptEmpty.classList.add('hidden');
  const last = transcriptList.lastElementChild;
  if (last?.classList.contains(kind)) {
    last.lastChild.textContent += text;
  } else {
    const item = document.createElement('li');
    item.className = kind;
    const title = document.createElement('strong');
    title.textContent = speaker;
    item.append(title, document.createTextNode(text));
    transcriptList.append(item);
  }
  transcriptList.scrollTop = transcriptList.scrollHeight;
}

function appendSessionMarker(text) {
  transcriptEmpty.classList.add('hidden');
  const item = document.createElement('li');
  item.className = 'session';
  item.textContent = text;
  transcriptList.append(item);
  transcriptList.scrollTop = transcriptList.scrollHeight;
}

async function getJSON(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

function post(url, body, options = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shannon-request-token': state.config.requestToken },
    body: JSON.stringify(body),
    signal: options.signal,
  });
}

async function responseError(response) {
  try { return new Error((await response.json()).error ?? `HTTP ${response.status}`); }
  catch { return new Error(`HTTP ${response.status}`); }
}

function option(value, label) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = label;
  return item;
}

function voiceLabel(id, label, type) {
  if (id.startsWith('voice_') || type === 'prompted' || type === 'replicated') return `${label} · 作成した声`;
  return label === id ? id : `${label} · ${id}`;
}

function updateTextCount() { textCount.value = String(sampleText.value.length); }
function setStatus(element, text, kind) { element.textContent = text; element.className = `status${kind ? ` ${kind}` : ''}`; }
function message(error) { return error instanceof Error ? error.message : '不明なエラー'; }
function shortModelName(model) { return String(model).includes('lite') ? 'Flash-Lite' : 'Flash'; }
function formatDuration(milliseconds) { return milliseconds >= 1_000 ? `${(milliseconds / 1_000).toFixed(1)}秒` : `${milliseconds}ms`; }
function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function ttsCost(model, durationMilliseconds) { return Math.ceil(durationMilliseconds / 10_000) * (model.includes('lite') ? .0015 : .00225); }
function usd(value) { return `$${value.toFixed(value < .01 ? 4 : 3)}`; }
function effectDescription(effects = {}) {
  const value = normalizeVoiceEffects(effects);
  if (!value.pitchCents && !value.robotAmount) return '原音';
  return `高さ+${Math.round(value.pitchCents)} · ロボ${Math.round(value.robotAmount * 100)}%`;
}
function effectFilename(effects = {}) {
  const value = normalizeVoiceEffects(effects);
  return `pitch-${Math.round(value.pitchCents)}-robot-${Math.round(value.robotAmount * 100)}`;
}
function styleLabel(style) { return style.length > 26 ? `${style.slice(0, 26)}…` : style; }
function safeFilename(value) { return String(value).replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 70); }
function escapeHTML(value) { const span = document.createElement('span'); span.textContent = value; return span.innerHTML; }

function base64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function base64Blob(value, type) { return new Blob([base64Bytes(value)], { type }); }
function arrayBufferBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let result = '';
  const size = 0x8000;
  for (let index = 0; index < bytes.length; index += size) result += String.fromCharCode(...bytes.subarray(index, index + size));
  return btoa(result);
}
