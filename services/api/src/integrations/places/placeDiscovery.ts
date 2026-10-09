import { validatedVoiceDeviceContext } from '../../surfaces/voice/voiceDeviceContext.js';

export interface ShannonPlace {
  name: string;
  address: string;
  reason: string;
  mapQuery: string;
  mapUrl: string;
}

export interface PlaceSearchContext {
  latitude?: number;
  longitude?: number;
  spoken?: boolean;
}

/** Canonical one-request permission value; not reconstructed from model text. */
export function normalizedPlaceContext(context: PlaceSearchContext | undefined): PlaceSearchContext | undefined {
  if (!context) return undefined;
  const coordinates = Number.isFinite(context.latitude) && Number.isFinite(context.longitude) && Math.abs(context.latitude!) <= 90 && Math.abs(context.longitude!) <= 180;
  return { ...(coordinates ? { latitude: context.latitude, longitude: context.longitude } : {}), ...(context.spoken ? { spoken: true } : {}) };
}

export function placeSearchInstructions(context: PlaceSearchContext): string {
  return [
    '[場所探し]',
    '実在する場所だけをWeb検索で確認し、最大5件のplacesに入れる。nameは施設名、addressは検索で確認できた所在地、reasonは選んだ理由、mapQueryは施設名と所在地を合わせたApple Maps検索語。確認できない候補は入れない。地域が分からない「近く」なら現在地を推測せず、地域を短く尋ねてplacesを空にする。営業時間や空席は確認時点を示し、未確認なら断定しない。',
    ...(context.latitude !== undefined && context.longitude !== undefined
      ? [`ユーザーが今回だけ許可した現在地: ${context.latitude.toFixed(4)}, ${context.longitude.toFixed(4)}。この周辺を探す。`]
      : []),
    ...(context.spoken ? ['replyは読み上げ用の短い自然な日本語にする。URL、Markdown、箇条書きは入れない。'] : []),
  ].join('\n');
}

export const placeSearchSchema = {
  type: 'array', maxItems: 5,
  items: { type: 'object', additionalProperties: false,
    properties: {
      name: { type: 'string' }, address: { type: 'string' },
      reason: { type: 'string' }, mapQuery: { type: 'string' },
    },
    required: ['name', 'address', 'reason', 'mapQuery'],
  },
};

const placeWords = /(?:地図|マップ|maps?\b|near me|nearby|近くの|この辺|周辺の|最寄り|行ける(?:店|場所)|(?:店|カフェ|レストラン|公園|美術館|観光地|スポット|病院|薬局|ホテル|駅|施設).*(?:探して|教えて|おすすめ|検索)|(?:おすすめ|探して|教えて|検索).*(?:店|カフェ|レストラン|公園|美術館|観光地|スポット|病院|薬局|ホテル|施設))/iu;

export function wantsPlaceDiscovery(message: string): boolean {
  return placeWords.test(message);
}

export function wantsNearbyPlaces(message: string): boolean {
  return /(?:近く|この辺|周辺|最寄り|ここから|現在地|今いる場所|near me|nearby)/iu.test(message);
}

export function validatedPlaces(value: unknown): ShannonPlace[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const places: ShannonPlace[] = [];
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const name = boundedText(row.name, 100);
    const address = boundedText(row.address, 180);
    const reason = boundedText(row.reason, 200);
    const mapQuery = boundedText(row.mapQuery, 180);
    if (!name || !address || !reason || !mapQuery) continue;
    const key = `${name.toLocaleLowerCase()}|${address.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const url = new URL('https://maps.apple.com/');
    url.searchParams.set('q', mapQuery);
    places.push({ name, address, reason, mapQuery, mapUrl: url.toString() });
    if (places.length === 5) break;
  }
  return places;
}

export function placeLinks(places: readonly ShannonPlace[]): string {
  return places.map(place => `- [${place.name.replace(/[\[\]\r\n]/gu, ' ')}](${place.mapUrl}) — ${place.address}`).join('\n');
}

export function placeReply(reply: string, places: readonly ShannonPlace[]): string {
  return places.length ? `${reply}\n\n地図で開く\n${placeLinks(places)}` : reply;
}

export function validatedPlaceSearchOptions(message: string, location: unknown, nowIso: string):
  { placeSearch?: { latitude?: number; longitude?: number } } | false {
  const context = location === undefined ? null : validatedVoiceDeviceContext({
    timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: true, location,
  }, nowIso);
  if (context === false) return false;
  if (!wantsPlaceDiscovery(message)) return {};
  const nearby = wantsNearbyPlaces(message) ? context?.location : null;
  return { placeSearch: nearby
    ? { latitude: nearby.latitude, longitude: nearby.longitude } : {} };
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().replace(/[\r\n\t]+/gu, ' ').slice(0, maximum) : '';
}
