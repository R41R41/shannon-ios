/**
 * Looking at the room through the camera of her body (owner decision, Syzygy ADR-0002
 * addendum 2026-10-02; prose in `docs/body-contract.md`, "Looking at the room").
 *
 * One JPEG frame per look. The frame is checked here, shown to the conversation model
 * once, and dropped. Nothing in this file, or in any module it is passed to, stores it.
 */
export const BODY_LOOK_LIMITS = Object.freeze({
  /** Owner's defaults; `SHANNON_BODY_LOOK_PER_HOUR` / `SHANNON_BODY_LOOK_PER_DAY` may lower or raise them. */
  perHour: 6,
  perDay: 30,
  /** Stage 2: looks she takes in her own activity, per owner-local day, inside the two limits above (`SHANNON_AUTONOMY_MAX_ROOM_LOOKS`; 0 switches stage 2 off). */
  activityPerDay: 3,
  /** A look the body has not answered by then is closed as `timeout`. The same for a look opened by her activity loop. */
  lifetimeMilliseconds: 30_000,
  /** For a look in her own time: the body counts as present (window visible) while its last presence read is this recent. */
  presenceFreshMilliseconds: 30_000,
  /**
   * For a look in conversation (text or voice): the same, with room for the body's 10-second poll to slip
   * while it is busy with a call. `SHANNON_BODY_LOOK_PRESENCE_FRESH_SECONDS` (10–300). The body still refuses
   * a look when her window is hidden, so a longer window costs at most one honest "could not look".
   */
  conversationPresenceFreshMilliseconds: 75_000,
  /** While a text turn is this recent, or a look is open, presence asks to be polled faster. */
  fastPollWindowMilliseconds: 60_000,
  fastPollSeconds: 3,
  /** Decoded JPEG bytes. */
  imageBytes: 400_000,
  imageWidth: 960,
  imageHeight: 1_920,
  /** What she says about one look. */
  messageCharacters: 400,
  contextMessages: 4,
  contextCharacters: 200,
});

/** Base64 of the largest accepted frame. */
export const BODY_LOOK_BASE64_CHARACTERS = Math.ceil(BODY_LOOK_LIMITS.imageBytes / 3) * 4;
/** The JSON body limit of `POST /v1/body/looks/{id}` only: the largest frame plus 2,048 bytes for the other fields. */
export const BODY_LOOK_REQUEST_BYTES = BODY_LOOK_BASE64_CHARACTERS + 2_048;

/**
 * The `thread_id` of a look her activity loop opened: it belongs to no Talk. Such a look is never
 * spoken about in a conversation and is recorded by the loop through the gate, not as a conversation action.
 */
export const BODY_LOOK_ACTIVITY_THREAD = 'activity:own-time';

export const BODY_LOOK_RESULT_PREFIX = '/v1/body/looks/';
const LOOK_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/u;

/** The look id of a result path, or null when the path is not one. */
export function bodyLookResultId(path: string): string | null {
  if (!path.startsWith(BODY_LOOK_RESULT_PREFIX)) return null;
  const id = path.slice(BODY_LOOK_RESULT_PREFIX.length);
  return LOOK_ID.test(id) ? id : null;
}

/** Why the body did not look. The first nine are sent by the body; the server adds the rest itself. */
export const BODY_LOOK_REFUSAL_CODES = [
  'camera_off', 'window_hidden', 'busy', 'no_camera', 'denied', 'failed', 'timeout', 'others_present', 'rate_limited',
] as const;
export type BodyLookRefusalCode = typeof BODY_LOOK_REFUSAL_CODES[number];
/** `model_failed`: the frame arrived and the model call did not produce a message. */
export type BodyLookCode = BodyLookRefusalCode | 'model_failed';

/** What the conversation model answered in the structured reply when a look was offered. */
export type RoomLookChoice = 'asked' | 'curious';
export function roomLookChoice(value: unknown): RoomLookChoice | null {
  return value === 'asked' || value === 'curious' ? value : null;
}

export interface BodyLookImage {
  mediaType: 'image/jpeg';
  /** Standard base64 of the JPEG, without a data-URL prefix. */
  base64: string;
  width: number;
  height: number;
}

export type BodyLookResult =
  | { outcome: 'seen'; audience: 'owner' | 'others'; image: BodyLookImage }
  | { outcome: 'refused'; code: BodyLookRefusalCode };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const unknownKey = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).find(key => !allowed.includes(key));

