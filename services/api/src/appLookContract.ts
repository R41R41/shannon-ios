import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { BODY_LOOK_BASE64_CHARACTERS, validatedBodyLookResult, type BodyLookImage, type RoomLookChoice } from './bodyLookContract.js';

/**
 * Looking through the camera of the app the owner is talking through (owner decision 2026-10-02:
 * 「これ見れる？」「今〜にいるんだ」「これ美味しそうでしょ？」; prose in `docs/body-contract.md`,
 * "A look through the app").
 *
 * The app in the current turn is the viewer for that turn: the request itself proves it is there, and
 * it says in `appLook` whether it can capture now. The server decides, answers the turn with one ask
 * (`appLook: { id, camera, expiresAt }`), and the app answers it with one JPEG frame
 * (`POST /v1/app/looks/{id}`). The frame is checked by the rules of a body look, shown to the
 * conversation model once, and dropped.
 */
export const APP_LOOK_LIMITS = Object.freeze({
  /** An ask the app has not answered by then is closed. Long enough for the first camera permission prompt. */
  lifetimeMilliseconds: 30_000,
  /** The same when the system has not asked about the camera yet: the owner reads an explanation and answers a prompt first. */
  firstUseLifetimeMilliseconds: 90_000,
  /** The loop guard: one look per turn, and no second one in the scope sooner than this (`SHANNON_APP_LOOK_MIN_INTERVAL_SECONDS`). */
  minimumIntervalMilliseconds: 5_000,
});

export const APP_LOOK_ROUTE_PREFIX = '/v1/app/looks/';
const LOOK_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/u;

/** The look id of an answer path, or null when the path is not one. */
export function appLookAnswerId(path: string): string | null {
  if (!path.startsWith(APP_LOOK_ROUTE_PREFIX)) return null;
  const id = path.slice(APP_LOOK_ROUTE_PREFIX.length);
  return LOOK_ID.test(id) ? id : null;
}

/** The JSON body limit of an app look answer: the largest frame plus 2,048 bytes for the other fields; null for every other path. */
export function appLookRequestBytes(path: string): number | null {
  return appLookAnswerId(path) ? BODY_LOOK_BASE64_CHARACTERS + 2_048 : null;
}

export const APP_LOOK_CAMERAS = ['back', 'front'] as const;
export type AppLookCamera = typeof APP_LOOK_CAMERAS[number];

/**
 * What the app says about itself in a turn. `ready`: in the foreground, permission granted, the owner's
 * switch on. `undetermined`: the same, but the system has not asked for the camera yet; the first ask does.
 */
export const APP_LOOK_CLIENT_STATES = ['ready', 'undetermined', 'background', 'denied', 'no_camera', 'switched_off'] as const;
export type AppLookClientState = typeof APP_LOOK_CLIENT_STATES[number];

