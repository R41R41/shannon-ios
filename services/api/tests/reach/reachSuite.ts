import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuredAutonomyTextModel, dedicatedAutonomyCredential, resolveAutonomyModel } from '../../src/mind/action/ownTime/autonomyTextModel.js';
import { createConfiguredChatModel } from '../../src/infra/models/chatModel.js';
import { estimatedOpenAICostUsd } from '../../src/infra/models/llmUsage.js';
import {
  COGNITION_SCENARIOS, RECALL_SCENARIOS, SKILL_SCENARIOS, TIER_SCENARIOS, WORKSPACE_SCENARIOS, PROACTIVE_SCENARIOS, autonomyDayScenario, buildReachReport, cappedEstimate, compareReachReports, conversationEstimate, estimateTotal,
  isReachReport, pendingEstimate, reachReportMarkdown, runReachScenario, shiritoriScenario, stableFingerprint, threeToolsScenario,
  type ReachDriver, type ReachEstimateLine, type ReachMode, type ReachReport, type ReachRunRecord, type ReachScenarioDefinition,
} from '../../../../packages/evaluation/src/reach/index.js';
import { autonomyDayDriver, scriptedAutonomyDayDriver } from './reachAutonomy.js';
import { REACH_YEN_PER_USD, ReachUsage, scriptedShiritoriDriver, shiritoriDriver } from './reachConversation.js';
import { pendingRegistryDriver, scriptedThreeToolsDriver } from './reachTools.js';
import { cognitionDrivers } from './reachCognition.js';
import { tierDrivers } from './reachTier.js';
import { anthropicApiKey, anthropicPrices, sonnetSettings } from '../../src/infra/models/anthropic/anthropicConfig.js';
import { skillDrivers } from './reachSkills.js';
import { recallDrivers } from './reachRecall.js';
import { mindDrivers } from './reachMind.js';

/**
 * The suite of reach scenarios for one mode, the live estimate, and the result files. The live mode is
 * built only from credentials in the environment, which are passed to the model adapters and never printed.
 */
export const REACH_SCENARIOS: readonly ReachScenarioDefinition[] = [shiritoriScenario, threeToolsScenario, autonomyDayScenario, ...COGNITION_SCENARIOS, ...SKILL_SCENARIOS, ...RECALL_SCENARIOS, ...TIER_SCENARIOS, ...WORKSPACE_SCENARIOS, ...PROACTIVE_SCENARIOS];
type Environment = Readonly<Record<string, string | undefined>>;

/** Drivers are made only for the scenarios a run includes, so nothing a skipped scenario would open is opened. */
export type ReachDriverFactory = () => ReachDriver;

const pending = (reason: string): ReachDriver => async () => ({ pending: reason });

export function scriptedDrivers(): Record<string, ReachDriverFactory> {
  return {
    [shiritoriScenario.id]: () => scriptedShiritoriDriver(),
    [threeToolsScenario.id]: () => scriptedThreeToolsDriver(),
    [autonomyDayScenario.id]: () => scriptedAutonomyDayDriver(),
    // Syzygy ADR-0008 stage 1, scenario suite v1: model-free in both modes.
    ...cognitionDrivers(),
    // Stage 2, suite v2 (skills and recall): model-free in both modes.
    ...skillDrivers(),
    ...recallDrivers(),
    // Stage 3, suite v3 (the workspace): model-free in both modes.
    ...mindDrivers(),
    // Syzygy ADR-0008 stage 2, step 5: the tier set, the Sonnet adapter answered by a script.
    ...tierDrivers('scripted'),
  };
}

/** What a live run would use, by name only: which scenarios have the credential they need. */
export function liveReadiness(environment: Environment) {
  return {
    conversation: Boolean(environment.OPENAI_API_KEY?.trim()),
    autonomy: Boolean(dedicatedAutonomyCredential('google', environment) || dedicatedAutonomyCredential('openai', environment)),
    sonnet: anthropicApiKey(environment) !== null,
  };
}

/** The price settings a live run is charged and estimated with: values and model ids, never a credential. */
export function livePriceInputs(environment: Environment): { conversation: Record<string, string>; autonomy: Record<string, string> } {
  const input = environment.SHANNON_LLM_INPUT_USD_PER_MILLION?.trim();
  const output = environment.SHANNON_LLM_OUTPUT_USD_PER_MILLION?.trim();
  const table = environment.SHANNON_AUTONOMY_MODEL_PRICES_JSON?.trim();
  let tableModels = 'unset';
  if (table) {
    try { tableModels = Object.keys(JSON.parse(table) as Record<string, unknown>).sort().join(',') || 'empty'; } catch { tableModels = 'unreadable'; }
  }
  return {
    conversation: { chatPrices: input && output ? `${input}/${output} USD per million` : 'built-in table' },
    autonomy: { priceTableModels: tableModels, priceTable: table ? stableFingerprint(table) : 'fail-safe' },
  };
}

