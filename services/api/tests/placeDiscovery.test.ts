import { describe, expect, it } from 'vitest';
import { validatedPlaceSearchOptions, wantsPlaceDiscovery, validatedPlaces } from '../src/integrations/places/placeDiscovery.js';

describe('place discovery', () => {
  it('recognizes place requests with the recommendation first or last', () => {
    expect(wantsPlaceDiscovery('おすすめのカフェを教えて')).toBe(true);
    expect(wantsPlaceDiscovery('浜松のカフェを検索して')).toBe(true);
    expect(wantsPlaceDiscovery('近くの公園')).toBe(true);
    expect(wantsPlaceDiscovery('今日の予定を教えて')).toBe(false);
  });

  it('uses location only for a nearby place request', () => {
    const location = { latitude: 34.7, longitude: 137.7, accuracyMeters: 24,
      observedAt: '2026-09-22T01:37:55.000Z' };
    const now = '2026-09-22T01:38:00.000Z';
    expect(validatedPlaceSearchOptions('この近くの公園', location, now))
      .toEqual({ placeSearch: { latitude: 34.7, longitude: 137.7 } });
    expect(validatedPlaceSearchOptions('浜松の公園を探して', location, now))
      .toEqual({ placeSearch: {} });
  });

  it('creates Apple Maps URLs from search terms and drops incomplete places', () => {
    expect(validatedPlaces([{ name: '浜松城公園', address: '浜松市', reason: '散歩', mapQuery: '浜松城公園 浜松市' },
      { name: '未確認', address: '', reason: '散歩', mapQuery: '未確認' }]))
      .toMatchObject([{ name: '浜松城公園', mapUrl: expect.stringMatching(/^https:\/\/maps\.apple\.com\/\?q=/) }]);
  });
});
