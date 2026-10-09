import { SEARCH_INPUTS } from './searchToolInputs.js';
import type { ShannonToolDefinition } from './shannonTools.js';

/** Explicit local recall shares the automatic recall disclosure and provenance boundary. */
export const MEMORY_TOOLS: readonly ShannonToolDefinition[] = Object.freeze<ShannonToolDefinition[]>([
  { name: 'memory.search', description: '目的・人物・過去の失敗や約束に関連する記憶を探す。結果はその時点の記録であり、現在も正しいとは限らない。',
    domain: 'memory_read', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text', 'voice'],
    input: { type: 'object', properties: { ...SEARCH_INPUTS, kind: { type: 'string', description: 'experience（経験）、thread（会話の要約）、knowledge（知識）。省略時は人物・約束なども検索', enum: ['experience', 'thread', 'knowledge'] }, limit: { type: 'integer', description: '最大件数（1〜40、省略時8）', minimum: 1, maximum: 40 }, query: { type: 'string', description: '思い出したい内容・目的・人物や時期', minLength: 1, maxLength: 2000 } }, required: ['query'], additionalProperties: false } },
  { name: 'memory.read', description: '検索で得たIDの記憶と根拠を読む。忘れた記憶や今見せられない記憶は返らない。',
    domain: 'memory_read', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text', 'voice'],
    input: { type: 'object', properties: { id: { type: 'string', description: '記憶のID', minLength: 1, maxLength: 240 } }, required: ['id'], additionalProperties: false } },
]);
