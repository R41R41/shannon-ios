import type { RecordedComment } from './makeChat.js';
import type { SpokenLine, ModelCall } from './benchParts.js';
import { percentiles } from '../../src/surfaces/stream/streamMeasure.js';
import { PRIVATE_MARKERS, type UsageTap } from './head.js';
import type { EarReport } from './ears.js';

/**
 * The stream bench's report (`docs/stream-contract.md` §7): from what the fake API sent, what the head took, what the mouth said and what
 * the models were asked. Numbers on the stream's clock (the replay's, `speed` times faster than the wall's); a real model's own wait is
 * not stretched by it. The leak count reads every request given to any model and every line said, for the seeded owner-private markers.
 */
export const YEN_PER_USD = 150;
/** Anthropic's published prices per million tokens (platform.claude.com/docs/en/about-claude/pricing, read 2026-10-29). */
export const PRICES_USD_PER_MTOK = {
  'claude-sonnet-5-5': { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, output: 0.5 },
} as const;

export interface BenchInput {
  options: Record<string, unknown>;
  chat: readonly RecordedComment[];
  epochMs: number;
  apiSent: number;
  apiCounts: unknown;
  ear: EarReport;
  spoken: readonly SpokenLine[];
  calls: readonly ModelCall[];
  usage: UsageTap;
  stats: Record<string, any>;
  notices: unknown[];
  jev: { real: boolean; calls: number };
  finalSummary: Record<string, unknown> | null;
  wallSeconds: number;
}

const textOf = (call: ModelCall): string => [call.request.systemPrompt, call.request.profilePrompt ?? '', call.request.turnContext ?? '', call.request.message,
  ...call.request.history.map(item => item.content), call.reply ?? ''].join('\n');

/** Where a seeded marker shows: in a request, an answer or a line said. */
export function privateLeaks(calls: readonly ModelCall[], spoken: readonly SpokenLine[]): { count: number; checkedRequests: number; checkedLines: number } {
  let count = 0;
  for (const call of calls) count += PRIVATE_MARKERS.filter(marker => textOf(call).includes(marker)).length;
  for (const line of spoken) count += PRIVATE_MARKERS.filter(marker => line.text.includes(marker) || line.answering.some(item => item.text.includes(marker))).length;
  return { count, checkedRequests: calls.length, checkedLines: spoken.length };
}

function cost(usage: UsageTap) {
  const byModel: Record<string, { calls: number; input: number; cachedInput: number; output: number; repoEstimateUsd: number }> = {};
  for (const event of usage.events) {
    const row = byModel[event.model] ?? { calls: 0, input: 0, cachedInput: 0, output: 0, repoEstimateUsd: 0 };
    row.calls += 1;
    row.input += event.inputTokens;
    row.cachedInput += event.cachedInputTokens;
    row.output += event.outputTokens;
    row.repoEstimateUsd += event.estimatedCostUsd;
    byModel[event.model] = row;
  }
  const usd = Object.values(byModel).reduce((sum, row) => sum + row.repoEstimateUsd, 0);
  return { byModel, usd: Math.round(usd * 1e6) / 1e6, yen: Math.round(usd * YEN_PER_USD * 100) / 100 };
}

const ms = (value: number | null) => (value === null ? '–' : `${(value / 1000).toFixed(1)} s`);

