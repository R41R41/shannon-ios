if (new URLSearchParams(window.location.search).get("theme") === "light") {
  document.documentElement.dataset.theme = "light";
}

const elements = {
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  sourceAudio: document.querySelector("#sourceAudio"),
  sourceName: document.querySelector("#sourceName"),
  sourceMeta: document.querySelector("#sourceMeta"),
  pitch: document.querySelector("#pitch"),
  pitchNumber: document.querySelector("#pitchNumber"),
  formant: document.querySelector("#formant"),
  formantNumber: document.querySelector("#formantNumber"),
  autoPreview: document.querySelector("#autoPreview"),
  resetButton: document.querySelector("#resetButton"),
  offButton: document.querySelector("#offButton"),
  renderButton: document.querySelector("#renderButton"),
  status: document.querySelector("#status"),
  presetLabel: document.querySelector("#presetLabel"),
  processingMetric: document.querySelector("#processingMetric"),
  latencyMetric: document.querySelector("#latencyMetric"),
  processedAudio: document.querySelector("#processedAudio"),
  processedMeta: document.querySelector("#processedMeta"),
  playOriginal: document.querySelector("#playOriginal"),
  playProcessed: document.querySelector("#playProcessed"),
  historyList: document.querySelector("#historyList"),
  historyEmpty: document.querySelector("#historyEmpty"),
  clearHistory: document.querySelector("#clearHistory"),
  emotionPicker: document.querySelector("#emotionPicker"),
  emotionTabs: document.querySelector("#emotionTabs"),
  emotionDirection: document.querySelector("#emotionDirection"),
  emotionText: document.querySelector("#emotionText"),
  voicePicker: document.querySelector("#voicePicker"),
  voiceTabs: document.querySelector("#voiceTabs"),
  voiceCount: document.querySelector("#voiceCount"),
};

let sourceBlob = null;
let sourceURL = null;
let processedURL = null;
let renderSequence = 0;
let history = [];
let emotionManifest = null;
let currentEmotion = "joy";
let currentVoice = "marin";
let sourceSequence = 0;

function signed(value, digits = 0) {
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`;
}

function tuning() {
  return {
    pitch: Number(elements.pitch.value),
    formant: Number(elements.formant.value),
  };
}

function updateTuningLabel() {
  const { pitch, formant } = tuning();
  elements.pitchNumber.value = pitch.toFixed(0);
  elements.formantNumber.value = formant.toFixed(1);
  elements.presetLabel.textContent = `Pitch ${signed(pitch)} · Formant ${signed(formant, 1)}`;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function setTuning(pitch, formant) {
  elements.pitch.value = clamp(Number(pitch), -300, 400);
  elements.formant.value = clamp(Number(formant), -3, 3);
  updateTuningLabel();
}

function setBusy(isBusy, message) {
  elements.status.textContent = message;
  elements.status.classList.toggle("is-busy", isBusy);
  for (const control of [elements.renderButton, elements.resetButton, elements.offButton]) {
    control.disabled = isBusy;
  }
}

function stopAudio(except = null) {
  for (const audio of [elements.sourceAudio, elements.processedAudio]) {
    if (audio !== except) audio.pause();
  }
}

async function play(audio) {
  if (!audio.src) return;
  stopAudio(audio);
  audio.currentTime = 0;
  try {
    await audio.play();
  } catch {
    elements.status.textContent = "生成済みです。再生ボタンを押してください";
  }
}

function audioDuration(blob) {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(blob);
    audio.addEventListener("loadedmetadata", () => {
      resolve(Number.isFinite(audio.duration) ? audio.duration : null);
      URL.revokeObjectURL(url);
    }, { once: true });
    audio.addEventListener("error", () => {
      resolve(null);
      URL.revokeObjectURL(url);
    }, { once: true });
    audio.src = url;
  });
}

async function setSource(blob, name) {
  if (!blob || blob.size < 44) {
    elements.status.textContent = "WAVを読み込めませんでした";
    return;
  }
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  sourceBlob = blob;
  sourceURL = URL.createObjectURL(blob);
  elements.sourceAudio.src = sourceURL;
  elements.sourceName.textContent = name;
  const duration = await audioDuration(blob);
  elements.sourceMeta.textContent = duration ? `${duration.toFixed(2)}秒 · ${(blob.size / 1024).toFixed(0)} KB` : `${(blob.size / 1024).toFixed(0)} KB`;
  elements.status.textContent = "スライダーを動かすか、この値を聴くを押してください";
  await render({ autoplay: false });
}

async function render({ autoplay = false } = {}) {
  if (!sourceBlob) {
    elements.status.textContent = "先にWAVを選んでください";
    return;
  }
  const { pitch, formant } = tuning();
  const sequence = ++renderSequence;
  setBusy(true, `Pitch ${signed(pitch)} / Formant ${signed(formant, 1)} を処理中`);
  try {
    const response = await fetch(`/api/process?pitch=${encodeURIComponent(pitch)}&formant=${encodeURIComponent(formant)}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: sourceBlob,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({ error: "処理に失敗しました" }));
      throw new Error(detail.error || "処理に失敗しました");
    }
    const blob = await response.blob();
    if (sequence !== renderSequence) return;
    const processing = Number(response.headers.get("X-Shannon-Processing-Ms") || 0);
    const latency = Number(response.headers.get("X-Shannon-Algorithm-Latency-Ms") || 0);
    if (processedURL) URL.revokeObjectURL(processedURL);
    processedURL = URL.createObjectURL(blob);
    elements.processedAudio.src = processedURL;
    elements.processingMetric.textContent = `${processing.toFixed(1)} ms`;
    elements.latencyMetric.textContent = `${latency.toFixed(1)} ms`;
    elements.processedMeta.textContent = `${signed(pitch)} cents · ${signed(formant, 1)} 半音`;
    elements.status.textContent = "試聴できます";
    elements.status.classList.remove("is-busy");
    addHistory({ pitch, formant, processing, latency, blob });
    if (autoplay) await play(elements.processedAudio);
  } catch (error) {
    if (sequence !== renderSequence) return;
    elements.status.textContent = error instanceof Error ? error.message : "処理に失敗しました";
    elements.status.classList.remove("is-busy");
  } finally {
    if (sequence === renderSequence) {
      for (const control of [elements.renderButton, elements.resetButton, elements.offButton]) {
        control.disabled = false;
      }
    }
  }
}

