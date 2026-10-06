import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAetherProposalStore } from '../src/integrations/aether/aetherProposal.js';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

function store() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-proposals-'));
  directories.push(directory);
  return { directory, store: new FileAetherProposalStore(directory, () => '2026-09-03T10:00:00.000Z') };
}

describe('Aether proposal outbox', () => {
  it('writes an immutable owner-only new-note proposal', () => {
    const fixture = store();
    const proposal = fixture.store.create('owner', { title: '設計案', content: '保存したい内容\n\n- 箇条書き', reason: '会話から' });
    expect(proposal).toMatchObject({ operation: 'new-note', title: '設計案', content: '保存したい内容\n\n- 箇条書き' });
    const file = join(fixture.directory, `${proposal.id}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(proposal);
  });

  it('requires target ID and expected revision together for append proposals', () => {
    const fixture = store();
    expect(() => fixture.store.create('owner', { content: '追記', targetNoteId: 'memo-1' })).toThrow('INVALID_AETHER_PROPOSAL');
    expect(fixture.store.create('owner', {
      content: '追記', targetNoteId: 'memo-1', expectedUpdatedAt: '2026-09-03T00:00:00.000Z',
    })).toMatchObject({ operation: 'append', targetNoteId: 'memo-1', expectedUpdatedAt: '2026-09-03T00:00:00.000Z' });
    expect(readdirSync(fixture.directory).filter(name => name.endsWith('.json'))).toHaveLength(1);
  });
});
