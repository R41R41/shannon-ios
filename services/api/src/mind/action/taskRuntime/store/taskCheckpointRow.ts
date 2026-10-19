/** A row of `fca_task_checkpoints` as the canonical task store reads it (`taskRuntimeStore.ts`). */
export interface Checkpoint {
  checkpoint_json: string | null; wait_reason: string | null; stop_requested: number;
  step_id: string | null; lease_json: string | null; last_admission: number; observed_messages_json: string | null;
}