export interface AppLookClient {
  /** The paired device the turn came from; only it may answer the ask. */
  deviceId: string;
  state: AppLookClientState;
  /** Cameras the device has, in no order. A Mac reports its one camera as `front`. */
  cameras: readonly AppLookCamera[];
  platform: 'ios' | 'macos';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The `appLook` field of a turn (`POST /v1/chat`, `POST /v1/voice/…/delegations`). Absent or malformed: the
 * turn has no app viewer and is what it was before the field existed. Facts with a closed vocabulary; no text.
 */
export function appLookClient(deviceId: string | undefined, value: unknown): AppLookClient | null {
  if (!isRecord(value) || !(APP_LOOK_CLIENT_STATES as readonly unknown[]).includes(value.state)) return null;
  const cameras = Array.isArray(value.cameras) ? APP_LOOK_CAMERAS.filter(camera => (value.cameras as unknown[]).includes(camera)) : [];
  const state = value.state as AppLookClientState;
  return {
    deviceId: deviceId ?? 'local', cameras, platform: value.platform === 'macos' ? 'macos' : 'ios',
    // A device that names no camera cannot look, whatever else it says.
    state: cameras.length || state === 'background' || state === 'switched_off' ? state : 'no_camera',
  };
}

/** What the turn's response carries when she looks: the app captures one frame with this camera and answers before `expiresAt`. */
export interface AppLookAsk {
  id: string; camera: AppLookCamera; expiresAt: string;
  /** Seconds from the ask to `expiresAt`, so that the app need not trust its own clock against the server's. */
  lifetimeSeconds: number;
}

/**
 * Why the app did not look. Sent by the app, except `timeout`, `model_failed` and `too_soon` (another look was open or just taken) and `not_opened` (she said she would look in a turn that could not), which the server adds itself.
 * `declined`: the system had not asked about the camera yet, and the owner chose not to allow it for now.
 * `interrupted`: he spoke over her or ended the call before the camera opened, so nothing was captured.
 */
export const APP_LOOK_REFUSAL_CODES = ['background', 'denied', 'declined', 'no_camera', 'switched_off', 'busy', 'failed', 'interrupted'] as const;
export type AppLookRefusalCode = typeof APP_LOOK_REFUSAL_CODES[number];
export type AppLookCode = AppLookRefusalCode | 'timeout' | 'model_failed' | 'too_soon' | 'not_opened';

export type AppLookResult =
  | { outcome: 'seen'; camera: AppLookCamera; image: BodyLookImage }
  | { outcome: 'refused'; code: AppLookRefusalCode };

/** The app's answer to one ask, or the reason the request is refused. The frame is held to the bounds of a body look. */
export function validatedAppLookResult(value: Record<string, unknown>): AppLookResult | string {
  if (value.outcome === 'refused') {
    const unknown = Object.keys(value).find(key => !['scopeKey', 'outcome', 'code'].includes(key));
    if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
    if (!(APP_LOOK_REFUSAL_CODES as readonly unknown[]).includes(value.code)) return 'code is invalid';
    return { outcome: 'refused', code: value.code as AppLookRefusalCode };
  }
  if (value.outcome !== 'seen') return 'outcome must be seen or refused';
  const unknown = Object.keys(value).find(key => !['scopeKey', 'outcome', 'camera', 'image'].includes(key));
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  if (value.camera !== 'back' && value.camera !== 'front') return 'camera must be back or front';
  // The same checks as a frame from her body: JPEG, at most 960 wide and 400,000 bytes, the size its own header states.
  const frame = validatedBodyLookResult({ outcome: 'seen', audience: 'owner', image: value.image });
  if (typeof frame === 'string') return frame;
  if (frame.outcome !== 'seen') return 'image is invalid';
  return { outcome: 'seen', camera: value.camera, image: frame.image };
}

/** What the conversation model answered in the structured reply of a text turn in which the app look was offered. */
export interface AppLookChoice { choice: RoomLookChoice; camera: AppLookCamera }

const CHOICES: Readonly<Record<string, AppLookChoice>> = Object.freeze({
  asked_back: { choice: 'asked', camera: 'back' }, asked_front: { choice: 'asked', camera: 'front' },
  curious_back: { choice: 'curious', camera: 'back' }, curious_front: { choice: 'curious', camera: 'front' },
});

/** The `appLook` field of the structured reply; it is in the schema only in a turn where the look is offered. */
export const APP_LOOK_SCHEMA = Object.freeze({
  type: 'string', enum: ['none', ...Object.keys(CHOICES)],
  description: `アプリのカメラで一度見るか。none=見ない。asked=${SHANNON_OWNER_NAME}に見てと言われたので見る。curious=言われていないが自分が見たいので見る。`
    + `_back=外側のカメラ（${SHANNON_OWNER_NAME}が見せているもの、いる場所）。_front=内側のカメラ（${SHANNON_OWNER_NAME}自身、服や髪や表情の話の時）`,
});

export function appLookChoice(value: unknown): AppLookChoice | null {
  return typeof value === 'string' && Object.hasOwn(CHOICES, value) ? CHOICES[value]! : null;
}

/** The camera the device has for the one that was chosen: the other one when it has only that. */
export function availableCamera(client: Pick<AppLookClient, 'cameras'>, wanted: AppLookCamera): AppLookCamera {
  return client.cameras.includes(wanted) ? wanted : client.cameras[0] ?? wanted;
}

export interface AppLookConfig {
  /** `SHANNON_APP_LOOK`; unset means on. */
  enabled: boolean;
  minimumIntervalMilliseconds: number;
}

/** Switching app looks off needs only `SHANNON_APP_LOOK=off` and a restart, not a deployment. */
export function configuredAppLook(environment: Readonly<Record<string, string | undefined>> = process.env): AppLookConfig {
  const seconds = Number(environment.SHANNON_APP_LOOK_MIN_INTERVAL_SECONDS?.trim());
  return {
    enabled: !['off', 'false', '0', 'disabled'].includes(environment.SHANNON_APP_LOOK?.trim().toLowerCase() ?? ''),
    minimumIntervalMilliseconds: environment.SHANNON_APP_LOOK_MIN_INTERVAL_SECONDS?.trim() && Number.isInteger(seconds) && seconds >= 0 && seconds <= 600
      ? seconds * 1_000 : APP_LOOK_LIMITS.minimumIntervalMilliseconds,
  };
}

/**
 * The voice router's questions for a turn that came from an app that can be asked to look (`voiceRoomLook.ts` asks
 * them in place of the body's). The first is the body's question in the app's terms; the second chooses the camera.
 */
const APP_ROUTER_INSTRUCTIONS = 'Would one look through the camera of the app he is talking through (his phone, or his Mac) be right now? True when the speaker asks her to look at him, at where he is, or at something he is showing or holding ("can you see this?", "look at this"), or asks what she can see; also when he is clearly showing her something or telling her where he is right now, so that one look is what he would welcome ("doesn\'t this look tasty?", "I\'m at the station now"). False for talk about cameras, photos, screens, notes or seeing in general, for past or hypothetical looking, when someone other than him asks, and when he asks her not to look.';
const APP_ROUTER_SELF_INSTRUCTIONS = 'If she looked through a camera now, is the speaker himself what should be seen (his face, expression, hair, clothes, how he looks, "can you see me?") rather than something he is pointing the camera at or the place he is in?';

export const APP_LOOK_ROUTER = Object.freeze({
  look: Object.freeze({ type: 'noul' as const, instructions: APP_ROUTER_INSTRUCTIONS,
    criteria: { true: 'One look through the camera of his app now is asked for or clearly welcome.', false: 'No look is wanted now.' } }),
  self: Object.freeze({ type: 'noul' as const, instructions: APP_ROUTER_SELF_INSTRUCTIONS,
    criteria: { true: 'He himself is what should be seen (the camera facing him).', false: 'Something else is what should be seen, or nothing.' } }),
});

/** The router's answer to the camera question, when it gave one. A malformed value is no answer. */
export function lookSelfAnswer(value: unknown): { lookSelfProbability?: number } {
  const probability = value !== null && typeof value === 'object' ? (value as { noul?: unknown }).noul : value;
  return typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1
    ? { lookSelfProbability: probability } : {};
}

/**
 * The camera of a voice look: the router's judgement when it gave one, otherwise a narrow rule on his words
 * (himself as what is looked at, or what he wears).
 */
export function voiceLookCamera(transcript: string, lookSelfProbability: number | undefined): AppLookCamera {
  if (lookSelfProbability !== undefined) return lookSelfProbability >= 0.5 ? 'front' : 'back';
  return /(?:僕|ぼく|ボク|俺|おれ|私|わたし)(?:のこと|の顔|の姿|の様子|の服|の髪|が見|を見)|この(?:服|髪|髪型|メガネ|眼鏡|帽子|格好)|似合/u.test(transcript.normalize('NFKC'))
    ? 'front' : 'back';
}
