import { OpenAISleepMemoryAnalyzer } from '../src/mind/sleep/sleepConsolidation.js';
import { EXPLICIT_MEMORY_DIALOGUE_CASES } from './explicitMemoryDialogueCases.js';

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY is required for the live memory evaluation');

const analyzer = new OpenAISleepMemoryAnalyzer({
  apiKey,
  model: process.env.SHANNON_SLEEP_MODEL?.trim() || process.env.SHANNON_LLM_MODEL?.trim(),
  timeoutMilliseconds: 60_000,
});
const failures: { id: string; reason: string }[] = [];
let proposalCount = 0;

for (let offset = 0; offset < EXPLICIT_MEMORY_DIALOGUE_CASES.length; offset += 5) {
  const batch = EXPLICIT_MEMORY_DIALOGUE_CASES.slice(offset, offset + 5);
  const proposals = await analyzer.analyze(batch.map((dialogue, index) => ({
    content: dialogue.message,
    observedAt: new Date(Date.UTC(2026, 8, 1, 0, offset + index)).toISOString(),
  })));
  proposalCount += proposals.length;

  for (const dialogue of batch) {
    const related = proposals.filter(proposal => sameEvidence(dialogue.message, proposal.evidence));
    if (!dialogue.expected.length) {
      if (related.length) failures.push({ id: dialogue.id, reason: `unexpected: ${related.map(row => row.statement).join(' / ')}` });
      continue;
    }
    for (const expected of dialogue.expected) {
      const normalizedExpected = expected.includes.map(normalizeMeaning);
      const match = related.find(proposal => proposal.kind === expected.kind
        && normalizedExpected.every(fragment => normalizeMeaning(proposal.statement).includes(fragment)));
      if (!match) {
        failures.push({
          id: dialogue.id,
          reason: `missing ${expected.kind}:${expected.includes.join('+')}; got ${related.map(row => `${row.kind}:${row.statement}`).join(' / ') || 'none'}`,
        });
      }
    }
  }
}

const summary = {
  model: process.env.SHANNON_SLEEP_MODEL?.trim() || process.env.SHANNON_LLM_MODEL?.trim() || 'gpt-5.6-luna',
  cases: EXPLICIT_MEMORY_DIALOGUE_CASES.length,
  proposals: proposalCount,
  passed: EXPLICIT_MEMORY_DIALOGUE_CASES.length - new Set(failures.map(failure => failure.id)).size,
  failures,
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 1;

function sameEvidence(message: string, evidence: string): boolean {
  const left = normalize(message);
  const right = normalize(evidence);
  return Boolean(right) && (left.includes(right) || right.includes(left));
}

function normalize(value: string): string {
  return value.replace(/[。！？!?]+$/u, '').replace(/\s+/g, ' ').trim();
}

function normalizeMeaning(value: string): string {
  return normalize(value)
    .replace(/アドバイス/gu, '助言')
    .replace(/好物/gu, '好きな食べ物')
    .replace(/が一番好き/gu, 'が好きな食べ物')
    .replace(/([^。、\s]+)が好き$/u, '好きな食べ物は$1')
    .replace(/好む/gu, '好き')
    .replace(/住んでいます|住んでます/gu, '住んでいる')
    .replace(/しています|してます/gu, 'している')
    .replace(/いらない|不要/gu, '望まない')
    .replace(/嫌い/gu, '苦手');
}
