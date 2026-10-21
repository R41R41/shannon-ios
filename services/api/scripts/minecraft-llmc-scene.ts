// The scene replay of the LLM-centric Minecraft body (design mb-llm-centric 4, "確かめ方 1"; owner 2026-10-21: the main model is chosen
// after Haiku, Sonnet and Opus solve the same scenes). Each scene is one decision, built exactly as a live decision of the mode
// (`minecraftLlmcScene.ts`: the same tools, cached instructions and live state), asked of each model; nothing reaches a body.
//
// It lives in services/api (r2, 2026-10-22): from the repository's root `@anthropic-ai/sdk` did not resolve where the API is deployed
// (only services/api has it), and the replay of 2026-10-21 had to add a link by hand.
//
//   cd services/api && ANTHROPIC_API_KEY=… node --import tsx scripts/minecraft-llmc-scene.ts <scenes.json> [--models=haiku,sonnet,opus]
//     [--repeat=1] [--scenes=a,b] [--out=answers.json] [--cap=1.6] [--spent=0]
//   cd services/api && ANTHROPIC_API_KEY=… node --import tsx scripts/minecraft-llmc-scene.ts --count <scenes.json>
//
// `--count` asks the provider's count_tokens for each scene's live state (and its map alone) beside the head's count (`llmcTokens`,
// minecraftLlmcLive.ts), to check its fit. A scenes file is a JSON array of `LlmcScene` (`scripts/minecraft-trials/llmc-scenes.example.json`
// at the repository's root shows the shape). A replay prints one line a scene and model: the time, the hands, whether the head would send
// the act to the body (and what it put into shape), the cost and the tokens (new input, cache read and write, output); `--out` writes every
// answer whole after each one. It stops before a call once the spending (with `--spent` already spent) passes `--cap` dollars.
import { readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicFcaModel, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { LLMC_SYSTEM_APPENDIX } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { sceneDecision, sceneInput, type LlmcScene } from '../src/surfaces/minecraft/minecraftLlmcScene.js';
import { llmcLiveTokens, llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';

const MODELS: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = args.find(arg => !arg.startsWith('--'));
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
if (!file || !apiKey) {
  console.error('usage: ANTHROPIC_API_KEY=… node --import tsx scripts/minecraft-llmc-scene.ts <scenes.json> [--models=haiku,sonnet,opus] [--count]');
  process.exit(2);
}
const only = flag('scenes')?.split(',').map(name => name.trim());
const scenes = (JSON.parse(readFileSync(file, 'utf8')) as LlmcScene[]).filter(scene => !only || only.includes(scene.name));

async function count(): Promise<void> {
  const client = new Anthropic({ apiKey });
  for (const scene of scenes) {
    const live = sceneInput(scene).transient as Record<string, unknown>;
    const tokens = async (text: string) => (await client.messages.countTokens({ model: MODELS.opus!,
      messages: [{ role: 'user', content: text }] })).input_tokens;
    const map = typeof live.map === 'string' ? live.map : '';
    const [whole, mapOnly, empty] = await Promise.all([tokens(JSON.stringify(live)), tokens(map || '.'), tokens('.')]);
    console.log(`${scene.name}: live ${whole - empty} tokens (head ${llmcLiveTokens(live)}), map ${mapOnly - empty} tokens (head ${llmcTokens(map)})`
      + ` for ${map.length} characters`);
  }
}

async function replay(): Promise<void> {
  const names = (flag('models') ?? 'haiku,sonnet,opus').split(',').map(name => MODELS[name.trim()] ?? name.trim());
  const repeat = Math.max(1, Number(flag('repeat') ?? 1));
  const cap = Number(flag('cap') ?? Infinity);
  let spent = Number(flag('spent') ?? 0);
  const out = flag('out');
  const answers: unknown[] = [];
  outer: for (const name of names) {
    const usage: AnthropicFcaUsage[] = [];
    const model = createAnthropicFcaModel({ model: name, apiKey: apiKey!, recordUsage: value => { usage.push(value); }, systemAppendix: LLMC_SYSTEM_APPENDIX });
    for (const scene of scenes) {
      for (let round = 0; round < repeat; round += 1) {
        if (spent > cap) { console.log(`STOP: spent $${spent.toFixed(3)} > cap $${cap}`); break outer; }
        const before = usage.length;
        const spentNow = () => usage.slice(before).reduce((sum, item) => sum + item.estimatedCostUsd, 0);
        try {
          const answer = await sceneDecision(scene, model);
          const cost = spentNow(), first = usage[before];
          spent += cost;
          const tokens = first ? { input: first.inputTokens - first.cachedInputTokens - first.cacheCreationInputTokens, cacheRead: first.cachedInputTokens,
            cacheWrite: first.cacheCreationInputTokens, output: first.outputTokens } : null;
          answers.push({ model: name, round, ...answer, costUsd: cost, tokens });
          console.log(`${scene.name}\t${name}\tr${round}\t${answer.ms}ms\t${answer.decision}\thands=${answer.hands.join(',') || '-'}`
            + `\t${answer.problem ? `refused: ${answer.problem}` : answer.fixes.length ? `ok (fixed: ${answer.fixes.join('; ')})` : 'ok'}\t$${cost.toFixed(4)}\t${JSON.stringify(tokens)}`);
        } catch (error) {
          const cost = spentNow();
          spent += cost;
          answers.push({ model: name, round, scene: scene.name, error: String(error), costUsd: cost });
          console.log(`${scene.name}\t${name}\tr${round}\terror ${String(error)}\t$${cost.toFixed(4)}`);
        }
        if (out) writeFileSync(out, JSON.stringify(answers, null, 1));
      }
    }
  }
  console.log(`TOTAL spent (with --spent) $${spent.toFixed(4)}`);
}

await (args.includes('--count') ? count() : replay());
