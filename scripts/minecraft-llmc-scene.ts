// The scene replay of the LLM-centric Minecraft body (design mb-llm-centric 4, "確かめ方 1"; owner 2026-10-21: the main model is chosen
// after Haiku, Sonnet and Opus solve the same scenes). Each scene is one decision, built exactly as a live decision of the mode
// (`minecraftLlmcScene.ts`: the same tools, cached instructions and live state), asked of each model; nothing reaches a body.
//
//   ANTHROPIC_API_KEY=… node --import tsx scripts/minecraft-llmc-scene.ts <scenes.json> [--models=haiku,sonnet,opus] [--repeat=1] [--out=answers.json]
//   ANTHROPIC_API_KEY=… node --import tsx scripts/minecraft-llmc-scene.ts --count <scenes.json>
//
// `--count` asks the provider's count_tokens for each scene's live state (and its map alone) beside the head's estimate, to calibrate
// `MAP_CHARS_PER_TOKEN` and `LLMC_LIVE_TOKENS` (`minecraftLlmcLive.ts`). A scenes file is a JSON array of `LlmcScene`
// (`scripts/minecraft-trials/llmc-scenes.example.json` shows the shape). Prints one line a scene and model: the time, the hands, whether
// the head would send the act to the body, and the cost; `--out` writes every answer whole.
import { readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicFcaModel, type AnthropicFcaUsage } from '../services/api/src/infra/models/anthropic/anthropicFcaModel.js';
import { LLMC_SYSTEM_APPENDIX } from '../services/api/src/surfaces/minecraft/minecraftKnowledge.js';
import { sceneDecision, sceneInput, type LlmcScene } from '../services/api/src/surfaces/minecraft/minecraftLlmcScene.js';
import { llmcLiveTokens } from '../services/api/src/surfaces/minecraft/minecraftLlmcLive.js';

const MODELS: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = args.find(arg => !arg.startsWith('--'));
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
if (!file || !apiKey) {
  console.error('usage: ANTHROPIC_API_KEY=… node --import tsx scripts/minecraft-llmc-scene.ts <scenes.json> [--models=haiku,sonnet,opus] [--count]');
  process.exit(2);
}
const scenes = JSON.parse(readFileSync(file, 'utf8')) as LlmcScene[];

async function count(): Promise<void> {
  const client = new Anthropic({ apiKey });
  for (const scene of scenes) {
    const live = sceneInput(scene).transient as Record<string, unknown>;
    const tokens = async (text: string) => (await client.messages.countTokens({ model: MODELS.sonnet!,
      messages: [{ role: 'user', content: text }] })).input_tokens;
    const map = typeof live.map === 'string' ? live.map : '';
    const [whole, mapOnly, empty] = await Promise.all([tokens(JSON.stringify(live)), tokens(map || '.'), tokens('.')]);
    console.log(`${scene.name}: live ${whole - empty} tokens (estimate ${llmcLiveTokens(live)}), map ${mapOnly - empty} tokens for ${map.length} characters`
      + ` (${(map.length / Math.max(1, mapOnly - empty)).toFixed(2)} characters a token)`);
  }
}

async function replay(): Promise<void> {
  const names = (flag('models') ?? 'haiku,sonnet,opus').split(',').map(name => MODELS[name.trim()] ?? name.trim());
  const repeat = Math.max(1, Number(flag('repeat') ?? 1));
  const answers: unknown[] = [];
  for (const name of names) {
    const usage: AnthropicFcaUsage[] = [];
    const model = createAnthropicFcaModel({ model: name, apiKey: apiKey!, recordUsage: value => { usage.push(value); }, systemAppendix: LLMC_SYSTEM_APPENDIX });
    for (const scene of scenes) {
      for (let round = 0; round < repeat; round += 1) {
        const before = usage.length;
        try {
          const answer = await sceneDecision(scene, model);
          const cost = usage.slice(before).reduce((sum, item) => sum + item.estimatedCostUsd, 0);
          answers.push({ model: name, round, ...answer, costUsd: cost });
          console.log(`${scene.name}\t${name}\t${answer.ms}ms\t${answer.decision}\thands=${answer.hands.join(',') || '-'}`
            + `\t${answer.problem ? `refused: ${answer.problem}` : 'ok'}\t$${cost.toFixed(4)}`);
        } catch (error) {
          answers.push({ model: name, round, scene: scene.name, error: String(error) });
          console.log(`${scene.name}\t${name}\terror ${String(error)}`);
        }
      }
    }
  }
  const out = flag('out');
  if (out) writeFileSync(out, JSON.stringify(answers, null, 2));
}

await (args.includes('--count') ? count() : replay());
