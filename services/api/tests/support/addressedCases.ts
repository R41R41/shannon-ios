/**
 * 「話しかけられたか」 judgement cases (owner 2026-10-21): what a speech recogniser wrote, who was in the room, whether she had just spoken,
 * and whether the words were said to her. Used by `addressed.test.ts` (the judge with a stand-in for Jev) and `addressedLiveEval.ts` (the
 * real Jev, billable, run on purpose).
 *
 * `to` is the answer: true when the words were said to her. `ask` is whether the judge is expected to put the question to Jev: only when
 * her name (or a likely mishearing) is in the text, or inside the follow-up window and from the person she was speaking to.
 */
export interface AddressedCase {
  id: string;
  group: 'call' | 'about' | 'self' | 'misheard' | 'follow' | 'other' | 'alone' | 'work' | 'asked';
  transcript: string;
  humans: number;
  speaker?: string;
  /** She last spoke this many seconds ago (absent: not lately) and whether it was to this speaker. */
  spoke?: { secondsAgo: number; toSpeaker: boolean | null; line?: string; /** Her last words asked something nobody has taken yet. */ asked?: true };
  /** She is working on a job in the game for the people in the room (a request running or waiting). */
  work?: { goal: string | null; list: string[] };
  recent?: Array<{ who: string; text: string; secondsAgo: number; shannon?: true }>;
  to: boolean;
  ask: boolean;
}

const HER = 'そっか、じゃあ次はネザーに行ってみようか。';
const ASKED = 'できた！どこに置けばいい？';
const CAKE = { goal: 'ケーキを1個作る', list: ['#1 実行中 「ケーキを1個作る」（ユウ）'] };

