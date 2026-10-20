import { describe, expect, it } from 'vitest';
import { WORK_AGENDA_LIMITS, WorkAgenda, agendaLines } from '../src/index.js';

describe('work agenda (mb-arch)', () => {
  it('keeps what the executor did, tells it once per reader, and says the running item', () => {
    const agenda = new WorkAgenda();
    const filler = agenda.begin('filler', 'mc.mine-block', 'まだ要る鉄が近い', 1_000);
    expect(agenda.running()).toMatchObject({ seq: filler, tool: 'mc.mine-block', endedAt: null });
    agenda.end(filler, true, '鉄を 3 個掘った', 6_000);
    const failed = agenda.begin('interrupt', 'mc.dig-block-at', '置かれたベッドを持つ', 7_000);
    agenda.end(failed, false, 'distance_too_far', 8_000);
    agenda.begin('planner', 'mc.move-to', '頼まれた手', 9_000);
    const since = agenda.since(0);
    expect(agendaLines(since.entries)).toEqual(['待つ間に: mc.mine-block（まだ要る鉄が近い）→ 鉄を 3 個掘った',
      '割り込み: mc.dig-block-at（置かれたベッドを持つ）→ できなかった: distance_too_far']);
    expect(agenda.since(since.cursor).entries).toEqual([]);
    agenda.end(failed, true, 'again', 10_000);
    expect(agenda.since(0).entries[1]!.ok).toBe(false);
  });

  it('keeps at most the bounded number of entries and cuts long notes', () => {
    const agenda = new WorkAgenda();
    for (let i = 0; i < WORK_AGENDA_LIMITS.kept + 5; i++) agenda.end(agenda.begin('filler', 'mc.x', 'why', i), true, 'x'.repeat(300), i);
    const entries = agenda.since(0).entries;
    expect(entries).toHaveLength(WORK_AGENDA_LIMITS.kept);
    expect(entries[0]!.note!.length).toBe(WORK_AGENDA_LIMITS.note);
  });
});
