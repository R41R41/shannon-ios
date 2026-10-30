import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { type BodyLookCode } from '../../contracts/bodyLookContract.js';
import { ROOM_LOOK_UNAVAILABLE_REASON, type BodyLookUnavailable } from '../../mind/perception/bodyLookLines.js';

/** Why a screen look the owner started was not taken at all (nothing was opened, and no model saw the frame). */
export type ScreenLookUnavailable = 'no_viewer' | 'busy' | 'limit_hour' | 'limit_day';

export type Unavailable = BodyLookUnavailable;

/** Neutral wording for the activity record. */
export const NOT_SEEN_REASON: Readonly<Record<BodyLookCode, string>> = Object.freeze({
  camera_off: 'カメラが切ってあった',
  window_hidden: '体の窓が隠れていた',
  busy: '体が別のことをしていた',
  no_camera: 'カメラがなかった',
  denied: 'カメラを使う許可がなかった',
  failed: '写せなかった',
  timeout: '体から返事がなかった',
  others_present: 'ほかの人がいるかもしれなかった',
  rate_limited: '体の側の回数の上限に達していた',
  model_failed: '届いた1枚を見られなかった',
});

export const BODY_LOOK_TOOL = 'body.look';

export const BODY_LOOK_SEEN_SUMMARY = '部屋を一度見ました。';

export const bodyLookNotSeenSummary = (code: BodyLookCode, frameDiscarded = false) =>
  `部屋を見ませんでした（${NOT_SEEN_REASON[code]}${frameDiscarded ? '。届いた1枚は見ずに捨てた' : ''}）。`;

/** The screen look in the activity record. The frame is not part of it, only that she looked and how it ended. */
export const BODY_SCREEN_LOOK_SEEN_SUMMARY = '画面を一度見ました。';

export const SCREEN_NOT_SEEN_REASON: Readonly<Partial<Record<BodyLookCode, string>>> = Object.freeze({
  others_present: 'ほかの人がいるかもしれなかった',
  timeout: '体から返事がなかった',
  rate_limited: '回数の上限に達していた',
  model_failed: '届いた1枚を見られなかった',
});

export const bodyScreenLookNotSeenSummary = (code: BodyLookCode, frameDiscarded = false) =>
  `画面を見ませんでした（${SCREEN_NOT_SEEN_REASON[code] ?? '画面を取れなかった'}${frameDiscarded ? '。届いた1枚は見ずに捨てた' : ''}）。`;

/** What she says when the owner asked her to look at his screen and she could not: the room's lines speak of the
 * room and the camera. */
export const SCREEN_NOT_SEEN_LINE: Readonly<Partial<Record<BodyLookCode, string>>> = Object.freeze({
  others_present: 'ほかの人がいるかもしれないので、いまは見ないでおきます。',
  model_failed: '画面を見せてもらったのですが、うまく見られませんでした。',
});

export const bodyScreenLookNotSeenLine = (code: BodyLookCode) => SCREEN_NOT_SEEN_LINE[code] ?? 'うまく画面を見られませんでした。';

export const ROOM_LOOK_OFFER_PROMPT =
  `[部屋を見る]（いまは体のカメラで部屋を一度だけ見られる。${SHANNON_OWNER_NAME}に見てと言われた時か、自分が見たい時だけ、返答のroomLookで選ぶ。` +
  '見えたものはこの返事のあとで届く。この返事では見てみると伝えるだけにして、まだ見ていないものを語らない）';

export const roomLookUnavailablePrompt = (reason: Unavailable) =>
  `[部屋を見る]（体のカメラで部屋を見てほしいという頼みなら、いまは見られない: ${ROOM_LOOK_UNAVAILABLE_REASON[reason]}。見たふりをせず、見られないと正直に伝える）`;
