import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type { ResultRow } from './run.js';

/** 出力トークンのうち、答えの JSON（手の列）が何トークンで、残り（見えない考え）がどれだけか。count_tokens（無料）で JSON の長さを数える。 */
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const rows = readFileSync(p('results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ResultRow).filter(row => row.ok);
const client = new Anthropic({ apiKey: process.env.SHANNON_ANTHROPIC_API_KEY! });
const empty = (await client.messages.countTokens({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: '.' }] })).input_tokens;
const summary: Record<string, { out: number[]; json: number[] }> = {};
for (const row of rows) {
  const text = JSON.stringify(row.answer.input);
  const tokens = (await client.messages.countTokens({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: text }] })).input_tokens - empty;
  (summary[row.variant] ??= { out: [], json: [] }).out.push(row.usage.output);
  summary[row.variant]!.json.push(tokens + 12);
}
const mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length;
for (const [variant, value] of Object.entries(summary)) console.log(variant, 'calls', value.out.length, 'output mean', mean(value.out).toFixed(0), 'answer JSON mean', mean(value.json).toFixed(0), 'hidden thinking (rest) mean', (mean(value.out) - mean(value.json)).toFixed(0));
