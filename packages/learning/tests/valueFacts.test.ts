import { describe, expect, it } from 'vitest';
import { VALUE_FACTS_HEADER, foldValues, valueCells, valueFactsSection, type ValueEvidence } from '../src/index.js';

const HOUR = 60 * 60_000;
const evidence = (choice: string, context: string, reward: number, index: number): ValueEvidence => ({
  choice, context, reward, world: 0.1, serve: reward > 0 ? 1 : 0, growth: 0.5, costYen: 12.4, settledAt: new Date(Date.UTC(2026, 9, 7) + index * HOUR).toISOString(),
});

describe('the value facts', () => {
  const cells = valueCells(foldValues([
    ...Array.from({ length: 9 }, (_, index) => evidence('reach_out.wonder', 'night.alone', index % 3 ? 0.4 : -0.2, index)),
    ...Array.from({ length: 4 }, (_, index) => evidence('read', 'afternoon.alone', 0.3, 20 + index)),
    ...Array.from({ length: 3 }, (_, index) => evidence('tool.study.search', 'night.others', 0.2, 30 + index)),
  ]));

  it('give one line of facts per offered choice with evidence, for the moment she is in, in a fixed order', () => {
    const section = valueFactsSection(cells, ['read', 'reach_out.wonder', 'draft', 'tool.study.search'], 'night.alone')!;
    const lines = section.split('\n');
    expect(lines[0]).toBe(VALUE_FACTS_HEADER);
    expect(lines[1]).toMatch(/^- 話しかける・いま何をしているか気になった（夜・ひとり）: [+−]\d\.\d{2} ±\d\.\d{2}（9回。世界0\.10／ライ氏\d\.\d{2}／成長0\.50／費用12円）$/u);
    // No evidence at night for reading: the choice as a whole answers; a draft has none at all: no line. Tools come last.
    expect(lines[2]).toMatch(/^- 公開ページを読む: /u);
    expect(lines[3]).toMatch(/^- 道具「study\.search」を使う（夜）: .*（3回。/u);
    expect(lines).toHaveLength(4);
  });

  it('give nothing without evidence, nothing for a choice not offered, and never more than eight lines', () => {
    expect(valueFactsSection(cells, ['draft', 'show'], 'night.alone')).toBeNull();
    expect(valueFactsSection([], ['read'], 'night.alone')).toBeNull();
    const many = valueCells(foldValues(['read', 'notion', 'note', 'draft', 'revise', 'show', 'look', 'jot', 'copy', 'put_away'].map((choice, index) => evidence(choice, 'night.alone', 0.1, index))));
    const section = valueFactsSection(many, ['read', 'notion', 'note', 'draft', 'revise', 'show', 'look', 'jot', 'copy', 'put_away'], 'night.alone')!;
    expect(section.split('\n')).toHaveLength(9);
    expect(section).not.toMatch(/すべき|しよう|おすすめ/u);
  });
});
