import { describe, expect, it } from 'vitest';
import { requestDigest, quiet, scenario, SUMMARY_POLICY, WIDE_POLICY } from './fcaCoreToolsHarness.js';

/**
 * `SHANNON_FCA_OBS_MODE=legacy` (the default) is production's request, byte for byte: the digests below were taken from the code of
 * origin/main 4f75c89, before the switch existed, over three scripted body-shaped tasks (ids and clock readings replaced). A change
 * that moves one is a change of the legacy request, and of its cache.
 */
const GOLDEN = {
  one_epoch: ['ba75cbbbbc0a3dba', 'd08c22ecbba02db7', '65f416b3b4b9ef70', '3e895f884900a87b', '4acbbe732af85521', '8b6a89b7826f0484', '914fff248351adcc', '534630f234c5dd87', '583b41f0395a4dc4', '7baabd8476ad2bc9', 'e5eb3c402141f4f2', '47b893daaf9bc1e0', 'bb7c2d231da03af8', '6700e0ee45668da1', 'a6a389deb93d6524', 'aca56098103730f3', 'c6569ecf3ef59192', '47fdd5671070acc0', '47dd7fe5ffa0104a', 'c291f256b9d8d2ed', '2d6a365b5cf75f53', 'c1de218671206beb', 'c6e1d88a8a9da1a9', '25febc7f6beaea05', 'dd7009ca52c5d8cf', '751e9a2b2450e3af', '888f7f37d07e582b', '19edd1887e13a85f', '2094f327c912ecce', 'ab445f9d1119f6a2'],
  summaries: ['ba75cbbbbc0a3dba', 'd08c22ecbba02db7', '65f416b3b4b9ef70', '3e895f884900a87b', '4acbbe732af85521', '8b6a89b7826f0484', '914fff248351adcc', '534630f234c5dd87', '583b41f0395a4dc4', '7baabd8476ad2bc9', '1b5e966a9a893c4b', '45ccc4b26bcdc00a', 'adf13fd9eb61e792', 'cbcd96797c494ba2', '41a597da4479f0dd', '748896f76bdbed55', '3fd577989209a16b', 'c06ee07a3e15f9d9', '17cdba6c746f4266', '845a31fcaf68250d', '24690206a8c3cd55', '4e9ade56c1ac1346', 'b35e6305e43d2896', 'ea7038de2627eb6c', '1f746fade04fe28b', 'ce2b5e0873cd9bdb', '1f8edabf5262730d', '706182ed2a96fda7', '3aa85d2bc729d148', 'bbbc6c37c328acf9'],
  not_a_body_task: ['ba75cbbbbc0a3dba', 'd08c22ecbba02db7', '65f416b3b4b9ef70', '3e895f884900a87b', '4acbbe732af85521', '8b6a89b7826f0484', '914fff248351adcc', '534630f234c5dd87', '583b41f0395a4dc4', '7baabd8476ad2bc9', 'e5eb3c402141f4f2', '47b893daaf9bc1e0', 'bb7c2d231da03af8', '6700e0ee45668da1', 'a6a389deb93d6524', 'aca56098103730f3', 'c6569ecf3ef59192', '47fdd5671070acc0', '47dd7fe5ffa0104a', 'c291f256b9d8d2ed', '2d6a365b5cf75f53', 'c1de218671206beb', 'c6e1d88a8a9da1a9', '25febc7f6beaea05', 'dd7009ca52c5d8cf', '751e9a2b2450e3af', '888f7f37d07e582b', '19edd1887e13a85f', '2094f327c912ecce', 'ab445f9d1119f6a2'],
};

async function digests(options: Parameters<typeof scenario>[0]): Promise<string[]> {
  quiet();
  const run = scenario(options);
  expect(await run.settle()).toBe('completed');
  expect(run.violations).toEqual([]);
  return run.bodies.map(requestDigest);
}

describe('SHANNON_FCA_OBS_MODE=legacy is the production request, byte for byte', () => {
  it('prints the digests (golden capture)', async () => {
    const found = { one_epoch: await digests({ policy: WIDE_POLICY }), summaries: await digests({ policy: SUMMARY_POLICY }),
      not_a_body_task: await digests({ policy: WIDE_POLICY, keepBody: false }) };
    if (process.env.GOLDEN_CAPTURE) console.error(`GOLDEN ${JSON.stringify(found)}`);
    expect(found).toEqual(GOLDEN);
  }, 120_000);
});
