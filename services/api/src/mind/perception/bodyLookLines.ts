import type { BodyLookCode } from '../../contracts/bodyLookContract.js';

/**
 * What she says when the owner asked her to look and she could not. Fixed sentences in her
 * voice (ボク, です・ます), one per reason; no model is called for them. They are a seed set
 * awaiting the owner's review, like the body's nudge lines: persona is core.
 */
const NOT_SEEN_LINE: Readonly<Record<BodyLookCode, string>> = Object.freeze({
  camera_off: 'カメラが切ってあるので、いまは部屋を見られませんでした。',
  window_hidden: 'ボクの窓が隠れているので、いまは部屋を見られませんでした。',
  busy: '体のほうが手いっぱいで、いまは部屋を見られませんでした。',
  no_camera: 'カメラが見つからなくて、部屋を見られませんでした。',
  denied: 'カメラを使う許可が出ていなくて、部屋を見られませんでした。',
  failed: 'うまく写せなくて、部屋を見られませんでした。',
  timeout: '体から返事がなくて、部屋を見られませんでした。',
  others_present: 'ほかの人がいるかもしれないので、いまは見ないでおきます。',
  rate_limited: '今日はもうたくさん見たので、少し間をあけます。',
  model_failed: '写してもらったのですが、うまく見られませんでした。',
});

/** The server's hourly limit, when a look she had announced in a voice turn could not be opened. Same seed set, same review. */
export const BODY_LOOK_HOUR_LIMIT_LINE = 'この1時間はもうたくさん見たので、少し間をあけます。';
/** The call was cut off while she was saying that she would look. */
export const BODY_LOOK_CUT_OFF_LINE = '話が途中になったので、いまは見ないでおきました。';

export function bodyLookNotSeenLine(code: BodyLookCode): string {
  return NOT_SEEN_LINE[code];
}

/** Why a look cannot be taken now, as the server knows it before asking the body. */
export type BodyLookUnavailable = 'switched_off' | 'not_alone' | 'no_viewer' | 'no_body' | 'no_camera' | 'body_away' | 'busy' | 'limit_hour' | 'limit_day';

/** The real reason, in the words a turn's prompt carries. Text and voice turns carry the same words. */
export const ROOM_LOOK_UNAVAILABLE_REASON: Readonly<Record<BodyLookUnavailable, string>> = Object.freeze({
  switched_off: 'この機能は止めてある',
  not_alone: 'ほかの人がいる場では見ない',
  no_viewer: '見る仕組みがいまは使えない',
  no_body: '体（PCのアプリ）がつながっていない',
  no_camera: '体のカメラが入っていない',
  body_away: '体からの知らせがしばらく届いていない（体の窓が隠れているか、体が動いていない）',
  busy: 'いま見ている途中',
  limit_hour: 'この1時間に見られる回数を使い切った',
  limit_day: '今日見られる回数を使い切った',
});

/**
 * Which of her fixed lines says why a look she announced in a voice turn was not opened after all. Absent: nothing is
 * said (other people may hear it now, or the reason cannot arise within a turn).
 */
export const UNOPENED_LINE: Readonly<Partial<Record<BodyLookUnavailable, { code: BodyLookCode; line: string }>>> = Object.freeze({
  no_body: { code: 'timeout', line: NOT_SEEN_LINE.timeout }, body_away: { code: 'timeout', line: NOT_SEEN_LINE.timeout },
  no_camera: { code: 'camera_off', line: NOT_SEEN_LINE.camera_off }, busy: { code: 'busy', line: NOT_SEEN_LINE.busy },
  limit_hour: { code: 'rate_limited', line: BODY_LOOK_HOUR_LIMIT_LINE }, limit_day: { code: 'rate_limited', line: NOT_SEEN_LINE.rate_limited },
});
