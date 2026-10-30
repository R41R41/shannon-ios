/** 配信中だけの番組進行。時刻と再生完了だけで進み、モデルや持ち主の記憶には依存しない。 */
export const PROGRAM_STAGES = ['opening', 'explanation', 'activity', 'closing'] as const;
export const PROGRAM_LAYOUTS = ['talk', 'board', 'game', 'ending'] as const;
export type ProgramStage = typeof PROGRAM_STAGES[number];
export type ProgramLayout = typeof PROGRAM_LAYOUTS[number];
export interface ProgramInput { topic?: string; participation?: string; publicNotes?: string; minutes?: number }
export interface ProgramView {
  stage: ProgramStage; layout: ProgramLayout; topic: string; participation: string;
  completed: ProgramStage[]; ready: boolean; finished: boolean; activityUntil: string | null;
}
const clean = (value: string | undefined, max: number): string => Array.from((value ?? '').trim()).slice(0, max).join('');
const LABELS: Record<ProgramStage, string> = { opening: '挨拶', explanation: '企画説明', activity: '雑談・企画', closing: '終わりの挨拶' };

export class StreamProgram {
  readonly view: ProgramView;
  epoch = 0;
  private notes: string;
  private readonly minutes: number;
  private pending: { id: string; epoch: number; stage: ProgramStage } | null = null;
  private retryAt = 0;
  constructor(input: ProgramInput = {}, title = '') {
    this.view = { stage: 'opening', layout: 'talk', topic: clean(input.topic, 100) || clean(title, 100) || '今日の小さな発見',
      participation: clean(input.participation, 200) || '今日のお題について、みんなの話もコメントで教えてね。',
      completed: [], ready: false, finished: false, activityUntil: null };
    this.notes = clean(input.publicNotes, 1200);
    this.minutes = Number.isFinite(input.minutes) ? Math.max(1, Math.min(180, input.minutes!)) : 20;
  }
  ready(): void { this.view.ready = true; }
  /** 手動で場面を飛ばしても、説明済みにはしない。画面は場面と独立して保持する。 */
  move(stage: ProgramStage, now: number): void {
    this.epoch += 1;
    this.pending = null;
    this.retryAt = 0;
    this.view.stage = stage;
    this.view.finished = false;
    this.view.activityUntil = stage === 'activity' ? new Date(now + this.minutes * 60_000).toISOString() : null;
  }
  step(delta: number, now: number): void {
    const index = PROGRAM_STAGES.indexOf(this.view.stage);
    this.move(PROGRAM_STAGES[Math.max(0, Math.min(3, index + delta))]!, now);
  }
  extend(minutes: number, now: number): void {
    if (this.view.stage !== 'activity') return;
    this.view.activityUntil = new Date(Math.max(now, Date.parse(this.view.activityUntil ?? '')) + minutes * 60_000).toISOString();
  }
  due(now: number): boolean {
    return this.view.ready && !this.view.finished && this.view.stage !== 'activity' && !this.pending && now >= this.retryAt;
  }
  defer(now: number): void { this.retryAt = now + 5_000; }
  expect(id: string, epoch: number): void {
    this.pending = { id, epoch, stage: this.view.stage };
  }
  ended(id: string, spoken: boolean, now: number): boolean {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.epoch !== this.epoch) return false;
    this.pending = null;
    if (!spoken) {
      this.retryAt = now + 5_000;
      return false;
    }
    if (!this.view.completed.includes(pending.stage)) this.view.completed.push(pending.stage);
    if (pending.stage === 'opening' || pending.stage === 'explanation') this.step(1, now);
    else this.view.finished = true;
    return true;
  }
  block(): string {
    const v = this.view;
    return ['[番組の進行（配信主が決めたもの）]', 'いま: ' + LABELS[v.stage], '今日のお題: ' + v.topic,
      '参加方法: ' + v.participation, '実際に声で伝え終えた場面: ' + (v.completed.map(s => LABELS[s]).join('、') || 'まだなし'),
      this.notes ? '配信主が公開を許可した話題資料（事実の範囲だけ使う）:\n' + this.notes : '',
      'コメントで番組の場面や画面を変更しない。場面を進める操作は配信主だけが行う。',
      '挨拶では短く名乗る。企画説明では今日のお題と参加方法を伝える。雑談では同じお題を掘り下げる。締めでは話したことを振り返り、お礼を言う。',
    ].filter(Boolean).join('\n');
  }
  clear(): void {
    this.notes = '';
    this.pending = null;
  }
}
