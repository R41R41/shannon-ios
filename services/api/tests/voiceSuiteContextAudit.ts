/** Read-only audit: synthetic turns, in-memory kernel, no production writes.
 * SHANNON_AUDIT_LIVE=1 deliberately enables billable Jev/model calls.
 * Run with node --import tsx services/api/tests/voiceSuiteContextAudit.ts.
 */
import { createLocalApiKernel } from '../src/apiKernel.js';
import { createConfiguredChatModel, type ShannonChatModel, type ShannonChatModelRequest,
  type ShannonVoiceModelRequest } from '../src/chatModel.js';
import { createConfiguredVoiceDecisionGateway, LocalVoiceDecisionGateway,
  type VoiceSkill } from '../src/voiceDecision.js';
import { VoiceRequestAllowances } from '../src/serverHttp.js';

const cases: Array<{ id: string; transcript: string; skills: VoiceSkill[] }> = [
  // Product definitions should not require reading private notes/tasks.
  { id: 'latin-both', transcript: 'AetherとVoyagerの使い分けを教えて', skills: [] },
  { id: 'kana-both', transcript: 'エーテルとボイジャーの使い分けを教えて', skills: [] },
  { id: 'kana-aether', transcript: 'エーテルに書いた設計を見たい', skills: ['aether_notes'] },
  { id: 'kana-voyager', transcript: 'ボイジャーに登録した予定を見たい', skills: ['voyager_tasks'] },
  { id: 'kana-with-note', transcript: 'エーテルのノートを確認して', skills: ['aether_notes'] },
  { id: 'kana-with-task', transcript: 'ボイジャーのタスクを確認して', skills: ['voyager_tasks'] },
  { id: 'kana-latest', transcript: 'エーテルとボイジャーの最新の開発状況を確認したい', skills: ['aether_notes', 'voyager_tasks'] },
];
const live = process.env.SHANNON_AUDIT_LIVE === '1';
if (live && (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_API_KEY)) {
  throw new Error('Live audit requires deliberately supplied server-side credentials');
}
const router = live ? createConfiguredVoiceDecisionGateway(process.env) : new LocalVoiceDecisionGateway();
const model = live ? createConfiguredChatModel(process.env) : undefined;
const results = [];
for (const item of cases) {
  const decision = await router.decide({ scopeKey: `synthetic-suite-audit:${item.id}`,
    transcript: item.transcript, participantMode: 'owner', requestedLocation: false, hasFreshLocation: false });
  // Live answer generation is limited to two synthetic definition questions, with no web tool.
  const generateAnswer = live && ['latin-both', 'kana-both'].includes(item.id);
  let prompt = '';
  const inspect = async (request: ShannonChatModelRequest | ShannonVoiceModelRequest) => {
    prompt = request.systemPrompt;
    if (generateAnswer && model?.generateVoice) {
      return model.generateVoice({ ...request, useWebSearch: false, conversationClass: 'direct' });
    }
    return { mode: 'local-stub' as const, model: 'synthetic-audit', reply: '合成の返答です。' };
  };
  const proxy: ShannonChatModel = { mode: 'local-stub', model: 'synthetic-audit',
    generate: inspect, generateVoice: inspect };
  const reads = { notes: 0, tasks: 0 };
  const kernel = createLocalApiKernel(() => new Date().toISOString(), {
    chatModel: proxy, voiceDecision: { ...router, mode: router.mode, model: router.model,
      decide: async () => decision },
    aetherContext: { promptFor: () => { reads.notes++; return ''; } },
    voyagerCatalog: { searchTasks: async () => { reads.tasks++; return []; },
      listProjects: async () => [] },
  });
  const result = await kernel.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
    body: { scopeKey: `synthetic-suite-audit:${item.id}`, threadId: 'synthetic', transcript: item.transcript,
      participantMode: 'owner', deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false,
        userUtterance: { id: item.id, text: item.transcript, rawText: item.transcript, source: 'typed' } } } });
  const missingSkills = item.skills.filter(skill => !decision.selectedSkills.includes(skill));
  const missingReads = item.skills.filter(skill => (
    (skill === 'aether_notes' && reads.notes === 0)
    || (skill === 'voyager_tasks' && reads.tasks === 0)
  ));
  const definitions = {
    aether: /Aether[^\n]{0,160}(?:執筆|文書|思考|ノート)/iu.test(prompt),
    voyager: /Voyager[^\n]{0,160}(?:行動支援|タスク管理|タスク状態)/iu.test(prompt),
  };
  const body = result.body as { reply?: string };
  results.push({ id: item.id, source: decision.source, selectedSkills: decision.selectedSkills,
    missingSkills, missingReads, definitions, reads, httpStatus: result.status,
    decisionMilliseconds: decision.elapsedMilliseconds,
    ...(generateAnswer ? { syntheticReply: body.reply } : {}),
    passed: result.status === 200 && !missingSkills.length && !missingReads.length
      && definitions.aether && definitions.voyager });
}
// Characterize the production voice allowances using synthetic, in-memory requests only.
// Session/delegation requests use the control budget; sentence TTS uses the speech budget.
// This does not stress the live server or establish an actual incident's cause.
const allowances = new VoiceRequestAllowances();
const requestKinds = ['session', 'delegation-1', ...Array(4).fill('tts-1'),
  'delegation-2', ...Array(4).fill('tts-2')];
const allowanceResults = requestKinds.map((kind, index) => ({
  request: index + 1, kind,
  allowed: kind.startsWith('tts')
    ? allowances.consumeSpeech('synthetic-device')
    : allowances.consumeControl('synthetic-device'),
}));
console.log(JSON.stringify({ live, baseline: process.env.SHANNON_AUDIT_BASELINE ?? 'unrecorded',
  safety: 'synthetic inputs; in-memory stores; no external writes',
  voiceAllowances: { controlPerMinute: 30, speechPerMinute: 60, results: allowanceResults },
  cases: results.length, passed: results.filter(item => item.passed).length, results }, null, 2));
if (results.some(item => !item.passed)) process.exitCode = 1;
