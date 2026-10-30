import type { CheckedStreamReply } from '../../mind/emotion/streamFeeling.js';
import type { StreamAuthor, AuthorSession } from './streamAuthor.js';
import type { StreamControl, StreamLineKind, StreamLinePlan, StreamSessionView } from './streamContract.js';
import type { StreamMouth } from './streamMouth.js';
import type { StreamProgram } from './streamProgram.js';
import { checkedLine } from './streamGate.js';
import { STREAM_CLOSINGS, STREAM_GREETINGS } from './streamTopics.js';
import { cleanStreamLine, type WriterPurpose } from './streamWriter.js';
interface Session { view: StreamSessionView; program: StreamProgram }
interface Ports {
  author: StreamAuthor; mouth: StreamMouth; now(): number; occupied(): boolean;
  stale(session: Session, epoch: number): boolean;
  put(reply: CheckedStreamReply, plan: StreamLinePlan, kind: StreamLineKind): string | null;
  track(job: Promise<void>): unknown;
}
const authorSession = ({ view }: Session): AuthorSession => ({ streamId: view.streamId, title: view.title, minecraft: view.minecraft });
const GENTLE: StreamLinePlan = { affect: 'happy', affectIntensity: 0.5, delivery: 'gentle' };
/** 番組の発言を、既存の書き手と単一の口へ流す。進行の正本は純粋なStreamProgram。 */
export class StreamProgramRunner {
  private job: Promise<void> | null = null;
  constructor(private readonly parts: Ports) {}
  busy(): boolean { return this.job !== null; }
  control(session: Session, control: StreamControl): void {
    const program = session.program;
    if (control.action === 'program_layout') program.view.layout = control.layout;
    else if (control.action === 'program_extend') program.extend(control.minutes, this.parts.now());
    else {
      if (control.action === 'program_close') program.move('closing', this.parts.now());
      else program.step(control.action === 'program_previous' ? -1 : 1, this.parts.now());
      this.parts.mouth.clearWaiting();
    }
  }
  schedule(session: Session): void {
    const { parts } = this;
    if (this.job || parts.occupied() || session.view.paused || !session.program.due(parts.now())) return;
    if (parts.mouth.hasCurrent() || parts.mouth.waitingCount()) return;
    const job = this.line(session).finally(() => { this.job = null; });
    this.job = job;
    parts.track(job);
  }
  private async line(session: Session): Promise<void> {
    const { program } = session;
    const epoch = program.epoch;
    const stage = program.view.stage;
    const kind = stage === 'opening' ? 'greeting' : stage === 'closing' ? 'closing' : 'topic';
    const instruction = stage === 'explanation' ? '今日のお題と参加方法を必ず伝え、視聴者に最初の質問を一つする。'
      : stage === 'closing' ? 'ここまでの公開会話を短く振り返り、見てくれた人にお礼を言う。' : '名乗って短く挨拶する。';
    const fixed = stage === 'explanation' ? ['今日は' + program.view.topic + 'のお話。' + program.view.participation]
      : stage === 'closing' ? STREAM_CLOSINGS : STREAM_GREETINGS;
    const line = await this.write(session, { kind: 'program', instruction }, kind, fixed);
    if (this.parts.stale(session, epoch)) return;
    if (!line) {
      program.defer(this.parts.now());
      return;
    }
    const id = this.parts.put(line.reply, line.plan, kind);
    if (id) program.expect(id, epoch);
  }
  async closing(session: Session, summary: { comments: number; answered: number; minutes: number }): Promise<void> {
    const line = await this.write(session, { kind: 'closing', summary }, 'closing', STREAM_CLOSINGS);
    if (line) this.parts.put(line.reply, line.plan, 'closing');
  }
  private async write(session: Session, purpose: WriterPurpose, kind: StreamLineKind, fixed: readonly string[])
    : Promise<{ reply: CheckedStreamReply; plan: StreamLinePlan } | null> {
    const turn = this.parts.author.ownTurn(session.view.streamId);
    if (!turn) return null;
    const written = await this.parts.author.write(authorSession(session), turn, purpose, [], kind);
    if (written) return { reply: written.reply, plan: written.draft.plan };
    const text = cleanStreamLine(fixed[0]!);
    if (!text) return null;
    const verdict = checkedLine(turn, text);
    return verdict.ok ? { reply: verdict.reply, plan: GENTLE } : null;
  }
}