/**
 * Width and height from the frame header of a JPEG, or null when the bytes are not one.
 * Only the marker segments are walked; no pixel is decoded.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!, width: (bytes[offset + 7]! << 8) | bytes[offset + 8]! };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * The answer of the body to one look, or the reason the request is refused. The frame is
 * decoded only to check its type and size; the returned value still holds it once, as base64.
 */
export function validatedBodyLookResult(value: Record<string, unknown>): BodyLookResult | string {
  if (value.outcome === 'refused') {
    const unknown = unknownKey(value, ['scopeKey', 'outcome', 'code']);
    if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
    if (!(BODY_LOOK_REFUSAL_CODES as readonly unknown[]).includes(value.code)) return 'code is invalid';
    return { outcome: 'refused', code: value.code as BodyLookRefusalCode };
  }
  if (value.outcome !== 'seen') return 'outcome must be seen or refused';
  const unknown = unknownKey(value, ['scopeKey', 'outcome', 'audience', 'image']);
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  if (value.audience !== 'owner' && value.audience !== 'others') return 'audience must be owner or others';
  const image = value.image;
  if (!isRecord(image)) return 'image must be an object';
  const unknownImageKey = unknownKey(image, ['mediaType', 'base64', 'width', 'height']);
  if (unknownImageKey) return `image.${unknownImageKey.slice(0, 40)} is not allowed`;
  if (image.mediaType !== 'image/jpeg') return 'image.mediaType must be image/jpeg';
  const { base64, width, height } = image;
  if (typeof base64 !== 'string' || !base64.length || base64.length > BODY_LOOK_BASE64_CHARACTERS
    || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) {
    return `image.base64 must be standard base64 of at most ${BODY_LOOK_LIMITS.imageBytes} bytes`;
  }
  if (!Number.isInteger(width) || (width as number) < 1 || (width as number) > BODY_LOOK_LIMITS.imageWidth) {
    return `image.width must be 1..${BODY_LOOK_LIMITS.imageWidth}`;
  }
  if (!Number.isInteger(height) || (height as number) < 1 || (height as number) > BODY_LOOK_LIMITS.imageHeight) {
    return `image.height must be 1..${BODY_LOOK_LIMITS.imageHeight}`;
  }
  const bytes = Buffer.from(base64, 'base64');
  try {
    if (bytes.length > BODY_LOOK_LIMITS.imageBytes) return `image.base64 must be standard base64 of at most ${BODY_LOOK_LIMITS.imageBytes} bytes`;
    const size = jpegSize(bytes);
    if (!size) return 'image.base64 is not a JPEG';
    if (size.width !== width || size.height !== height) return 'image.width and image.height must match the JPEG';
  } finally {
    bytes.fill(0);
  }
  return { outcome: 'seen', audience: value.audience, image: { mediaType: 'image/jpeg', base64, width: width as number, height: height as number } };
}

export interface BodyLookConfig {
  /** `SHANNON_BODY_LOOK`; unset means on. */
  enabled: boolean;
  perHour: number;
  perDay: number;
  /** Looks from her own activity per owner-local day, counted inside `perHour` and `perDay`. 0: stage 2 is off. */
  activityPerDay: number;
  /** How recent a presence read must be for a look in conversation. Absent: `BODY_LOOK_LIMITS.conversationPresenceFreshMilliseconds`. */
  presenceFreshMilliseconds?: number;
}

function boundedLimit(value: string | undefined, fallback: number, maximum: number, minimum = 0): number {
  const parsed = Number(value?.trim());
  return value?.trim() && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

/** Switching looks off needs only `SHANNON_BODY_LOOK=off` and a restart, not a deployment. */
export function configuredBodyLook(environment: Readonly<Record<string, string | undefined>> = process.env): BodyLookConfig {
  return {
    enabled: !['off', 'false', '0', 'disabled'].includes(environment.SHANNON_BODY_LOOK?.trim().toLowerCase() ?? ''),
    perHour: boundedLimit(environment.SHANNON_BODY_LOOK_PER_HOUR, BODY_LOOK_LIMITS.perHour, 60),
    perDay: boundedLimit(environment.SHANNON_BODY_LOOK_PER_DAY, BODY_LOOK_LIMITS.perDay, 500),
    activityPerDay: boundedLimit(environment.SHANNON_AUTONOMY_MAX_ROOM_LOOKS, BODY_LOOK_LIMITS.activityPerDay, 30),
    presenceFreshMilliseconds: boundedLimit(environment.SHANNON_BODY_LOOK_PRESENCE_FRESH_SECONDS,
      BODY_LOOK_LIMITS.conversationPresenceFreshMilliseconds / 1_000, 300, 10) * 1_000,
  };
}
