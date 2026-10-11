import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryLines, withSwitchSection } from './generate-env-example.mjs';

const entries = [
  { name: 'SHANNON_A', default: 'on', kind: 'default_on', owner: 'mind', requires: [], doc: 'A.' },
  { name: 'SHANNON_B', default: 'off', kind: 'true_only', owner: 'autonomy', requires: ['SHANNON_A'], doc: 'B.' },
];

test('each switch is written as its default, in the words its kind reads', () => {
  assert.deepEqual(entryLines(entries[0]), ['# A. [mind; on unless off/false/0/disabled/no/none]', 'SHANNON_A=on']);
  assert.deepEqual(entryLines(entries[1]), ['# B. [autonomy; off unless true] Needs SHANNON_A.', 'SHANNON_B=false']);
});

test('the section is appended once and then replaced in place, leaving the rest of the file alone', () => {
  const first = withSwitchSection('KEEP=1\n', entries);
  assert.match(first, /^KEEP=1\n\n# --- Switches: generated/u);
  assert.equal(withSwitchSection(first, entries), first);
  const changed = withSwitchSection(first, [entries[0]]);
  assert.ok(changed.startsWith('KEEP=1\n'));
  assert.ok(!changed.includes('SHANNON_B='));
});
