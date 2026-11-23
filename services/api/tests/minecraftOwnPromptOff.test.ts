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
  transient_one_epoch: ['ff33a6f160d06a8a', '41a6b63de1858b9d', 'fd1cc22e4fde9eaf', '57b1790563b465cd', '56071f8faf322718', 'e5559d0bac45b8a2', '728c9857da850d8b', 'e5f6f559be79c883', '151028729e706a27', '182bd80cae803bbf', 'fa4ac8eded3016a9', 'dd4909e551b44607', '780dccb5b19409eb', '2fa713925af4e8d2', '57dda367f4b17273', '666d9681b367f2d7', '29b1ab440138c561', '50ca3bbe18198484', 'e2bdeafda9e3c095', 'a67559707ff6ec9e', '35c022c4d30251c3', '0b8cc31513d10fb8', 'c86039d6e693a8f7', '454fd1d5d3d7dd60', '6f09d3998fcbb058', '40ef69ad99b80863', '65794c1d1c86ac42', '7e206fa060a3c5f4', '46f9975157ae370d', 'c09164cf6e4e49f6'],
  transient_summaries: ['ff33a6f160d06a8a', '41a6b63de1858b9d', 'fd1cc22e4fde9eaf', '57b1790563b465cd', '56071f8faf322718', 'e5559d0bac45b8a2', '728c9857da850d8b', 'e5f6f559be79c883', '151028729e706a27', '182bd80cae803bbf', 'c140aa19fde60ce9', '1880da65c8aa039e', '32fabbe3f9519663', '18a711e99962b3ab', '35527622b8fcd17f', '3884a7be1ace3814', '5095f531c8c346e5', '972d6a4140ee201f', 'aa98aa1171a2c5f5', '32daf21aa358b61e', 'a6c748a0b6582d8b', '0d3977bc4f4056bc', 'c2b669212b027760', '774133ba92d2bca9', 'ccc692f07a8ff659', '3af4d4715b2303c4', 'a5a99f421b96e0ec', '2afb7c0808b79909', '69e0b3903999ac45', '521246ad8660176e'],
  // Flow 1113 (e8665813): the body summary's instruction says its size (within 4,000 tokens), so its digest is new.
  body_summary: ['7b60659dbbc760e6'],
  // 11/11 trim: the stage rules (and so the first plan, which carries them) lose the reference sentence of runs 41 and 42, whose example the descent's reason line says once.
  first_plan: ['1d03a04bc6c71595'],
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
