// The first plan and the first decision on starts the head has never seen (the skill-port plan #6, 2026-11-03): a start with no village, on a beach by the
// sea, in a snowy forest, at a cave mouth. For each world the planner is asked as the run asks it (`ownFirstPlanSystem`, the scan, the readiness), the
// plan is read the way the run reads it, and the first decision is asked of a decision model with that plan. What is printed: the plan's nodes, whether
// food, iron, a bow and arrows, and the gate are in it, every coordinate in the answers that is not in the world given, and the first act's hands.
//
//   cd services/api && ANTHROPIC_API_KEY=… node --import tsx scripts/minecraft-llmc-start-scenes.ts tests/fixtures/minecraft/unknown-seed-starts.json
//     [--plan=opus] [--decide=sonnet] [--repeat=1] [--cap=2] [--out=answers.json] [--dry]
import { readFileSync, writeFileSync } from 'node:fs';
import { createAnthropicFcaModel, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { LLMC_SYSTEM_APPENDIX } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { firstPlanInput, planFromAnswer } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { ownFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { sceneDecision } from '../src/surfaces/minecraft/minecraftLlmcScene.js';
import { configuredMinecraftLlmc } from '../src/wiring/minecraftLlmcConfiguration.js';

const MODELS: Record<string, string> = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = args.find(arg => !arg.startsWith('--'));
const dry = args.includes('--dry');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
if (!file || (!dry && !apiKey)) {
  console.error('usage: [ANTHROPIC_API_KEY=…] node --import tsx scripts/minecraft-llmc-start-scenes.ts <starts.json> [--plan=opus] [--decide=sonnet] [--repeat=1] [--dry]');
  process.exit(2);
}
interface Start { name: string; goal: string; world: Record<string, unknown> }
const starts = JSON.parse(readFileSync(file, 'utf8')) as Start[];
const COORD = /-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/gu;
const foreign = (answer: unknown, world: unknown): string[] => {
  const given = JSON.stringify(world).replace(/\s+/gu, '');
  return [...new Set((JSON.stringify(answer).match(COORD) ?? []).map(item => item.replace(/\s+/gu, '')).filter(item => !given.includes(item)))];
};
const has = (text: string, pattern: RegExp) => pattern.test(text);

async function run(): Promise<void> {
  const planName = MODELS[flag('plan') ?? 'opus'] ?? flag('plan')!, decideName = MODELS[flag('decide') ?? 'sonnet'] ?? flag('decide')!;
  const repeat = Math.max(1, Number(flag('repeat') ?? 1)), cap = Number(flag('cap') ?? Infinity);
  const usage: AnthropicFcaUsage[] = [];
  const record = (value: AnthropicFcaUsage) => { usage.push(value); };
  const llmc = configuredMinecraftLlmc({ SHANNON_ANTHROPIC_API_KEY: apiKey!, SHANNON_MINECRAFT_LLMC_PLAN_MODEL: planName }, { recordUsage: record }, { log: () => undefined });
  if (!llmc?.planner) throw new Error('no planner');
  const decider = createAnthropicFcaModel({ model: decideName, apiKey: apiKey!, recordUsage: record, systemAppendix: LLMC_SYSTEM_APPENDIX });
  const rows: unknown[] = [];
  const spent = () => usage.reduce((sum, item) => sum + item.estimatedCostUsd, 0);
  for (const start of starts) {
    for (let round = 0; round < repeat; round += 1) {
      if (spent() > cap) { console.log(`STOP: spent $${spent().toFixed(3)} > cap $${cap}`); return; }
      const input = firstPlanInput(start.goal, start.world, { scan: true, readiness: true });
      try {
        const began = performance.now();
        const answer = await llmc.planner(ownFirstPlanSystem(), input, new AbortController().signal);
        const planMs = Math.round(performance.now() - began);
        const tree = planFromAnswer(answer, new Date(0).toISOString());
        const text = JSON.stringify(tree?.nodes ?? answer);
        const flags = { food: has(text, /"kind":"food"|食料|狩|肉/u), iron: has(text, /"kind":"iron"|鉄/u), bow: has(text, /弓|矢|bow|arrow/iu),
          portal: has(text, /"kind":"portal"|ネザー|ゲート/u) };
        const titles = (tree?.nodes ?? []).map(node => `${node.kind}:${node.title}`);
        console.log(`PLAN ${start.name} r${round} ${planMs}ms nodes=${titles.length} ${JSON.stringify(flags)} foreign=${JSON.stringify(foreign(answer, start.world))}`);
        console.log(titles.map(title => `   ${title}`).join('\n'));
        const decided = await sceneDecision({ name: start.name, goal: start.goal, world: start.world, ...(tree ? { plan: tree } : {}), elapsedMinutes: 0 }, decider);
        const calls = JSON.stringify(decided.calls).slice(0, 700);
        console.log(`DECIDE ${start.name} r${round} ${decided.ms}ms ${decided.decision} hands=${decided.hands.join(',') || '-'} ${decided.problem ? `refused: ${decided.problem}` : 'ok'} foreign=${JSON.stringify(foreign(decided.calls, start.world))}\n   ${calls}`);
        rows.push({ start: start.name, round, planMs, flags, titles, foreign: foreign(answer, start.world), decided, answer });
      } catch (error) {
        console.log(`${start.name} r${round} error ${String(error)}`);
      }
      if (flag('out')) writeFileSync(flag('out')!, JSON.stringify(rows, null, 1));
    }
  }
  console.log(`TOTAL spent $${spent().toFixed(4)}`);
}

if (dry) for (const start of starts) console.log(`## ${start.name} planInput=${firstPlanInput(start.goal, start.world, { scan: true, readiness: true }).length} chars`);
else await run();
