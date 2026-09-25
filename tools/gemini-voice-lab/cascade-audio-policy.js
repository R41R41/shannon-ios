export function shouldSendCascadeAudio({ ready, socketOpen, activeTurn, bargeIn }) {
  return ready === true && socketOpen === true && (bargeIn === true || activeTurn !== true);
}

export function shouldInterruptCascadeOutput({ bargeIn, activeTurn, interimText, finalText }) {
  if (bargeIn !== true || activeTurn !== true) return false;
  return Boolean(String(interimText ?? '').trim() || String(finalText ?? '').trim());
}
