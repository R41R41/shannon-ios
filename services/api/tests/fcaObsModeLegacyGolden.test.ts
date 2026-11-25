import { toLegacyPersonaDeep } from './legacyPersona.js';
import { describe, expect, it } from 'vitest';
import { requestDigest, quiet, scenario, SUMMARY_POLICY, WIDE_POLICY } from './fcaCoreToolsHarness.js';

/**
 * `SHANNON_FCA_OBS_MODE=legacy` (the default until 2026-10-19, now the way back) is that request, byte for byte: the digests below were taken from the code of
 * origin/main 4f75c89, before the switch existed, over three scripted body-shaped tasks (ids and clock readings replaced). A change
 * that moves one is a change of the legacy request, and of its cache.
 */
const GOLDEN = {
  one_epoch: ['f20517a092dbd5b9', '4308ed52c58923b2', '8ea89836fa275af1', '09afcd4be0b5d571', '5d8000f7d9a610fd', '7e5157e8de47dca5', '70b91c6372a9639f', '5aa7f985742cbc68', '9a0d22e99543d384', '94a15f1820d0ee97', 'c04f26f36bf947cd', '50af3ed007cf8e80', '61a0d4d52a541fe5', '6ff1c7e84d5cc8e5', '925b4aa840d56540', '980a44c13339b962', '7f2a914a68102aa4', '2061053213f12e89', '90ab2672a8077ae6', '05b3559c955f9ca5', '0b65a60366310d72', '56fbae3448c1b923', '1eab1aa31aff55f0', 'd97768e8242570ae', 'ad79a8547c90eede', '4b7712aaf19cc464', '2c3e22b5e175c10b', '8ec51f79b47b492b', 'aab1bd6b1000b288', 'f96ed562f7ebd4f5'],
  summaries: ['f20517a092dbd5b9', '4308ed52c58923b2', '8ea89836fa275af1', '09afcd4be0b5d571', '5d8000f7d9a610fd', '7e5157e8de47dca5', '70b91c6372a9639f', '5aa7f985742cbc68', '9a0d22e99543d384', '94a15f1820d0ee97', '299816897a3e1299', '089cd9e848cbd6db', 'f5acb95e0501bc79', 'd9ddedb6964129ef', 'f76b3b1dce6722ac', 'c4b0e3dd10a47630', 'd79cc445706bc28a', 'c4cf2cfe7af13126', '01ee7be22e5c82f3', '5436a241f3c7da72', '27519fa7d558b00a', 'd552daf4875581f3', '6ea94837663ffd40', 'd13b4d3f37327512', '74d1a14e432e8ac9', '323ba05932a49715', '7f2deba9207c04d7', '914eb00b34b0891b', '87c3a02c240bf36f', 'e4635b1752a46672'],
  not_a_body_task: ['f20517a092dbd5b9', '4308ed52c58923b2', '8ea89836fa275af1', '09afcd4be0b5d571', '5d8000f7d9a610fd', '7e5157e8de47dca5', '70b91c6372a9639f', '5aa7f985742cbc68', '9a0d22e99543d384', '94a15f1820d0ee97', 'c04f26f36bf947cd', '50af3ed007cf8e80', '61a0d4d52a541fe5', '6ff1c7e84d5cc8e5', '925b4aa840d56540', '980a44c13339b962', '7f2a914a68102aa4', '2061053213f12e89', '90ab2672a8077ae6', '05b3559c955f9ca5', '0b65a60366310d72', '56fbae3448c1b923', '1eab1aa31aff55f0', 'd97768e8242570ae', 'ad79a8547c90eede', '4b7712aaf19cc464', '2c3e22b5e175c10b', '8ec51f79b47b492b', 'aab1bd6b1000b288', 'f96ed562f7ebd4f5'],
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