function addHistory(entry) {
  history.unshift(entry);
  history = history.slice(0, 8);
  drawHistory();
}

function drawHistory() {
  elements.historyList.replaceChildren();
  elements.historyEmpty.hidden = history.length > 0;
  for (const item of history) {
    const row = document.createElement("li");
    const values = document.createElement("p");
    values.className = "history-values";
    values.textContent = `P ${signed(item.pitch)} · F ${signed(item.formant, 1)}`;
    const metrics = document.createElement("p");
    metrics.className = "history-metrics";
    metrics.textContent = `前処理 ${item.processing.toFixed(1)} ms\nDSP遅延 ${item.latency.toFixed(1)} ms`;
    const button = document.createElement("button");
    button.className = "secondary-button history-play";
    button.type = "button";
    button.textContent = "この結果を再生";
    button.addEventListener("click", () => {
      if (processedURL) URL.revokeObjectURL(processedURL);
      processedURL = URL.createObjectURL(item.blob);
      elements.processedAudio.src = processedURL;
      play(elements.processedAudio);
    });
    row.append(values, metrics, button);
    elements.historyList.append(row);
  }
}

function bindTuning(range, number, digits) {
  range.addEventListener("input", () => {
    number.value = Number(range.value).toFixed(digits);
    updateTuningLabel();
    elements.status.textContent = "指を離すと試聴します";
  });
  range.addEventListener("change", () => {
    if (elements.autoPreview.checked) render({ autoplay: true });
  });
  number.addEventListener("change", () => {
    const value = clamp(Number(number.value), Number(range.min), Number(range.max));
    range.value = Number.isFinite(value) ? value : 0;
    updateTuningLabel();
    if (elements.autoPreview.checked) render({ autoplay: true });
  });
}

bindTuning(elements.pitch, elements.pitchNumber, 0);
bindTuning(elements.formant, elements.formantNumber, 1);

elements.fileInput.addEventListener("change", () => {
  const file = elements.fileInput.files?.[0];
  if (file) setSource(file, file.name);
});
for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
  });
}
elements.dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) setSource(file, file.name);
});
elements.renderButton.addEventListener("click", () => render({ autoplay: true }));
elements.resetButton.addEventListener("click", () => {
  setTuning(200, 0);
  render({ autoplay: true });
});
elements.offButton.addEventListener("click", () => {
  setTuning(0, 0);
  render({ autoplay: true });
});
elements.playOriginal.addEventListener("click", () => play(elements.sourceAudio));
elements.playProcessed.addEventListener("click", () => play(elements.processedAudio));
elements.clearHistory.addEventListener("click", () => {
  history = [];
  drawHistory();
});

