import type { ShannonEmotionKind, ShannonEmotionOverrideReason } from './types.js';

/**
 * Forced emotion overrides. They exist so that play never displaces support,
 * and they must stay proportionate: a word alone is a suspicion, not a verdict.
 * Every rule here reads the speaker's words only, never Shannon's own reply.
 */

/** Unambiguous danger to a person. Any one of these overrides. */
const HARD_EMERGENCY = /(?:死にたい|自殺|殺され|息ができない|息が出来ない|意識がない|意識が無い|出血|火事|救急|119番|110番)/u;
/** Words that mean an emergency only in a personal-danger context. */
const SOFT_EMERGENCY = /(?:助けて|緊急|危険)/u;
const NEGATED_DANGER = /(?:危険(?:は|じゃ|では|性は)?(?:ない|なさ|ありません|なく)|緊急(?:じゃ|では)(?:ない|ありません)|助けて(?:くれた|もらった|あげ))/u;
const PERSONAL_DANGER_CONTEXT = /(?:今すぐ|誰か|倒れ|事故|襲われ|怪我|けが|痛い|苦しい|動けない|閉じ込め|溺れ|燃えて|血が|追われ|脅され)/u;
const WORK_CONTEXT = /(?:バグ|コード|ビルド|エラー|実装|デプロイ|テスト|宿題|仕事|タスク|設定|アプリ|資料|締め切り|締切|レビュー|プログラム|関数|サーバー|メール)/u;

const HARD_GRIEF = /(?:亡くな|死別|お葬式|葬儀|余命|重い病気|喪失|流産)/u;
const DEATH_WORD = /(?:死んだ|死んじゃった|死んでしまった)/u;
const LOVED_ONE = /(?:父|母|祖父|祖母|おじい|おばあ|兄|姉|弟|妹|妻|夫|子ども|子供|息子|娘|家族|友達|友人|親友|恋人|彼女|彼氏|犬|猫|ペット|先生|先輩)/u;

/** Facts where a wrong or joking answer costs the owner something real. */
const HIGH_STAKES_FACT = /(?:健康|病気|症状|薬|金銭|お金|送金|支払|振込|請求|個人情報|人物情報)/u;
/** Facts that must be stated straight, but that do not make a cheerful mood wrong. */
const PLAIN_FACT = /(?:記憶|覚えて|進捗|完了|配布|デプロイ|安全)/u;

/** Kinds whose humour depends on saying something untrue or concealing intent. */
const DECEPTIVE_PLAY = new Set<ShannonEmotionKind>(['harmlessFalsehood', 'plotting', 'mischievous', 'deadpan']);

export function supportOverrideFor(
  transcript: string,
): Extract<ShannonEmotionOverrideReason, 'emergency' | 'grief'> | null {
  if (HARD_EMERGENCY.test(transcript)) return 'emergency';
  if (SOFT_EMERGENCY.test(transcript) && !NEGATED_DANGER.test(transcript) && !WORK_CONTEXT.test(transcript)) {
    // A bare cry for help is an emergency; inside a longer sentence it needs a danger context.
    const bare = Array.from(transcript.replace(/[\s、。！？!?…ー〜]/gu, '')).length <= 8;
    if (bare || PERSONAL_DANGER_CONTEXT.test(transcript)) return 'emergency';
  }
  if (HARD_GRIEF.test(transcript)) return 'grief';
  if (DEATH_WORD.test(transcript) && LOVED_ONE.test(transcript)) return 'grief';
  return null;
}

/**
 * Whether accuracy must replace play for this turn. Health, money and personal
 * information always do. Memory, progress and completion do only for humour
 * that works by saying something untrue; pride or teasing may stay.
 */
export function accuracyOverrideApplies(
  combined: string,
  primary: ShannonEmotionKind,
  playful: boolean,
): boolean {
  if (!playful) return false;
  if (HIGH_STAKES_FACT.test(combined)) return true;
  return PLAIN_FACT.test(combined) && DECEPTIVE_PLAY.has(primary);
}
