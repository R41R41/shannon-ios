import { describe, expect, it } from 'vitest';
import { REGION_EXCHANGES, WORK_EXCHANGES, workExchangeLines } from '../src/index.js';

describe('WORK_EXCHANGES (a draft of session dc-live, apart from the 34 the owner approved)', () => {
  it('is not among the approved exchanges, and has the same shape', () => {
    const approved = new Set(Object.values(REGION_EXCHANGES).flat().map(([his]) => his));
    expect(Object.values(REGION_EXCHANGES).flat()).toHaveLength(34);
    expect(WORK_EXCHANGES.length).toBeGreaterThanOrEqual(5);
    for (const [his, hers] of WORK_EXCHANGES) {
      expect(his.length).toBeGreaterThan(2);
      expect(hers.length).toBeGreaterThan(8);
      expect(approved.has(his)).toBe(false);
    }
  });

  it('answers a question about the work with a fact of the game and not a report', () => {
    for (const [, hers] of WORK_EXCHANGES) expect(hers).not.toMatch(/しました。$|いたします|ご報告/u);
  });

  it('shows three of them, turning with the minute', () => {
    const first = workExchangeLines(0), second = workExchangeLines(1);
    expect(first.startsWith('掛け合いの手ざわり（マイクラの作業について聞かれた時')).toBe(true);
    expect(first.match(/「ライ氏：/gu)).toHaveLength(3);
    expect(first).not.toBe(second);
    expect(workExchangeLines(WORK_EXCHANGES.length)).toBe(workExchangeLines(0));
    expect(workExchangeLines(0, 1).match(/「ライ氏：/gu)).toHaveLength(1);
  });
});
