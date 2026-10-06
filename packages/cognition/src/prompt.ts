import type { CompanionStateSnapshot } from './types.js';
import type { ContextualMemory, ShannonCognitiveFrame, ShannonIntent, ShannonSituationSnapshot } from './runtime.js';
import { memoryControlFor, memoryIdentifier, visibleMemoryText } from './memory.js';
import { filterMeaningfulInterests } from './interests.js';
import { shannonPersonaPrompt, shannonSuitePrompt, type ShannonAudience, type ShannonPersonaOptions } from './persona.js';
import { shannonCapabilityPrompt } from './capabilities.js';
import { lingeringFeelingLine, presentShannonFeeling } from './emotionContinuity.js';
import type { ShannonEmotionTiming } from './emotionTime.js';

/**
 * Stable identity block: canonical persona, suite roles, and capabilities. It is the
 * first section of every response prompt so the provider can cache it across turns.
 */
export function shannonIdentityPrompt(audience: ShannonAudience = 'owner', options: ShannonPersonaOptions = {}): string {
  return [shannonPersonaPrompt(audience, options), shannonSuitePrompt(), shannonCapabilityPrompt(audience)].join('\n\n');
}

export const SHANNON_CORE_PROMPT = shannonIdentityPrompt('owner');

export interface CompanionPromptOptions {
  maximumCharacters?: number;
  /** Turn time. When given, the prompt states the conversational feeling as it stands at that moment. */
  now?: string;
  /** The server's emotion timing; the table's defaults when absent. */
  timing?: ShannonEmotionTiming;
}

function fixed(value: number): string {
  return value.toFixed(2);
}

function fitSections(sections: readonly string[], maximumCharacters: number): string {
  if (maximumCharacters < 1) return '';
  let result = '';
  for (const section of sections) {
    if (!section) continue;
    const separator = result ? '\n' : '';
    if (result.length + separator.length + section.length <= maximumCharacters) {
      result += separator + section;
      continue;
    }
    const remaining = maximumCharacters - result.length - separator.length;
    if (remaining > 1) result += separator + section.slice(0, remaining - 1).trimEnd() + '…';
    break;
  }
  return result;
}

