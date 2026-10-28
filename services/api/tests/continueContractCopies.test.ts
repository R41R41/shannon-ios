import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOAL_OUTCOMES, RUN_ENDS } from '../src/contracts/continueContract.js';

/**
 * The catalog contract check (the release gate) loads `minecraftControlValidation.ts` alone, so it may import types only: the two closed word lists of a unit's axes are
 * written there as well. They are held equal to the contract's here, and the file keeps no value import.
 */
describe('minecraftControlValidation.ts keeps its own copy of the unit\'s closed words', () => {
  const text = readFileSync(new URL('../src/surfaces/minecraft/minecraftControlValidation.ts', import.meta.url), 'utf8');
  const listOf = (name: string): string[] => {
    const start = text.indexOf(`const ${name} = [`);
    const end = start < 0 ? -1 : text.indexOf('] as const;', start);
    const body = start < 0 || end < 0 ? '' : text.slice(start, end);
    return [...body.matchAll(/'([a-z_]+)'/gu)].map(match => match[1]!);
  };
  it('the goal words and the end words are the contract\'s', () => {
    expect(listOf('GOAL_OUTCOMES')).toEqual([...GOAL_OUTCOMES]);
    expect(listOf('RUN_ENDS')).toEqual([...RUN_ENDS]);
  });
  it('imports types only (no value import from another module)', () => {
    const imports = text.split('\n').filter(line => /^import /u.test(line));
    expect(imports.filter(line => !/^import type /u.test(line))).toEqual([]);
  });
});
