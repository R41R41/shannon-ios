import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalApiKernel, type ShannonApiKernelOptions } from '../../src/infra/http/apiKernel.js';
import { OpenAIResponsesChatModel } from '../../src/infra/models/chatModel.js';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { OpenAIMemoryModelGateway } from '../../src/mind/recall/memoryModels.js';
import { createConfiguredTurnMemoryRecall } from '../../src/mind/recall/turnMemoryRecall.js';
import { createConfiguredVoiceDecisionGateway, VOICE_SKILLS } from '../../src/mind/selectors/voiceDecision.js';

/**
 * The recall scenarios of the stage-2 switched-off proof (`stage2SwitchedOffRecall.test.ts`): turns that recall her knowledge
 * notes, where at ca7cf519 luna navigated a long note by its headings (`selectSections`). Only APIs that existed at ca7cf519 are
 * used here, so the digests can be recorded on ca7cf519 itself (`SHANNON_WRITE_STAGE2_OFF=1` in a worktree of that commit). Never
 * change a scenario of v1.
 */
export interface RecallTurn { kind: 'text' | 'voice'; words: string; extra: Record<string, unknown> }
export interface RecallScenario { name: string; turns: readonly RecallTurn[]; voiceClass?: 'skill_complex' }

export const stage2RecallScenarios: readonly RecallScenario[] = Object.freeze([
  { name: 'text-recall-note', turns: [{ kind: 'text', words: '週のふりかえりの手順を思い出して', extra: {} }] },
  { name: 'text-recall-others', turns: [{ kind: 'text', words: '週のふりかえりの手順を思い出して', extra: { audience: 'others' } }] },
  { name: 'voice-recall-complex', turns: [{ kind: 'voice', words: '週のふりかえりの手順を比べて整理して', extra: {} }], voiceClass: 'skill_complex' },
  { name: 'voice-recall-plain', turns: [{ kind: 'voice', words: '週のふりかえりの手順って覚えてる？', extra: {} }] },
]);

const at = '2026-10-07T03:00:00.000Z';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const digest = (text: string) => createHash('sha256').update(text.replace(UUID, 'ID')).digest('hex').slice(0, 24);

/** A long note with a heading tree (longer than 1,500 characters, so the old path navigates it). */
export const LONG_NOTE = {
  title: '週のふりかえりの手順',
  applicability: '週末にふりかえりをする時',
  body: [
    '## 準備', `${'前の週のメモを集める。'.repeat(60)}`,
    '## 手順', '### 三つ挙げる', `${'良かったことを三つ挙げる。'.repeat(60)}`, '### 一つ決める', `${'来週の一つを決める。'.repeat(60)}`,
    '## 注意', `${'疲れている時は短くする。'.repeat(60)}`,
  ].join('\n'),
};

export interface CapturedRecall { openai: string[]; jev: string[] }

/**
 * Runs every scenario on a fresh kernel over a fresh store with the note, and returns the digests of what was sent. `tree` is a
 * fourth argument of `createConfiguredTurnMemoryRecall` (stage 2, step 8; absent at ca7cf519); `extra` is merged into the kernel's
 * options.
 */
