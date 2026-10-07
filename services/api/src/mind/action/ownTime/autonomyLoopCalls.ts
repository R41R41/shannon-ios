import { yenFromUsd } from '../../inhibition/inhibitionPorts.js';
import { actionPermit, currentActionExecution } from '../../../infra/context/actionExecution.js';
import { parsedModelObject, type AutonomyPrompt } from './autonomyLoopPrompts.js';
import type { StepDependencies } from './autonomyLoopSteps.js';
import { autonomyModelCostUsd, type AutonomyModelPurpose } from './autonomyModels.js';
import { AutonomyModelError, resolveAutonomyModel, type AutonomyTextModel, type AutonomyTextRequest, type AutonomyTextResult } from './autonomyTextModel.js';

/**
 * One paid model call of a step: which model, what the gate is asked to make room for, and the call itself.
 * Shared by the step kinds so each prices and charges a call the same way.
 */
export interface PaidCall { model: string; estimate: { inputTokens: number; outputTokens: number }; estimatedCostYen: number; prompt: AutonomyPrompt; maximumOutputTokens: number; /** A planning call asks the provider for little reasoning. */ reasoning?: 'low' }

/** Null when no usable model serves the purpose or its price is unknown. */
export function paidCall(dependencies: StepDependencies, scopeKey: string, purpose: AutonomyModelPurpose, prompt: AutonomyPrompt, maximumOutputTokens: number): PaidCall | null {
  const model = resolveAutonomyModel(purpose, dependencies.store.modelPreferences(scopeKey), id => dependencies.model.canUse(id));
  if (!model) return null;
  // Japanese runs near one token per character; the estimate assumes more so the gate errs high.
  const estimate = { inputTokens: Math.ceil((prompt.system.length + prompt.prompt.length) * 1.5) + 64, outputTokens: maximumOutputTokens };
  const costUsd = autonomyModelCostUsd(model, estimate, dependencies.config.modelPrices);
  if (costUsd === null) return null;
  return { model, estimate, estimatedCostYen: yenFromUsd(costUsd, dependencies.config), prompt, maximumOutputTokens };
}

export async function callModel(adapters: { model?: AutonomyTextModel }, call: PaidCall, signal?: AbortSignal):
  Promise<{ reply: Record<string, unknown> | null; usage?: { inputTokens: number; outputTokens: number }; failure?: string; /** The reply was cut off at the output ceiling. */ truncated?: boolean; /** The reply as text, when it was not one JSON object. */ text?: string }> {
  if (!adapters.model) return { reply: null, failure: 'AUTONOMY_STEP_NOT_BOUND' };
  try {
    const result = await generateModel(adapters.model,{
      model: call.model, system: call.prompt.system, prompt: call.prompt.prompt, maximumOutputTokens: call.maximumOutputTokens, ...(call.reasoning ? { reasoning: call.reasoning } : {}), signal,
    });
    const reply = parsedModelObject(result.text);
    return { reply, usage: result.usage, ...(result.truncated ? { truncated: true } : {}), ...(reply ? {} : { text: result.text }) };
  } catch (error) {
    // The provider answered with an error: charged only what it reported. No answer at all (a timeout, a lost
    // connection, a shutdown) leaves the cost unknown, so the estimate is charged and the count errs high.
    const usage = error instanceof AutonomyModelError ? error.usage : call.estimate;
    const failure = error instanceof Error ? error.message : 'AUTONOMY_MODEL_FAILED';
    return { reply: null, failure, ...(usage ? { usage } : {}), ...(failure === 'AUTONOMY_MODEL_TRUNCATED' ? { truncated: true } : {}) };
  }
}

/** All own-time model paths carry the same transient usage/acknowledgement, including outreach and phone wording. */
export async function generateModel(model:AutonomyTextModel,request:AutonomyTextRequest):Promise<AutonomyTextResult> {
  await actionPermit();
  const execution=currentActionExecution();if(execution){execution.modelOutcome='unknown';delete execution.modelUsage;}
  try {
    const result=await model.generate(request);
    if(execution){execution.modelOutcome='acknowledged';execution.modelUsage=result.usage;}
    return result;
  }catch(error){
    if(execution && error instanceof AutonomyModelError){execution.modelOutcome='acknowledged';execution.modelUsage=error.usage;}
    throw error;
  }
}

/** Owner-local date and hour, with the minute when asked. */
export function ownerLocalTime(at: string, timeZone: string, minute = false): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', ...(minute ? { minute: '2-digit' as const } : {}), hourCycle: 'h23',
    }).format(new Date(at));
  } catch {
    return at.slice(0, minute ? 16 : 13);
  }
}
