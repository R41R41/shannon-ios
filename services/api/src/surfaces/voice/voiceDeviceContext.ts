import { objectBody, validBoundedString } from '../../infra/http/apiValidation.js';
import type { UserUtterance } from '../../mind/action/respond/conversationCommands.js';
import { validatedGuestCallContext, type GuestCallContext } from './voiceGuestCall.js';

export interface VoiceDeviceContext {
  userUtterance?: UserUtterance;
  /** In-call context of a 「友人も一緒」 call; never persisted. */
  guestCall?: GuestCallContext | null;
  /** Owner mode: the owner said someone else is with him and the call was not switched. */
  companionPresent?: boolean;
  timeZoneIdentifier: string;
  requestedLocation: boolean;
  location: { latitude: number; longitude: number; accuracyMeters: number } | null;
}

export function validatedVoiceDeviceContext(value: unknown, nowIso: string): VoiceDeviceContext | null | false {
  if (value === undefined || value === null) return null;
  if (!objectBody(value)
    || !validBoundedString(value.timeZoneIdentifier, 64)
    || typeof value.requestedLocation !== 'boolean') return false;
  try {
    new Intl.DateTimeFormat('ja-JP', { timeZone: value.timeZoneIdentifier });
  } catch {
    return false;
  }
  const utterance = value.userUtterance;
  if (utterance !== undefined && (!objectBody(utterance) || !validBoundedString(utterance.id, 120)
    || !validBoundedString(utterance.text, 8_000)
    || (utterance.source !== undefined && !['speech', 'typed', 'camera'].includes(String(utterance.source)))
    || (utterance.historyReceipt !== undefined && utterance.historyReceipt !== 'utterance-id')
    || (utterance.rawText !== undefined && !validBoundedString(utterance.rawText, 12_000)))) return false;
  const guestCall = validatedGuestCallContext(objectBody(utterance) ? utterance.callContext : undefined);
  if (guestCall === false) return false;
  const userUtterance = utterance === undefined ? undefined : {
    id: utterance.id, text: utterance.text,
    ...(utterance.source !== undefined ? { source: utterance.source } : {}),
    ...(utterance.rawText !== undefined ? { rawText: utterance.rawText } : {}),
    ...clientConfidence(utterance.confidence),
    ...(utterance.historyReceipt === 'utterance-id' ? { historyReceipt: 'utterance-id' as const } : {}),
  } as UserUtterance;
  if (value.companionPresent !== undefined && typeof value.companionPresent !== 'boolean') return false;
  if (objectBody(utterance) && utterance.companionPresent !== undefined && typeof utterance.companionPresent !== 'boolean') return false;
  const companion = value.companionPresent === true || (objectBody(utterance) && utterance.companionPresent === true)
    ? { companionPresent: true } : {};
  if (value.location === undefined || value.location === null) {
    return { timeZoneIdentifier: value.timeZoneIdentifier, requestedLocation: value.requestedLocation, location: null, userUtterance, guestCall, ...companion };
  }
  if (!value.requestedLocation || !objectBody(value.location)) return false;
  const { latitude, longitude, accuracyMeters, observedAt } = value.location;
  const observedMilliseconds = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180
    || typeof accuracyMeters !== 'number' || !Number.isFinite(accuracyMeters)
    || accuracyMeters < 0 || accuracyMeters > 1_000
    || !Number.isFinite(observedMilliseconds)
    || Math.abs(Date.parse(nowIso) - observedMilliseconds) > 300_000) return false;
  return {
    timeZoneIdentifier: value.timeZoneIdentifier,
    requestedLocation: true,
    userUtterance,
    guestCall,
    ...companion,
    location: { latitude, longitude, accuracyMeters },
  };
}

/**
 * The client's recognition confidence (Windows, 2026-10-14), kept only as a finite number in 0…1. Anything else is dropped, never a
 * refused turn: an older or newer client that sends something else still talks.
 */
function clientConfidence(value: unknown): { confidence?: number } {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? { confidence: value } : {};
}

export function voiceDeviceContextPrompt(nowIso: string, context: VoiceDeviceContext | null): string {
  const timeZone = context?.timeZoneIdentifier ?? 'Asia/Tokyo';
  const localTime = new Intl.DateTimeFormat('ja-JP', {
    timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(nowIso));
  const location = context?.location;
  return [
    '[Current request context]',
    `Server clock: ${localTime} (${timeZone}). Use this for today's date and departure-time questions.`,
    ...(location ? [
      `One-time iPhone GPS for this request: latitude ${location.latitude.toFixed(4)}, longitude ${location.longitude.toFixed(4)}, accuracy about ${Math.round(location.accuracyMeters)} m. It is approximate, not a verified street address.`,
    ] : context?.requestedLocation ? [
      'The iPhone could not provide a current location. Ask the user for their station or nearby landmark; do not infer GPS from memory.',
    ] : []),
  ].join('\n');
}
