import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { peopleAudience, selfInterestNightKey } from '@shannon/cognition';
import { selfInterestWorld } from './support/selfInterestWorld.js';

const worlds: ReturnType<typeof selfInterestWorld>[] = [];
const world = (enabled = true) => { const result = selfInterestWorld(enabled); worlds.push(result); return result; };
afterEach(() => { for (const current of worlds.splice(0)) current.close(); });

describe('stage 5 self interests through the one SQLite memory writer', () => {
  it('starts empty, preserves mixed legacy interests and opens no self schema while OFF', () => {
    const off = world(false);
    off.store.apply('owner', { type: 'interest-observed', interest: '旧来の関心' });
    expect(off.store.selfInterests()).toBeNull();
    const database = new DatabaseSync(off.path, { readOnly: true });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'self_interest_%'").all()).toEqual([]);
    database.close();
    const on = world();
    on.store.apply('owner', { type: 'interest-observed', interest: '旧来の関心' });
    expect(on.memory!.snapshot('owner')).toMatchObject({ revision: 0, items: [], changes: [], capacity: { used: 0 } });
    expect(on.store.snapshot('owner').interests).toEqual(['旧来の関心']);
  });

  it('holds the third addition through retries, another connection and old batch dates; undo refunds no allowance', async () => {
    const w = world();
    w.add('天文'); w.add('音楽'); const third = w.add('鉱物');
    await w.night();
    expect(w.memory!.snapshot('owner').capacity.used).toBe(2);
    const one = w.memory!.store.all('owner')[0]!;
    const change = w.memory!.snapshot('owner').changes.find(item => item.itemId === one.id)!;
    expect(w.mutate({ itemId: one.id, expectedRevision: one.revision, action: 'undo', changeId: change.changeId }).code).toBe('changed');
    const second = w.open('restarted-writer');
    w.advance(61_000);
    await second.night();
    expect(w.memory!.snapshot('owner').capacity.used).toBe(1);
    expect(w.memory!.store.candidates('owner', false).find(item => item.proposal.candidateId === third)).toMatchObject({ status: 'held', code: 'night_limit' });
    w.advance(86_400_000);
    await second.night();
    expect(w.memory!.snapshot('owner').capacity.used).toBe(2);
    expect(w.memory!.store.candidates('owner', false).find(item => item.proposal.candidateId === third)?.status).toBe('accepted');
  });

  it('limits actual-night deletions to two, retaining the held third and every item version', async () => {
    const w = world();
    w.add('天文'); w.add('音楽'); await w.night();
    w.advance(86_400_000); w.add('鉱物'); await w.night();
    const current = w.memory!.store.all('owner');
    for (const item of current) w.propose({ kind: 'remove', itemId: item.id, expectedRevision: item.revision, ownerGeneration: item.ownerGeneration, reason: '関心を整理する' });
    await w.night();
    expect(w.memory!.snapshot('owner').capacity.used).toBe(1);
    expect(w.memory!.store.all('owner')).toHaveLength(3);
    expect(w.memory!.store.candidates('owner').filter(item => item.code === 'night_limit')).toHaveLength(1);
    w.advance(86_400_000); await w.night();
    expect(w.memory!.snapshot('owner').capacity.used).toBe(0);
    expect(w.memory!.snapshot('owner').changes.filter(item => item.kind === 'remove')).toHaveLength(3);
  });

  it('uses the beginning-of-night baseline for net weight changes and never accepts out-of-range values', async () => {
    const w = world(); w.add('天文'); await w.night();
    const patch = async (weight: number) => {
      const item = w.memory!.store.all('owner')[0]!;
      const id = w.propose({ kind: 'patch', itemId: item.id, expectedRevision: item.revision, ownerGeneration: item.ownerGeneration, weight, reason: '手応えを反映する' });
      await w.night();
      return w.memory!.store.candidates('owner', false).find(candidate => candidate.proposal.candidateId === id)!;
    };
    expect((await patch(0.6)).status).toBe('accepted');
    expect(await patch(0.7)).toMatchObject({ status: 'rejected', code: 'weight_limit' });
    expect((await patch(0.4)).status).toBe('accepted');
    expect(await patch(-0.1)).toMatchObject({ status: 'rejected', code: 'bad_weight' });
    expect(w.memory!.store.all('owner')[0]!.weight).toBe(0.4);
    w.advance(86_400_000);
    expect((await patch(0.3)).status).toBe('accepted');
  });

  it('keeps owner CAS/idempotency receipts and stale proposals stable across competing connections', async () => {
    const w = world(); w.add('天文'); await w.night();
    const item = w.memory!.store.all('owner')[0]!;
    const second = w.open('competing-writer');
    const command = { itemId: item.id, expectedRevision: item.revision, action: 'pin' as const, operationId: 'same-owner-command' };
    expect(w.mutate(command).code).toBe('changed');
    expect(second.mutate(command).code).toBe('changed');
    expect(w.memory!.store.get('owner', item.id)!.revision).toBe(2);
    expect(second.mutate({ ...command, action: 'ban' }).code).toBe('operation_conflict');
    expect(second.mutate({ ...command, operationId: 'other-owner-command', action: 'ban' }).code).toBe('stale');
    w.propose({ kind: 'patch', itemId: item.id, expectedRevision: item.revision, ownerGeneration: item.ownerGeneration, weight: 0.6, reason: '古い案' });
    await w.night();
    expect(w.memory!.store.candidates('owner', false).at(-1)).toMatchObject({ status: 'rejected', code: 'stale' });
  });

  it('rejects undo of an older content version even when the latest content happens to be identical', async () => {
    const w = world(); w.add('天文'); await w.night();
    const original = w.memory!.snapshot('owner').changes[0]!;
    let item = original.after;
    w.propose({ kind: 'patch', itemId: item.id, expectedRevision: item.revision, ownerGeneration: item.ownerGeneration,
      description: item.description, weight: item.weight, reason: item.reason, evidenceRefs: item.evidenceRefs });
    await w.night();
    item = w.memory!.store.get('owner', item.id)!;
    expect(w.mutate({ itemId: item.id, expectedRevision: item.revision, action: 'undo', changeId: original.changeId }).code).toBe('stale');
    expect(w.memory!.store.get('owner', item.id)?.frozen).toBe(false);
  });

  it('undo keeps owner pin/ban/forget controls and freezes only that item until owner resume', async () => {
    const w = world(); w.add('天文'); w.add('音楽'); await w.night();
    let item = w.memory!.store.all('owner').find(row => row.title === '天文')!;
    const original = w.memory!.snapshot('owner').changes.find(change => change.itemId === item.id)!;
    w.mutate({ itemId: item.id, expectedRevision: item.revision, action: 'pin' });
    item = w.memory!.store.get('owner', item.id)!;
    expect(w.mutate({ itemId: item.id, expectedRevision: item.revision, action: 'undo', changeId: original.changeId }).code).toBe('changed');
    item = w.memory!.store.get('owner', item.id)!;
    expect(item).toMatchObject({ pinned: true, frozen: true, retired: true });
    w.advance(86_400_000); w.add('天文'); w.add('植物'); await w.night();
    expect(w.memory!.store.all('owner').find(row => row.title === '植物')).toBeTruthy();
    expect(w.memory!.store.candidates('owner', false).at(-2)).toMatchObject({ code: 'owner_control' });
    w.mutate({ itemId: item.id, expectedRevision: item.revision, action: 'resume' });
    item = w.memory!.store.get('owner', item.id)!;
    w.mutate({ itemId: item.id, expectedRevision: item.revision, action: 'unpin' });
    w.advance(86_400_000); w.add('天文'); await w.night();
    expect(w.memory!.store.get('owner', item.id)).toMatchObject({ frozen: false, pinned: false, retired: false, weight: 0.5 });
    expect(w.memory!.store.all('owner').filter(row => row.title === '天文')).toHaveLength(1);
  });

  it('forgets title, topic, reason and evidence in current/detail/history projections, and blocks reintroduction', async () => {
    const w = world(); w.add('秘密の星図'); await w.night();
    const item = w.memory!.store.all('owner')[0]!;
    w.mutate({ itemId: item.id, expectedRevision: item.revision, action: 'forget' });
    const snapshot = w.memory!.snapshot('owner');
    expect(JSON.stringify(snapshot)).not.toContain('秘密の星図');
    expect(JSON.stringify(snapshot)).not.toContain('会話に共鳴した');
    expect(snapshot.items[0]).toMatchObject({ topicKey: '', evidenceRefs: [], forgotten: true });
    expect(w.memory!.projection('owner')).toBe('');
    w.advance(86_400_000); w.add('秘密の星図'); await w.night();
    expect(w.memory!.store.candidates('owner', false).at(-1)).toMatchObject({ status: 'rejected', code: 'owner_control' });
  });

  it('rechecks canonical evidence and disclosure at adoption and every read', async () => {
    const w = world(); const evidence = w.source('秘密です。天文の観測方法を考える。'); w.add('天文', [evidence]); await w.night();
    expect(w.memory!.projection('owner')).toContain('天文');
    expect(w.memory!.projection('owner', peopleAudience(['guest']))).toBe('');
    w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: evidence, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: w.now(), changeReason: 'owner' } });
    expect(w.memory!.projection('owner')).toBe('');
    expect(JSON.stringify(w.memory!.snapshot('owner'))).not.toContain('天文について');
    const op = w.add('観測', [evidence]); await w.night();
    expect(w.outbox.rows().find(row => row.opId === op)).toMatchObject({ status: 'superseded', outcomeCode: 'forgotten' });
    expect(w.memory!.store.all('owner')).toHaveLength(1);
  });

  it('never truncates at either capacity boundary; only the excess proposal is held', async () => {
    const w = world();
    for (let day = 0; day < 6; day++) { w.add(`題材${day}A`); w.add(`題材${day}B`); await w.night(); w.advance(86_400_000); }
    w.add('追加題材'); await w.night();
    expect(w.memory!.snapshot('owner').capacity.used).toBe(12);
    expect(w.memory!.store.candidates('owner').at(-1)).toMatchObject({ status: 'held', code: 'over_capacity' });
    expect([...w.memory!.projection('owner')].length).toBeLessThanOrEqual(1_000);
    const long = world();
    for (let day = 0; day < 6; day++) { long.add(`${day}A${'長'.repeat(78)}`); long.add(`${day}B${'短'.repeat(78)}`); await long.night(); long.advance(86_400_000); }
    expect(long.memory!.snapshot('owner').capacity.used).toBeLessThan(12);
    expect(long.memory!.store.candidates('owner').some(candidate => candidate.code === 'over_capacity')).toBe(true);
    expect([...long.memory!.projection('owner')].length).toBeLessThanOrEqual(1_000);
  });

  it('rolls back item, version, audit, allowance and outbox ACK together if a write fails', async () => {
    const w = world(); w.add('天文');
    w.proposals.propose({ opId: 'night-crash', scopeKey: 'owner', kind: 'self.interest.night', origin: 'sleep', subjectKey: 'self-interest-night', payload: {} });
    const append = w.memory!.store.appendChange.bind(w.memory!.store);
    w.memory!.store.appendChange = () => { throw new Error('STAGED_FAILURE'); };
    await w.writer().runOnce();
    expect(w.memory!.store.all('owner')).toEqual([]);
    expect(w.memory!.store.revision('owner')).toBe(0);
    expect(w.memory!.store.night('owner', selfInterestNightKey(w.now()))).toBeNull();
    expect(w.outbox.rows().find(row => row.opId === 'night-crash')).toMatchObject({ status: 'pending', attempts: 1 });
    w.memory!.store.appendChange = append; w.advance(31_000); await w.writer().drain();
    expect(w.memory!.store.all('owner')).toHaveLength(1);
    expect(w.memory!.store.changes('owner')).toHaveLength(1);
    expect(() => w.memory!.store.save('owner', w.memory!.store.all('owner')[0]!)).toThrow('SELF_INTEREST_WRITER_TRANSACTION_REQUIRED');
  });

  it('allows only one concurrent leased writer to spend the actual-night allowance', async () => {
    const w = world(); const second = w.open('writer-two');
    w.add('天文'); w.add('音楽'); w.add('植物');
    w.proposals.propose({ opId: 'concurrent-night', scopeKey: 'owner', kind: 'self.interest.night', origin: 'sleep', subjectKey: 'self-interest-night', payload: {} });
    const result = await Promise.all([w.writer().runOnce(), second.writer().runOnce()]);
    expect(result).toContain('leased_elsewhere');
    expect(w.memory!.store.all('owner')).toHaveLength(2);
    expect(second.memory!.store.night('owner', selfInterestNightKey(w.now()))).toMatchObject({ added: 2, removed: 0 });
    w.advance(61_000); await second.night();
    expect(w.memory!.store.all('owner')).toHaveLength(2);
  });

  it('keeps removal and partial edits reachable behind a full batch of unverified and excess additions', async () => {
    const w = world(); w.add('天文'); await w.night();
    const item = w.memory!.store.all('owner')[0]!;
    const evidence = [w.source()];
    w.outbox.underLock(w.now(), () => {
      for (let index = 0; index < 205; index++) w.memory!.holdUnverifiedWithin('owner', { candidateId: `old-${index}`, kind: 'add',
        title: `由来不明${index}`, reason: '由来不明', evidenceRefs: [], disclosure: null }, w.now());
      for (let index = 0; index < 205; index++) w.memory!.proposeWithin('owner', { candidateId: `excess-${index}`, kind: 'add',
        title: `候補${index}`, reason: '会話に共鳴した', evidenceRefs: evidence, disclosure: null }, w.now());
    });
    const remove = w.propose({ kind: 'remove', itemId: item.id, expectedRevision: item.revision, ownerGeneration: item.ownerGeneration, reason: '整理する' });
    await w.night();
    expect(w.memory!.store.get('owner', item.id)?.retired).toBe(true);
    expect(w.memory!.store.adoptableCandidates('owner').every(candidate => candidate.code !== 'provenance_unknown')).toBe(true);
    expect(w.outbox.rows().find(row => row.opId === remove)?.status).toBe('applied');
  });
});
