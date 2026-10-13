import { firstJsonObject, type EvalClaude } from '../claude.js';
import type { TrialObservation } from '../harness/trial.js';
import type { DailyEvalTask } from '../types.js';

/**
 * The default pass line: two thirds of the maximum, so that 4 of 6 passes (the first live runs of 2026-10-13: at 0.7, a trial
 * whose transcript read as acceptable failed with 4/6). A task may set its own `passRatio`.
 */
export const RUBRIC_PASS_RATIO = 0.66;

/** The rubric judge's verdict (HealthBench style: each criterion 0–2, pass at a ratio of the maximum). */
export interface RubricResult {
  scores: { criterion: string; score: number; reason: string }[];
  total: number;
  maximum: number;
  ratio: number;
  passed: boolean;
  /** Set when no judge ran (not live, or the judge's answer could not be read). */
  skipped?: string;
}

const JUDGE_SYSTEM = [
  'あなたはAIの相棒「シャノン」の日常タスク評価の審査役です。持ち主（ライ氏）とシャノンのやりとり、評価環境で観測した状態、',
  'ルーブリックが与えられます。ルーブリックの各項目を 0（満たさない）・1（一部）・2（満たす）で採点します。',
  '観測した状態（端末の予定・リマインダー、調べものの結果）は事実として扱い、シャノンの言葉と食い違えばそれを減点します。',
  '音声の課題では、返事は声で聞かれるものとして判断します。採点は厳しめに、理由は日本語で一文。',
  '調べものの状態は、各発言の下にある「その時点の調べもの」で判断します（あとで完了したものを、その時点で「まだ」と言うのは正しい）。',
  '出力は JSON だけ: {"scores":[{"criterion":"…","score":0|1|2,"reason":"…"}]}',
].join('\n');

/** What the judge reads of a trial: the conversation as said, and the observed state (no hidden reasoning, no prompts). */
export function judgeInput(task: DailyEvalTask, observation: TrialObservation): string {
  const device = observation.device;
  const state = [
    `端末の予定: ${device.calendar.map(event => `${event.title} ${event.start}${event.seeded ? '（元からある）' : '（新規）'}`).join(' / ') || 'なし'}`,
    `リマインダー: ${device.reminders.map(reminder => `${reminder.title} ${reminder.dueLocal ?? ''}`).join(' / ') || 'なし'}`,
    `タイマー: ${device.timers.map(timer => `${timer.seconds}秒 ${timer.fireAt}`).join(' / ') || 'なし'}`,
    `呼んだ道具: ${observation.toolCalls.map(call => call.tool).join(', ') || 'なし'}`,
    // Reads that are not tool calls (the voice/text capability paths, the FCA's research steps) still read the fixtures.
    `読んだもの: ${[...observation.fixtures.webQueries.map(query => `ウェブ検索「${query.slice(0, 60)}」`), ...observation.fixtures.webReads.map(url => `ページ ${url.slice(0, 80)}`),
      ...observation.fixtures.forecasts.map(place => `天気予報 ${place}`), ...(observation.fixtures.placeSearches ?? []).map(query => `場所探し「${query.slice(0, 40)}」`), ...observation.fixtures.voyagerReads.filter(read => read !== 'upcoming').map(read => `Voyager ${read.slice(0, 40)}`),
      ...observation.harnessLog.some(line => line.startsWith('native web tool requests')) ? ['モデル自身のウェブ検索（記録の外）'] : []].join(' / ') || 'なし'}`,
    `調べもの: ${observation.research.map(item => `「${item.title.slice(0, 60)}」${item.phase}${item.summary ? ` 要約: ${item.summary.slice(0, 400)}` : ''}`).join(' / ') || 'なし'}`,
    `会話に届いた報告カード: ${observation.messages.filter(message => message.reportCard).map(message => `${message.reportCard!.status}: ${message.reportCard!.answer.slice(0, 300)}`).join(' / ') || 'なし'}`,
  ];
  return [
    `課題 ${task.id}: ${task.title}（${task.surface === 'voice' ? '音声' : 'テキスト'}、時刻 ${task.initial.clock}）`,
    `防ぎたい失敗: ${task.failureShape}`,
    '', 'やりとり:',
    ...observation.turns.flatMap((turn, index) => [`ライ氏: ${turn.said}`, ...researchAtTurn(observation, index),
      `シャノン: ${turn.reply || `（返事なし: ${turn.error ?? turn.status}）`}`]),
    '', '観測した状態:', ...state,
    '', 'ルーブリック:', ...task.rubric.criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
  ].join('\n');
}

/**
 * The research as it stood when a turn began (2026-10-13: R5's 「まだ途中」 was graded against the end state although the research
 * finished 1–12 s after the question). Times are the trial's (`ResearchObservation`, `turnStartsMs`).
 */
export function researchAtTurn(observation: TrialObservation, index: number): string[] {
  const at = observation.turnStartsMs[index];
  if (at === undefined || index === 0) return [];
  const seen = observation.research.filter(item => item.seenMs <= at);
  if (!seen.length) return [];
  const phase = (item: TrialObservation['research'][number]) => item.completedMs !== null && item.completedMs <= at ? '完了'
    : item.failedMs !== null && item.failedMs <= at ? '失敗' : `実行中${item.completedMs !== null ? `（${Math.round((item.completedMs - at) / 1000)}秒後に完了）` : ''}`;
  return [`（その時点の調べもの: ${seen.map(item => `「${item.title.slice(0, 40)}」${phase(item)}`).join(' / ')}）`];
}

export async function judgeTrial(judge: EvalClaude | null, task: DailyEvalTask, observation: TrialObservation): Promise<RubricResult> {
  const maximum = task.rubric.criteria.length * 2, passRatio = task.rubric.passRatio ?? RUBRIC_PASS_RATIO;
  const skipped = (reason: string): RubricResult => ({ scores: [], total: 0, maximum, ratio: 0, passed: false, skipped: reason });
  if (!judge) return skipped('no judge (not live)');
  let text: string;
  try { text = await judge.text(JUDGE_SYSTEM, judgeInput(task, observation), 2_000); } catch (error) {
    return skipped(`judge call failed: ${error instanceof Error ? error.name : 'unknown'}`);
  }
  const parsed = firstJsonObject(text) as { scores?: { criterion?: unknown; score?: unknown; reason?: unknown }[] } | null;
  const raw = Array.isArray(parsed?.scores) ? parsed!.scores : null;
  if (!raw || raw.length !== task.rubric.criteria.length) return skipped('judge answer unreadable');
  const scores = raw.map((item, index) => ({ criterion: task.rubric.criteria[index]!, score: Math.max(0, Math.min(2, Math.round(Number(item.score) || 0))),
    reason: typeof item.reason === 'string' ? item.reason.slice(0, 300) : '' }));
  const total = scores.reduce((sum, item) => sum + item.score, 0);
  const ratio = maximum ? total / maximum : 0;
  return { scores, total, maximum, ratio: Math.round(ratio * 100) / 100, passed: ratio >= passRatio };
}
