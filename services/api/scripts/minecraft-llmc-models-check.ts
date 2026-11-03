// The models a Minecraft body task's decisions would use under an environment, and one real decision through the main one (11/3, S3: run60 runs every
// decision on Opus). `--model=claude-opus-5-5` is SHANNON_MINECRAFT_LLMC_MODEL; the plan model and the escalation are the environment's defaults.
//
//   cd services/api && ANTHROPIC_API_KEY=… node --import tsx scripts/minecraft-llmc-models-check.ts <scenes.json> [--model=claude-opus-5-5] [--dry]
import { readFileSync } from 'node:fs';
import type { AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { sceneDecision, type LlmcScene } from '../src/surfaces/minecraft/minecraftLlmcScene.js';
import { configuredMinecraftLlmc, decidedBy, llmcModelRouter, llmcModelNames } from '../src/wiring/minecraftLlmcConfiguration.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = args.find(arg => !arg.startsWith('--'));
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
const env = { ...(flag('model') ? { SHANNON_MINECRAFT_LLMC_MODEL: flag('model') } : {}) };
console.log(`names ${JSON.stringify(llmcModelNames(env))}`);
if (!args.includes('--dry')) {
  if (!file || !apiKey) { console.error('usage: ANTHROPIC_API_KEY=… … <scenes.json> [--model=…] [--dry]'); process.exit(2); }
  const usage: AnthropicFcaUsage[] = [];
  const llmc = configuredMinecraftLlmc({ SHANNON_ANTHROPIC_API_KEY: apiKey, ...env }, { recordUsage: value => { usage.push(value); } }, { log: () => undefined });
  if (!llmc) throw new Error('no llmc');
  const scene = (JSON.parse(readFileSync(file, 'utf8')) as LlmcScene[])[0]!;
  // Router: an overworld step with the plan not in a strong stage, and one in the End.
  for (const dimension of ['overworld', 'the_nether', 'the_end']) {
    console.log(`router ${dimension}: ${decidedBy(llmc, llmcModelRouter(llmc.models, null, undefined, 't', () => dimension))}`);
  }
  const answer = await sceneDecision(scene, llmc.models.main);
  console.log(`decision ${answer.decision} hands=${answer.hands.join(',') || '-'} model(s) billed: ${[...new Set(usage.map(item => item.model))].join(',')}`);
}
