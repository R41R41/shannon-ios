import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SHANNON_ONE_LINE_VOICE_INNER } from '@shannon/cognition';
import {
  COMMITMENT_LINE_INSTRUCTIONS, commitmentLineInstructions, commitmentRequest, groundedCommitmentLine, neutralCommitmentLine, type CommitmentFacts, type CommitmentLineWriter,
} from '../src/mind/action/respond/commitmentLine.js';
import { commitmentFacts, commitmentLinePreparer } from '../src/wiring/commitmentLinesWiring.js';
import { extractProspectiveMemories } from '../src/mind/memory/prospectiveMemory.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteInitiativeSources } from '../src/surfaces/outreach/store/initiativeSources.js';
import { apiSourceFile } from './support/sources.js';

/**
 * A promise's notice in her own words (owner decision 2026-10-14): written at the moment it is due from its facts alone, checked to
 * state the promise correctly, and the neutral factual line when it cannot be written or trusted, so a promise is never lost. It is
 * system delivery of something he asked for: no moment cap, no mood, no inner note; with anyone else present, private-safe.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-commitment-line-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const SAID = '2026-09-24T01:00:00.000Z';
const NINE = '2026-09-25T00:00:00.000Z'; // 09:00 in Tokyo, the day after
const ALONE: CommitmentFacts = { title: '明日プレゼンの練習しよう', when: '今日', overdueMinutes: null, others: false };

describe('the line', () => {
  it('is used only when it states the promise: named while he is alone, and no number the facts do not hold', () => {
    expect(groundedCommitmentLine('ライ氏、明日プレゼンの練習しよう、の約束の時間です。準備できてますか？', ALONE)).toContain('プレゼンの練習');
    expect(groundedCommitmentLine('ライ氏、そろそろあの約束の時間ですよ。', ALONE)).toBeNull();
    expect(groundedCommitmentLine('ライ氏、明日プレゼンの練習しよう、の約束です。15時からですね。', ALONE)).toBeNull();
    const timed: CommitmentFacts = { title: '歯医者に電話する', when: '14:00', overdueMinutes: 20, others: false };
    expect(groundedCommitmentLine('ライ氏、14:00の歯医者に電話する約束、20分過ぎてますよ。', timed)).not.toBeNull();
    expect(groundedCommitmentLine('', ALONE)).toBeNull();
    expect(groundedCommitmentLine({ line: 1 }, ALONE)).toBeNull();
  });

  it('does not name the promise with anyone else present, and is not told it', () => {
    const others = { ...ALONE, others: true };
    expect(groundedCommitmentLine('ライ氏、約束の時間になりましたよ。', others)).not.toBeNull();
    expect(groundedCommitmentLine('ライ氏、明日プレゼンの練習しようの時間です。', others)).toBeNull();
    expect(commitmentRequest(others)).not.toContain('プレゼン');
    expect(commitmentRequest(ALONE)).toContain('プレゼン');
    expect(neutralCommitmentLine(others)).not.toContain('プレゼン');
  });

  it('falls back to one neutral factual line, the only fixed text for a promise, never in her voice', () => {
    expect(neutralCommitmentLine({ title: '歯医者に電話する', when: '14:00', others: false })).toBe('約束：「歯医者に電話する」（14:00）');
    const source = readFileSync(apiSourceFile('initiativeStore.ts'), 'utf8');
    expect(source).not.toContain('という約束が残っています');
    expect(source).not.toContain('今、続けますか');
  });

  it('is written from the promise\'s facts alone: nothing of her mood, her inner note or a moment', () => {
    const request = JSON.parse(commitmentRequest({ title: '歯医者に電話する', when: '14:00', overdueMinutes: 5, others: false })) as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(['due', 'others_present', 'promise', 'state']);
    expect(COMMITMENT_LINE_INSTRUCTIONS).not.toMatch(/sulk|mood|feeling|すね|気分/iu);
    expect(COMMITMENT_LINE_INSTRUCTIONS).toMatch(/Never add a place, a person, a time, a date/u);
    // Syzygy ADR-0012 (N7): with SHANNON_INNER_NOTE on, her one-line voice is her core's; off, the bytes of before.
    expect(commitmentLineInstructions(false)).toBe(COMMITMENT_LINE_INSTRUCTIONS);
    expect(commitmentLineInstructions(true)).toContain(SHANNON_ONE_LINE_VOICE_INNER);
    expect(commitmentLineInstructions(true)).not.toMatch(/sulk|mood|feeling|すね|気分/iu);
  });
});

function fixture() {
  const path = join(directory, `promise-${Math.random().toString(36).slice(2)}.sqlite`);
  let now = SAID;
  const state = new SQLiteShannonStore({ path, now: () => now });
  const threadId = state.createThread('owner', 'いつものトーク');
  state.apply('owner', { type: 'prospective-memory-upserted', memory: extractProspectiveMemories('明日プレゼンの練習しよう', SAID)[0]! });
  const initiatives = new SQLiteInitiativeStore(path, () => now);
  const sources = new SQLiteInitiativeSources(path);
  const close = () => { sources.close(); initiatives.close(); state.close(); };
  return { state, threadId, initiatives, sources, close, setNow: (value: string) => { now = value; } };
}

class FakeWriter implements CommitmentLineWriter {
  readonly asked: CommitmentFacts[] = [];
  constructor(private readonly line: string | null) {}
  async write(_scopeKey: string, facts: CommitmentFacts): Promise<string | null> {
    this.asked.push(facts);
    return this.line === null ? null : groundedCommitmentLine(this.line, facts);
  }
}

describe('at the moment it is due', () => {
  const prepare = (f: ReturnType<typeof fixture>, writer: CommitmentLineWriter | null, others = false) => commitmentLinePreparer({
    writer, scopeKey: 'owner', timeZone: 'Asia/Tokyo', snapshot: scopeKey => f.state.snapshot(scopeKey),
    delivered: (scopeKey, itemId) => f.sources.delivered(scopeKey, itemId), others: () => others,
  });

  it('delivers her own line, written once, on the voiced path (it takes no moment cap)', async () => {
    const f = fixture();
    f.setNow(NINE);
    const writer = new FakeWriter('ライ氏、明日プレゼンの練習しよう、の約束の朝です。いっしょに始めましょうか。');
    const lines = prepare(f, writer);
    const prepared = await lines(NINE);
    expect(writer.asked).toEqual([expect.objectContaining({ title: '明日プレゼンの練習しよう', others: false })]);
    expect(f.initiatives.runOnce(NINE, 'Asia/Tokyo', new Map(), undefined, prepared)).toMatchObject({ sent: 1 });
    expect(f.state.conversationHistory('owner', f.threadId).at(-1)?.content).toBe('ライ氏、明日プレゼンの練習しよう、の約束の朝です。いっしょに始めましょうか。');
    // Told once: nothing more is written or paid for.
    expect(await lines(NINE)).toEqual(new Map());
    expect(writer.asked).toHaveLength(1);
    f.close();
  });

  it('never loses the promise: a write that fails or cannot be trusted gives the neutral factual line', async () => {
    for (const writer of [new FakeWriter(null), new FakeWriter('ライ氏、15時の会議の約束です。'), null]) {
      const f = fixture();
      f.setNow(NINE);
      const prepared = await prepare(f, writer)(NINE);
      expect(f.initiatives.runOnce(NINE, 'Asia/Tokyo', new Map(), undefined, prepared)).toMatchObject({ sent: 1 });
      expect(f.state.conversationHistory('owner', f.threadId).at(-1)?.content).toBe('約束：「明日プレゼンの練習しよう」（今日）');
      f.close();
    }
  });

  it('uses the private-safe wording with anyone else at her body', async () => {
    const f = fixture();
    f.setNow(NINE);
    const writer = new FakeWriter('ライ氏、約束の時間になりましたよ。');
    const prepared = await prepare(f, writer, true)(NINE);
    expect(writer.asked[0]).toMatchObject({ others: true });
    f.initiatives.runOnce(NINE, 'Asia/Tokyo', new Map(), undefined, prepared);
    expect(f.state.conversationHistory('owner', f.threadId).at(-1)?.content).toBe('ライ氏、約束の時間になりましたよ。');
    f.close();
  });

  it('writes nothing in the quiet hours, and states when and how late from the promise itself', async () => {
    const f = fixture();
    const writer = new FakeWriter('x');
    expect(await prepare(f, writer)('2026-09-24T15:00:00.000Z')).toEqual(new Map()); // 00:00 in Tokyo
    expect(writer.asked).toEqual([]);
    expect(commitmentFacts({ title: '歯医者に電話する', published_at: '2026-09-25T05:00:00.000Z' }, '2026-09-25T05:20:00.000Z', 'Asia/Tokyo', false))
      .toEqual({ title: '歯医者に電話する', when: '14:00', overdueMinutes: 20, others: false, dueOn: { month: 9, day: 25, weekday: '金' } });
    f.close();
  });
});
