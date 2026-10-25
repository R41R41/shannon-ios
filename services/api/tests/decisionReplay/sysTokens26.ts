import { loadAllRuns } from './allRuns.js';
import { candFixed } from './candidateAdapter.js';
import { llmcTokens } from '../../src/surfaces/minecraft/minecraftLlmcLive.js';
const runs = loadAllRuns();
const run = [...runs.values()].find(r => r.key === 'r34')!;
const fixed = await candFixed(run.core);
const system = (fixed.fixed as any).system as Array<{ text: string }>;
console.log('system[1] chars', system[1]!.text.length, 'llmcTokens', llmcTokens(system[1]!.text));
