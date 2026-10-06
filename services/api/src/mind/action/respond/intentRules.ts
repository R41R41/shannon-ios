import { promiseGuarded } from './promiseRules.js';

/**
 * Ordinary ways of stating a continuing goal that the original verb list
 * missed (「…を今月中に配信したい」「完成させたい」「実装したいです」). A goal changes
 * every later reply and may be raised again by Shannon, so a passing wish
 * (「ラーメン食べたい」) or a plan for today or tomorrow is deliberately left out.
 */
const WANT = /たい(?:です|んだ|んです)?$/u;
/** 「…したいと思います」 is a polite statement of intent, not a guess. */
const POLITE_TAIL = /(?<=たい)と思(?:います|っています|っている|ってる)$/u;
const NEAR_TERM = /今日|今夜|今晩|明日|明晩|あした|明後日|あさって|明々後日|しあさって|[月火水木金土日]曜|\d{1,3}日後|あとで|後で|今から|今すぐ|さっき/u;
const NEGATED = /たくない|ないで|やめたい|中止したい|つもりはない/u;
const QUESTION = /(?:[?？]|か|かな|かしら|っけ)$/u;
const BUILD = /(?:実装|改善|統合|構築|作成|開発|修正|整理|実現|完成|配信|公開|リリース|出荷|達成|習得|移行|導入|設計|執筆|出版|合格|卒業|取得|制作|製作|刷新|自動化|最適化|収益化|独立|起業|転職|完走|克服|勉強|学習|マスター)(?:し|させ)たい|(?:進め|育て|仕上げ|終わらせ|作り上げ|書き上げ|身につけ|間に合わせ|続け|習慣にし|できるようになり|学び)たい|になりたい/u;
const MADE_THING = /(?:[A-Za-z]{2,}|機能|アプリ|サービス|サイト|ゲーム|曲|動画|資料|仕組み|環境|ツール|システム|作品|会社|チーム|習慣|プロダクト|ライブラリ|画面|モード|ボット|エージェント|ホームページ|ブログ|ポートフォリオ)[^を]{0,12}を(?:作|つく|創)りたい/u;
const DEADLINE = /今月中|今年中|年内|今週中|来月中|来年中|年末まで|来月まで|来年まで|来週まで|\d{1,2}月(?:末|中)?まで|今年こそ|いつか|将来|\d+年以内|\d+(?:か|ヶ|カ)月以内/u;
const HABIT = /毎日|毎朝|毎晩|毎週|毎月|週に?\d+回|習慣/u;
/** A wish about the body or the moment is not a goal even with 「いつか」. */
const PASSING_WISH = /(?:食べ|飲み|寝|眠り|帰り|休み|会い)たい/u;

/** A plan for today or tomorrow is a promise, and a conditional wish is not yet a goal. */
export function isNearTermOrConditionalWish(text: string): boolean {
  return NEAR_TERM.test(text) || /^(?:もし|仮に|例えば|たとえば)|たら|れば/u.test(text);
}

export function widenedGoalStatement(message: string): string | null {
  const sentences = message.match(/[^。！？!?]+[。！？!?]?/gu) ?? [];
  for (const raw of sentences) {
    const sentence = raw.replace(/[。.!！]+$/u, '').trim();
    if (sentence.length < 6 || sentence.length > 280 || /[?？]$/u.test(raw.trim())) continue;
    const core = sentence.replace(POLITE_TAIL, '');
    if (!WANT.test(core) || QUESTION.test(core) || NEGATED.test(core) || NEAR_TERM.test(core) || promiseGuarded(core)) continue;
    if (BUILD.test(core) || MADE_THING.test(core)
      || ((HABIT.test(core) || DEADLINE.test(core)) && !PASSING_WISH.test(core))) return sentence;
  }
  return null;
}
