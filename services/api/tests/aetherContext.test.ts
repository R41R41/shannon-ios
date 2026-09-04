import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAetherContextReader } from '../src/aetherContext.js';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

function fixture(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-aether-'));
  directories.push(directory);
  const file = join(directory, 'context.json');
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

function snapshot() {
  return {
    version: 1,
    source: 'aether-ios',
    sharedAt: '2026-09-03T00:00:00.000Z',
    notes: [
      { id: 'design', title: 'Shannonの設計', excerpt: '感情と記憶の共有状態を考える', updatedAt: '2026-09-03T00:00:00.000Z', tags: ['AI'], type: 'design', status: 'growing' },
      { id: 'food', title: '夕食', excerpt: 'カレーを作る', updatedAt: '2026-09-02T00:00:00.000Z', tags: ['生活'], type: 'diary', status: 'done' },
    ],
  };
}

describe('Aether context reader', () => {
  it('selects only relevant short excerpts and keeps IDs for future proposals', () => {
    const prompt = new FileAetherContextReader(fixture(snapshot())).promptFor('owner', 'Shannonの感情設計を続けたい');
    expect(prompt).toContain('Shannonの設計');
    expect(prompt).toContain('ID: design');
    expect(prompt).not.toContain('カレー');
  });

  it('returns recent notes when Aether itself is requested', () => {
    const prompt = new FileAetherContextReader(fixture(snapshot())).promptFor('owner', 'Aetherに何を書いていた？');
    expect(prompt).toContain('Shannonの設計');
    expect(prompt).toContain('夕食');
  });

  it('fails closed for malformed, oversized and missing files', () => {
    expect(new FileAetherContextReader(fixture({ nope: true })).promptFor('owner', 'Aether')).toBe('');
    const oversized = fixture({ ...snapshot(), notes: [] });
    writeFileSync(oversized, 'x'.repeat(65 * 1024));
    expect(new FileAetherContextReader(oversized).promptFor('owner', 'Aether')).toBe('');
    expect(new FileAetherContextReader('/missing/aether-context.json').promptFor('owner', 'Aether')).toBe('');
  });
});
