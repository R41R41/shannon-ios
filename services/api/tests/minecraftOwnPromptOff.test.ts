import { describe, expect, it } from 'vitest';
import { llmcSystemAppendix } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { bodySummaryRequest, firstPlanRequest, llmcRequests } from './support/minecraftBodyRequests.js';
import { quiet, requestDigest, scenario, WIDE_POLICY, SUMMARY_POLICY } from './fcaCoreToolsHarness.js';

/**
 * SHANNON_MINECRAFT_OWN_PROMPT off is the request of 3008876b (rel38), byte for byte. The digests below were taken from the code of
 * origin/main 3008876b before the switch existed: the transient body task through the real runtime (`fcaCoreToolsHarness.ts`, old mode:
 * the default model, no appendix), and the LLM-centric model with r3's and r9's appendix (two decisions each, with a shared context and an
 * owner clock). A change that moves one is a change of the production request and of its cache.
 */
const GOLDEN = {
  transient_one_epoch: ['eddf94d3b1ef91bb', '4654cbc14a63f06f', '29c338928c4f6968', 'c7d701daf38462bd', '5e224b1666fe64a8', '1f954f2300fd6062', '6c83287ac9460438', 'bd159dbfd829db5b', '6ab0fa01fc78289a', '1397581d5bbb00b6', '487fc2bee410a252', 'b2cd43c94761cbf6', '7f9f42697d6b700a', '53b878aeefb97208', 'b540873b8ee66064', 'd77f872cf418d38d', '8db7b5e317f65b39', 'cf8ec4d3ab6c8691', 'c3b146509c653106', 'b668f42c6e455171', 'cb4208ac8ca666f7', '412a88b09a2c50f7', 'cab86c3978620ec7', '6ba2885d250f3f8d', '1b3c7567bab82722', '0183e65c217bc13a', '92553a4daf637b05', 'b938600758edf66c', 'd67e7e86df5d810b', 'ca0735af3b0b45f1'],
  transient_summaries: ['eddf94d3b1ef91bb', '4654cbc14a63f06f', '29c338928c4f6968', 'c7d701daf38462bd', '5e224b1666fe64a8', '1f954f2300fd6062', '6c83287ac9460438', 'bd159dbfd829db5b', '6ab0fa01fc78289a', '1397581d5bbb00b6', '96e65cc04c6eecc9', '618e7cbfa9e928ca', '14861444176cfc3b', '4b95dcc001993096', '8082bd578945bd54', '986243b7895b2b7c', '2fcdd4ee172a4ea6', 'a26562c0f4493a6e', '40e1720a7e199452', '85a712416337f6cd', '4e5fd1ac8522395d', '47b5ea5fcd6dedcb', '320e614b4b3f2400', 'f9b05a5c5e73477c', 'a3440dfd6e93254e', '91c50bf7552be186', '9932b51e0651bf11', 'd4f5a098babc10ee', 'c4b888ef93df63b6', '71a51e890bcadd55'],
  llmc_r9: ['98cd4677604476d9', 'ab830df7827b78a4'],
  llmc_r3: ['eaf06e2c7aeae254', '4ae1fde19f78e950'],
  body_summary: ['54841a24b34c54d9'],
  first_plan: ['ee49ad61e3913cfb'],
};

const live = (step: number) => ({ observation: { position: { x: 10 + step, y: 64, z: -3 }, health: 20, food: 18 }, pace: { minutes: step } });

async function transientDigests(policy: typeof WIDE_POLICY): Promise<string[]> {
  quiet();
  const run = scenario({ mode: () => 'transient', policy, body: live });
  expect(await run.settle()).toBe('completed');
  expect(run.violations).toEqual([]);
  return run.bodies.map(requestDigest);
}

describe('SHANNON_MINECRAFT_OWN_PROMPT off is the production request, byte for byte', () => {
  it('prints the digests (golden capture)', async () => {
    const found = {
      transient_one_epoch: await transientDigests(WIDE_POLICY), transient_summaries: await transientDigests(SUMMARY_POLICY),
      llmc_r9: (await llmcRequests({ systemAppendix: llmcSystemAppendix(true) })).map(requestDigest),
      llmc_r3: (await llmcRequests({ systemAppendix: llmcSystemAppendix(false) })).map(requestDigest),
      body_summary: [requestDigest(await bodySummaryRequest())],
      first_plan: [requestDigest((await firstPlanRequest()).body)],
    };
    if (process.env.GOLDEN_CAPTURE) console.error(`GOLDEN ${JSON.stringify(found)}`);
    expect(found).toEqual(GOLDEN);
  }, 120_000);
});
