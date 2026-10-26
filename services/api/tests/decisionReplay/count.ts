import Anthropic from '@anthropic-ai/sdk';
import { decisions, loadRuns } from './load.js';
import { bootstraps } from './bootstrap.js';
import { buildRequest, VARIANTS } from './request.js';
import { decisionOf, loadScenes } from './score.js';

/** count_tokens（無料）で、場面 × 版の要求の入力トークンを数える。費用の見積もりの元。 */
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const runs = loadRuns(p('export1.txt'), p('journal.txt'));
const client = new Anthropic({ apiKey: process.env.SHANNON_ANTHROPIC_API_KEY!, maxRetries: 2 });
const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : undefined;
const fixed = new Map<string, Record<number, string>>();
for (const run of runs.values()) fixed.set(run.key, await bootstraps(run, process.env.SHANNON_ANTHROPIC_API_KEY!));
const out: Record<string, Record<string, number>> = {};
for (const scene of loadScenes().filter(item => !only || only.includes(item.id.split('-')[0]!))) {
  const decision = decisionOf(runs, scene);
  const text = decision.epoch > 0 ? fixed.get(scene.run)![decision.epoch] ?? null : null;
  out[scene.id] = {};
  for (const variant of VARIANTS) {
    const request = await buildRequest(variant, decision, runs.get(scene.run)!.core, text);
    const { max_tokens: _m, stream: _s, cache_control: _c, tool_choice: _t, ...rest } = request.body as Record<string, any>;
    try {
      const counted = await (client.beta.messages as any).countTokens({ ...rest, betas: String(request.headers['anthropic-beta']).split(',') });
      out[scene.id]![variant.id] = counted.input_tokens;
    } catch (error) {
      out[scene.id]![variant.id] = -1;
      console.log(scene.id, variant.id, 'count failed', String((error as Error).message).slice(0, 200));
    }
  }
  console.log(scene.id, JSON.stringify(out[scene.id]), 'chars', JSON.stringify((await buildRequest(VARIANTS[0]!, decision, runs.get(scene.run)!.core, text)).body).length);
}

import { writeFileSync } from 'node:fs';
if (!only) writeFileSync(p('counts.json'), JSON.stringify(out, null, 1));
