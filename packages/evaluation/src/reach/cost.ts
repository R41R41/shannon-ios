/**
 * The estimate printed before a live run. It errs high on purpose: one token per character of every
 * request (Japanese runs below that, the English of the prompts well below), a generous output per
 * call to leave room for reasoning tokens, and for a scenario that runs under the activity gate the
 * cap the gate enforces, which already prices calls at the gate's conservative rates.
 */
export interface ConversationEstimateInput {
  scenarioId: string;
  /** From the model-free pass: what the live pass will send. */
  calls: number;
  promptCharacters: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  outputTokensPerCall?: number;
  tokensPerCharacter?: number;
}

export interface ReachEstimateLine {
  scenarioId: string;
  yen: number;
  basis: string;
}

export function conversationEstimate(input: ConversationEstimateInput, yenPerUsd: number): ReachEstimateLine {
  const inputTokens = Math.ceil(input.promptCharacters * (input.tokensPerCharacter ?? 1));
  const outputTokens = input.calls * (input.outputTokensPerCall ?? 800);
  const usd = (inputTokens * input.inputUsdPerMillion + outputTokens * input.outputUsdPerMillion) / 1_000_000;
  return {
    scenarioId: input.scenarioId,
    yen: Math.ceil(usd * yenPerUsd * 100) / 100,
    basis: `${input.calls} calls, ~${inputTokens} input and ~${outputTokens} output tokens at ${input.inputUsdPerMillion}/${input.outputUsdPerMillion} USD per million`,
  };
}

/** A scenario under the activity gate cannot spend past its cap; the cap is the estimate. */
export function cappedEstimate(scenarioId: string, capYen: number): ReachEstimateLine {
  return { scenarioId, yen: capYen, basis: `at most the sandbox cap the gate enforces (${capYen} yen)` };
}

export function pendingEstimate(scenarioId: string, reason: string): ReachEstimateLine {
  return { scenarioId, yen: 0, basis: `pending: ${reason}` };
}

export function estimateTotal(lines: readonly ReachEstimateLine[]): number {
  return Math.ceil(lines.reduce((sum, line) => sum + line.yen, 0));
}
