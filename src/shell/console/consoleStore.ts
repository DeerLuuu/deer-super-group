import type { DeerApi } from "../../shared/ipc.js";
import type {
  ConsoleError,
  ConsoleEvent,
  ConsoleResult,
  ConsoleSession,
  ConsoleSnapshot,
  ConsoleStartInput,
} from "../../shared/console.js";

export type ConsoleApi = Pick<
  DeerApi,
  | "consoleList"
  | "consoleStart"
  | "consoleStop"
  | "consoleInput"
  | "consoleClear"
  | "consoleSnapshot"
  | "consoleCwds"
>;

type ConsoleMeta = {
  sessions: ConsoleSession[];
  selectedId: string | null;
  loading: boolean;
  error: ConsoleError | null;
};

type ConsoleOutput = {
  output: string;
  seq: number;
  truncated: boolean;
  droppedBytes: number;
  loaded: boolean;
};

const EMPTY_OUTPUT: ConsoleOutput = {
  output: "",
  seq: 0,
  truncated: false,
  droppedBytes: 0,
  loaded: false,
};

const TAIL_BYTES = 256 * 1024;

function tailBytes(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  return bytes.length <= maxBytes ? value : new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function running(session: ConsoleSession): boolean {
  return session.status === "starting" || session.status === "running" || session.status === "stopping";
}

export class ConsoleStore {
  private api: Partial<ConsoleApi>;
  private workspaceId: string | null = null;
  private workspaceVersion = 0;
  private meta: ConsoleMeta = { sessions: [], selectedId: null, loading: false, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly outputListeners = new Map<string, Set<() => void>>();
  private readonly outputs = new Map<string, ConsoleOutput>();
  private readonly hidden = new Set<string>();
  private readonly snapshotsRequested = new Set<string>();

  constructor(api: Partial<ConsoleApi> = {}) {
    this.api = api;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ConsoleMeta => this.meta;

  subscribeOutput = (sessionId: string, listener: () => void): (() => void) => {
    let set = this.outputListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.outputListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.outputListeners.delete(sessionId);
    };
  };

  getOutput = (sessionId: string): ConsoleOutput => this.outputs.get(sessionId) ?? EMPTY_OUTPUT;

  visibleSessions(): ConsoleSession[] {
    return this.meta.sessions.filter((session) => !this.hidden.has(session.id));
  }

  selected(): ConsoleSession | null {
    return this.meta.sessions.find((session) => session.id === this.meta.selectedId) ?? null;
  }

  runningCount(): number {
    return this.meta.sessions.filter(running).length;
  }

  async setWorkspace(workspaceId: string | null): Promise<void> {
    if (this.workspaceId === workspaceId) return;
    this.workspaceId = workspaceId;
    const version = ++this.workspaceVersion;
    this.meta = { sessions: [], selectedId: null, loading: Boolean(workspaceId), error: null };
    this.outputs.clear();
    this.hidden.clear();
    this.snapshotsRequested.clear();
    this.notifyMeta();
    if (workspaceId) await this.refresh(version);
  }

  async refresh(expectedVersion = this.workspaceVersion): Promise<void> {
    const workspaceId = this.workspaceId;
    if (!workspaceId) return;
    if (expectedVersion !== this.workspaceVersion) return;
    this.setMeta({ loading: true, error: null });
    try {
      const sessions = await this.api.consoleList?.(workspaceId);
      if (expectedVersion !== this.workspaceVersion || this.workspaceId !== workspaceId) return;
      if (!Array.isArray(sessions)) {
        this.setMeta({ loading: false, sessions: [] });
        return;
      }
      const scoped = sessions.filter((session) => session.workspaceId === workspaceId);
      const selectedId =
        this.meta.selectedId && scoped.some((session) => session.id === this.meta.selectedId)
          ? this.meta.selectedId
          : (scoped.find((session) => running(session))?.id ?? scoped[0]?.id ?? null);
      this.meta = { sessions: scoped, selectedId, loading: false, error: null };
      this.notifyMeta();
      if (selectedId) await this.select(selectedId);
    } catch (error) {
      if (expectedVersion !== this.workspaceVersion) return;
      this.setMeta({ loading: false, error: this.toError(error) });
    }
  }

  async select(sessionId: string): Promise<void> {
    this.hidden.delete(sessionId);
    if (this.meta.selectedId !== sessionId) {
      this.meta = { ...this.meta, selectedId: sessionId };
      this.notifyMeta();
    }
    if (!this.meta.sessions.some((session) => session.id === sessionId)) return;
    if (!this.snapshotsRequested.has(sessionId)) {
      this.snapshotsRequested.add(sessionId);
      await this.loadSnapshot(sessionId);
    }
  }

  async loadSnapshot(sessionId: string): Promise<void> {
    if (!this.workspaceId) return;
    const workspaceId = this.workspaceId;
    const version = this.workspaceVersion;
    const result = await this.api.consoleSnapshot?.(workspaceId, sessionId);
    if (version !== this.workspaceVersion || this.workspaceId !== workspaceId) return;
    if (!result?.ok) {
      if (result && !result.ok) this.setMeta({ error: result.error });
      return;
    }
    const snapshot: ConsoleSnapshot = result.value;
    if (snapshot.session.workspaceId !== workspaceId) return;
    this.outputs.set(sessionId, {
      output: tailBytes(snapshot.output, TAIL_BYTES),
      seq: snapshot.seq,
      truncated: snapshot.truncated || byteLength(snapshot.output) > TAIL_BYTES,
      droppedBytes: snapshot.droppedBytes,
      loaded: true,
    });
    this.updateSession(snapshot.session);
    this.notifyOutput(sessionId);
  }

  async start(input: ConsoleStartInput): Promise<ConsoleResult<ConsoleSession> | null> {
    if (!this.workspaceId) return null;
    const workspaceId = this.workspaceId;
    const version = this.workspaceVersion;
    const result = await this.api.consoleStart?.(workspaceId, input);
    if (!result) return null;
    if (version !== this.workspaceVersion || this.workspaceId !== workspaceId) return result;
    if (!result.ok) {
      this.setMeta({ error: result.error });
      return result;
    }
    const session = result.value;
    if (session.workspaceId !== workspaceId) return result;
    this.hidden.delete(session.id);
    this.outputs.set(session.id, { ...EMPTY_OUTPUT, loaded: true });
    this.meta = {
      ...this.meta,
      sessions: [session, ...this.meta.sessions.filter((item) => item.id !== session.id)],
      selectedId: session.id,
      error: null,
    };
    this.notifyMeta();
    return result;
  }

  async stop(sessionId: string): Promise<ConsoleResult<ConsoleSession> | null> {
    if (!this.workspaceId) return null;
    const result = await this.api.consoleStop?.(this.workspaceId, sessionId);
    if (!result) return null;
    if (result.ok) this.updateSession(result.value);
    else this.setMeta({ error: result.error });
    return result;
  }

  async input(sessionId: string, data: string): Promise<ConsoleResult<{ accepted: boolean }> | null> {
    if (!this.workspaceId) return null;
    const result = await this.api.consoleInput?.(this.workspaceId, sessionId, data);
    if (result && !result.ok) this.setMeta({ error: result.error });
    return result ?? null;
  }

  async clear(sessionId: string): Promise<ConsoleResult<ConsoleSession> | null> {
    if (!this.workspaceId) return null;
    const result = await this.api.consoleClear?.(this.workspaceId, sessionId);
    if (!result) return null;
    if (result.ok) {
      this.outputs.set(sessionId, { ...EMPTY_OUTPUT, loaded: true });
      this.updateSession(result.value);
      this.notifyOutput(sessionId);
    } else {
      this.setMeta({ error: result.error });
    }
    return result;
  }

  async cwds(): Promise<string[]> {
    if (!this.workspaceId) return ["."];
    const result = await this.api.consoleCwds?.(this.workspaceId);
    if (!result?.ok) return ["."];
    return result.value.map((item) => item.relative);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.meta.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    if (running(session)) await this.stop(sessionId);
    this.hidden.add(sessionId);
    if (this.meta.selectedId === sessionId) {
      const next = this.visibleSessions().find((item) => item.id !== sessionId)?.id ?? null;
      this.meta = { ...this.meta, selectedId: next };
      if (next) void this.select(next);
    }
    this.notifyMeta();
  }

  handleEvent(event: ConsoleEvent): void {
    if (!this.workspaceId || event.workspaceId !== this.workspaceId) return;
    if (event.type !== "status" && !this.meta.sessions.some((item) => item.id === event.sessionId)) {
      // 事件先于 list/status 到达时忽略，待 status/list 建 tab；不把未知 session 注入当前 workspace。
      return;
    }
    if (event.type === "output") {
      const current = this.getOutput(event.sessionId);
      if (current.loaded && event.seq <= current.seq) return;
      if (current.loaded && event.seq > current.seq + 1) {
        void this.loadSnapshot(event.sessionId);
        return;
      }
      const output = tailBytes(current.output + event.data, TAIL_BYTES);
      this.outputs.set(event.sessionId, {
        output,
        seq: event.seq,
        truncated:
          current.truncated ||
          event.truncated ||
          byteLength(current.output + event.data) > TAIL_BYTES,
        droppedBytes: current.droppedBytes,
        loaded: true,
      });
      this.notifyOutput(event.sessionId);
      return;
    }
    if (event.type === "status") {
      this.updateSession(event.session);
      if (!this.snapshotsRequested.has(event.sessionId)) {
        this.snapshotsRequested.add(event.sessionId);
        void this.loadSnapshot(event.sessionId);
      }
      return;
    }
    if (event.type === "cleared") {
      this.outputs.set(event.sessionId, { ...EMPTY_OUTPUT, seq: event.seq, loaded: true });
      this.updateSession(event.session);
      this.notifyOutput(event.sessionId);
    }
  }

  private updateSession(session: ConsoleSession): void {
    if (!this.workspaceId || session.workspaceId !== this.workspaceId) return;
    const sessions = this.meta.sessions.some((item) => item.id === session.id)
      ? this.meta.sessions.map((item) => (item.id === session.id ? session : item))
      : [session, ...this.meta.sessions];
    this.meta = { ...this.meta, sessions };
    this.notifyMeta();
  }

  private setMeta(patch: Partial<ConsoleMeta>): void {
    this.meta = { ...this.meta, ...patch };
    this.notifyMeta();
  }

  private notifyMeta(): void {
    for (const listener of this.listeners) listener();
  }

  private notifyOutput(sessionId: string): void {
    for (const listener of this.outputListeners.get(sessionId) ?? []) listener();
  }

  private toError(error: unknown): ConsoleError {
    return {
      code: "CONSOLE_INTERNAL",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}
