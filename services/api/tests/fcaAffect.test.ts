import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { appraiseChoice } from '@shannon/cognition';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { AffectCoordinator, type FcaAffectEvidence } from '../src/mind/emotion/emotionPorts.js';

const roots: string[] = [], closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fca-affect-')); roots.push(dir); const path = join(dir, 'state.sqlite');
  const now = () => '2026-10-09T00:00:00.000Z';
  const open = () => { const store = new SQLiteShannonStore({ path, now, predictionLedger: false, choiceLedger: false, predictionShadow: false }); closers.push(() => store.close()); return store; };
  const state = open(), db = new DatabaseSync(path); closers.push(() => db.close());
  const evidence = (eventId = 'canonical-operation'): FcaAffectEvidence => ({ eventId, taskId: 'child-task', revision: 1, observedAt: now(),
    value: 0.6, expectedValue: 0.2, unexpected: 0.4, cause: 'A public result was observed', target: 'research', sources: [] });
  return { state, db, open, evidence };
}
describe('shared FCA affect through the existing companion writer', () => {
  it('creates no FCA receipt schema until used and applies the existing bounded appraisal exactly once across connections', async () => {
    const f = fixture(), other = f.open(), before = f.state.snapshot('owner');
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='fca_affect_receipts'").get()).toBeUndefined();
    const item = f.evidence();
    const results = await Promise.all([Promise.resolve().then(() => f.state.applyFcaAffectEvidence('owner', item, () => true)),
      Promise.resolve().then(() => other.applyFcaAffectEvidence('owner', { ...item, taskId: 'parent-task' }, () => true))]);
    expect(results.sort()).toEqual(['applied', 'duplicate']);
    const expected = appraiseChoice(before.emotion, { error: 0.4, expectation: 0.2, unexpected: 0.4 });
    expect(f.state.snapshot('owner').emotion.valence).toBeCloseTo(expected.valence, 12);
    expect(other.snapshot('owner')).toEqual(f.state.snapshot('owner'));
    expect(f.state.fcaAffectReceipts('owner')).toHaveLength(1);
  });

  it('serializes independent results and revises an event by its changed meaning without another full increment', () => {
    const f = fixture(), second = f.open();
    f.state.applyFcaAffectEvidence('owner', f.evidence('first'), () => true);
    second.applyFcaAffectEvidence('owner', { ...f.evidence('second'), value: -0.4 }, () => true);
    const before = f.state.snapshot('owner'), revised = { ...f.evidence('first'), revision: 2, value: -0.5 };
    const prior = appraiseChoice(before.emotion, { error: 0.4, expectation: 0.2, unexpected: 0.4 });
    const next = appraiseChoice(before.emotion, { error: -0.7, expectation: 0.2, unexpected: 0.4 });
    expect(f.state.applyFcaAffectEvidence('owner', revised, () => true)).toBe('revised');
    expect(f.state.snapshot('owner').emotion.valence).toBeCloseTo(before.emotion.valence + next.valence - prior.valence, 12);
    const saved = f.state.snapshot('owner');
    expect(second.applyFcaAffectEvidence('owner', revised, () => true)).toBe('duplicate');
    expect(second.applyFcaAffectEvidence('owner', f.evidence('first'), () => true)).toBe('stale');
    expect(second.applyFcaAffectEvidence('owner', { ...revised, revision: 4 }, () => true)).toBe('stale');
    expect(f.state.snapshot('owner')).toEqual(saved);
    expect(f.open().fcaAffectReceipts('owner').find(item => item.eventId === 'first')?.revision).toBe(2);
  });

  it('rolls back receipt and emotional update together if persistence fails', () => {
    const f = fixture(); f.state.fcaAffectReceipts('owner'); const before = f.state.snapshot('owner');
    f.db.exec("CREATE TRIGGER fail_affect BEFORE INSERT ON fca_affect_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
    expect(() => f.state.applyFcaAffectEvidence('owner', f.evidence(), () => true)).toThrow('receipt failure');
    expect(f.state.snapshot('owner')).toEqual(before); expect(f.state.fcaAffectReceipts('owner')).toEqual([]);
    f.db.exec('DROP TRIGGER fail_affect');
    expect(f.state.applyFcaAffectEvidence('owner', f.evidence(), () => true)).toBe('applied');
  });
  it('looks up exact event revisions even after they leave the bounded latest-cause window', () => {
    const f = fixture();
    for (let index = 0; index < 102; index++) f.state.applyFcaAffectEvidence('owner', { ...f.evidence(`event-${String(index).padStart(3, '0')}`), value: 0, expectedValue: 0, unexpected: 0 }, () => true);
    expect(f.state.fcaAffectReceipts('owner')).toHaveLength(100);
    expect(f.state.fcaAffectReceipts('owner').some(item => item.eventId === 'event-101')).toBe(false);
    expect(f.state.fcaAffectReceipts('owner', ['event-101'])).toMatchObject([{ eventId: 'event-101', revision: 1 }]);
    expect(f.state.applyFcaAffectEvidence('owner', { ...f.evidence('event-101'), revision: 2 }, () => true)).toBe('revised');
  });

  it('filters causes with their current source access and keeps appraisal prose out of audit events', () => {
    const f = fixture(); let visible = true;
    const coordinator = new AffectCoordinator(f.state, () => visible);
    const source = { stepId: 'source-step', threadId: 'thread', experienceId: 'experience', observedAt: f.evidence().observedAt, recalledMemoryIds: [] };
    const evidence = { ...f.evidence(), cause: 'PRIVATE_SOURCE_MEANING', sources: [source] };
    coordinator.submit('owner', evidence);
    expect(coordinator.snapshot('owner')).toMatchObject({ version: 'fca_affect.v1', causes: [{ eventId: evidence.eventId, cause: evidence.cause }] });
    visible = false;
    expect(coordinator.snapshot('owner').causes).toEqual([]);
    const before = f.state.snapshot('owner');
    expect(coordinator.submit('owner', { ...evidence, revision: 2 })).toBe('withheld');
    expect(f.state.snapshot('owner')).toEqual(before);
    expect(JSON.stringify(f.db.prepare("SELECT payload_json FROM experience_events WHERE event_type LIKE 'fca.%' OR event_type='state.emotion-adjusted'").all())).not.toContain(evidence.cause);
  });
});
