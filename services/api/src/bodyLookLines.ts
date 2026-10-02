import type { BodyLookCode } from './bodyLookContract.js';

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

export function bodyLookNotSeenLine(code: BodyLookCode): string {
  return NOT_SEEN_LINE[code];
}
