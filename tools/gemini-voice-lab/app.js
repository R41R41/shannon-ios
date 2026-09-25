import { voiceDesignPresets } from './voice-design-presets.js';

const scripts = Object.freeze({
  identity: 'こんにちは、シャノンです。今日も一緒に、ゆっくり考えていこうね。',
  pronunciation: 'AetherとVoyager、それからSyzygyの進み具合を確認したよ。APIとSwiftUIの接続も大丈夫。',
  emotion: 'えへへ、うれしい。<short pause> でも、無理しすぎないでね。',
  long: 'おかえりなさい。今日はどんな一日だった？ うまく言葉にできなくても大丈夫。少しずつ、一緒に整理していこう。',
});

const knownVoices = ['Leda', 'Aoede', 'Zephyr', 'Achernar', 'Laomedeia', 'Achird', 'Vindemiatrix', 'Sadachbia'];
const state = {
  config: null,
  samples: [],
  designedVoice: null,
  live: null,
};

const sampleForm = document.querySelector('#sample-form');
const voiceSelect = document.querySelector('#voice');
const scriptPreset = document.querySelector('#script-preset');
const sampleText = document.querySelector('#sample-text');
const textCount = document.querySelector('#text-count');
const stylePreset = document.querySelector('#style-preset');
const customStyleField = document.querySelector('#custom-style-field');
const customStyle = document.querySelector('#custom-style');
const sampleStatus = document.querySelector('#sample-status');
const sampleList = document.querySelector('#sample-list');
const sampleEmpty = document.querySelector('#sample-empty');
const generateButton = document.querySelector('#generate-button');
const designForm = document.querySelector('#design-form');
const designPreset = document.querySelector('#design-preset');
const designName = document.querySelector('#design-name');
const designPrompt = document.querySelector('#design-prompt');
const designButton = document.querySelector('#design-button');
const confirmStore = document.querySelector('#confirm-store');
const designStatus = document.querySelector('#design-status');
const designResult = document.querySelector('#design-result');
const liveToggle = document.querySelector('#live-toggle');
const liveVoice = document.querySelector('#live-voice');
const liveStatus = document.querySelector('#live-status');
const liveOrb = document.querySelector('#live-orb');
const transcriptEmpty = document.querySelector('#transcript-empty');
const transcriptList = document.querySelector('#transcript-list');

sampleText.value = scripts.identity;
applyDesignPreset(designPreset.value);
updateTextCount();
initialize();

scriptPreset.addEventListener('change', () => {
  if (scriptPreset.value !== 'custom') sampleText.value = scripts[scriptPreset.value];
  sampleText.focus();
  updateTextCount();
});
sampleText.addEventListener('input', () => {
  if (!Object.values(scripts).includes(sampleText.value)) scriptPreset.value = 'custom';
  updateTextCount();
});
voiceSelect.addEventListener('change', () => {
  if (liveVoice.querySelector(`option[value="${CSS.escape(voiceSelect.value)}"]`)) {
    liveVoice.value = voiceSelect.value;
  }
});
stylePreset.addEventListener('change', () => {
  customStyleField.classList.toggle('hidden', stylePreset.value !== 'custom');
  if (stylePreset.value === 'custom') customStyle.focus();
});
designPreset.addEventListener('change', () => {
  if (designPreset.value !== 'custom') applyDesignPreset(designPreset.value, true);
});
designPrompt.addEventListener('input', () => {
  const current = voiceDesignPresets.find(preset => preset.id === designPreset.value);
  if (!current || designPrompt.value !== current.prompt) designPreset.value = 'custom';
});
confirmStore.addEventListener('change', () => { designButton.disabled = !confirmStore.checked; });
document.querySelector('#clear-samples').addEventListener('click', clearSamples);
sampleForm.addEventListener('submit', generateSample);
designForm.addEventListener('submit', designVoice);
liveToggle.addEventListener('click', () => state.live ? stopLive('停止しました。') : startLive());
window.addEventListener('beforeunload', () => {
  stopLive();
  for (const sample of state.samples) URL.revokeObjectURL(sample.url);
  if (state.designedVoice?.url) URL.revokeObjectURL(state.designedVoice.url);
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
    const selected = voiceSelect.value;
    const liveSelected = liveVoice.value;
    voiceSelect.replaceChildren(...[...voices.values()].map(({ id, label, type }) => option(id, voiceLabel(id, label, type))));
    liveVoice.replaceChildren(...[...voices.values()].map(({ id, label, type }) => option(id, voiceLabel(id, label, type))));
    if (voices.has(selected)) voiceSelect.value = selected;
    else voiceSelect.value = 'Leda';
    if (voices.has(liveSelected)) liveVoice.value = liveSelected;
    else liveVoice.value = voices.has(voiceSelect.value) ? voiceSelect.value : 'Aoede';
  } catch (error) {
    setStatus(sampleStatus, `声一覧は既定候補を使います: ${message(error)}`);
  }
}

