import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ensureColumns } from '../src/infra/sqlite/schemaColumns.js';

/** Additive columns (stage 3 review, low): adding one that another connection added between the read and the write is not an error. */
describe('ensureColumns', () => {
  it('adds a missing column, and accepts one another connection added after it looked', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE things (id TEXT PRIMARY KEY)');
    ensureColumns(database, 'things', { extra: 'TEXT' });
    const names = () => (database.prepare('PRAGMA table_info(things)').all() as Array<{ name: string }>).map(row => row.name);
    expect(names()).toEqual(['id', 'extra']);
    // A stale look: the column seems absent, but it is there by the time of the ALTER.
    const stale = { prepare: () => ({ all: () => [{ name: 'id' }] }), exec: (sql: string) => database.exec(sql) } as unknown as DatabaseSync;
    expect(() => ensureColumns(stale, 'things', { extra: 'TEXT' })).not.toThrow();
    expect(() => ensureColumns(stale, 'things', { broken: 'NOT A TYPE (' })).toThrow();
    expect(names()).toEqual(['id', 'extra']);
    database.close();
  });
});
