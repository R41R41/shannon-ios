import { REACH_STOP_CAUSE_LABEL, type ReachReport, type ReachRunRecord, type ReachStop } from './format.js';

export type ReachChange = 'regression' | 'improvement' | 'unchanged' | 'incomparable' | 'added' | 'removed';

export interface ReachCheckDelta {
  id: string;
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface ReachScenarioDelta {
  scenarioId: string;
  change: ReachChange;
  /** Why two runs cannot be compared: another scenario version, another mode, or a pending or invalid side. */
  reason?: string;
  before: ReachRunRecord['status'] | null;
  after: ReachRunRecord['status'] | null;
  stopBefore: ReachStop | null;
  stopAfter: ReachStop | null;
  checks: readonly ReachCheckDelta[];
  costYenDelta: number | null;
  wallMillisecondsDelta: number | null;
}

export interface ReachComparison {
  baseline: { revision: string; mode: string; generatedAt: string };
  candidate: { revision: string; mode: string; generatedAt: string };
  scenarios: readonly ReachScenarioDelta[];
  regressions: readonly string[];
  improvements: readonly string[];
}

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Version-to-version comparison. A scenario is a regression when it passed and now fails, or when it
 * fails in both and any check's score went down; an improvement the other way round. Records with a
 * different definition fingerprint or mode are never compared.
 */
export function compareReachReports(baseline: ReachReport, candidate: ReachReport): ReachComparison {
  const before = new Map(baseline.runs.map(run => [run.scenarioId, run]));
  const after = new Map(candidate.runs.map(run => [run.scenarioId, run]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const scenarios = ids.map(id => scenarioDelta(id, before.get(id) ?? null, after.get(id) ?? null));
  return {
    baseline: header(baseline), candidate: header(candidate), scenarios,
    regressions: scenarios.filter(item => item.change === 'regression').map(item => item.scenarioId),
    improvements: scenarios.filter(item => item.change === 'improvement').map(item => item.scenarioId),
  };
}

function header(report: ReachReport) {
  return { revision: report.revision, mode: report.mode, generatedAt: report.generatedAt };
}

function scenarioDelta(id: string, before: ReachRunRecord | null, after: ReachRunRecord | null): ReachScenarioDelta {
  const empty = { checks: [], costYenDelta: null, wallMillisecondsDelta: null };
  const base = { scenarioId: id, before: before?.status ?? null, after: after?.status ?? null, stopBefore: before?.stop ?? null, stopAfter: after?.stop ?? null };
  if (!before) return { ...base, ...empty, change: 'added' };
  if (!after) return { ...base, ...empty, change: 'removed' };
  const reason = before.definitionFingerprint !== after.definitionFingerprint ? 'definition-changed'
    : before.mode !== after.mode ? 'mode-differs'
      : before.status === 'pending' || after.status === 'pending' ? 'pending'
        : before.status === 'invalid' || after.status === 'invalid' ? 'invalid' : null;
  const ids = [...new Set([...before.checks.map(check => check.id), ...after.checks.map(check => check.id)])];
  const checks = ids.map(checkId => {
    const left = before.checks.find(check => check.id === checkId && !check.skipped)?.score ?? null;
    const right = after.checks.find(check => check.id === checkId && !check.skipped)?.score ?? null;
    return { id: checkId, before: left, after: right, delta: left !== null && right !== null ? round(right - left) : null };
  });
  const deltas = { checks, costYenDelta: round(after.cost.yen - before.cost.yen, 2), wallMillisecondsDelta: after.wallMilliseconds - before.wallMilliseconds };
  if (reason) return { ...base, ...deltas, change: 'incomparable', reason };
  const worse = checks.some(check => (check.delta ?? 0) < 0);
  const better = checks.some(check => (check.delta ?? 0) > 0);
  const change: ReachChange = before.status === 'passed' && after.status === 'failed' ? 'regression'
    : before.status === 'failed' && after.status === 'passed' ? 'improvement'
      : worse && !better ? 'regression' : better && !worse ? 'improvement' : 'unchanged';
  return { ...base, ...deltas, change };
}

function stopText(stop: ReachStop | null): string {
  return stop ? `${REACH_STOP_CAUSE_LABEL[stop.cause]} (${stop.cause}: ${stop.detail})` : '—';
}

/** The report as Markdown, with the comparison to a baseline when one is given. Counts and codes only. */
export function reachReportMarkdown(report: ReachReport, comparison?: ReachComparison): string {
  const lines = [
    `# Shannon reach measures (${report.mode})`,
    '',
    `- Revision: \`${report.revision}\``,
    `- Generated: ${report.generatedAt}`,
    `- Scenario set: \`${report.scenarioSetFingerprint}\``,
    `- Totals: passed ${report.totals.passed}, failed ${report.totals.failed}, pending ${report.totals.pending}, invalid ${report.totals.invalid}; cost ${report.totals.costYen} yen`,
    '',
    '| Scenario | Status | Stopped at | Checks passed | Cost (yen) | Tokens in/out | Wall (s) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.runs.map(run => {
      const judged = run.checks.filter(check => !check.skipped);
      const passed = judged.filter(check => check.passed).length;
      return `| ${run.scenarioId} v${run.scenarioVersion} | ${run.status}${run.reason ? ` (${run.reason})` : ''} | ${stopText(run.stop)} | ${passed}/${judged.length} | ${run.cost.yen}${run.cost.measured ? '' : ' (simulated)'} | ${run.cost.inputTokens}/${run.cost.outputTokens} | ${round(run.wallMilliseconds / 1000, 1)} |`;
    }),
  ];
  for (const run of report.runs.filter(item => item.checks.length)) {
    lines.push('', `## ${run.scenarioId}`, '', '| Check | Score | Result | Cause | Detail |', '| --- | --- | --- | --- | --- |');
    for (const check of run.checks) {
      const result = check.skipped ? 'skipped' : check.passed ? 'pass' : 'fail';
      lines.push(`| ${check.id} | ${check.score} | ${result} | ${check.cause ?? ''} | ${check.detail ?? ''} |`);
    }
    const metrics = Object.entries(run.metrics);
    if (metrics.length) lines.push('', metrics.map(([key, value]) => `\`${key}\`=${value}`).join(', '));
  }
  if (comparison) {
    lines.push('', `## Compared with \`${comparison.baseline.revision}\` (${comparison.baseline.generatedAt})`, '',
      `- Regressions: ${comparison.regressions.join(', ') || 'none'}`,
      `- Improvements: ${comparison.improvements.join(', ') || 'none'}`, '',
      '| Scenario | Change | Before | After | Stop before | Stop after | Score changes | Cost Δ (yen) |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const item of comparison.scenarios) {
      const moved = item.checks.filter(check => check.delta).map(check => `${check.id} ${check.delta! > 0 ? '+' : ''}${check.delta}`).join('; ');
      lines.push(`| ${item.scenarioId} | ${item.change}${item.reason ? ` (${item.reason})` : ''} | ${item.before ?? '—'} | ${item.after ?? '—'} | ${stopText(item.stopBefore)} | ${stopText(item.stopAfter)} | ${moved || '—'} | ${item.costYenDelta ?? '—'} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