export function liveDrivers(environment: Environment): Record<string, ReachDriverFactory> {
  const ready = liveReadiness(environment);
  const prices = livePriceInputs(environment);
  const table = environment.SHANNON_AUTONOMY_MODEL_PRICES_JSON?.trim();
  return {
    [shiritoriScenario.id]: () => {
      if (!ready.conversation) return pending('credential: OPENAI_API_KEY is not set');
      const usage = new ReachUsage();
      return shiritoriDriver(createConfiguredChatModel(environment, usage), { usage, inputs: prices.conversation });
    },
    [threeToolsScenario.id]: () => pendingRegistryDriver(),
    [autonomyDayScenario.id]: () => {
      if (!ready.autonomy) return pending('credential: no dedicated SHANNON_AUTONOMY_*_API_KEY is set');
      const model = configuredAutonomyTextModel(environment);
      const resolved = (purpose: 'planning' | 'prose') => resolveAutonomyModel(purpose, [], id => model.canUse(id)) ?? 'none';
      return autonomyDayDriver(model, {
        ...(table ? { environment: { SHANNON_AUTONOMY_MODEL_PRICES_JSON: table } } : {}),
        inputs: { planningModel: resolved('planning'), proseModel: resolved('prose'), ...prices.autonomy },
      });
    },
    // Model-free: the same drivers, nothing spent.
    ...cognitionDrivers(),
    ...skillDrivers(),
    ...recallDrivers(),
    // Stage 3, suite v3 (the workspace): model-free in both modes.
    ...mindDrivers(),
    // The tier set against Anthropic (the tuning harness); pending without the key.
    ...tierDrivers('live', environment),
  };
}

export async function runReachSuite(
  drivers: Record<string, ReachDriverFactory>,
  context: { mode: ReachMode; revision: string; only?: readonly string[]; now?: () => string },
): Promise<ReachReport> {
  const now = context.now ?? (() => new Date().toISOString());
  const runs: ReachRunRecord[] = [];
  for (const definition of REACH_SCENARIOS) {
    if (context.only?.length && !context.only.some(prefix => definition.id.startsWith(prefix))) continue;
    runs.push(await runReachScenario(definition, drivers[definition.id]!(), { mode: context.mode, startedAt: now(), clock: () => performance.now() }));
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
    } else if (TIER_SCENARIOS.some(scenario => scenario.id === run.scenarioId)) {
      const prices = anthropicPrices(sonnetSettings(environment).model);
      lines.push(unready(conversationEstimate({
        scenarioId: run.scenarioId, calls: run.cost.calls, promptCharacters: run.cost.promptCharacters,
        inputUsdPerMillion: prices.input, outputUsdPerMillion: prices.output, outputTokensPerCall: 2_000,
      }, REACH_YEN_PER_USD), ready.sonnet));
    } else if ([...COGNITION_SCENARIOS, ...SKILL_SCENARIOS, ...RECALL_SCENARIOS, ...WORKSPACE_SCENARIOS, ...PROACTIVE_SCENARIOS].some(scenario => scenario.id === run.scenarioId)) {
      lines.push({ scenarioId: run.scenarioId, yen: 0, basis: 'model-free in both modes: no model is called' });
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
  let compared: string | null = null;
  if (basePath) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(readFileSync(basePath, 'utf8')); } catch { parsed = null; }
    // A baseline the owner named must be valid; a latest file of an older format is set aside and replaced.
    if (isReachReport(parsed)) { baseline = parsed; compared = basePath; }
    else if (options.baselinePath) throw new Error(`REACH_BASELINE_INVALID: ${basePath}`);
  }
  const comparison = baseline ? compareReachReports(baseline, report) : undefined;
  const stem = `${report.generatedAt.replace(/[:.]/gu, '-')}-${report.revision.slice(0, 12)}-${report.mode}`;
  const json = join(directory, `${stem}.json`);
  const markdown = join(directory, `${stem}.md`);
  const text = reachReportMarkdown(report, comparison);
  writeFileSync(json, `${JSON.stringify({ ...report, ...(comparison ? { comparison } : {}) }, null, 2)}\n`);
  writeFileSync(markdown, text);
  if (options.full) writeFileSync(latest, `${JSON.stringify(report, null, 2)}\n`);
  return { json, markdown, text, compared };
}
