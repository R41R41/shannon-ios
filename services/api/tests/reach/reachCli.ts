import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReachReports, isReachReport, reachReportMarkdown } from '../../../../packages/evaluation/src/reach/index.js';
import { reachUsageReport, usageReportMarkdown } from './reachUsageReport.js';
import { estimateText, liveDrivers, liveEstimate, liveReadiness, runReachSuite, scriptedDrivers, writeReachReport } from './reachSuite.js';

/**
 * `scripts/reach-measures.sh` lands here.
 *
 *   run [--only <prefix,...>] [--out <dir>] [--baseline <report.json>]          model-free, free, deterministic
 *   run --live [--yes] [--only ...] [--out ...] [--baseline ...]                prints the estimate; spends only with --yes
 *   compare <baseline.json> <candidate.json>                                     Markdown comparison to stdout
 *   usage <copy-of-shannon.sqlite> [--days 30] [--until <iso>] [--scope owner]  counts and rates from use, read-only
 *
 * Output is content-free: ids, statuses, counts, costs. Credentials are read from the environment by the
 * model adapters and never printed.
 */
const repositoryRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const DEFAULT_OUT = join(repositoryRoot, 'artifacts', 'reach');

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Options that take a value; their value is never a positional argument. */
const VALUE_OPTIONS = new Set(['--revision', '--only', '--out', '--baseline', '--days', '--until', '--scope']);

/** The arguments that are neither a `--flag` nor the value of one. */
function positionals(args: string[]): string[] {
  return args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && args[index - 1]!.startsWith('--') && VALUE_OPTIONS.has(args[index - 1]!)));
}

async function run(args: string[]): Promise<number> {
  const live = args.includes('--live');
  const revision = option(args, '--revision') ?? 'unknown';
  const only = option(args, '--only')?.split(',').map(item => item.trim()).filter(Boolean);
  const out = resolve(option(args, '--out') ?? DEFAULT_OUT);
  const baseline = option(args, '--baseline');
  // The model-free pass always runs first: it is the regression check, and the basis of the live estimate.
  const scripted = await runReachSuite(scriptedDrivers(), { mode: 'scripted', revision, ...(only ? { only } : {}) });
  if (!live) {
    const written = writeReachReport(scripted, out, { ...(baseline ? { baselinePath: baseline } : {}), full: !only });
    process.stdout.write(written.text);
    console.log(`\nWrote ${written.json}\n      ${written.markdown}${written.compared ? `\nCompared with ${written.compared}` : ''}`);
    return scripted.totals.failed + scripted.totals.invalid > 0 ? 1 : 0;
  }
  if (scripted.totals.failed + scripted.totals.invalid > 0) {
    process.stdout.write(reachReportMarkdown(scripted));
    console.error('\nThe model-free pass failed, so the live run is refused. Fix the build first. Nothing was spent.');
    return 1;
  }
  // The repository's .env is read only now, after the model-free pass, so its settings never shape that pass.
  const envFile = join(repositoryRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const ready = liveReadiness(process.env);
  console.log(`Live mode. Credentials present: conversation=${ready.conversation ? 'yes' : 'no'}, her own time=${ready.autonomy ? 'yes' : 'no'}.`);
  console.log('Estimated cost of this live run (errs high):');
  console.log(estimateText(liveEstimate(scripted, process.env)));
  if (!args.includes('--yes')) {
    console.log('\nNothing was spent. Run again with --yes to make the billable calls.');
    return 0;
  }
  const report = await runReachSuite(liveDrivers(process.env), { mode: 'live', revision, ...(only ? { only } : {}) });
  const written = writeReachReport(report, out, { ...(baseline ? { baselinePath: baseline } : {}), full: !only });
  process.stdout.write(written.text);
  console.log(`\nSpent ${report.totals.costYen} yen.\nWrote ${written.json}\n      ${written.markdown}${written.compared ? `\nCompared with ${written.compared}` : ''}`);
  return report.totals.failed + report.totals.invalid > 0 ? 1 : 0;
}

function compare(args: string[]): number {
  const [left, right] = positionals(args);
  if (!left || !right) throw new Error('usage: compare <baseline.json> <candidate.json>');
  const read = (path: string) => {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isReachReport(parsed)) throw new Error(`not a reach report: ${path}`);
    return parsed;
  };
  const candidate = read(right);
  const comparison = compareReachReports(read(left), candidate);
  process.stdout.write(reachReportMarkdown(candidate, comparison));
  return comparison.regressions.length ? 1 : 0;
}

function usage(args: string[]): number {
  const [path] = positionals(args);
  if (!path) throw new Error('usage: usage <copy-of-shannon.sqlite> [--days 30] [--until <iso>] [--scope owner]');
  const report = reachUsageReport(path, {
    days: Math.max(1, Math.min(365, Number(option(args, '--days') ?? 30) || 30)),
    until: option(args, '--until') ?? new Date().toISOString(),
    scopeKey: option(args, '--scope') ?? 'owner',
  });
  const out = resolve(option(args, '--out') ?? DEFAULT_OUT);
  mkdirSync(out, { recursive: true });
  const stem = join(out, `usage-${report.window.until.replace(/[:.]/gu, '-')}`);
  writeFileSync(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${stem}.md`, usageReportMarkdown(report));
  process.stdout.write(usageReportMarkdown(report));
  console.log(`Wrote ${stem}.json\n      ${stem}.md`);
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
try {
  const code = command === 'run' ? await run(rest) : command === 'compare' ? compare(rest) : command === 'usage' ? usage(rest) : (() => {
    console.error('usage: reach-measures.sh run [--live [--yes]] | compare <a.json> <b.json> | usage <copy.sqlite>');
    return 2;
  })();
  process.exitCode = code;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'reach measures failed');
  process.exitCode = 1;
}
