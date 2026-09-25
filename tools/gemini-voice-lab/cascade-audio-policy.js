export const CASCADE_BARGE_CONFIRM_MS = 320;
export const CASCADE_BARGE_RELEASE_MS = 850;
export const CASCADE_PLAYBACK_LEAD_SECONDS = 0.045;

export function shouldSendCascadeAudio({ ready, socketOpen, activeTurn, bargeIn }) {
  return ready === true && socketOpen === true && (bargeIn === true || activeTurn !== true);
}

export function cascadeBargeInAction({
  bargeIn,
  activeTurn,
  candidateStartedAt,
  now,
  interimText,
  finalText,
  confirmAfterMs = CASCADE_BARGE_CONFIRM_MS,
}) {
  if (bargeIn !== true || activeTurn !== true) return 'ignore';
  const interim = String(interimText ?? '').trim();
  const final = String(finalText ?? '').trim();
  if (!interim && !final) return 'ignore';
  if (final) return 'interrupt';
  if (!Number.isFinite(candidateStartedAt)) return 'duck';
  return now - candidateStartedAt >= confirmAfterMs ? 'interrupt' : 'hold';
}

export function shouldRestoreCascadeVolume({ candidateLastHeardAt, now, releaseAfterMs = CASCADE_BARGE_RELEASE_MS }) {
  return Number.isFinite(candidateLastHeardAt) && now - candidateLastHeardAt >= releaseAfterMs;
}

export function adaptiveCascadeFinalizeDelay(text, { turnComplete = false } = {}) {
  if (turnComplete) return 0;
  const value = String(text ?? '').trim();
  if (/[。！？!?][」』）】”"]?$/u.test(value)) return 80;
  if (/[、…]|(?:けど|から|ので|でも|だが|ながら|つつ)$/u.test(value)) return 420;
  if (value.length <= 3) return 360;
  return 220;
}

export function cascadeBargeTuning({ trackLabel = '', settings = {}, remoteLevel = 0, falsePositiveCount = 0 } = {}) {
  const isHeadset = /(?:airpods?|head(?:set|phone)|ear(?:buds?|phone)|bluetooth|イヤホン|ヘッド|耳)/iu.test(String(trackLabel));
  const echoCancellation = settings?.echoCancellation === true;
  let mode = '保護';
  let confirmAfterMs = 480;
  let releaseAfterMs = 1_050;
  let duckGain = 0.08;

  if (isHeadset) {
    mode = 'イヤホン';
    confirmAfterMs = 180;
    releaseAfterMs = 620;
    duckGain = 0.34;
  } else if (echoCancellation) {
    mode = 'スピーカーAEC';
    confirmAfterMs = 340;
    releaseAfterMs = 850;
    duckGain = 0.18;
  }

  if (Number(remoteLevel) >= 0.2 && !isHeadset) {
    confirmAfterMs += 120;
    duckGain = Math.min(duckGain, 0.12);
  }
  const penalty = Math.min(4, Math.max(0, Number(falsePositiveCount) || 0));
  confirmAfterMs += penalty * 40;
  releaseAfterMs += penalty * 50;

  return Object.freeze({ mode, confirmAfterMs, releaseAfterMs, duckGain });
}

export function nextCascadePlaybackLead({
  currentLeadSeconds = 0,
  targetSeconds = CASCADE_PLAYBACK_LEAD_SECONDS,
  underrun = false,
} = {}) {
  const target = Number.isFinite(targetSeconds) ? targetSeconds : CASCADE_PLAYBACK_LEAD_SECONDS;
  if (underrun) return Math.min(0.12, target + 0.015);
  if (currentLeadSeconds > 0.16) return Math.max(0.035, target - 0.005);
  return Math.min(0.12, Math.max(0.035, target));
}
