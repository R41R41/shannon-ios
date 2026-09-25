export const CASCADE_BARGE_CONFIRM_MS = 320;
export const CASCADE_BARGE_RELEASE_MS = 850;

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
