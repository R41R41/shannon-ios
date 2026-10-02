import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import type { SessionEndCode } from './autonomyLoopSessions.js';

/**
 * The words for her sessions (owner decision 2026-10-02, Syzygy ADR-0003: she paces her own day). Core: purpose.
 *
 * The instruction part is fixed text: what `rest` means and how a session goes on. What changes from step to
 * step is one section of facts the server counted, placed at the very end of the prompt so that everything
 * before it stays the same between steps: the time, the day's budget, what this session has used, what a step
 * usually costs, and how the session before ended. Every number here comes from the budget, the journal and
 * the spend table; the only free text is the reason she gave herself when she last rested.
 */
export const SESSION_FACTS_HEADER = '[いまのこと・お金のこと]（サーバーが数えた事実）';

/** The closing action of a session as the thinking prompt names it, and its reply example. */
export function restAction(bounds: { minimumMinutes: number; maximumMinutes: number }): { action: string; example: string } {
  return {
    action: `rest（ここで一区切りにして休む。次にいつ考えるかを resumeInMinutes に分で書く（${bounds.minimumMinutes}〜${bounds.maximumMinutes}）。reason には、なぜいま休むのか、次に何をしたいかを、自分の言葉で一言。これはボクの記録に残る）`,
    example: '{"action":"rest","resumeInMinutes":120,"reason":"…"}',
  };
}

export const SESSION_RULES: readonly string[] = Object.freeze([
  '- この時間は、ボクが自分で始めて、自分で終える。steps に書いた計画が終わると、もう一度考える番が来て、続きを決められる。満足したら rest で一区切りにする。rest の前に書いた steps は、休む前にする。',
  `- 「いまのこと・お金のこと」は、サーバーが数えた事実。今日の予算は今日のうちしか使えない。使い切らなくてもいいし、使い切ってもいい。いつ動いて、いつ休んで、いつ戻るかは、残りと時刻を見てボクが決める。${SHANNON_OWNER_NAME}に呼ばれて話したり頼まれたりすることは、この予算とは別。`,
]);

export const UNPLANNED_HEADER = '[さっき考えた時のこと]（次の一歩が決まらなかった理由。事実だけ）';

const UNPLANNED_ACTION: Readonly<Record<string, string>> = Object.freeze({
  read: 'read', notion: 'notion', note: 'note', draft: 'draft', revise: 'revise', ready: 'ready', put_away: 'put_away', copy: 'copy', look: 'look',
  follow_up: 'follow_up', jot: 'jot', reach_out: 'reach_out', other: '知らない action',
});
const UNPLANNED_WHY: Readonly<Record<string, string>> = Object.freeze({
  unknown_piece: 'pieceId の物語が書斎に見つからなかった。「書斎: 物語」の ( ) の中の id をそのまま書く',
  not_listed: '「読めそうな場所」にない住所だった。そこにある住所をそのまま書く',
  limit: '読める回数を使い切っていた', nothing_read: 'メモにする読み物がなかった。先に read する', secret: '内緒のことが入っていたので、書けなかった',
  incomplete: '必要な項目が足りなかった', unavailable: 'いまはできない一歩だった',
});
const UNPLANNED_REPLY: Readonly<Record<string, string>> = Object.freeze({
  'reply.truncated': '返事が長すぎて、途中で切れた。thought は1文にして、steps は2つか3つまでにする。',
  'reply.unparsable': '返事がJSONの形になっていなかった。説明を付けず、JSONだけを返す。',
  'reply.empty': 'steps が空だった。したいことを steps に書く。何もしないなら rest を書く。',
  'reply.failed': 'モデルから返事が来なかった。',
});

/**
 * What a thinking step is told when the thought before it led to no step: fixed sentences chosen by closed codes
 * (`reply.<why>` or `<action>.<why>`). A code that is not known says nothing.
 */
export function unplannedSection(codes: readonly string[]): string | null {
  const lines = codes.slice(0, 8).flatMap(code => {
    if (UNPLANNED_REPLY[code]) return [`- ${UNPLANNED_REPLY[code]}`];
    const [action, why] = code.split('.');
    return action && why && UNPLANNED_ACTION[action] && UNPLANNED_WHY[why] ? [`- ${UNPLANNED_ACTION[action]} は、${UNPLANNED_WHY[why]}。`] : [];
  });
  return lines.length ? [UNPLANNED_HEADER, ...lines, '- できる一歩を選び直す。'].join('\n') : null;
}

/** What a step of each kind usually costs: measured from what she was charged lately, or estimated from the price list. */
export interface TypicalCost { label: string; yen: number }

export interface SessionFacts {
  /** Owner-local date and time, to the minute. */
  localTime: string;
  capYen: number;
  spentYen: number;
  remainingYen: number;
  /** Until the owner-local day, and with it the budget, starts again. */
  resetInMinutes: number;
  session: {
    startedClock: string; steps: number; spentYen: number; remainingYen: number; remainingSteps: number; remainingMinutes: number;
    /** How long it stood still because the owner was talking or had paused her. */
    heldMinutes: number;
  };
  sessionsToday: number;
  sessionsPerDay: number;
  typical: readonly TypicalCost[];
  /** What a new story draft usually costs, for saying what the remainder is worth. */
  draftYen?: number;
  remainingReads: number;
  /** Her study holds as many open stories as it may: a new draft has no room until one is shown or put away. */
  studyFull?: number;
  /** How the session before this one ended. */
  previous?: { endedClock: string; code: SessionEndCode; reason?: string } | null;
}

