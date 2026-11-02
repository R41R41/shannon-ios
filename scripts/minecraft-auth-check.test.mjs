import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMinecraftCredentials } from './minecraft-auth-check.mjs';
test('checks the separate gameplay and summary keys without generation or exposing errors', async () => {
  const calls = [];
  const answer = await checkMinecraftCredentials({ SHANNON_ANTHROPIC_API_KEY: 'main-fixture', SHANNON_HAIKU_API_KEY: 'summary-fixture' },
    async (key, model) => { calls.push([key, model]); if (key === 'summary-fixture') throw { status: 401, message: 'secret-fixture' }; return { input_tokens: 3 }; });
  assert.equal(calls[0][0], 'main-fixture');
  assert.equal(calls[1][0], 'summary-fixture');
  assert.equal(answer.generationCalls, 0);
  assert.equal(answer.balanceVerified, false);
  assert.equal(answer.results[1].status, 401);
  assert.equal(JSON.stringify(answer).includes('secret-fixture'), false);
});
test('the summary uses the primary fallback if no separate key is configured', async () => {
  const keys = [];
  await checkMinecraftCredentials({ SHANNON_ANTHROPIC_API_KEY: 'fallback-fixture' }, async key => { keys.push(key); return { input_tokens: 3 }; });
  assert.deepEqual(keys, ['fallback-fixture', 'fallback-fixture']);
});
