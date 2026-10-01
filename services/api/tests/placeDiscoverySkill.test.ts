import { describe, expect, it } from 'vitest';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/chatModel.js';
import { combinedPlaceSources, placeSkillReply, runPlaceDiscoverySkill, spokenPlaceReply } from '../src/placeDiscoverySkill.js';

describe('place discovery skill', () => {
  it('returns bounded candidate data for later skills without sending private history', async () => {
    let searchRequest: ShannonChatModelRequest | undefined;
    const model: ShannonChatModel = { mode: 'openai', model: 'test',
      async generate(request) {
        searchRequest = request;
        return { mode: 'openai', model: 'test', reply: '候補です', places: [
          { name: '浜松城公園', address: '浜松市', reason: '散歩', mapQuery: '浜松城公園 浜松市', mapUrl: 'https://invalid.example' },
          { name: '住所なし', address: '', reason: '不明', mapQuery: '住所なし', mapUrl: '' },
        ], webSources: [{ title: '市の案内', url: 'https://city.example/park' }] };
      },
    };
    const result = await runPlaceDiscoverySkill(model, { scopeKey: 'owner',
      message: '浜松の公園と天気を教えて', context: { spoken: true } });
    expect(searchRequest).toMatchObject({ history: [], useWebSearch: true, placeSearch: { spoken: true } });
    expect(result.places).toHaveLength(1);
    expect(result.places[0]?.mapUrl).toMatch(/^https:\/\/maps\.apple\.com\//);
    expect(result.prompt).toContain('浜松城公園');
    expect(result.prompt).not.toContain('住所なし');
    expect(combinedPlaceSources(result, [{ title: '重複', url: 'https://city.example/park' }])).toEqual(result.webSources);
  });

  it('passes an empty search result to synthesis without adding a map link', async () => {
    const model: ShannonChatModel = { mode: 'openai', model: 'test',
      async generate() { return { mode: 'openai', model: 'test', reply: '', places: [] }; },
    };
    const result = await runPlaceDiscoverySkill(model, { scopeKey: 'owner',
      message: '近くのカフェを探して', context: { spoken: false } });
    expect(result.prompt).toContain('Candidates: []');
    expect(placeSkillReply({ mode: 'openai', model: 'test', reply: '現在地を教えてください。' }, result))
      .toBe('現在地を教えてください。');
  });

  it('keeps place names and weather while removing generated links from speech', () => {
    expect(spokenPlaceReply('浜松城公園です。[地図で開く](https://maps.apple.com/?q=hamamatsu) 今日の天気は晴れです。参照: https://weather.example/today'))
      .toBe('浜松城公園です。地図で開く 今日の天気は晴れです。参照:');
  });
});