async function generateSample(event) {
  event.preventDefault();
  if (!state.config) return;
  generateButton.disabled = true;
  setStatus(sampleStatus, '音声を生成しています…');
  const model = new FormData(sampleForm).get('model');
  const voice = voiceSelect.value;
  const style = stylePreset.value === 'custom' ? customStyle.value : stylePreset.value;
  try {
    const response = await post('/api/sample', { model, voice, text: sampleText.value, style });
    if (!response.ok) throw await responseError(response);
    const blob = await response.blob();
    const durationMilliseconds = Number(response.headers.get('x-shannon-duration-ms')) || 0;
    const elapsedMilliseconds = Number(response.headers.get('x-shannon-elapsed-ms')) || 0;
    const sample = {
      id: crypto.randomUUID(), model, voice, style, text: sampleText.value, blob,
      url: URL.createObjectURL(blob), durationMilliseconds, elapsedMilliseconds,
    };
    state.samples.unshift(sample);
    while (state.samples.length > 8) removeSample(state.samples.at(-1).id);
    renderSamples();
    const estimate = ttsCost(model, durationMilliseconds);
    setStatus(sampleStatus, `${formatDuration(durationMilliseconds)}の音声を${formatDuration(elapsedMilliseconds)}で生成 · 約${usd(estimate)}`, 'success');
  } catch (error) {
    setStatus(sampleStatus, `生成できませんでした: ${message(error)}`, 'error');
  } finally {
    generateButton.disabled = false;
  }
}