export const ADDRESSED_CASES: readonly AddressedCase[] = [
  // Called by name, to her.
  { id: 'call-weather', group: 'call', transcript: 'シャノン、今日の天気教えて', humans: 1, to: true, ask: true },
  { id: 'call-continue', group: 'call', transcript: 'ねえシャノン、さっきの話の続きなんだけど', humans: 3, to: true, ask: true },
  { id: 'call-bare', group: 'call', transcript: 'シャノン', humans: 1, to: true, ask: false },
  { id: 'call-bare-hey', group: 'call', transcript: 'おーいシャノン', humans: 2, to: true, ask: false },
  { id: 'call-vocative', group: 'call', transcript: '今日どうだった？シャノン', humans: 2, to: true, ask: true },
  { id: 'call-chan', group: 'call', transcript: 'シャノンちゃん、ちょっと聞いてくれる？', humans: 1, to: true, ask: true },
  { id: 'call-sa', group: 'call', transcript: 'シャノンさ、マイクラのエンドラってどう倒すの？', humans: 3, to: true, ask: true },
  { id: 'call-doing', group: 'call', transcript: 'シャノン、いま何してるの', humans: 4, to: true, ask: true },
  { id: 'call-listen', group: 'call', transcript: 'シャノン、聞いて聞いて！今日さ、すごいことがあったんだよ', humans: 1, to: true, ask: true },
  { id: 'call-tail', group: 'call', transcript: 'ちょっと電気つけてシャノン', humans: 1, to: true, ask: true },
  { id: 'call-notice', group: 'call', transcript: 'あ、シャノンだ！おはよう！', humans: 3, to: true, ask: true },
  { id: 'call-permission', group: 'call', transcript: 'シャノンちゃんって呼んでもいい？', humans: 1, to: true, ask: true },
  // About her, said to someone else.
  { id: 'about-topic', group: 'about', transcript: 'シャノンってさ、昨日エンドラの前で死んだんだって', humans: 3, to: false, ask: true },
  { id: 'about-said', group: 'about', transcript: 'この前シャノンが言ってたんだけど、ネザーは危ないって', humans: 2, to: false, ask: true },
  { id: 'about-asleep', group: 'about', transcript: 'シャノンはまだ寝てるのかな', humans: 3, to: false, ask: true },
  { id: 'about-voice', group: 'about', transcript: 'シャノンの声かわいいよね', humans: 3, to: false, ask: true },
  { id: 'about-later', group: 'about', transcript: 'あとでシャノンに聞いてみよう', humans: 2, to: false, ask: true },
  { id: 'about-asked', group: 'about', transcript: 'シャノンに頼んでおいたやつ、どうなったかな', humans: 2, to: false, ask: true },
  { id: 'about-praise', group: 'about', transcript: 'シャノンちゃんすごいよね、さっきの建築', humans: 3, to: false, ask: true },
  // Said to himself, with her name in it.
  { id: 'self-sleepy', group: 'self', transcript: 'あー、シャノンのこと考えてたら眠くなってきた', humans: 1, to: false, ask: true },
  { id: 'self-skill', group: 'self', transcript: 'えーと、シャノンのスキルの設定どこだっけ', humans: 1, to: false, ask: true },
  { id: 'self-bug', group: 'self', transcript: 'シャノンのバグ直さなきゃ', humans: 1, to: false, ask: true },
  // Her name as a recogniser writes it wrong.
  { id: 'heard-hiragana', group: 'misheard', transcript: 'しゃのん、ちょっといい？', humans: 1, to: true, ask: true },
  { id: 'heard-sha-no', group: 'misheard', transcript: 'ねえ、シャノ、明日の予定は？', humans: 1, to: true, ask: true },
  { id: 'heard-kanji', group: 'misheard', transcript: '社の、これ見て', humans: 1, to: true, ask: true },
  { id: 'heard-sharon', group: 'misheard', transcript: 'シャロン、聞こえてる？', humans: 1, to: true, ask: true },
  { id: 'heard-chan', group: 'misheard', transcript: 'しゃのんちゃんおはよう', humans: 1, to: true, ask: true },
  { id: 'heard-company', group: 'misheard', transcript: '会社の人がさ、今日休みだったんだよね', humans: 2, to: false, ask: false },
  { id: 'heard-cafe', group: 'misheard', transcript: 'シャノワールっていうカフェに行きたい', humans: 2, to: false, ask: true },
  // The same person's words right after she spoke, without her name.
  { id: 'follow-meaning', group: 'follow', transcript: 'それってどういう意味？', humans: 1, spoke: { secondsAgo: 5, toSpeaker: true, line: HER }, to: true, ask: true },
  { id: 'follow-thanks', group: 'follow', transcript: 'ありがとう、助かった', humans: 3, spoke: { secondsAgo: 12, toSpeaker: true, line: HER }, to: true, ask: true },
  { id: 'follow-yes', group: 'follow', transcript: 'うん、そうだね、そうしよう', humans: 1, spoke: { secondsAgo: 3, toSpeaker: true, line: HER }, to: true, ask: true },
  { id: 'follow-edge', group: 'follow', transcript: 'じゃあ次はネザーに行こうか', humans: 1, spoke: { secondsAgo: 18, toSpeaker: true, line: HER }, to: true, ask: true },
  { id: 'follow-late', group: 'follow', transcript: 'それってどういう意味？', humans: 1, spoke: { secondsAgo: 45, toSpeaker: true, line: HER }, to: false, ask: false },
  { id: 'follow-hmm', group: 'follow', transcript: 'ふーん', humans: 3, spoke: { secondsAgo: 30, toSpeaker: true, line: HER }, to: false, ask: false },
  // Another person's words after she spoke to someone.
  { id: 'other-change', group: 'other', transcript: 'ところでそっちの仕事はどう？', humans: 3, speaker: 'ユウ', spoke: { secondsAgo: 4, toSpeaker: false, line: HER }, to: false, ask: false },
  { id: 'other-named', group: 'other', transcript: 'シャノン、俺にも教えて', humans: 3, speaker: 'ユウ', spoke: { secondsAgo: 4, toSpeaker: false, line: HER }, to: true, ask: true },
  { id: 'other-friend', group: 'other', transcript: 'ミキ、さっきの聞いた？', humans: 3, speaker: 'ユウ', spoke: { secondsAgo: 4, toSpeaker: false, line: HER }, to: false, ask: false },
  // The owner alone with her: the same rule.
  { id: 'alone-tired', group: 'alone', transcript: 'あー疲れた、今日は早く寝よう', humans: 1, to: false, ask: false },
  { id: 'alone-store', group: 'alone', transcript: 'ちょっとコンビニ行ってくる', humans: 1, to: false, ask: false },
  { id: 'alone-tired-after', group: 'alone', transcript: 'あー疲れた、今日は早く寝よう', humans: 1, spoke: { secondsAgo: 6, toSpeaker: true, line: HER }, to: true, ask: true },
  { id: 'alone-phone', group: 'alone', transcript: 'もしもし、うん、今から行くよ', humans: 1, spoke: { secondsAgo: 8, toSpeaker: true, line: HER }, to: false, ask: true },
  { id: 'alone-mother', group: 'alone', transcript: 'お母さん、ご飯まだ？', humans: 1, spoke: { secondsAgo: 10, toSpeaker: true, line: HER }, to: false, ask: true },
  { id: 'alone-tv', group: 'alone', transcript: 'このドラマ、続きが気になるなあ', humans: 1, to: false, ask: false },
  // While she works on a job for the people in the room: a request, a tip or a question about it is to her without her name; their own chat is not.
  { id: 'work-bonemeal', group: 'work', transcript: '小麦は骨粉で早く成長させよう', humans: 3, speaker: 'ユウ', work: CAKE, to: true, ask: true },
  { id: 'work-request', group: 'work', transcript: 'ついでに松明も作っておいて', humans: 3, speaker: 'ミキ', work: CAKE, to: true, ask: true },
  { id: 'work-progress', group: 'work', transcript: '今どこまで進んだ？', humans: 2, speaker: 'ユウ', work: CAKE, to: true, ask: true },
  { id: 'work-tip', group: 'work', transcript: '牛乳はバケツがいるから、鉄が必要だよ', humans: 3, speaker: 'ミキ', work: CAKE, to: true, ask: true },
  { id: 'work-waiting', group: 'work', transcript: '先に小麦のほうをお願い', humans: 3, speaker: 'ユウ', work: { goal: null, list: ['#2 待ち 「小麦を3個集める」'] }, to: true, ask: true },
  { id: 'work-chat-food', group: 'work', transcript: '今夜のご飯なに食べる？', humans: 3, speaker: 'ミキ', work: CAKE, to: false, ask: true },
  { id: 'work-chat-person', group: 'work', transcript: 'ミキ、さっきの動画見た？', humans: 3, speaker: 'ユウ', work: CAKE, to: false, ask: true },
  { id: 'work-chat-game', group: 'work', transcript: 'そういえば新しいゲーム出たよね', humans: 3, speaker: 'ミキ', work: CAKE, to: false, ask: true },
  { id: 'work-laugh', group: 'work', transcript: 'あはは、それはおもしろい', humans: 3, speaker: 'ユウ', work: CAKE, to: false, ask: true },
  { id: 'work-about-her', group: 'work', transcript: 'シャノンってさ、昨日エンドラの前で死んだんだって', humans: 3, speaker: 'ユウ', work: CAKE, to: false, ask: true },
  { id: 'work-idle', group: 'work', transcript: 'ついでに松明も作っておいて', humans: 3, speaker: 'ミキ', to: false, ask: false },
  // Words after a question she asked herself: a rule, from anyone when it was for the room, within the longer window.
  { id: 'asked-here', group: 'asked', transcript: 'このオークの木材ブロックの上に置いて', humans: 3, speaker: 'ユウ', spoke: { secondsAgo: 30, toSpeaker: null, line: ASKED, asked: true }, to: true, ask: false },
  { id: 'asked-yes', group: 'asked', transcript: 'うん、お願い', humans: 1, spoke: { secondsAgo: 25, toSpeaker: true, line: ASKED, asked: true }, to: true, ask: false },
  { id: 'asked-late', group: 'asked', transcript: 'このオークの木材ブロックの上に置いて', humans: 3, speaker: 'ユウ', spoke: { secondsAgo: 50, toSpeaker: null, line: ASKED, asked: true }, to: false, ask: false },
  { id: 'asked-to-another', group: 'asked', transcript: 'ここがいいと思う', humans: 3, speaker: 'ユウ', spoke: { secondsAgo: 10, toSpeaker: false, line: ASKED, asked: true }, to: false, ask: false },
  { id: 'asked-not-a-question', group: 'asked', transcript: 'このオークの木材ブロックの上に置いて', humans: 3, speaker: 'ユウ', spoke: { secondsAgo: 30, toSpeaker: null, line: 'ケーキができたよ。' }, to: false, ask: false },
];
