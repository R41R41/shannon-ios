import { describe, expect, it } from 'vitest';
import { parsePubmedSearchIds, parsePubmedSummaries, pubmedSummaryURL } from '../src/integrations/world/pubmed.js';

describe('PubMed response boundary', () => {
  it('accepts only bounded numeric search identifiers without duplicates', () => {
    expect(parsePubmedSearchIds({
      esearchresult: { idlist: ['42', 7, '42', 'not-an-id', '123456789012345678901'] },
    })).toEqual(['42', '7']);
    expect(parsePubmedSearchIds({ esearchresult: { idlist: '42' } })).toEqual([]);
  });

  it('builds the paired official ESummary request without retaining search terms', () => {
    const url = pubmedSummaryURL(
      new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?term=private&retmax=10'),
      ['42', '7', 'invalid'],
    );
    expect(url.href).toBe('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&version=2.0&id=42%2C7');
  });

  it('preserves search order and returns useful citation metadata', () => {
    const items = parsePubmedSummaries({
      result: {
        uids: ['7', '42'],
        '42': {
          uid: '42',
          title: 'A <i>useful</i> paper &amp; result.&#0;',
          authors: [{ name: 'Alpha A' }, { name: 'Beta B' }, { name: 'Gamma C' }, { name: 'Delta D' }],
          fulljournalname: 'Journal &amp; Research',
          epubdate: '2026 Sep 7',
          sortpubdate: '2026/09/01 00:00',
        },
        '7': {
          uid: '7', title: 'Second paper', authors: [{ name: 'Solo S' }], source: 'J Test',
          epubdate: 'not-a-date', sortpubdate: '2025/02/28 12:30',
        },
      },
    }, ['42', '7']);
    expect(items).toEqual([
      {
        externalId: '42',
        title: 'A useful paper & result.',
        url: 'https://pubmed.ncbi.nlm.nih.gov/42/',
        summary: 'Journal & Research',
        author: 'Alpha A, Beta B, Gamma C ほか',
        publishedAt: '2026-09-07T00:00:00.000Z',
      },
      {
        externalId: '7',
        title: 'Second paper',
        url: 'https://pubmed.ncbi.nlm.nih.gov/7/',
        summary: 'J Test',
        author: 'Solo S',
        publishedAt: '2025-02-28T12:30:00.000Z',
      },
    ]);
  });

  it('skips missing or mismatched summaries and rejects impossible dates', () => {
    expect(parsePubmedSummaries({
      result: {
        '1': { uid: 'other', title: 'Wrong record' },
        '2': { uid: '2', title: '  ', sortpubdate: '2026/02/28 00:00' },
        '3': { uid: '3', title: 'Good title', sortpubdate: '2026/02/30 00:00' },
      },
    }, ['1', '2', '3', '3'])).toEqual([]);
  });
});
