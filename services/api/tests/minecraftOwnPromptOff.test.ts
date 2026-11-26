import { describe, expect, it } from 'vitest';
import { bodySummaryRequest, firstPlanRequest, llmcRequests } from './support/minecraftBodyRequests.js';
import { toLegacyPersonaDeep } from './legacyPersona.js';
import { quiet, requestDigest, scenario, WIDE_POLICY, SUMMARY_POLICY } from './fcaCoreToolsHarness.js';

/**
 * SHANNON_MINECRAFT_OWN_PROMPT off is the request of 3008876b (rel38), byte for byte. The digests below were taken from the code of
 * origin/main 3008876b before the switch existed: the transient body task through the real runtime (`fcaCoreToolsHarness.ts`, old mode:
 * the default model, no appendix), and the LLM-centric model with r3's and r9's appendix (two decisions each, with a shared context and an
 * owner clock). A change that moves one is a change of the production request and of its cache.
 * The continue contract (2026-10-28, chapter 7 and 3): the first plan asks for each node's kind and for the promises (schema and two lines of the words), so the first plan's digest is the new one;
 * the others are as they were.
 */
const GOLDEN = {
  transient_one_epoch: ['cefd022ea195c63b', 'a18be46624e2719f', '3b333f5a78d51a3e', '9d5f17a5ad455dad', '9c94b7baa2696ed5', 'b1d496550a37b67e', 'da0f3794f0e640a6', '599e7912fdc9cbfb', 'abe0da50ea78e553', 'e648b0c5cf6424ff', '0302a3a0b820de19', '7ac01ea695233f45', '87d079442c96fb36', '11acd513737b7cd9', 'b1768c2bfccdbfab', 'a6ed4c29decd5e8a', '9885fd3f9d5c50ea', '6c40e204a7304c71', 'ddd6b30af4d5e2f0', 'e41b08ccb69024ba', 'c764fbbc4f247eb4', '41036845879dc5a3', '08c285ef76d4e15c', 'ff67796eee2bb8fa', '1b31fc51de29bad6', '15b86ccd49d5f8ee', '9ceb71a9e63a4dbf', 'b98ee006637de617', '5f248fd4c245f2b3', '4351237951d76e31'],
  transient_summaries: ['cefd022ea195c63b', 'a18be46624e2719f', '3b333f5a78d51a3e', '9d5f17a5ad455dad', '9c94b7baa2696ed5', 'b1d496550a37b67e', 'da0f3794f0e640a6', '599e7912fdc9cbfb', 'abe0da50ea78e553', 'e648b0c5cf6424ff', '8b428776da55eec7', 'e240f8dafd26a74d', '04007d5b4c2638b0', 'dec1d414901a7466', 'ae790211cd5e2a5d', '3762a605f44c0c17', '3769e2798c0e3cc8', 'c734cbeed7d5bae2', 'fd9837f5974d7864', '17c1d3bdd6876355', '3029327bcc6258fd', 'c38e7fd6c6f56e87', '12876f36955c8edb', 'b69d2987792f76db', '496c6a0a27760f99', 'd44fe2763007fd71', '2a9ec0fd3476b8ea', '985a737b14e74acc', '93c11cff5e712840', '7c7e4965b0efdc5b'],
  // Flow 1113 (e8665813): the body summary's instruction says its size (within 4,000 tokens), so its digest is new.
  body_summary: ['3c26e85291bd8deb'],
  // 11/27 (run 7 of 11/26): the first plan's R9 words order the End's check before the entry and write a where with its dimension.
  // 11/11 trim: the stage rules (and so the first plan, which carries them) lose the reference sentence of runs 41 and 42, whose example the descent's reason line says once.
  first_plan: ['debd18b12cb9786e'],
};

const live = (step: number) => ({ observation: { position: { x: 10 + step, y: 64, z: -3 }, health: 20, food: 18 }, pace: { minutes: step } });

async function transientDigests(policy: typeof WIDE_POLICY): Promise<string[]> {
  quiet();
  const run = scenario({ mode: () => 'transient', policy, body: live });
  expect(await run.settle()).toBe('completed');
  expect(run.violations).toEqual([]);
  return run.bodies.map(body => requestDigest(toLegacyPersonaDeep(body)));
}

describe('SHANNON_MINECRAFT_OWN_PROMPT off is the production request, byte for byte', () => {
  it('prints the digests (golden capture)', async () => {
    const found = {
      transient_one_epoch: await transientDigests(WIDE_POLICY), transient_summaries: await transientDigests(SUMMARY_POLICY),
      body_summary: [requestDigest(toLegacyPersonaDeep(await bodySummaryRequest()))],
      first_plan: [requestDigest(toLegacyPersonaDeep((await firstPlanRequest(false)).body))],
    };
    if (process.env.GOLDEN_CAPTURE) console.error(`GOLDEN ${JSON.stringify(found)}`);
    expect(found).toEqual(GOLDEN);
  }, 120_000);
});
