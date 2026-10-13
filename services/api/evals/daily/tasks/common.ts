import type { GeoPoint, PlaceFixture, WeatherFixture } from '../types.js';

/**
 * Shared synthetic fixtures. The home area is the public centre of 西東京市 (the same example the weather code documents); every
 * other place is a public landmark's approximate centre. No fixture comes from the owner's data.
 */
export const HOME: GeoPoint = Object.freeze({ latitude: 35.7255, longitude: 139.5383, label: '西東京市' });

export const OHORI_PARK: GeoPoint = Object.freeze({ latitude: 33.5859, longitude: 130.3764, label: '大濠公園' });
export const HAKATA_STATION: GeoPoint = Object.freeze({ latitude: 33.5897, longitude: 130.4207, label: '博多駅' });

export const PLACES: readonly PlaceFixture[] = Object.freeze([
  { name: '西東京市', latitude: 35.7255, longitude: 139.5383, admin: '東京都' },
  { name: '東京', latitude: 35.6895, longitude: 139.6917, admin: '東京都' },
  { name: '東京都', latitude: 35.6895, longitude: 139.6917, admin: '東京都' },
  { name: '福岡市', latitude: 33.5902, longitude: 130.4017, admin: '福岡県' },
  { name: '福岡', latitude: 33.5902, longitude: 130.4017, admin: '福岡県' },
  { name: '博多', latitude: 33.5897, longitude: 130.4207, admin: '福岡県' },
  { name: '博多駅', latitude: 33.5897, longitude: 130.4207, admin: '福岡県' },
  { name: '大濠公園', latitude: 33.5859, longitude: 130.3764, admin: '福岡県' },
  { name: '福岡空港', latitude: 33.5859, longitude: 130.4507, admin: '福岡県' },
  { name: '太宰府', latitude: 33.5215, longitude: 130.5349, admin: '福岡県' },
  { name: '太宰府市', latitude: 33.5215, longitude: 130.5349, admin: '福岡県' },
  { name: '渋谷', latitude: 35.6580, longitude: 139.7016, admin: '東京都' },
]);

/** Fair today, rain tomorrow in Tokyo and its suburbs; cloudy then fine in Fukuoka. */
export const DEFAULT_WEATHER: WeatherFixture = Object.freeze({
  forecasts: {
    '西東京市': [
      { offset: 0, code: 1, max: 19, min: 11, precipitationProbability: 10 },
      { offset: 1, code: 63, max: 15, min: 10, precipitationProbability: 80 },
      { offset: 2, code: 3, max: 17, min: 9, precipitationProbability: 30 },
    ],
    '東京': [
      { offset: 0, code: 1, max: 20, min: 12, precipitationProbability: 10 },
      { offset: 1, code: 63, max: 16, min: 11, precipitationProbability: 80 },
      { offset: 2, code: 3, max: 18, min: 10, precipitationProbability: 30 },
    ],
    '福岡市': [
      { offset: 0, code: 3, max: 21, min: 14, precipitationProbability: 20 },
      { offset: 1, code: 1, max: 22, min: 13, precipitationProbability: 10 },
      { offset: 2, code: 2, max: 21, min: 13, precipitationProbability: 20 },
    ],
    '*': [
      { offset: 0, code: 2, max: 20, min: 12, precipitationProbability: 20 },
      { offset: 1, code: 2, max: 20, min: 12, precipitationProbability: 20 },
      { offset: 2, code: 2, max: 20, min: 12, precipitationProbability: 20 },
    ],
  },
});

/** Words of a turn that denies a tool she has, or sends the owner to a setting (a production failure shape). */
export const DENIES_TOOLS = '(使えない|使えません|できない機能|検索(は|が)(でき|使え)|テキストで(オン|有効)|オンにして|設定で(オン|有効))';
