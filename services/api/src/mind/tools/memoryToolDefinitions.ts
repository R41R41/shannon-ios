import type { ShannonToolDefinition } from './shannonTools.js';

/** Explicit local recall shares the automatic recall disclosure and provenance boundary. */
export const MEMORY_TOOLS: readonly ShannonToolDefinition[] = Object.freeze<ShannonToolDefinition[]>([
  { name: 'memory.search', description: '目的・人物・過去の失敗や約束に関連する記憶を探す。結果はその時点の記録であり、現在も正しいとは限らない。',
    domain: 'memory_read', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text', 'voice'],
    input: { type: 'object', properties: { query: { type: 'string', description: '思い出したい内容・目的・人物や時期', minLength: 1, maxLength: 2000 } }, required: ['query'], additionalProperties: false } },
  { name: 'memory.read', description: '検索で得たIDの記憶と根拠を読む。忘れた記憶や今見せられない記憶は返らない。',
    domain: 'memory_read', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text', 'voice'],
    input: { type: 'object', properties: { id: { type: 'string', description: '記憶のID', minLength: 1, maxLength: 240 } }, required: ['id'], additionalProperties: false } },
]);
