import { summarize, pcmWav, readFrames } from './metrics.js';

const $ = id => document.getElementById(id);
const presets = {
  short: 'うん、聞いてるよ。',
  daily: 'ライ氏、おかえり。今日もお疲れさま。ボクに話したいこと、ある？',
  warm: '今日はうまくいかなかったんだね。大丈夫、急いで元気にならなくてもいいよ。ボクはここにいるから。',
  names: 'シャノン、エーテル、ボイジャー。APIとSwiftUIを確認して、TestFlightで試してみよう。',
  long: 'ライ氏、そのアイデア、面白いね。まずは小さく動くものを作って、実際に使いながら確かめよう。必要なら、ボクも一緒に考えるよ。速さだけじゃなく、毎日心地よく使えることも大切にしたいな。',
};
const errors = {
  ELEVEN_NOT_CONFIGURED: 'ElevenLabsを接続してから、もう一度試してください。',
  GEMINI_NOT_CONFIGURED: 'Geminiの接続設定がありません。Azure版でデモを起動してください。',
  INVALID_KEY: 'APIキーの入力を確認してください。',
  ELEVEN_HTTP_401: 'ElevenLabsのAPIキーを確認してください。',
  ELEVEN_HTTP_403: 'このキーには声の一覧を読む権限がありません。',
  ELEVEN_HTTP_429: 'ElevenLabsが混み合っているか、利用上限に達しています。少し待って再試行してください。',
  ELEVEN_GENERATION_FAILED: 'ElevenLabsが音声生成を拒否しました。v4の利用可否、TTS権限、残りクレジット、声のIDを確認してください。',
  ELEVEN_CONNECTION_FAILED: 'ElevenLabsへ接続できませんでした。接続設定を確認して再試行してください。',
  ELEVEN_STREAM_INCOMPLETE: 'ElevenLabsの接続が途中で閉じました。この測定は成功結果に含めません。',
  GEMINI_STREAM_INCOMPLETE: 'Geminiの音声生成が完了しませんでした。この測定は成功結果に含めません。',
  GEMINI_GENERATION_FAILED: 'Geminiが音声を生成できませんでした。文章や声を変えて再試行してください。',
  GEMINI_HTTP_429: 'Geminiの利用上限に達しています。少し待って再試行してください。',
  BUSY: '前の音声生成が終了するまで、少し待ってください。',
  RELOAD_PAGE: '接続の有効期限が切れました。ページを再読み込みしてください。',
  EMPTY_AUDIO: '音声を受信できませんでした。再試行してください。',
  STREAM_INCOMPLETE: '音声が途中で途切れました。この測定は成功結果に含めません。',
  TIMEOUT: '時間内に音声を受信できませんでした。再試行してください。',
};
const message = code => errors[code] ?? '接続または音声生成に失敗しました。設定を確認して再試行してください。';
const ms = value => Number.isFinite(value) ? `${Math.round(value).toLocaleString()} ms` : '—';
let config;
let busy = false;
let samples = [];
let snapshot;
let audioContext;
let controller;
let generation = 0;
let currentPlayer;