export function buildCompanionStatePrompt(
  snapshot: CompanionStateSnapshot,
  options: CompanionPromptOptions = {},
): string {
  const maximumCharacters = Math.max(0, options.maximumCharacters ?? 2_400);
  const interests = filterMeaningfulInterests(snapshot.interests).flatMap(interest => {
    const id = memoryIdentifier('interest', interest);
    const text = visibleMemoryText(snapshot, id, interest);
    return text ? [{ text, pinned: memoryControlFor(snapshot, id)?.pinned === true }] : [];
  }).sort((left, right) => Number(right.pinned) - Number(left.pinned));
  const facts = snapshot.userFacts.flatMap(fact => {
    const text = visibleMemoryText(snapshot, fact.id, fact.statement);
    return text ? [{ ...fact, statement: text, pinned: memoryControlFor(snapshot, fact.id)?.pinned === true }] : [];
  }).sort((left, right) => Number(right.pinned) - Number(left.pinned));
  const relationships = snapshot.relationships.flatMap(relationship => {
    const text = visibleMemoryText(snapshot, relationship.id, relationship.statement);
    return text ? [{ ...relationship, statement: text, pinned: memoryControlFor(snapshot, relationship.id)?.pinned === true }] : [];
  }).sort((left, right) => Number(right.pinned) - Number(left.pinned));
  const activeMemories = snapshot.activeMemories.flatMap(memory => {
    const text = visibleMemoryText(snapshot, memory.id, memory.summary);
    return text ? [{ ...memory, summary: text, pinned: memoryControlFor(snapshot, memory.id)?.pinned === true }] : [];
  }).sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.relevance - left.relevance);
  const prospectiveMemories = snapshot.prospectiveMemories
    .filter(memory => memory.status === 'pending'
      && visibleMemoryText(snapshot, memory.id, memory.summary)
      && (!memory.sourceExperienceId || visibleMemoryText(snapshot, memory.sourceExperienceId, memory.summary)))
    .sort((a, b) => (a.dueAt ?? a.dueDate ?? '9999').localeCompare(b.dueAt ?? b.dueDate ?? '9999'))
    .slice(0, 8);
  return fitSections([
    `[Shannon shared state v${snapshot.version}]`,
    fitSections([prospectiveMemories.length
      ? `未完了の約束・未来記憶 (保存済み。外部実行の証拠ではない):\n${prospectiveMemories.map(memory => `- ${visibleMemoryText(snapshot, memory.id, memory.summary)} [発言=${memory.createdAt}; 期限=${memory.dueAt ?? memory.dueDate ?? memory.dueHint ?? '未定'}; TZ=${memory.timeZone ?? '不明'}]`).join('\n')}`
      : '未完了の約束・未来記憶: なし'], Math.floor(maximumCharacters * 0.32)),
    // Traits that move with evidence (see temperament.ts) and fixed dispositions are labelled apart.
    `経験で育つ気質: 親密さ ${fixed(snapshot.temperament.closeness)} / 好奇心 ${fixed(snapshot.temperament.curiosity)} / ユーザー理解の確信 ${fixed(snapshot.temperament.confidenceAboutUser)}`,
    `変わらない性格: 自発性 ${fixed(snapshot.temperament.initiative)} / 落ち着き ${fixed(snapshot.temperament.calmness)} / 継続欲求 ${fixed(snapshot.temperament.needForContinuity)}`,
    `感情: 快・不快 ${fixed(snapshot.emotion.valence)} / 活性 ${fixed(snapshot.emotion.arousal)} / 開放性 ${fixed(snapshot.emotion.openness)}`,
    currentFeelingLine(snapshot, options.now, options.timing),
    lingeringFeelingLine(snapshot, options.now, options.timing),
    interests.length ? `今日の関心: ${interests[0]!.text}` : '今日の関心: まだ形成されていない',
    interests.length > 1 ? `ほかに育っている関心: ${interests.slice(1).map(item => item.text).join('、')}` : '',
    fitSections([facts.length
      ? `ユーザーについて分かっていること:\n${facts.map(fact => `- ${fact.statement} (確信 ${fixed(fact.confidence)})`).join('\n')}`
      : 'ユーザーについて分かっていること: まだない'], Math.floor(maximumCharacters * 0.22)),
    fitSections([relationships.length
      ? `関係について分かっていること:\n${relationships.map(relationship => `- ${relationship.statement} (確信 ${fixed(relationship.confidence)})`).join('\n')}`
      : '関係について分かっていること: まだない'], Math.floor(maximumCharacters * 0.14)),
    fitSections([activeMemories.length
      ? `今、想起されている記憶:\n${activeMemories.map(memory => `- ${memory.summary}`).join('\n')}`
      : '今、想起されている記憶: なし'], Math.floor(maximumCharacters * 0.14)),
  ], maximumCharacters);
}

/**
 * The conversational feeling as it stands at `now`, through the carry-over rule
 * shared with voice. Without a clock (a cached projection) the line is left out
 * rather than showing a stored feeling that may be hours old.
 */
function currentFeelingLine(snapshot: CompanionStateSnapshot, now: string | undefined, timing: ShannonEmotionTiming | undefined): string {
  if (!now) return '';
  const feeling = presentShannonFeeling(snapshot, now, timing);
  return feeling.primary === 'neutral'
    ? `いまの会話感情: 落ち着いている (${feeling.cause})`
    : `いまの会話感情: ${feeling.primary} / 強度 ${fixed(feeling.intensity)} / 対象 ${feeling.target} / 理由 ${feeling.cause} / 表出 ${feeling.visibility}`;
}

export function assembleShannonSystemPrompt(
  snapshot: CompanionStateSnapshot,
  options: CompanionPromptOptions = {},
): string {
  const statePrompt = buildCompanionStatePrompt(snapshot, options);
  return statePrompt ? `${SHANNON_CORE_PROMPT}\n\n${statePrompt}` : SHANNON_CORE_PROMPT;
}