export async function capturedRecallDigests(options: {
  tree?: (fetchers: { jev: typeof fetch }) => unknown;
  extra?: (fetchers: { jev: typeof fetch }) => Partial<ShannonApiKernelOptions>;
  expectStatus?: (status: number, name: string) => void;
} = {}): Promise<Record<string, CapturedRecall>> {
  const out: Record<string, CapturedRecall> = {};
  for (const scenario of stage2RecallScenarios) {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-stage2-recall-'));
    const store = new SQLiteShannonStore({ path: join(directory, 'recall.sqlite'), now: () => at });
    try {
      // Two turns of the owner alone that the note was built from, a day earlier, in another Talk.
      const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };
      const sources = ['先週のふりかえりを一緒にした', '今週もふりかえりをした'].map(words => store.appendTurn('owner', 'thread-source', words, 'うん、三つ挙げようね。', '2026-10-06T03:00:00.000Z',
        { capturedStateVersion: 0, messageEmotion: emotion }).id);
      store.createShannonKnowledge('owner', { title: LONG_NOTE.title, bodyMarkdown: LONG_NOTE.body, applicability: LONG_NOTE.applicability, status: 'confirmed',
        sourceExperienceIds: sources }, at, 'test');
      const captured: CapturedRecall = { openai: [], jev: [] };
      const openai = (async (url: string | URL | Request, init?: RequestInit) => {
        const body = String(init?.body);
        captured.openai.push(digest(body));
        const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
        if (String(url).includes('/embeddings')) {
          const inputs = (JSON.parse(body) as { input: string[] }).input;
          return new Response(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: Array.from({ length: 512 }, (__, slot) => (slot === index ? 1 : 0)) })), usage: { prompt_tokens: 5, total_tokens: 5 } }));
        }
        const parsed = JSON.parse(body) as { text?: { format?: { name?: string } } };
        const name = parsed.text?.format?.name;
        const output = name === 'shannon_knowledge_navigation' ? { nodeIds: ['h2'] } : name === 'shannon_memory_query_rewrite' ? { queries: [] }
          : name === 'shannon_memory_rerank' ? { scores: [] } : null;
        if (output) return new Response(JSON.stringify({ output_text: JSON.stringify(output), usage }));
        const voice = parsed.text?.format === undefined;
        return new Response(JSON.stringify({ output_text: voice ? 'はい、覚えています。' : JSON.stringify({
          reply: 'はい、覚えています。', feeling: null, threadSummary: null, threadTitle: null, taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null,
        }), usage }));
      }) as typeof fetch;
      const jev = (async (_url: string | URL | Request, init?: RequestInit) => {
        captured.jev.push(digest(String(init?.body)));
        const asked = (JSON.parse(String(init?.body)) as { questions: Record<string, { type: string; criteria: Record<string, string> }> }).questions;
        const router: Record<string, unknown> = {
          ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: skill === 'conversation_memory' ? 0.9 : 0.1 }])),
          transcript_reliable: { type: 'noul', noul: 0.95 }, reply_required: { type: 'noul', noul: 0.9 }, solution_wanted: { type: 'noul', noul: 0.7 },
          conversation_class: { type: 'choice', choice: scenario.voiceClass ?? 'skill_simple' }, affect: { type: 'choice', choice: 'bright' },
          affect_intensity: { type: 'choice', choice: 'moderate' }, delivery: { type: 'choice', choice: 'quick' },
          latency_class: { type: 'choice', choice: 'under_3s' }, waiting_scenario: { type: 'choice', choice: 'general' },
          waiting_variant: { type: 'choice', choice: 'steady' }, waiting_affect: { type: 'choice', choice: 'bright' },
          waiting_intensity: { type: 'choice', choice: 'subtle' }, waiting_delivery: { type: 'choice', choice: 'quick' },
        };
        return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(asked).map(([key, question]) => [key, router[key]
          ?? (question.type === 'choice' ? { type: 'choice', choice: Object.keys(question.criteria)[0] } : { type: 'noul', noul: key === 'n1' ? 0.9 : 0.2 })])) }));
      }) as typeof fetch;
      const gateway = new OpenAIMemoryModelGateway({ apiKey: 'test-only', fetcher: openai, now: () => at });
      const tree = options.tree?.({ jev });
      const memoryRecall = (createConfiguredTurnMemoryRecall as (...args: unknown[]) => ReturnType<typeof createConfiguredTurnMemoryRecall>)(store, {}, gateway, ...(tree ? [tree] : []));
      const chatModel = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: openai, now: () => at });
      const voiceDecision = createConfiguredVoiceDecisionGateway({ TYPESAFE_API_KEY: 'jev-test' }, undefined, jev);
      const api = createLocalApiKernel(() => at, { chatModel, voiceDecision, knowledgeStore: store, memoryRecall, ...options.extra?.({ jev }) });
      for (const turn of scenario.turns) {
        const response = await api.dispatch(turn.kind === 'text'
          ? { method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: turn.words, ...turn.extra } }
          : { method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
            scopeKey: 'owner', threadId: 'thread-voice', transcript: turn.words, deviceContext: {
              timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, ...turn.extra,
              userUtterance: { id: `u-${turn.words.length}`, text: turn.words, source: 'speech', rawText: turn.words },
            } } });
        options.expectStatus?.(response.status, `${scenario.name}: ${turn.words}`);
        await api.waitForBackground('owner');
      }
      out[scenario.name] = captured;
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return out;
}
