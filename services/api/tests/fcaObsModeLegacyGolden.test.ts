import { toLegacyPersonaDeep } from './legacyPersona.js';
import { describe, expect, it } from 'vitest';
import { requestDigest, quiet, scenario, SUMMARY_POLICY, WIDE_POLICY } from './fcaCoreToolsHarness.js';

/**
 * `SHANNON_FCA_OBS_MODE=legacy` (the default until 2026-10-19, now the way back) is that request, byte for byte: the digests below were taken from the code of
 * origin/main 4f75c89, before the switch existed, over three scripted body-shaped tasks (ids and clock readings replaced). A change
 * that moves one is a change of the legacy request, and of its cache.
 */
const GOLDEN = {
  one_epoch: ['e279671d0487ce06', '5b1bd0549878022a', '13a8b538c408265e', '765347173824c1d4', 'f11acd0f33a5bb28', '895be556d7d943d4', 'a00cbef508d4ec94', 'ed259a5ead386948', '651bff4756dd7c42', '234e6500ab6289f5', 'add7ca902b327939', '2d5568d2181a842b', 'ff349eea9668712a', '97e51c6f406c83c6', '9808acbf3b2f7842', '20d5a4b3acfad3b1', '71bde2322677292f', '5f4d6c6fc1974cc4', '0f2a9e40a4ee9c76', '64b42f5dbd21c2de', 'd5b5948eee60b34d', '202e8ab447b6b9e6', 'b96c780458a6457f', '2b24ab36696e69e9', '2e2c4beaffc1c0b6', '7d8ad7f7a0abc2f0', '3be1b3e11f739dce', 'd3077984a13602db', '5c8444c277fa558c', '69b43815fcb3e5aa'],
  summaries: ['e279671d0487ce06', '5b1bd0549878022a', '13a8b538c408265e', '765347173824c1d4', 'f11acd0f33a5bb28', '895be556d7d943d4', 'a00cbef508d4ec94', 'ed259a5ead386948', '651bff4756dd7c42', '234e6500ab6289f5', '7468cbf88b26800d', '74cd38ec7d02472e', 'c5f1a9040f1a92b3', 'eae89f20cc52e80b', '12d951d3990157c3', 'f920f2ea6f57d3d5', '3ac1ab360bb8c924', '1816198328e5d3cf', 'd610c4e2496e3946', '30443677c449bdfd', 'd503fe43d89c82bf', '304dcfe602f97d64', '3bae8b5f70a61631', '5d0bf75e5fbb7d64', '574f7c38daefb324', '910a522d83996849', 'ecae781d50e362e2', '3d061f1558305b55', 'cd58c67e053465f3', '0dbc73f3a4b2a5f1'],
  not_a_body_task: ['e279671d0487ce06', '5b1bd0549878022a', '13a8b538c408265e', '765347173824c1d4', 'f11acd0f33a5bb28', '895be556d7d943d4', 'a00cbef508d4ec94', 'ed259a5ead386948', '651bff4756dd7c42', '234e6500ab6289f5', 'add7ca902b327939', '2d5568d2181a842b', 'ff349eea9668712a', '97e51c6f406c83c6', '9808acbf3b2f7842', '20d5a4b3acfad3b1', '71bde2322677292f', '5f4d6c6fc1974cc4', '0f2a9e40a4ee9c76', '64b42f5dbd21c2de', 'd5b5948eee60b34d', '202e8ab447b6b9e6', 'b96c780458a6457f', '2b24ab36696e69e9', '2e2c4beaffc1c0b6', '7d8ad7f7a0abc2f0', '3be1b3e11f739dce', 'd3077984a13602db', '5c8444c277fa558c', '69b43815fcb3e5aa'],
};

async function digests(options: Parameters<typeof scenario>[0]): Promise<string[]> {
  quiet();
  const run = scenario(options);
  expect(await run.settle()).toBe('completed');
  expect(run.violations).toEqual([]);
  return run.bodies.map(body => requestDigest(toLegacyPersonaDeep(body)));
}

describe('SHANNON_FCA_OBS_MODE=legacy is the production request, byte for byte', () => {
  it('prints the digests (golden capture)', async () => {
    const found = { one_epoch: await digests({ policy: WIDE_POLICY }), summaries: await digests({ policy: SUMMARY_POLICY }),
      not_a_body_task: await digests({ policy: WIDE_POLICY, keepBody: false }) };
    if (process.env.GOLDEN_CAPTURE) console.error(`GOLDEN ${JSON.stringify(found)}`);
    expect(found).toEqual(GOLDEN);
  }, 120_000);
});
