/**
 * What a conversation turn is handed of her skill memory (Syzygy ADR-0008 stage 2, step 6; `docs/skill-and-routing-contract.md`).
 * Built in `wiring/skillMemoryWiring.ts` over `SkillMemory` while `SHANNON_SKILLS` is on; absent, no index, no `skill.read`, no
 * use is noted, and every turn is what it was. The surfaces and her tools are handed functions, never a store.
 */
export interface SkillTurnSkill {
  skillId: string;
  name: string;
  version: number;
  status: 'draft' | 'active';
  /** The SKILL.md (or the owner's edit of it). */
  body: string;
}

export interface SkillTurnPorts {
  /** The index for the profile layer of a turn the owner alone reads; empty while she has none. */
  index(scopeKey: string): string;
  /** One usable skill by its name; null when there is none. Throws when it cannot be read now. */
  open(scopeKey: string, name: string): SkillTurnSkill | null;
  /** A use of a skill at the end of its turn, with G; returns the skill's id (the choice ledger's source) or null. */
  used(scopeKey: string, name: string, use: { talk: string; growth: number }, at: string): string | null;
  /** The owner's next turn in a Talk, as S (`nextTurnServe`): settles the uses of the turn before. */
  nextTurn(scopeKey: string, talk: string, serve: number, at: string): void;
}