async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, { method, signal, headers: {
    'x-shannon-request-token': config?.requestToken ?? '', ...(body ? { 'content-type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error ?? 'REQUEST_FAILED');
  }
  return response;
}

function notice(text, error = false) { $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); }

function setBusy(value) {
  busy = value;
  for (const element of document.querySelectorAll('.providers input,.providers select,.script-panel input,.script-panel select,.script-panel textarea,.presets button,#connect')) element.disabled = value;
  $('stop').hidden = !value;
  for (const audio of document.querySelectorAll('.sample audio')) { audio.controls = !value; if (value) audio.pause(); }
  updateActions();
}

function updateActions() {
  const validText = Boolean($('script').value.trim());
  const gemini = Boolean(config?.geminiReady && $('gemini-voice').value.trim());
  const eleven = Boolean(config?.elevenReady && $('eleven-voice').value.trim());
  $('gemini-try').disabled = busy || !gemini || !validText;
  $('eleven-try').disabled = busy || !eleven || !validText;
  $('compare').disabled = busy || !gemini || !eleven || !validText;
  $('export').disabled = busy || !samples.length;
  $('character-count').textContent = `${$('script').value.length}文字`;
  const repeats = Number($('repetitions').value);
  $('call-count').textContent = `合計${repeats * 2}回の音声生成。プロバイダーの利用料が発生します。`;
  $('compare').textContent = repeats === 1 ? 'A → Bで聴き比べる' : `${repeats}回ずつ、速度を測定`;
  if (!busy) $('run-status').textContent = config?.geminiReady && config?.elevenReady ? '同じ文章で比較できます' : 'ElevenLabsを接続すると比較できます';
}

function setProviderReady(provider, ready) {
  const label = $(`${provider}-state`);
  label.textContent = ready ? '接続済み' : '未接続';
  label.classList.toggle('ready', ready);
}

function fillVoices(provider, voices) {
  const list = $(`${provider}-voices`);
  list.replaceChildren();
  for (const voice of voices) {
    if (!voice.id) continue;
    const option = document.createElement('option'); option.value = voice.id; option.label = voice.name;
    list.append(option);
  }
  if (provider === 'eleven' && !$('eleven-voice').value && voices[0]?.id) $('eleven-voice').value = voices[0].id;
  updateActions();
}

async function loadVoices(provider) {
  try { fillVoices(provider, (await (await api(`/api/voices?provider=${provider}`)).json()).voices); }
  catch { notice('声の一覧を取得できませんでした。Voice IDを直接入力して試せます。'); }
}

class StreamingPlayer {
  constructor(context, signal, started, sample) {
    this.context = context; this.started = started; this.sample = sample;
    this.pending = new Uint8Array(); this.nextAt = 0; this.sources = new Set(); this.waiters = [];
    this.abort = () => this.stop(); this.signal = signal;
    signal.addEventListener('abort', this.abort, { once: true });
  }
  feed(chunk) {
    const merged = new Uint8Array(this.pending.length + chunk.length);
    merged.set(this.pending); merged.set(chunk, this.pending.length); this.pending = merged;
    if (this.pending.length >= 4800) this.flush();
  }
  flush() {
    this.signal.throwIfAborted();
    if (!this.pending.length) return;
    const pcm = this.pending; this.pending = new Uint8Array();
    const buffer = this.context.createBuffer(1, pcm.length / 2, 24000);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    const at = Math.max(this.context.currentTime + .015, this.nextAt);
    if (this.sample.playbackMs === null) {
      this.sample.playbackMs = performance.now() - this.started + (at - this.context.currentTime + (this.context.baseLatency ?? 0) + (this.context.outputLatency ?? 0)) * 1000;
    } else if (this.nextAt < this.context.currentTime) this.sample.underruns++;
    this.nextAt = at + buffer.duration;
    this.sources.add(source);
    source.onended = () => { source.disconnect(); this.sources.delete(source); if (!this.sources.size) this.waiters.splice(0).forEach(resolve => resolve()); };
    source.start(at);
  }
  async finish() {
    this.flush();
    if (this.sources.size) await new Promise(resolve => this.waiters.push(resolve));
    this.signal.throwIfAborted();
    this.signal.removeEventListener('abort', this.abort);
  }
  stop() {
    this.signal.removeEventListener('abort', this.abort);
    for (const source of this.sources) { try { source.stop(); source.disconnect(); } catch {} }
    this.sources.clear(); this.waiters.splice(0).forEach(resolve => resolve());
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
  if (className) node.className = className; return node;
}

function addSample(sample) {
  const empty = $('samples').querySelector('.empty'); empty?.remove();
  const article = element('article', undefined, 'sample');
  const header = element('div', undefined, 'sample-head');
  header.append(element('h3', `${sample.provider === 'gemini' ? 'A · Gemini' : 'B · ElevenLabs'} · ${sample.repetition}回目`), element('span', sample.model));
  const state = element('span', '生成中', 'sample-state'); header.append(state);
  const metrics = element('dl', undefined, 'sample-metrics');
  const values = [];
  for (const title of ['上流の最初の音声', '端末への最初の音声', '再生開始の推定']) {
    const box = element('div'); const dd = element('dd', '—'); box.append(element('dt', title), dd); metrics.append(box); values.push(dd);
  }
  const detail = element('p', '音声を待っています…', 'detail');
  article.append(header, metrics, detail); $('samples').append(article);
  sample.ui = { article, state, values, detail };
}

function refreshSample(sample) {
  sample.ui.values[0].textContent = ms(sample.metrics?.firstByteMs);
  sample.ui.values[1].textContent = ms(sample.clientFirstMs);
  sample.ui.values[2].textContent = ms(sample.playbackMs);
}

function renderSummary() {
  $('result-summary').replaceChildren();
  for (const provider of ['gemini', 'eleven']) {
    const group = samples.filter(s => s.provider === provider);
    if (!group.length) continue;
    const result = summarize(group);
    const card = element('div', undefined, 'summary-card');
    const heading = element('h3', `${provider === 'gemini' ? 'A · Gemini' : 'B · ElevenLabs'} / 最初の音声まで`);
    const number = element('strong', ms(result.median)); number.append(element('small', '中央値'));
    card.append(heading, number, element('p', `p95 ${ms(result.p95)} · 成功 ${result.count}回 / 失敗 ${result.failed}回`));
    if (result.count < 10) card.append(element('p', '少数サンプルの参考値です。'));
    $('result-summary').append(card);
  }
}

async function runSample(input, repetition, listen, signal, runID) {
  const sample = { ...input, repetition, state: 'running', metrics: null, clientFirstMs: null, playbackMs: null, underruns: 0 };
  samples.push(sample); addSample(sample);
  $('run-status').textContent = `${input.provider === 'gemini' ? 'Gemini' : 'ElevenLabs'} · ${repetition}回目を生成中`;
  const chunks = [];
  let totalBytes = 0;
  const started = performance.now();
  const player = listen ? new StreamingPlayer(audioContext, signal, started, sample) : null;
  currentPlayer = player;
  try {
    const response = await api('/api/stream', { method: 'POST', body: input, signal });
    let completed = false;
    await readFrames(response.body, frame => {
      signal.throwIfAborted();
      if (runID !== generation) throw new DOMException('Cancelled', 'AbortError');
      if (frame.type === 'error') throw new Error(frame.code);
      if (frame.type === 'meta' && (frame.sampleRate !== 24000 || frame.bitsPerSample !== 16 || frame.channels !== 1)) throw new Error('INVALID_AUDIO');
      if (frame.type === 'first_audio') { sample.metrics = frame; refreshSample(sample); }
      if (frame.type === 'audio') {
        sample.clientFirstMs ??= performance.now() - started;
        const decoded = Uint8Array.from(atob(frame.audio), char => char.charCodeAt(0));
        totalBytes += decoded.length;
        if (!decoded.length || decoded.length % 2 || totalBytes > 8388608) throw new Error('INVALID_AUDIO');
        chunks.push(decoded); player?.feed(decoded); refreshSample(sample);
        sample.ui.state.textContent = listen ? 'ストリーミング試聴中' : '計測中';
      }
      if (frame.type === 'complete') { sample.metrics = frame; completed = true; }
    });
    if (!completed || !totalBytes) throw new Error('STREAM_INCOMPLETE');
    await player?.finish(); signal.throwIfAborted();
    sample.state = 'complete'; sample.ui.state.textContent = '完了';
    const wav = pcmWav(chunks); sample.url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    const audio = element('audio'); audio.controls = !busy; audio.src = sample.url; audio.preload = 'metadata';
    audio.setAttribute('aria-label', `${input.provider === 'gemini' ? 'Gemini' : 'ElevenLabs'} ${repetition}回目の再試聴`);
    audio.addEventListener('play', () => document.querySelectorAll('.sample audio').forEach(other => { if (other !== audio) other.pause(); }));
    sample.ui.article.append(audio);
    const actions = element('div', undefined, 'sample-actions');
    const save = element('button', '音声を保存', 'subtle'); save.addEventListener('click', () => download(sample.url, `${input.provider}-${repetition}.wav`)); actions.append(save); sample.ui.article.append(actions);
    const connection = Number.isFinite(sample.metrics.connectionMs) ? ` · 接続 ${ms(sample.metrics.connectionMs)} / テキスト送信後 ${ms(sample.metrics.synthesisFirstByteMs)}` : '';
    sample.ui.detail.textContent = `音声 ${(sample.metrics.durationMs / 1000).toFixed(2)}秒 · 全生成 ${ms(sample.metrics.elapsedMs)}${connection}${listen ? ` · 再生の継ぎ目 ${sample.underruns}回` : ' · 今回は再生せず計測'}。声: ${input.voice}`;
  } catch (error) {
    player?.stop();
    sample.state = signal.aborted ? 'cancelled' : 'failed';
    sample.error = signal.aborted ? 'CANCELLED' : error.message;
    sample.ui.state.textContent = signal.aborted ? '停止' : '失敗';
    sample.ui.article.classList.toggle('failed', !signal.aborted);
    sample.ui.detail.textContent = signal.aborted ? '生成と再生を停止しました。未完成の音声は比較に含めません。' : message(error.message);
    sample.ui.detail.classList.add('error');
  } finally { if (currentPlayer === player) currentPlayer = null; refreshSample(sample); renderSummary(); }
}

async function run(providers) {
  if (busy) return;
  notice(''); setBusy(true);
  controller = new AbortController();
  const signal = controller.signal;
  const runID = ++generation;
  try {
    const repeats = providers.length === 1 ? 1 : Number($('repetitions').value);
    const listen = repeats === 1;
    if (listen) { audioContext ??= new AudioContext({ sampleRate: 24000 }); await audioContext.resume(); }
    for (const sample of samples) if (sample.url) URL.revokeObjectURL(sample.url);
    samples = []; $('samples').replaceChildren(); $('result-summary').replaceChildren();
    snapshot = { text: $('script').value.trim(), createdAt: new Date().toISOString(), location: config.location,
      bufferMs: 100, sampleRate: 24000, repeats, rawVoice: true,
      inputs: Object.fromEntries(providers.map(provider => [provider, {
        provider, model: $(`${provider}-model`).value, voice: $(`${provider}-voice`).value.trim(),
        text: $('script').value.trim(), style: $('gemini-style').value, tag: $('eleven-tag').value,
      }])) };
    $('comparison-description').textContent = `${config.location}から生成 · 同じ文章 ${snapshot.text.length}文字 · ${repeats === 1 ? '順番にストリーミング試聴' : '再生せず測定。試聴は結果のプレイヤーから'}。`;
    for (let repetition = 1; repetition <= repeats; repetition++) {
      const order = repetition % 2 === 0 ? [...providers].reverse() : providers;
      for (const provider of order) {
        signal.throwIfAborted();
        await runSample(snapshot.inputs[provider], repetition, listen, signal, runID);
      }
    }
    if (providers.length === 2 && !samples.some(s => s.state === 'complete' && s.provider === 'eleven')) notice('ElevenLabsの音声を取得できなかったため、速度差はまだ比較できません。成功したGeminiの音声は再試聴できます。', true);
  } catch (error) { if (!signal.aborted) notice(error.message === 'NotAllowedError' ? '音声の再生を許可して、もう一度試してください。' : message(error.message), true); }
  finally { if (runID === generation) { setBusy(false); $('run-status').textContent = signal.aborted ? '停止しました' : '測定を終了しました'; } }
}

function download(url, filename) { const link = element('a'); link.href = url; link.download = filename; link.click(); }

$('stop').addEventListener('click', () => { controller?.abort(); currentPlayer?.stop(); document.querySelectorAll('audio').forEach(a => a.pause()); });
$('compare').addEventListener('click', () => run(['gemini', 'eleven']));
for (const provider of ['gemini', 'eleven']) $(`${provider}-try`).addEventListener('click', () => run([provider]));
for (const field of ['script', 'repetitions', 'gemini-voice', 'eleven-voice']) $(field).addEventListener('input', updateActions);
$('script').addEventListener('input', () => document.querySelectorAll('[data-preset]').forEach(button => button.setAttribute('aria-pressed', 'false')));
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
  $('script').value = presets[button.dataset.preset];
  document.querySelectorAll('[data-preset]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
  updateActions();
}));
$('connect').addEventListener('click', () => { $('connection-error').textContent = ''; $('connection-dialog').showModal(); });
$('close-dialog').addEventListener('click', () => $('connection-dialog').close());
$('connection-dialog').addEventListener('close', () => { $('api-key').value = ''; });
$('connection-form').addEventListener('submit', async event => {
  event.preventDefault(); $('submit-key').disabled = true; $('connection-error').textContent = '接続を確認しています…';
  const apiKey = $('api-key').value; $('api-key').value = '';
  try {
    const result = await (await api('/api/eleven/connect', { method: 'POST', body: { apiKey } })).json();
    config.elevenReady = true; setProviderReady('eleven', true); fillVoices('eleven', result.voices);
    $('connect').textContent = '接続設定'; $('connection-dialog').close(); notice('ElevenLabsに接続しました。声を選んで比較できます。');
  } catch (error) { $('connection-error').textContent = message(error.message); }
  finally { $('submit-key').disabled = false; updateActions(); }
});
$('disconnect').addEventListener('click', async () => {
  try { await api('/api/eleven/disconnect', { method: 'POST', body: {} }); config.elevenReady = false; setProviderReady('eleven', false); $('connect').textContent = 'ElevenLabsに接続'; $('connection-dialog').close(); updateActions(); }
  catch (error) { $('connection-error').textContent = message(error.message); }
});
$('export').addEventListener('click', async () => {
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot.text)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const report = { schemaVersion: 1, createdAt: snapshot.createdAt, location: snapshot.location,
    textSha256: hash, characters: snapshot.text.length, bufferMs: 100, rawVoice: true,
    samples: samples.map(({ provider, model, voice, tag, style, repetition, state, error, metrics, clientFirstMs, playbackMs, underruns }) =>
      ({ provider, model, voice, tag, style, repetition, state, error, metrics, clientFirstMs, playbackEstimateMs: playbackMs, underruns })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  download(url, 'tts-comparison.json'); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => { controller?.abort(); currentPlayer?.stop(); for (const sample of samples) if (sample.url) URL.revokeObjectURL(sample.url); });

async function initialize() {
  try {
    config = await (await api('/api/config')).json();
    $('gemini-model').value = config.geminiModel; $('gemini-voice').value = config.geminiVoice; $('gemini-style').value = config.geminiStyle;
    setProviderReady('gemini', config.geminiReady); setProviderReady('eleven', config.elevenReady);
    $('route-description').textContent = `${config.location}の同じサーバー・24 kHz PCM・100 msの共通再生バッファで比較します。声は無加工です。`;
    if (!config.elevenReady) notice('Geminiは現在のシャノンの声で試聴できます。ElevenLabsを接続すると、A/B比較が使えます。');
    if (config.geminiReady) void loadVoices('gemini');
    if (config.elevenReady) { $('connect').textContent = '接続設定'; void loadVoices('eleven'); }
  } catch { setProviderReady('gemini', false); notice('デモに接続できません。「Open TTS Compare.command」で起動してから、このページを開いてください。', true); }
  updateActions();
}
void initialize();