function renderSamples() {
  sampleEmpty.classList.toggle('hidden', state.samples.length > 0);
  sampleList.replaceChildren(...state.samples.map((sample, index) => {
    const item = document.createElement('li');
    item.className = 'sample-card';
    const shortModel = sample.model.includes('lite') ? 'Flash-Lite' : 'Flash';
    item.innerHTML = `<header><div><h4>${escapeHTML(sample.voice)}</h4><div class="meta">${shortModel}${sample.style ? ` · ${escapeHTML(styleLabel(sample.style))}` : ' · 指定なし'}</div></div><small>#${state.samples.length - index}</small></header>`;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = sample.url;
    const footer = document.createElement('footer');
    const metrics = document.createElement('span');
    metrics.textContent = `${formatDuration(sample.durationMilliseconds)} · 約${usd(ttsCost(sample.model, sample.durationMilliseconds))}`;
    const actions = document.createElement('span');
    const download = document.createElement('a');
    download.href = sample.url;
    download.download = `shannon-${safeFilename(sample.voice)}-${shortModel.toLowerCase()}.wav`;
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
  URL.revokeObjectURL(state.samples[index].url);
  state.samples.splice(index, 1);
  renderSamples();
}

function clearSamples() {
  for (const sample of state.samples) URL.revokeObjectURL(sample.url);
  state.samples = [];
  renderSamples();
  setStatus(sampleStatus, '比較トレイを空にしました。');
}

async function designVoice(event) {
  event.preventDefault();
  if (!confirmStore.checked) return;
  designButton.disabled = true;
  setStatus(designStatus, '声を設計しています。通常の試聴より時間がかかります…');
  try {
    const response = await post('/api/design', {
      name: designName.value,
      prompt: designPrompt.value,
      language: 'ja-JP',
      gender: 'female',
      confirmStore: true,
    });
    if (!response.ok) throw await responseError(response);
    const result = await response.json();
    if (state.designedVoice?.url) URL.revokeObjectURL(state.designedVoice.url);
    const blob = base64Blob(result.audioBase64, result.mimeType);
    state.designedVoice = { ...result, url: URL.createObjectURL(blob) };
    addDesignedVoiceOption(result.id, result.name);
    renderDesignResult();
    setStatus(designStatus, '新しい声を作りました。比較欄でも選べます。', 'success');
  } catch (error) {
    setStatus(designStatus, `声を作れませんでした: ${message(error)}`, 'error');
  } finally {
    designButton.disabled = !confirmStore.checked;
  }
}

function applyDesignPreset(id, focus = false) {
  const preset = voiceDesignPresets.find(item => item.id === id);
  if (!preset) return;
  designName.value = preset.name;
  designPrompt.value = preset.prompt;
  if (focus) designPrompt.focus();
}

function renderDesignResult() {
  const result = state.designedVoice;
  designResult.className = 'design-result';
  designResult.replaceChildren();
  const title = document.createElement('h3');
  title.textContent = result.name;
  const note = document.createElement('p');
  note.textContent = 'このIDを選ぶと同じ声をFlash / Flash-Liteで比較できます。';
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
  button.textContent = 'この保存済み音声を削除';
  button.disabled = true;
  input.addEventListener('input', () => { button.disabled = input.value !== result.id; });
  button.addEventListener('click', () => deleteDesignedVoice(input, button));
  label.append(input);
  deletion.append(label, button);
  designResult.append(title, note, code, audio, deletion);
}

async function deleteDesignedVoice(input, button) {
  const id = state.designedVoice?.id;
  if (!id || input.value !== id) return;
  button.disabled = true;
  setStatus(designStatus, '保存済み音声を削除しています…');
  try {
    const response = await post('/api/delete', { id, confirm: id });
    if (!response.ok) throw await responseError(response);
    voiceSelect.querySelector(`option[value="${CSS.escape(id)}"]`)?.remove();
    liveVoice.querySelector(`option[value="${CSS.escape(id)}"]`)?.remove();
    if (liveVoice.value === id) liveVoice.value = 'Aoede';
    URL.revokeObjectURL(state.designedVoice.url);
    state.designedVoice = null;
    designResult.className = 'design-result empty-state';
    designResult.innerHTML = '<span aria-hidden="true">✦</span><p>作った声のプレビューとVoice IDを表示します。</p>';
    setStatus(designStatus, '保存済み音声を削除しました。', 'success');
  } catch (error) {
    button.disabled = false;
    setStatus(designStatus, `削除できませんでした: ${message(error)}`, 'error');
  }
}

function addDesignedVoiceOption(id, name) {
  for (const select of [voiceSelect, liveVoice]) {
    select.querySelector(`option[value="${CSS.escape(id)}"]`)?.remove();
    select.prepend(option(id, `${name} · 作成した声`));
  }
  voiceSelect.value = id;
  liveVoice.value = id;
}

async function startLive() {
  if (!state.config) return;
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
    state.live = { socket, session, stream, context, source, capture, mute, ready: false, nextPlaybackTime: 0, sources: new Set() };
    pendingStream = null;
    pendingContext = null;
    capture.port.onmessage = ({ data }) => sendMicrophoneChunk(data);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(liveSetup(session.model, session.voice)));
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
    const text = data instanceof Blob ? await data.text() : String(data);
    const event = JSON.parse(text);
    if (event.setupComplete) {
      state.live.ready = true;
      liveToggle.disabled = false;
      liveToggle.innerHTML = '<span aria-hidden="true">■</span> 会話を止める';
      liveToggle.classList.add('secondary');
      liveVoice.disabled = true;
      liveOrb.classList.add('active');
      setStatus(liveStatus, '会話中 · どう聞こえるか短く話しかけてください。', 'success');
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
  liveOrb.classList.remove('active');
  if (status) setStatus(liveStatus, status, kind);
}

function stopPlaybackFor(live) {
  for (const source of live.sources) { try { source.stop(); } catch {} }
  live.sources.clear();
}

function liveSetup(model, voice) {
  const voiceConfig = voice.startsWith('voice_')
    ? { voice }
    : { prebuiltVoiceConfig: { voiceName: voice } };
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig } },
      systemInstruction: { parts: [{ text: 'あなたはShannonの声を試聴する短時間の会話相手です。日本語で、自然で短い返答をしてください。声質を評価しやすいよう、過剰な演技や長い説明は避けてください。' }] },
      inputAudioTranscription: {}, outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { disabled: false, startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', prefixPaddingMs: 80, silenceDurationMs: 600 }, activityHandling: 'START_OF_ACTIVITY_INTERRUPTS' },
      contextWindowCompression: { slidingWindow: {} },
    },
  };
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

async function getJSON(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shannon-request-token': state.config.requestToken },
    body: JSON.stringify(body),
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
function formatDuration(milliseconds) { return milliseconds >= 1_000 ? `${(milliseconds / 1_000).toFixed(1)}秒` : `${milliseconds}ms`; }
function ttsCost(model, durationMilliseconds) { return Math.ceil(durationMilliseconds / 10_000) * (model.includes('lite') ? .0015 : .00225); }
function usd(value) { return `$${value.toFixed(value < .01 ? 4 : 3)}`; }
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
