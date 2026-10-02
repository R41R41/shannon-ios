import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import type { AppLookCamera, AppLookClient, AppLookCode } from './appLookContract.js';
import { BODY_LOOK_CUT_OFF_LINE } from './bodyLookLines.js';

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
  // The same words as a look through her body that was cut off: 「話が途中になったので、いまは見ないでおきました。」
  interrupted: BODY_LOOK_CUT_OFF_LINE,
  timeout: 'カメラの用意が間に合わなくて、いまは見られませんでした。',
  model_failed: '写してもらったのですが、うまく見られませんでした。',
  too_soon: 'いま見たばかりなので、少し間をあけてから見ます。',
  not_opened: 'すみません、見ると言いましたが、いまは見られていません。まだ何も見ていないです。',
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
  interrupted: '話が途中で切れた',
  timeout: 'アプリから返事がなかった',
  model_failed: '届いた1枚を見られなかった',
  too_soon: '直前に見たばかりか、見ている途中だった',
  not_opened: '見ると言ったが、見られる状態ではなかった',
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
const AFTERWARDS = '見えたものはこの返事のあとで届く。この返事では「カメラで見てみますね」と短く伝えるだけにして、まだ見ていないものを語らない';
/**
 * The fact a turn without a look carries when the owner is alone: nothing has been seen in this conversation unless
 * the Talk holds what she saw. A photo he shared himself, and the description that came with it, is another matter.
 */
const NOTHING_SEEN = `この会話では、履歴に見た結果の発言がない限り、カメラでまだ何も見ていない。人や物の見た目・色・様子を、いま見えているものとして語らない。${SHANNON_OWNER_NAME}が共有した写真と、その内容として届いた説明は別で、それについては話してよい`;

/** Her reply without what it quotes: 「「カメラで見てみますね」と言えば見られます」 announces nothing. */
const unquoted = (reply: string) => reply.normalize('NFKC').replace(/「[^」]*」|『[^』]*』|"[^"]*"/gu, '');
/** Not a question, a negation or a report of the words: 「見てみますか？」「見てみますね、とは言えません」. */
const AFFIRMED = '(?![ねよ]?[、,]?\\s*(?:か|とは|と言|って言))';
/** Non-past and affirmative: 見てみます／見てきます／見てみる／見ます／のぞいてみます, never 見ました／見ません／見ましょうか. */
const STRICT_LOOK = new RegExp(`カメラで[^。！？!?\\n]{0,12}(?:見てみます|見てきます|見てみる|見ます|のぞいてみます)${AFFIRMED}`, 'u');
const LOOKING = `(?:見てみます|見てきます|見てみる|見ますね|のぞいてみます|確認します|確認して[^。！？!?\\n]{0,24}(?:伝え|言い|話し|答え|見てみ)ます)${AFFIRMED}`;
const BROAD_LOOK = new RegExp(LOOKING, 'u');
/** The same in other words, with the camera named as the means: 「カメラ、見てみますね」「カメラを使って見てみますね」「カメラで確認しますね」. */
const CAMERA_LOOK = new RegExp(`カメラ(?:で|、|,|を使って|から|越しに)[^。！？!?\\n]{0,12}${LOOKING}`, 'u');

/**
 * Her reply says, in the words her look line gives her, that she looks through the camera now: non-past, affirmative,
 * and not inside a quotation. A reply about reading a note or checking a schedule (「見てみますね」) is not one.
 */
export function announcesCameraLook(reply: string): boolean {
  return STRICT_LOOK.test(unquoted(reply));
}

/**
 * Whether her reply announces a look. `camera`: it names the camera as the means, in the given words or others.
 * `looking`: it says that she will look or check without naming the camera (「見てみますね」「いま確認して、感想を伝えますね」),
 * which is about the camera only when his words asked her to look. null: no announcement.
 */
export function lookAnnouncement(reply: string): 'camera' | 'looking' | null {
  const text = unquoted(reply);
  if (STRICT_LOOK.test(text) || CAMERA_LOOK.test(text)) return 'camera';
  return BROAD_LOOK.test(text) ? 'looking' : null;
}

/** She announced a look through the camera in this turn: in so many words, or by saying she will look after he asked her to. */
export function announcedLook(reply: string, heAsked: boolean): boolean {
  const kind = lookAnnouncement(reply);
  return kind === 'camera' || (kind === 'looking' && heAsked);
}

