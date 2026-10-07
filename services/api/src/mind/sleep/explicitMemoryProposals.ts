import type { UserFactProposal } from './sleepConsolidation.js';
import { EXPLICIT_FACT_PATTERNS, RELATIONSHIP_PATTERNS, INTEREST_PATTERNS, appendRuleProposal, deduplicateProposals, normalize, explicitFactStatement } from './sleepConsolidationRules.js';
import { classifyRememberRequest, rememberRequestContent } from '../action/respond/rememberRulePorts.js';

/** Explicit owner observations, shared by immediate and nightly capture without loading a worker or model. */
export function extractExplicitMemoryProposals(value: string): UserFactProposal[] {
  const text = normalize(value).slice(0, 2_000);
  if (!text) return [];
  const proposals: UserFactProposal[] = [];
  const utterances = text.match(/[^。！？!?]+[。！？!?]?/gu) ?? [];
  let likedSubject: string | undefined;
  for (const utterance of utterances) {
    if (/[？?]\s*$/u.test(utterance)) continue;
    const sentence = utterance.replace(/[。！!]\s*$/u, '').trim();
    if (!sentence) continue;
    // 「…、覚えておいて」 states its fact before the request; the request is not part of the fact.
    const stated = rememberRequestContent(sentence) ?? sentence;
    for (const pattern of EXPLICIT_FACT_PATTERNS) appendRuleProposal(proposals, stated, pattern, 'user-fact');
    for (const pattern of RELATIONSHIP_PATTERNS) appendRuleProposal(proposals, stated, pattern, 'relationship');
    for (const pattern of INTEREST_PATTERNS) appendRuleProposal(proposals, stated, pattern, 'interest');
    const remembered = classifyRememberRequest(sentence, likedSubject);
    if (remembered?.kind === 'knowledge') proposals.push({ kind: 'user-fact', statement: remembered.statement, evidence: remembered.evidence.slice(0, 240) });
    likedSubject = explicitFactStatement(stated)?.match(/^ユーザーは(.{1,40})が好き$/u)?.[1] ?? likedSubject;
  }
  return deduplicateProposals(proposals);
}
