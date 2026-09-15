import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

export type CodexRequestID = number | string;

export interface CodexNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexServerRequest extends CodexNotification {
  id: CodexRequestID;
}

export interface CodexAppServerClientOptions {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export interface CodexAppServerConnection {
  onNotification(handler: (notification: CodexNotification) => void): () => void;
  onServerRequest(handler: (request: CodexServerRequest) => void): () => void;
  onDiagnostic(handler: (message: string) => void): () => void;
  start(): Promise<void>;
  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T>;
  respond(id: CodexRequestID, result: Record<string, unknown>): void;
  respondError(id: CodexRequestID, code: number, message: string): void;
  stop(): Promise<void>;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

export class CodexAppServerClient implements CodexAppServerConnection {
  private process?: ChildProcessWithoutNullStreams;
  private lines?: ReadlineInterface;
  private nextRequestID = 1;
  private readonly pending = new Map<CodexRequestID, PendingRequest>();
  private readonly notificationHandlers = new Set<(notification: CodexNotification) => void>();
  private readonly serverRequestHandlers = new Set<(request: CodexServerRequest) => void>();
  private readonly diagnosticHandlers = new Set<(message: string) => void>();
  private started = false;
  private stopping = false;

  constructor(private readonly options: CodexAppServerClientOptions) {}

  onNotification(handler: (notification: CodexNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: (request: CodexServerRequest) => void): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  onDiagnostic(handler: (message: string) => void): () => void {
    this.diagnosticHandlers.add(handler);
    return () => this.diagnosticHandlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.stopping = false;
    const args = [...(this.options.args ?? ['app-server', '--stdio'])];
    const child = spawn(this.options.executable, args, {
      cwd: this.options.cwd,
      env: this.options.environment ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', value => this.emitDiagnostic(String(value).trim()));
    child.once('error', error => this.handleExit(error));
    child.once('exit', (code, signal) => {
      if (!this.stopping) this.handleExit(new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'})`));
    });

    try {
      await this.request('initialize', {
        clientInfo: { name: 'shannon_agent_host', title: 'Shannon Agent Host', version: '0.1.0' },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: [
            'item/reasoning/textDelta',
            'item/reasoning/summaryTextDelta',
            'item/reasoning/summaryPartAdded',
          ],
        },
      });
      this.send({ method: 'initialized', params: {} });
      this.started = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.process) throw new Error('CODEX_APP_SERVER_NOT_STARTED');
    const id = this.nextRequestID++;
    const timeoutMs = this.options.requestTimeoutMs ?? 20_000;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ method, id, params });
    return await promise as T;
  }

  respond(id: CodexRequestID, result: Record<string, unknown>): void {
    this.send({ id, result });
  }

  respondError(id: CodexRequestID, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.lines?.close();
    this.lines = undefined;
    const child = this.process;
    this.process = undefined;
    this.rejectPending(new Error('Codex App Server stopped'));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.emitDiagnostic('Codex App Server sent invalid JSONL; message ignored.');
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    const id = requestID(message.id);
    if (id !== undefined && typeof message.method !== 'string') {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error && typeof message.error === 'object') {
        const error = message.error as Record<string, unknown>;
        pending.reject(new Error(`Codex App Server: ${String(error.message ?? 'request failed')}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = objectValue(message.params);
    if (id !== undefined) {
      const request: CodexServerRequest = { method: message.method, id, ...(params ? { params } : {}) };
      if (!this.serverRequestHandlers.size) {
        this.respondError(id, -32601, 'Shannon Agent Host cannot handle this request');
        return;
      }
      for (const handler of this.serverRequestHandlers) handler(request);
      return;
    }
    const notification: CodexNotification = { method: message.method, ...(params ? { params } : {}) };
    for (const handler of this.notificationHandlers) handler(notification);
  }

  private send(message: Record<string, unknown>): void {
    const input = this.process?.stdin;
    if (!input?.writable) throw new Error('CODEX_APP_SERVER_NOT_WRITABLE');
    input.write(`${JSON.stringify(message)}\n`);
  }

  private handleExit(error: Error): void {
    this.started = false;
    this.process = undefined;
    this.rejectPending(error);
    this.emitDiagnostic(error.message);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private emitDiagnostic(message: string): void {
    if (!message) return;
    for (const handler of this.diagnosticHandlers) handler(message);
  }
}

function requestID(value: unknown): CodexRequestID | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