/**
 * A turn in which no camera is offered at all (no app camera in the turn, her body not offering one): she knows from
 * her capabilities that she can look, so she is told as a fact that this reply does not, and that she has not.
 */
export const LOOK_NOT_SEEN_GUARD = `[カメラ]（この返事ではカメラで見ていない。${NOTHING_SEEN}。「見てみます」「見えています」と言わない。見てほしいと言われても、この返事では見ない。見たふりをしない）`;
/**
 * The same where other people can hear: what she saw earlier is not replayed to such a turn, so nothing is said about
 * whether she has seen anything, only that this reply does not look.
 */
export const LOOK_NOT_NOW_GUARD = '[カメラ]（この返事ではカメラで見ていない。「見てみます」と言わない。いま見えているかのように語らない。見てほしいと言われても、この返事では見ない。見たふりをしない）';

/**
 * A voice turn from an app that can look, in which nothing decided a look beforehand: she may choose it herself by
 * saying so. `uncertain`: a model tier did not trust the spoken transcript, so a request in it is not taken as certain.
 */
export const voiceAppLookOfferPrompt = (uncertain: boolean) => `[アプリのカメラで見る]（いまは${SHANNON_OWNER_NAME}が使っているアプリのカメラで一度だけ見られる。この返事ではまだ見ていない。${NOTHING_SEEN}。`
  + (uncertain
    ? `聞き取りが確かでないので、${SHANNON_OWNER_NAME}に見てと言われたように聞こえた時（「これ見れる？」「見て」）は見てよい。`
    : `${SHANNON_OWNER_NAME}に見てと言われた時（「これ見れる？」「見える？」「見て」「カメラ見て」）は必ず見る。`)
  + `いまいる場所、目の前のもの、${SHANNON_OWNER_NAME}の服や見た目の話で自分が見たくなった時も見てよい。`
  + '見る時は、この返事で必ず「カメラで見てみますね」と短く言う。そう言った時だけ、返事のあとで実際に一度見て、見えたものは次の発言で届く。'
  + '見ない時は、見るとも見えたとも言わない。カメラの許可や接続の不具合など、起きていないことを言わない）';
export const VOICE_APP_LOOK_OFFER_PROMPT = voiceAppLookOfferPrompt(false);

/** A text turn in which she may choose the look in the structured reply (`appLook`). */
export const APP_LOOK_OFFER_PROMPT = `[アプリのカメラで見る]（いまは${SHANNON_OWNER_NAME}が使っているアプリのカメラで一度だけ見られる。返答のappLookで選ぶ。`
  + `${SHANNON_OWNER_NAME}に見てと言われた時（「これ見れる？」「見える？」「見て」）は必ず見る。`
  + '見てと言われていなくても、いまいる場所や目の前のものの話（「今〜にいるんだ」「これ美味しそうでしょ？」）で自分が見たくなった時は見てよい。そうでなければ見ない。'
  + `${SHANNON_OWNER_NAME}自身や服・髪・表情の話なら内側のカメラ、それ以外は外側のカメラを選ぶ。${AFTERWARDS}。`
  + `appLookでnoneを選ぶ返事では、見るとも見えたとも言わない。${NOTHING_SEEN}）`;

/** `guarded`: other people can hear; nothing is then said about what she has or has not seen before. */
export const appLookUnavailablePrompt = (reason: AppLookUnavailable, platform: AppLookClient['platform'], guarded = false) =>
  `[アプリのカメラで見る]（いまはアプリのカメラで見られない。本当の理由: ${appLookUnavailableReason(reason, platform)}。この返事では見ない。「見てみます」と言わない。`
  + `${guarded ? 'いま見えているかのように語らない' : NOTHING_SEEN}。見てほしいと言われたら、この理由だけを短く正直に伝える。見たふりをしない。ここに書かれていない原因を作って言わない）`;

/** The reply of a voice turn in which the look is taken. */
export const voiceAppLookPrompt = (asked: boolean, camera: AppLookCamera) => `[アプリのカメラで見る]（${asked
  ? `${SHANNON_OWNER_NAME}に見てと言われたので、`
  : 'いまの話から自分で見たくなったので、'}この返事のあとアプリの${CAMERA_WORDS[camera]}で一度だけ見る。${AFTERWARDS}。カメラの許可や接続の不具合など、起きていないことを言わない）`;
