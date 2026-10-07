import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { selfInterestWorld } from './support/selfInterestWorld.js';

const worlds: ReturnType<typeof selfInterestWorld>[] = [];
const world = () => { const w = selfInterestWorld(); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });

describe('current-visible canonical self-interest evidence detail', () => {
  it('shows bounded original user excerpts and explicit omissions without projecting evidence into the index', async () => {
    const w = world();
    const refs = Array.from({ length: 16 }, (_, index) => w.source(`元の発言-${index}。${'天文を観測したい。'.repeat(60)}`));
    w.add('天文', refs); await w.night();
    const item = w.memory!.snapshot('owner').items[0]!;
    const detail = w.memory!.detail('owner', item.id)!;
    expect(detail.evidence).toMatchObject({ status: 'available', total: 16, omitted: 9 });
    expect(detail.evidence.items).toHaveLength(7);
    expect(detail.evidence.items.every(row => row.truncated && [...row.text].length <= 240)).toBe(true);
    expect(detail.evidence.items.reduce((sum, row) => sum + [...row.text].length, 0)).toBe(1_600);
    expect(detail.evidence.items[0]!.text).toContain('元の発言-0');
    expect(JSON.stringify(detail.evidence)).not.toContain('会話に共鳴した');
    expect(w.memory!.projection('owner')).not.toContain('元の発言-');
  });

  it('rechecks current correction and forgetting without returning the superseded private source', async () => {
    const w = world(); const source = w.source('SENTINEL-ORIGINAL-EVIDENCE を観測したい。'); w.add('天文', [source]); await w.night();
    const item = w.memory!.snapshot('owner').items[0]!;
    w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: source, kind: 'experience', status: 'active', pinned: false,
      updatedAt: w.now(), changeReason: 'owner', overrideText: '訂正後の公開できる発言。' } });
    expect(w.memory!.detail('owner', item.id)!.evidence.items).toEqual([{ id: source, text: '訂正後の公開できる発言。', truncated: false }]);
    expect(JSON.stringify(w.memory!.detail('owner', item.id)!.evidence)).not.toContain('SENTINEL-ORIGINAL');
    w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: source, kind: 'experience', status: 'forgotten', pinned: false,
      updatedAt: w.now(), changeReason: 'owner' } });
    expect(w.memory!.detail('owner', item.id)!.evidence).toEqual({ status: 'hidden', total: 0, omitted: 0, items: [] });
    expect(JSON.stringify(w.memory!.detail('owner', item.id))).not.toContain('SENTINEL-ORIGINAL');
  });

  it('distinguishes unavailable original references from known forgetting, exposing no candidate/private trace fallback', async () => {
    const w = world(); const source = w.source('SENTINEL-UNAVAILABLE を観測したい。'); w.add('天文', [source]); await w.night();
    const item = w.memory!.snapshot('owner').items[0]!;
    const db = new DatabaseSync(w.path);
    db.prepare('DELETE FROM experience_events WHERE event_id=?').run(source); db.close();
    const detail = w.memory!.detail('owner', item.id)!;
    expect(detail.evidence).toEqual({ status: 'unavailable', total: 0, omitted: 0, items: [] });
    expect(JSON.stringify(detail)).not.toContain('SENTINEL-UNAVAILABLE');
    expect(detail.item.title).toBe('（表示しない関心）');
  });

  it('never displays forgotten interest evidence even when the original source remains present', async () => {
    const w = world(); w.add('天文'); await w.night(); const item = w.memory!.snapshot('owner').items[0]!;
    w.mutate({ itemId: item.id, expectedRevision: item.revision, action: 'forget' });
    expect(w.memory!.detail('owner', item.id)!.evidence).toEqual({ status: 'hidden', total: 0, omitted: 0, items: [] });
  });
});
