import { pathToFileURL } from 'node:url';
import { keyFor, llmcModelNames } from '../services/api/src/wiring/minecraftLlmcConfiguration.ts';
import { DEFAULT_HAIKU_MODEL } from '../services/api/src/infra/models/anthropic/haikuConfig.ts';
import { claudeClient } from '../services/api/src/infra/models/claude/claudeClient.ts';

/** Use the very same routing as gameplay and summaries. Token counting generates no answer and proves no balance. */
export async function checkMinecraftCredentials(values, count) {
  const names = llmcModelNames(values);
  const results = [];
  for (const [route, model] of [['main', names.main], ['summary', DEFAULT_HAIKU_MODEL]]) {
    const apiKey = keyFor(values, model);
    if (!apiKey) { results.push({ route, model, ok: false, code: 'missing_key' }); continue; }
    try {
      const result = await count(apiKey, model);
      results.push({ route, model, ok: Number.isSafeInteger(result.input_tokens), code: 'count_tokens_only' });
    } catch (error) {
      // Provider error messages can contain request details; expose only the status.
      results.push({ route, model, ok: false, status: Number.isInteger(error?.status) ? error.status : null, code: 'connection_failed' });
    }
  }
  return { generationCalls: 0, balanceVerified: false, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkMinecraftCredentials(process.env, (apiKey, model) =>
    claudeClient({ apiKey, timeoutMilliseconds: 15000 }).messages.countTokens({ model, messages: [{ role: 'user', content: '接続確認' }] }));
  console.log(JSON.stringify(result));
  process.exitCode = result.results.every(row => row.ok) ? 0 : 1;
}
