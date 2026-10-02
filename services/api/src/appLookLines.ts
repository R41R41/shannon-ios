import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import type { AppLookCamera, AppLookClient, AppLookCode } from './appLookContract.js';

/**
 * What she says when she was to look through the app's camera and could not. Fixed sentences in her
 * voice (ボク, です・ます), one per reason; no model is called for them. Like the lines of `bodyLookLines.ts`
 * they are a seed set awaiting the owner's review: persona is core.
 */
const NOT_SEEN_LINE: Readonly<Record<Exclude<AppLookCode, 'denied'>, string>> = Object.freeze({
  background: 'アプリが画面に出ていないので、いまは見られませんでした。',
  declined: 'いまはカメラを使わないとのことなので、見ないでおきます。',
  no_camera: 'カメラが見つからなくて、見られませんでした。',
  switched_off: '会話中にカメラで見るのは設定で切ってあるので、見ていません。',
  busy: 'カメラがほかのことに使われていて、いまは見られませんでした。',
  failed: 'うまく写せなくて、見られませんでした。',
  timeout: 'カメラの用意が間に合わなくて、いまは見られませんでした。',
  model_failed: '写してもらったのですが、うまく見られませんでした。',
});

/** Where the owner allows the camera, by platform. */
const DENIED_LINE: Readonly<Record<AppLookClient['platform'], string>> = Object.freeze({
  ios: 'カメラを使う許可が出ていなくて、見られませんでした。設定アプリの「シャノン」でカメラをオンにしてもらえたら見られます。',
  macos: 'カメラを使う許可が出ていなくて、見られませんでした。システム設定の「プライバシーとセキュリティ」→「カメラ」でシャノンをオンにしてもらえたら見られます。',
});

export function appLookNotSeenLine(code: AppLookCode, platform: AppLookClient['platform']): string {
  return code === 'denied' ? DENIED_LINE[platform] : NOT_SEEN_LINE[code];
}

/** Neutral wording for the activity record. */
const NOT_SEEN_REASON: Readonly<Record<AppLookCode, string>> = Object.freeze({
  background: 'アプリが画面に出ていなかった',
  denied: 'カメラを使う許可がなかった',
  declined: 'カメラの確認で、いまは使わないと選ばれた',
  no_camera: 'カメラがなかった',
  switched_off: 'アプリの設定で切ってあった',
  busy: 'カメラがほかのことに使われていた',
  failed: '写せなかった',
  timeout: 'アプリから返事がなかった',
  model_failed: '届いた1枚を見られなかった',
});

export const APP_LOOK_TOOL = 'app.look';
export const APP_LOOK_SEEN_SUMMARY = 'アプリのカメラで一度見ました。';
export const appLookNotSeenSummary = (code: AppLookCode) => `アプリのカメラで見ませんでした（${NOT_SEEN_REASON[code]}）。`;

/** Why the app cannot be asked to look now, as the server knows it when the turn begins. */
export type AppLookUnavailable = 'server_off' | 'no_viewer' | 'guest' | 'background' | 'denied' | 'no_camera' | 'switched_off' | 'busy';

/** The real reason, in the words a turn's prompt carries. Text and voice turns carry the same words. */
export function appLookUnavailableReason(reason: AppLookUnavailable, platform: AppLookClient['platform']): string {
  switch (reason) {
    case 'server_off': return 'この機能は止めてある';
    case 'no_viewer': return '見る仕組みがいまは使えない';
    case 'guest': return `${SHANNON_OWNER_NAME}以外の人の頼みでは、カメラで見ない`;
    case 'background': return 'アプリが画面に出ていない（画面に出ていない間はカメラを使えない）。アプリを開いてもらえば見られる';
    case 'denied': return platform === 'macos'
      ? 'カメラを使う許可が出ていない。システム設定の「プライバシーとセキュリティ」→「カメラ」でシャノンをオンにしてもらえば見られる'
      : 'カメラを使う許可が出ていない。設定アプリの「シャノン」でカメラをオンにしてもらえば見られる';
    case 'no_camera': return 'この端末にカメラが見つからない';
    case 'switched_off': return 'アプリの設定の「会話中にシャノンがカメラで見る」が切ってある';
    case 'busy': return 'いま見たばかりか、見ている途中';
  }
}

const CAMERA_WORDS: Readonly<Record<AppLookCamera, string>> = Object.freeze({
  back: `外側のカメラ（${SHANNON_OWNER_NAME}が向けている先）`, front: `内側のカメラ（${SHANNON_OWNER_NAME}自身）`,
});
const AFTERWARDS = '見えたものはこの返事のあとで届く。この返事では「見てみますね」のように短く伝えるだけにして、まだ見ていないものを語らない';

/** A text turn in which she may choose the look in the structured reply (`appLook`). */
export const APP_LOOK_OFFER_PROMPT = `[アプリのカメラで見る]（いまは${SHANNON_OWNER_NAME}が使っているアプリのカメラで一度だけ見られる。返答のappLookで選ぶ。`
  + `${SHANNON_OWNER_NAME}に見てと言われた時（「これ見れる？」「見える？」「見て」）は必ず見る。`
  + '見てと言われていなくても、いまいる場所や目の前のものの話（「今〜にいるんだ」「これ美味しそうでしょ？」）で自分が見たくなった時は見てよい。そうでなければ見ない。'
  + `${SHANNON_OWNER_NAME}自身や服・髪・表情の話なら内側のカメラ、それ以外は外側のカメラを選ぶ。${AFTERWARDS}）`;

export const appLookUnavailablePrompt = (reason: AppLookUnavailable, platform: AppLookClient['platform']) =>
  `[アプリのカメラで見る]（カメラで見てほしいという頼みなら、いまは見られない。本当の理由: ${appLookUnavailableReason(reason, platform)}。`
  + 'この理由だけを短く正直に伝える。見たふりをしない。ここに書かれていない原因を作って言わない）';

/** The reply of a voice turn in which the look is taken. */
export const voiceAppLookPrompt = (asked: boolean, camera: AppLookCamera) => `[アプリのカメラで見る]（${asked
  ? `${SHANNON_OWNER_NAME}に見てと言われたので、`
  : 'いまの話から自分で見たくなったので、'}この返事のあとアプリの${CAMERA_WORDS[camera]}で一度だけ見る。${AFTERWARDS}。カメラの許可や接続の不具合など、起きていないことを言わない）`;

/** The camera was mentioned, nobody chose a look, and she could take one. */
export const VOICE_APP_LOOK_READY_PROMPT = `[アプリのカメラで見る]（いまはアプリのカメラで一度見られる状態。この返事では見ない。${SHANNON_OWNER_NAME}に見てと言われたら見られる、と伝えてよい。見えたものや、カメラの許可・接続の不具合を作って言わない）`;
