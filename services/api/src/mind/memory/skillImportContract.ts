/** Operator artifact ancestry, separate from experience sources and observed outcomes. */
export interface OperatorSkillProvenance {
  origin: 'operator_authored';
  packId: string;
  packRevision: string;
  /** Full SHA-256 of the exact imported artifact bytes; later edits retain this ancestry. */
  bodySha256: string;
  sourceAuthor: string;
  sourceReference: string;
  referenceRevision: string;
  validatorRevision: string;
  importReceiptId: string;
}
export interface SkillPack {
  schemaVersion: 1;
  packId: string;
  revision: string;
  sourceAuthor: string;
  sourceReference: string;
  referenceRevision: string;
  validatorRevision: string;
  /**
   * `revises`: instead of a new skill, a new version of the operator-authored skill of the same name, through the ordinary revision
   * path (`SkillMemory.revise`, actor `operator_authored`), only while its current body is exactly `bodySha256`.
   */
  skills: readonly {
    name: string; body: string; sha256: string; tools: readonly string[]; conditionalTools?: readonly string[]; revises?: { bodySha256: string };
  }[];
}
export interface SkillImportReceipt {
  receiptId: string;
  scopeKey: string;
  packId: string;
  packRevision: string;
  packSha256: string;
  planHash: string;
  /** An owner's explicit adoption reference, never an experience or success. */
  approvalReference: string;
  importedAt: string;
  skills: readonly { skillId: string; name: string; bodySha256: string; revisionId: string }[];
}
export interface SkillImportPlan {
  packId: string;
  packRevision: string;
  packSha256: string;
  receiptId: string;
  planHash: string;
  capacity: { used: number; added: number; limit: number };
  skills: readonly {
    name: string; sha256: string; body: string; lint: readonly string[]; tools: readonly string[]; conditionalTools?: readonly string[];
    revises?: { bodySha256: string };
  }[];
  problems: readonly { name: string | null; code: string }[];
  existingReceipt: SkillImportReceipt | null;
}