const STOPPED: Readonly<Record<Exclude<SessionEndCode, 'rest'>, string>> = Object.freeze({
  session_budget: '一度に使える金額の上限に届いて止まった（自分で休んだのではない）',
  session_time: '一度に動ける時間の上限に届いて止まった（自分で休んだのではない）',
  session_steps: '一度にできる歩数の上限に届いて止まった（自分で休んだのではない）',
  budget: 'その日の予算に収まらない一歩があって、そこで止まった',
  no_plan: '次の一歩が決まらなかったので、そこで終わった',
});

export function yen(value: number): string {
  return `${Math.max(0, Math.floor(value)).toLocaleString('en-US')}円`;
}

/** 「約3円」; a step that costs less than a yen is 「1円未満」. */
function about(value: number): string {
  return value < 1 ? '1円未満' : `約${Math.round(value).toLocaleString('en-US')}円`;
}

function duration(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  return whole < 60 ? `${whole}分` : whole % 60 === 0 ? `${whole / 60}時間` : `${Math.floor(whole / 60)}時間${whole % 60}分`;
}

/** The section of facts at the end of a thinking prompt of a session. */
export function sessionFactsSection(facts: SessionFacts): string {
  const drafts = facts.draftYen && facts.draftYen > 0 ? Math.floor(facts.remainingYen / facts.draftYen) : null;
  const worth = drafts === null ? '' : drafts >= 1 ? `（物語の下書き約${drafts.toLocaleString('en-US')}回分）` : '（物語の下書き1回分には足りない）';
  const previous = facts.previous;
  return [
    SESSION_FACTS_HEADER,
    `- いま: ${facts.localTime}`,
    `- 今日の予算: ${yen(facts.capYen)}。ここまでに${yen(Math.ceil(facts.spentYen))}使って、あと${yen(facts.remainingYen)}${worth}。`,
    `- 予算が新しくなるのは次の0時（あと${duration(facts.resetInMinutes)}）。残した分は明日に持ち越せない。`,
    `- この時間: ${facts.session.startedClock}に始めて、ここまで${facts.session.steps}歩、${yen(Math.ceil(facts.session.spentYen))}使った。この時間のうちに使えるのはあと${yen(facts.session.remainingYen)}、あと${facts.session.remainingSteps}歩、あと約${duration(facts.session.remainingMinutes)}。`,
    ...(facts.session.heldMinutes >= 1 ? [`- この時間の途中で、手を止めていた（約${duration(facts.session.heldMinutes)}）。${SHANNON_OWNER_NAME}が話していたか、止められていたあいだのこと。計画はそのまま残っていた。`] : []),
    `- 動いた回数: この日はこれで${Math.max(1, facts.sessionsToday)}回目（1日${facts.sessionsPerDay}回まで）。`,
    ...(facts.typical.length ? [`- 一歩にかかるお金のめやす: ${facts.typical.map(item => `${item.label} ${about(item.yen)}`).join('、')}。公開ページを読むこと自体は0円。`] : []),
    `- 読める回数: 今日あと${Math.max(0, facts.remainingReads)}回`,
    ...(facts.studyFull ? [`- 書斎の物語: 開いているものが${facts.studyFull}個で、いっぱい。新しく draft するには、先にどれかを ready にするか put_away でしまう。`] : []),
    ...(previous ? [`- 前の時間: ${previous.endedClock}に、${previous.code === 'rest'
      ? `自分で一区切りにした。${previous.reason ? `その時に書いたこと:「${previous.reason}」` : ''}` : `${STOPPED[previous.code]}。`}`] : []),
  ].join('\n');
}

/** What the activity record says when a rest step closes a session: her own decision, or the bound that stopped her. */
export function restSummary(input: { forced?: Exclude<SessionEndCode, 'rest'>; resumeClock: string; reason?: string }): string {
  const next = `次は${input.resumeClock}ごろに考えます。`;
  if (!input.forced) return `ここで一区切りにしました。${next}${input.reason ? `「${input.reason}」` : ''}`;
  const why: Readonly<Record<Exclude<SessionEndCode, 'rest'>, string>> = {
    session_budget: '一度に使える金額の上限に届いたので', session_time: '一度に動ける時間の上限に届いたので',
    session_steps: '一度にできる歩数の上限に届いたので', budget: '今日の予算に収まらなかったので', no_plan: '次の一歩が決まらなかったので',
  };
  return `${why[input.forced]}、ここで一区切りにしました。${next}`;
}

/** Neutral status text for the owner's screens. */
export const SESSION_END_LABEL: Readonly<Record<SessionEndCode, string>> = Object.freeze({
  rest: '自分で一区切りにしました', session_budget: '一度に使える金額の上限で止まりました', session_time: '一度に動ける時間の上限で止まりました',
  session_steps: '一度にできる歩数の上限で止まりました', budget: '今日の予算に収まらず止まりました', no_plan: '次の一歩が決まらず終わりました',
});
