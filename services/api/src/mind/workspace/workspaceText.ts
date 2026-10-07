import { isMemoryEvidenceVisible, visibleMemoryText, type CompanionStateSnapshot, type MemoryAudience } from '@shannon/cognition';
import { DisclosureGate } from '../inhibition/disclosurePorts.js';
import { MemoryWithholding, type ConversationStore } from '../memory/memoryPorts.js';

/**
 * The words of a workspace item, read again when a turn is rendered (Syzygy ADR-0008 stage 3, `docs/mind-workspace-contract.md`).
 * The journal and the snapshots hold no text: an item has a reference (`experience:<id>`, the stored turn) and, while the process
 * lives, the text it was perceived with. Either is passed through the withholding (what the owner had her forget, reject or
 * correct) and the disclosure gate of the turn's audience at the moment of rendering, so a forget applies at once, and also
 * after a restart (when only the reference is left). Null when nothing may be shown.
 */
export class WorkspaceTextReader {
  private withholding?: MemoryWithholding;
  private gate?: DisclosureGate;

  constructor(
    private readonly snapshot: CompanionStateSnapshot,
    private readonly store: ConversationStore | null,
    private readonly scopeKey: string,
    private readonly present: MemoryAudience,
  ) {}

  private rules(): MemoryWithholding {
    this.withholding ??= new MemoryWithholding(this.snapshot, this.store, this.scopeKey);
    return this.withholding;
  }

  private disclosure(): DisclosureGate {
    this.gate ??= new DisclosureGate(this.present, this.snapshot, this.store, this.scopeKey);
    return this.gate;
  }

  /** The text of an item for this turn, with the gate's marker when it is guarded; null when it may not be shown. */
  read(item: { ref: string | null; at: string }, held: string | null): string | null {
    if (item.ref?.startsWith('experience:')) return this.experience(item.ref.slice('experience:'.length));
    if (held === null || !held.trim()) return null;
    if (!isMemoryEvidenceVisible(this.snapshot, held)) return null;
    if (this.rules().withholdsReply({ text: held, observedAt: item.at })) return null;
    if (this.disclosure().mentionsWithheld(held)) return null;
    return held;
  }

  /**
   * Whether a notice's source is still visible now (stage 3 review): a promise that is still there and not forgotten (nor the turn
   * it came from), a task the owner did not hide. Read from the source id the producer gave it (`promise-<id>@…`, `task-<id>@…`).
   */
  noticeVisible(item: { kind: string; sourceId: string }): boolean {
    const id = (prefix: string) => (item.sourceId.startsWith(prefix) && item.sourceId.includes('@') ? item.sourceId.slice(prefix.length, item.sourceId.lastIndexOf('@')) : null);
    if (item.kind === 'promise_due') {
      const promiseId = id('promise-');
      const memory = promiseId ? this.snapshot.prospectiveMemories.find(entry => entry.id === promiseId) : undefined;
      if (!memory) return false;
      if (visibleMemoryText(this.snapshot, memory.id, memory.summary) === null) return false;
      return !memory.sourceExperienceId || visibleMemoryText(this.snapshot, memory.sourceExperienceId, memory.summary) !== null;
    }
    if (item.kind === 'task_outcome') {
      const taskId = id('task-');
      return taskId === null || visibleMemoryText(this.snapshot, taskId, 'visible') !== null;
    }
    return true;
  }

  private experience(id: string): string | null {
    const experience = this.store?.experiencesById?.(this.scopeKey, [id])[0];
    if (!experience) return null;
    const gate = this.disclosure();
    if (!gate.allowsTurn(experience)) return null;
    if (this.rules().withholdsExperience({ id: experience.id, summary: experience.summary, observedAt: experience.observedAt,
      ...(experience.recalledMemoryIds ? { recalledMemoryIds: experience.recalledMemoryIds } : {}) })) return null;
    if (!isMemoryEvidenceVisible(this.snapshot, experience.userMessage)) return null;
    return `${gate.markerForTurn(experience)}${experience.userMessage}`;
  }
}
