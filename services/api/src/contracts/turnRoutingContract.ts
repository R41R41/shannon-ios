/**
 * What a conversation turn is handed for Syzygy ADR-0008 stage 2, step 4 (`docs/skill-and-routing-contract.md`): the tier
 * policy's inputs, the turn verifier, and where its choices are learned. Built in `wiring/turnRoutingWiring.ts` from the
 * switches; the surfaces are handed functions, never a store. Absent, every turn is what it was.
 */
export interface TurnRoutingSwitches {
  /** `SHANNON_DIFFICULTY`: Jev's difficulty answers choose the tier. */
  difficulty: boolean;
  /** `SHANNON_TURN_VERIFY`: the deterministic write-claim check (and, with the difficulty, the luna checker). */
  turnVerify: boolean;
  /** `SHANNON_CONVERSATION_REWARD` (owner answer I-3): her conversation choices go into reward, mood and the value table. */
  conversationReward: boolean;
}

export interface ConversationTurnRecord {
  /** The Talk (a closed identifier) whose next turn of the owner's settles these choices. */
  talk: string;
  surface: 'text' | 'voice';
  presence: 'alone' | 'others';
  /** The tier that served the turn and Jev's task kind; null when the policy did not route it. */
  tier: { served: string; kind: string } | null;
  /**
   * Her tool calls that ran, as closed values; `subject` is the closed name of the skill a `skill.read` opened (step 6);
   * `withheld` when a rule stopped it (ADR-0008 §14): never learned as a choice of hers.
   */
  tools: readonly { name: string; ok: boolean; subject?: string; withheld?: boolean }[];
  /** The turn ended inside its deadline (not with her out-of-time line). */
  inDeadline: boolean;
  /** The verifier's verdict: true when it found nothing, false when it flagged a claim, null when it did not check. */
  verified: boolean | null;
  /**
   * Doing or describing (ADR-0008 §14): `done` when the turn was to run or change something and an `acts` tool result worked;
   * `described_not_done` when it was, or her reply claimed doing, without one (then nothing in the turn earns growth); null
   * otherwise. Absent: null.
   */
  doing?: TurnDoing | null;
}

export type TurnDoing = 'done' | 'described_not_done';

export interface TurnRouting {
  readonly switches: TurnRoutingSwitches;
  /** The Anthropic key and `SHANNON_SONNET_ROUTING=on` (step 5); false in steps 1–4. */
  readonly sonnetAvailable: boolean;
  /** Step 5's hook: Sonnet's measured first-token latency on voice; null until measured. */
  sonnetFirstTokenMs(): number | null;
  /** The competence table's (tier, kind). */
  competence(scopeKey: string, tier: string, kind: string): { successes: number; failures: number } | null;
  /** The owner's next turn in a Talk, as Jev's retry-or-correction probability. */
  nextTurn(scopeKey: string, talk: string, retryProbability: number, at: string): void;
  /** One turn's choices at its end. */
  record(scopeKey: string, turn: ConversationTurnRecord, at: string): void;
  /** The luna checker (text only); absent without a model key. */
  checker?: { check(scopeKey: string, reply: string, results: readonly { name: string; effect: 'read' | 'write'; ok: boolean }[]): Promise<'consistent' | 'claims_unsupported' | 'unclear'> };
}