async function selectEmotion(slug, autoplay = false) {
  if (!emotionManifest) return;
  const sequence = ++sourceSequence;
  const emotion = emotionManifest.emotions.find((item) => item.slug === slug) || emotionManifest.emotions[0];
  const voice = emotionManifest.voices.find((item) => item.id === currentVoice) || emotionManifest.voices[0];
  currentEmotion = emotion.slug;
  for (const button of elements.emotionTabs.querySelectorAll("button")) {
    button.setAttribute("aria-selected", String(button.dataset.emotion === currentEmotion));
  }
  elements.emotionDirection.textContent = emotion.direction;
  elements.emotionText.textContent = `「${emotion.text}」`;
  setBusy(true, `${voice.label} · ${emotion.label}を読み込み中`);
  try {
    const response = await fetch(`/api/emotion/${encodeURIComponent(voice.id)}/${encodeURIComponent(emotion.slug)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("感情音源を読み込めませんでした");
    const blob = await response.blob();
    if (sequence !== sourceSequence) return;
    await setSource(blob, `${voice.label} · ${emotion.label}`);
    if (autoplay) await play(elements.sourceAudio);
  } catch (error) {
    elements.status.textContent = error instanceof Error ? error.message : "感情音源を読み込めませんでした";
  }
}

async function loadEmotionSources() {
  const response = await fetch("/api/emotions", { cache: "no-store" });
  if (!response.ok) throw new Error("感情一覧を読み込めませんでした");
  emotionManifest = await response.json();
  const liveVoiceCount = emotionManifest.voices.filter((voice) => voice.newLive).length;
  elements.voiceCount.textContent = `全${emotionManifest.voices.length}声 · GPT-Live追加${liveVoiceCount}声は日本語実生成済み`;
  elements.voiceTabs.innerHTML = emotionManifest.voices.map((voice) => `
    <button type="button" role="tab" data-voice="${voice.id}" aria-selected="${voice.id === currentVoice}"
      title="${voice.newLive ? `GPT-Live · ${voice.languageLabel} · ${voice.voiceStyle}` : 'Realtime / GPT-Live 共通音声'}">
      ${voice.label}${voice.newLive ? '<span>GPT-LIVE · NEW</span>' : (voice.recommended ? '<span>推奨</span>' : '')}
    </button>
  `).join("");
  elements.voiceTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-voice]");
    if (!button || button.dataset.voice === currentVoice) return;
    currentVoice = button.dataset.voice;
    for (const tab of elements.voiceTabs.querySelectorAll("button")) {
      tab.setAttribute("aria-selected", String(tab.dataset.voice === currentVoice));
    }
    selectEmotion(currentEmotion, true);
  });
  elements.emotionTabs.innerHTML = emotionManifest.emotions.map((emotion) => `
    <button type="button" role="tab" data-emotion="${emotion.slug}" aria-selected="${emotion.slug === currentEmotion}">${emotion.label}</button>
  `).join("");
  elements.emotionTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-emotion]");
    if (button) selectEmotion(button.dataset.emotion, true);
  });
  elements.voicePicker.hidden = false;
  elements.emotionPicker.hidden = false;
  await selectEmotion(currentEmotion, false);
}

async function loadDefaultSource() {
  try {
    const health = await fetch("/api/health").then((response) => response.json());
    if (health.hasEmotionSources) {
      await loadEmotionSources();
      return;
    }
    if (!health.hasDefaultSource) {
      elements.sourceMeta.textContent = "WAVを選択";
      elements.status.textContent = "WAVを選んでください";
      return;
    }
    const response = await fetch("/api/default.wav");
    if (!response.ok) throw new Error("既定音源を読み込めませんでした");
    const name = response.headers.get("X-Shannon-Source-Name") || "Realtime voice.wav";
    await setSource(await response.blob(), name);
  } catch (error) {
    elements.status.textContent = error instanceof Error ? error.message : "起動に失敗しました";
  }
}

updateTuningLabel();
drawHistory();
loadDefaultSource();
