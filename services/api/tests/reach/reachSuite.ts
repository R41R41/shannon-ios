import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuredAutonomyTextModel, dedicatedAutonomyCredential } from '../../src/autonomyTextModel.js';
import { createConfiguredChatModel } from '../../src/chatModel.js';
import { estimatedOpenAICostUsd } from '../../src/llmUsage.js';
import {
  autonomyDayScenario, buildReachReport, cappedEstimate, compareReachReports, conversationEstimate, estimateTotal,
  isReachReport, pendingEstimate, reachReportMarkdown, runReachScenario, shiritoriScenario, threeToolsScenario,
  type ReachDriver, type ReachEstimateLine, type ReachMode, type ReachReport, type ReachRunRecord, type ReachScenarioDefinition,
} from '../../../../packages/evaluation/src/reach/index.js';
import { autonomyDayDriver, scriptedAutonomyDayDriver } from './reachAutonomy.js';
import { REACH_YEN_PER_USD, ReachUsage, scriptedShiritoriDriver, shiritoriDriver } from './reachConversation.js';
import { pendingRegistryDriver, scriptedThreeToolsDriver } from './reachTools.js';

/**
 * The suite of reach scenarios for one mode, the live estimate, and the result files. The live mode is
 * built only from credentials in the environment, which are passed to the model adapters and never printed.
 */
export const REACH_SCENARIOS: readonly ReachScenarioDefinition[] = [shiritoriScenario, threeToolsScenario, autonomyDayScenario];
type Environment = Readonly<Record<string, string | undefined>>;

const pending = (reason: string): ReachDriver => async () => ({ pending: reason });

export function scriptedDrivers(): Record<string, ReachDriver> {
  return {
    [shiritoriScenario.id]: scriptedShiritoriDriver(),
    [threeToolsScenario.id]: scriptedThreeToolsDriver(),
    [autonomyDayScenario.id]: scriptedAutonomyDayDriver(),
  };
}

/** What a live run would use, by name only: which scenarios have the credential they need. */
export function liveReadiness(environment: Environment) {
  return {
    conversation: Boolean(environment.OPENAI_API_KEY?.trim()),
    autonomy: Boolean(dedicatedAutonomyCredential('google', environment) || dedicatedAutonomyCredential('openai', environment)),
  };
}

export function liveDrivers(environment: Environment): Record<string, ReachDriver> {
  const ready = liveReadiness(environment);
  const usage = new ReachUsage();
  const prices = environment.SHANNON_AUTONOMY_MODEL_PRICES_JSON?.trim();
  return {
    [shiritoriScenario.id]: ready.conversation ? shiritoriDriver(createConfiguredChatModel(environment, usage), usage) : pending('credential: OPENAI_API_KEY is not set'),
    [threeToolsScenario.id]: pendingRegistryDriver(),
    [autonomyDayScenario.id]: ready.autonomy
      ? autonomyDayDriver(configuredAutonomyTextModel(environment), prices ? { environment: { SHANNON_AUTONOMY_MODEL_PRICES_JSON: prices } } : {})
      : pending('credential: no dedicated SHANNON_AUTONOMY_*_API_KEY is set'),
  };
}

export async function runReachSuite(
  drivers: Record<string, ReachDriver>,
  context: { mode: ReachMode; revision: string; only?: readonly string[]; now?: () => string },
): Promise<ReachReport> {
  const now = context.now ?? (() => new Date().toISOString());
  const runs: ReachRunRecord[] = [];
  for (const definition of REACH_SCENARIOS) {
    if (context.only?.length && !context.only.some(prefix => definition.id.startsWith(prefix))) continue;
    runs.push(await runReachScenario(definition, drivers[definition.id]!, { mode: context.mode, startedAt: now(), clock: () => performance.now() }));
  }
  return buildReachReport(runs, { revision: context.revision, mode: context.mode, generatedAt: now() });
}

/**
 * The estimate of a live run, from a model-free pass of the same scenarios. A scenario whose credential
 * is missing is estimated all the same (what it would cost once the credential is set) and says so.
 */
export function liveEstimate(scripted: ReachReport, environment: Environment): ReachEstimateLine[] {
  const ready = liveReadiness(environment);
  const model = environment.SHANNON_LLM_MODEL?.trim() || 'gpt-5.6-luna';
  const usdPerMillion = (input: number, output: number) => estimatedOpenAICostUsd(model, { inputTokens: input, outputTokens: output, cachedInputTokens: 0, totalTokens: input + output }, environment);
  const unready = (line: ReachEstimateLine, present: boolean) => present ? line : { ...line, basis: `${line.basis}; no credential, so it would be pending now` };
  const lines: ReachEstimateLine[] = [];
  for (const run of scripted.runs) {
    if (run.scenarioId === shiritoriScenario.id) {
      lines.push(unready(conversationEstimate({
        scenarioId: run.scenarioId, calls: run.cost.calls, promptCharacters: run.cost.promptCharacters,
        inputUsdPerMillion: usdPerMillion(1_000_000, 0), outputUsdPerMillion: usdPerMillion(0, 1_000_000),
      }, REACH_YEN_PER_USD), ready.conversation));
    } else if (run.scenarioId === threeToolsScenario.id) {
      lines.push(pendingEstimate(run.scenarioId, 'registry not on main'));
    } else if (run.scenarioId === autonomyDayScenario.id) {
      lines.push(unready(cappedEstimate(run.scenarioId, autonomyDayScenario.limits.budgetYen!), ready.autonomy));
    }
  }
  return lines;
}

export function estimateText(lines: readonly ReachEstimateLine[]): string {
  return [...lines.map(line => `  ${line.scenarioId}: ${line.yen} yen (${line.basis})`), `  total: about ${estimateTotal(lines)} yen`].join('\n');
}

/**
 * Writes the report (JSON and Markdown) and compares it with a baseline, or with the previous full report
 * of its mode. A full run (no `--only`) becomes that mode's latest.
 */
export function writeReachReport(report: ReachReport, directory: string, options: { baselinePath?: string; full: boolean }): { json: string; markdown: string; text: string; compared: string | null } {
  mkdirSync(directory, { recursive: true });
  const latest = join(directory, `latest-${report.mode}.json`);
  const basePath = options.baselinePath ?? (existsSync(latest) ? latest : null);
  let baseline: ReachReport | null = null;
  if (basePath) {
    const parsed: unknown = JSON.parse(readFileSync(basePath, 'utf8'));
    if (!isReachReport(parsed)) throw new Error(`REACH_BASELINE_INVALID: ${basePath}`);
    baseline = parsed;
  }
  const comparison = baseline ? compareReachReports(baseline, report) : undefined;
  const stem = `${report.generatedAt.replace(/[:.]/gu, '-')}-${report.revision.slice(0, 12)}-${report.mode}`;
  const json = join(directory, `${stem}.json`);
  const markdown = join(directory, `${stem}.md`);
  const text = reachReportMarkdown(report, comparison);
  writeFileSync(json, `${JSON.stringify({ ...report, ...(comparison ? { comparison } : {}) }, null, 2)}\n`);
  writeFileSync(markdown, text);
  if (options.full) writeFileSync(latest, `${JSON.stringify(report, null, 2)}\n`);
  return { json, markdown, text, compared: basePath };
}