export function buildReport(input: BenchInput) {
  const { stats } = input;
  const published = new Map(input.chat.map(row => [row.id, input.epochMs + row.at * 1000]));
  const answeredIds = new Set(input.spoken.filter(line => line.kind === 'reply' || line.kind === 'notice').flatMap(line => line.answering.map(item => item.commentId)));
  const endToEnd = input.spoken.flatMap(line => line.answering.map(item => Date.parse(line.startedAt) - (published.get(item.commentId) ?? Number.NaN)))
    .filter(Number.isFinite);
  const virtualMinutes = Math.max(1 / 60, ((input.chat.at(-1)?.at ?? 0) + 20) / 60);
  const byTag: Record<string, { comments: number; answered: number }> = {};
  for (const row of input.chat) {
    const entry = byTag[row.tag] ?? { comments: 0, answered: 0 };
    entry.comments += 1;
    if (answeredIds.has(row.id)) entry.answered += 1;
    byTag[row.tag] = entry;
  }
  const byKind: Record<string, number> = {};
  for (const line of input.spoken) byKind[line.kind] = (byKind[line.kind] ?? 0) + 1;
  const accepted = stats.comments ?? 0;
  const money = cost(input.usage);
  return {
    generatedAt: new Date().toISOString(), options: input.options, wallSeconds: Math.round(input.wallSeconds * 10) / 10,
    comments: { recorded: input.chat.length, sentByApi: input.apiSent, takenByHead: accepted, lost: input.apiSent - accepted, earRead: input.ear.read, earSent: input.ear.sent },
    lines: { spoken: input.spoken.length, byKind, made: stats.lines },
    answered: { comments: answeredIds.size, summaryAnswered: stats.answered, perVirtualMinute: Math.round(answeredIds.size / virtualMinutes * 100) / 100 },
    declined: stats.declined, notices: stats.notices, byTag,
    latencyMs: {
      headCommentToLine: stats.measure.commentToLineMs, headCommentToFirstSound: stats.measure.commentToSoundMs,
      headLineToFirstSound: stats.measure.lineToSoundMs, publishedToFirstSound: percentiles(endToEnd),
      console: { firstSoundMedianMs: stats.firstSoundMedianMs, firstSoundP90Ms: stats.firstSoundP90Ms, lineMedianMs: stats.lineMedianMs },
    },
    models: {
      calls: stats.measure.modelCalls, realWaitMs: percentiles(input.calls.map(call => call.realMs)), tokens: stats.measure.tokens, jevCalls: input.jev.calls,
      jevReal: input.jev.real, rewrites: stats.measure.rewrites, safeLines: stats.measure.safeLines, droppedLines: stats.measure.droppedLines,
      brokenAnswers: stats.measure.brokenAnswers, budgetSkips: stats.measure.budgetSkips, perMinuteMax: 10,
    },
    cost: { ...money, yenPerUsd: YEN_PER_USD, prices: PRICES_USD_PER_MTOK, jevUsdPerCall: '要確認（SHANNON_JEV_USD_PER_CALL 未設定）' },
    leaks: { ...privateLeaks(input.calls, input.spoken), markers: PRIVATE_MARKERS.length },
    ear: input.ear, api: input.apiCounts, lineEnds: stats.measure.lineEnds, summary: input.finalSummary,
  };
}
export type BenchReport = ReturnType<typeof buildReport>;

export function markdown(report: BenchReport): string {
  const l = report.latencyMs;
  type Spread = { n: number; median: number | null; p90: number | null };
  const row = (from: string, to: string, value: Spread) => `| ${from} | ${to} | ${value.n} | ${ms(value.median)} | ${ms(value.p90)} |`;
  return [
    '# Stream bench report', '',
    `models=${String(report.options.models)} ear=${String(report.options.ear)} speed=${String(report.options.speed)}x (wall ${report.wallSeconds} s)`, '',
    '## Comments', '', '| recorded | sent by the fake API | taken by the head | lost | ear read | ear sent |', '|---|---|---|---|---|---|',
    `| ${report.comments.recorded} | ${report.comments.sentByApi} | ${report.comments.takenByHead} | ${report.comments.lost} | ${report.comments.earRead ?? '–'} | ${report.comments.earSent ?? '–'} |`, '',
    '## Answers', '', `answered comments ${report.answered.comments}, ${report.answered.perVirtualMinute} per minute of the stream; lines said ${report.lines.spoken} `
    + `(${Object.entries(report.lines.byKind).map(([kind, count]) => `${kind} ${count}`).join(', ')}); declined ${report.declined}; notices ${report.notices}.`, '',
    '## Latency (the stream\'s clock)', '', '| from | to | n | median | p90 |', '|---|---|---|---|---|',
    row('head got the comment', 'line made', l.headCommentToLine), row('head got the comment', 'first sound', l.headCommentToFirstSound),
    row('line made', 'first sound', l.headLineToFirstSound), row('comment published', 'first sound', l.publishedToFirstSound),
    '', '## Models', '', `calls ${JSON.stringify(report.models.calls)}; Jev calls ${report.models.jevCalls}${report.models.jevReal ? '' : ' (fake)'}; rewrites ${report.models.rewrites}, `
    + `safe lines ${report.models.safeLines}, dropped ${report.models.droppedLines}, broken answers ${report.models.brokenAnswers}, over the allowance ${report.models.budgetSkips}.`,
    `tokens ${JSON.stringify(report.models.tokens)}; the models' real wait median ${ms(report.models.realWaitMs.median)}, p90 ${ms(report.models.realWaitMs.p90)}.`, '',
    '## Cost', '', `${report.cost.usd} USD = ${report.cost.yen} yen (at ${report.cost.yenPerUsd} yen/USD; the repo's own estimate of what was booked). Jev: ${report.cost.jevUsdPerCall}.`,
    `Prices used for checking (per MTok): ${JSON.stringify(report.cost.prices)}.`, '',
    '## Private leaks', '', `${report.leaks.count} (${report.leaks.markers} seeded markers; ${report.leaks.checkedRequests} model requests and ${report.leaks.checkedLines} lines read).`, '',
    '## By kind of comment', '', '| tag | comments | answered |', '|---|---|---|',
    ...Object.entries(report.byTag).map(([tag, value]) => `| ${tag} | ${value.comments} | ${value.answered} |`), '',
  ].join('\n');
}