export function buildTurnCognitivePrompt(
  situation: ShannonSituationSnapshot,
  memories: readonly ContextualMemory[],
  maximumCharacters = 1_800,
): string {
  const situationLines = [
    `channel=${situation.channel}`,
    `occurred_at=${situation.occurredAt}`,
    ...(situation.localTime ? [`local_time=${situation.localTime}`] : []),
    ...(situation.locationLabels?.length ? [`location=${situation.locationLabels.join(' / ')}`] : []),
    ...(situation.participants?.length ? [`participants=${situation.participants.join(' / ')}`] : []),
    ...(situation.currentGoal ? [`current_goal=${situation.currentGoal}`] : []),
  ];
  return fitSections([
    '[Current cognitive context — use before answering]',
    `Situation: ${situationLines.join('; ')}`,
    memories.length
      ? `Relevant memories recalled for this exact turn (prefer over older active-memory projections):\n${memories.map(memory => `- ${memory.summary} (observed_at: ${memory.observedAt}; cue: ${memory.reasons.join(', ')})`).join('\n')}`
      : 'Relevant memories recalled for this exact turn: none. Do not invent continuity.',
    'Use recalled memories only when they naturally help. Do not recite them, expose retrieval mechanics, or pretend certainty beyond the evidence.',
  ], Math.max(0, maximumCharacters));
}

export function buildIntentPrompt(
  frame: ShannonCognitiveFrame,
  maximumCharacters = 1_200,
): string {
  const intent = frame.primaryIntent;
  if (!intent) return '';
  return fitSections([
    '[Current intention frame — durable, owner-visible, and evidence-backed]',
    `Primary objective: ${intent.title}`,
    `Desired outcome: ${intent.desiredOutcome}`,
    ...(intent.nextStep ? [`Next known step: ${intent.nextStep}`] : []),
    ...(intent.planSteps?.length ? [`Owner-visible plan proposal:\n${intent.planSteps.slice(0, 5).map((step, index) => `${index + 1}. ${step}`).join('\n')}`] : []),
    ...(intent.verifiedWork ? [verifiedWorkPrompt(intent.verifiedWork)] : []),
    `Evidence: explicitly stated by the user; recorded_at=${intent.createdAt}; confidence=${fixed(intent.confidence)}`,
    `Response mode: ${frame.responseMode}`,
    'Use this objective to maintain continuity across turns. Do not announce the frame, invent progress, or treat a proposal as completed work.',
    'The plan is guidance, not proof of action or completion. Verified work is authoritative for task progress, but task completion does not automatically complete the broader objective. If the next step is ambiguous or consequential, ask or propose it instead of silently acting.',
  ], Math.max(0, maximumCharacters));
}

function verifiedWorkPrompt(work: NonNullable<ShannonIntent['verifiedWork']>): string {
  const progress = work.totalPlanSteps > 0
    ? `${work.completedPlanSteps}/${work.totalPlanSteps} plan steps completed`
    : 'no task plan reported';
  const current = work.currentAction ? `; current_action=${work.currentAction}` : '';
  const tests = `; tests_passed=${work.testsPassed}; tests_failed=${work.testsFailed}`;
  return `Verified linked work: task_id=${work.taskId}; status=${work.status}; ${progress}${current}${tests}; updated_at=${work.updatedAt}\nSummary: ${work.summary}`;
}

/**
 * Selects one bounded objective without model calls. Exact current-turn evidence,
 * the current thread, and recency win; inactive objectives never participate.
 */
export function selectPrimaryIntent(
  message: string,
  threadId: string,
  intents: readonly ShannonIntent[],
  occurredAt = new Date().toISOString(),
): ShannonIntent | undefined {
  const terms = normalizedTerms(message);
  return intents.filter(intent => intent.status === 'active').map(intent => {
    const intentTerms = normalizedTerms(`${intent.title} ${intent.desiredOutcome} ${intent.nextStep ?? ''}`);
    const overlap = terms.size
      ? [...terms].filter(term => intentTerms.has(term)).length / terms.size
      : 0;
    const thread = intent.threadId === threadId ? 0.28 : 0;
    const priority = Math.max(0, Math.min(1, intent.priority)) * 0.2;
    const recency = Math.max(0, 0.18 - Math.max(0, Date.parse(occurredAt) - Date.parse(intent.updatedAt)) / 86_400_000 * 0.01);
    return { intent, score: overlap * 0.7 + thread + priority + recency };
  }).sort((left, right) => right.score - left.score || right.intent.updatedAt.localeCompare(left.intent.updatedAt))[0]?.intent;
}

function normalizedTerms(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase('ja-JP').replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .split(' ').flatMap(part => part.length >= 2 ? [part, ...part.match(/.{2,6}/gu) ?? []] : [])
    .filter(term => term.length >= 2));
}
