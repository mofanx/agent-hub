type EventListener = (obj: Record<string, unknown>) => void;
type OpenListener = () => void;
type CloseListener = () => void;
type ErrorListener = (msg: string) => void;

export interface HubClientOptions {
  heartbeatIntervalMs?: number;
  maxReconnectDelayMs?: number;
}

export class HubClient {
  private ws?: WebSocket;
  private url?: string;
  private callbacks?: {
    onOpen: () => void;
    onFailure: (msg: string) => void;
  };

  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (reason: unknown) => void }
  >();

  private eventListeners = new Set<EventListener>();
  private openListeners = new Set<OpenListener>();
  private closeListeners = new Set<CloseListener>();
  private errorListeners = new Set<ErrorListener>();

  private heartbeatTimer?: number;
  private reconnectTimer?: number;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private shouldReconnect = true;
  private closed = false;
  private hadError = false;

  isConnected = false;

  constructor(private options: HubClientOptions = {}) {}

  connect(url: string, onOpen: () => void, onFailure: (msg: string) => void) {
    this.disconnect(false);
    this.url = url;
    this.callbacks = { onOpen, onFailure };
    this.closed = false;
    this.shouldReconnect = true;
    this.hadError = false;
    this._connect();
  }

  private _connect() {
    if (this.ws) {
      const old = this.ws;
      this.ws = undefined;
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      try {
        old.close();
      } catch {}
    }

    if (!this.url) return;

    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this._onFailure(String(e));
      return;
    }

    this.ws.onopen = () => this._onOpen();
    this.ws.onmessage = (ev) => this._onMessage(ev.data);
    this.ws.onclose = () => this._onClose();
    this.ws.onerror = () => this._onFailure("websocket error");
  }

  private _onOpen() {
    this.isConnected = true;
    this.reconnectAttempt = 0;
    this.reconnecting = false;
    this.hadError = false;
    this._startHeartbeat();
    this.openListeners.forEach((l) => l());
    this.callbacks?.onOpen();
  }

  private _onMessage(text: string) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }

    const id = typeof obj.id === "number" ? obj.id : undefined;
    if (id !== undefined && this.pending.has(id)) {
      const { resolve, reject } = this.pending.get(id)!;
      this.pending.delete(id);
      if (obj.error !== undefined) {
        reject(new Error(String(obj.error)));
      } else {
        resolve(((obj.result ?? {}) as Record<string, unknown>) || {});
      }
      return;
    }

    this.eventListeners.forEach((l) => l(obj));
  }

  private _onClose() {
    this.isConnected = false;
    this._stopHeartbeat();
    if (this.hadError) {
      this.closeListeners.forEach((l) => l());
    } else {
      this._failPending(new Error("connection closed"));
      this.closeListeners.forEach((l) => l());
      this.callbacks?.onFailure("connection closed");
    }
    if (!this.closed && this.shouldReconnect) {
      this._scheduleReconnect();
    }
  }

  private _onFailure(msg: string) {
    this.hadError = true;
    this.isConnected = false;
    this._stopHeartbeat();
    this._failPending(new Error(msg));
    this.errorListeners.forEach((l) => l(msg));
    this.callbacks?.onFailure(msg);
    if (!this.ws && !this.closed && this.shouldReconnect) {
      this._scheduleReconnect();
    }
  }

  private _failPending(err: Error) {
    const copy = new Map(this.pending);
    this.pending.clear();
    copy.forEach((d) => d.reject(err));
  }

  private _scheduleReconnect() {
    if (this.reconnecting || this.closed || !this.url) return;
    this.reconnecting = true;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt),
      this.options.maxReconnectDelayMs ?? 60000,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnecting = false;
      if (!this.closed) this._connect();
    }, delay);
  }

  private _clearReconnect() {
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnecting = false;
  }

  private _startHeartbeat() {
    this._stopHeartbeat();
    const interval = this.options.heartbeatIntervalMs ?? 20000;
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws && this.isConnected) {
        try {
          this.ws.send(JSON.stringify({ method: "ping" }));
        } catch {}
      }
    }, interval);
  }

  private _stopHeartbeat() {
    if (this.heartbeatTimer !== undefined) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || !this.isConnected) {
      return Promise.reject(new Error("not connected"));
    }
    const id = this.nextId++;
    const msg = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  disconnect(stopReconnect = true) {
    this._clearReconnect();
    if (stopReconnect) {
      this.closed = true;
      this.shouldReconnect = false;
    }
    this._stopHeartbeat();
    if (this.ws) {
      const old = this.ws;
      this.ws = undefined;
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      try {
        old.close();
      } catch {}
    }
    this.isConnected = false;
    this._failPending(new Error("disconnected"));
  }

  addEventListener(type: "event", listener: EventListener): () => void;
  addEventListener(type: "open", listener: OpenListener): () => void;
  addEventListener(type: "close", listener: CloseListener): () => void;
  addEventListener(type: "error", listener: ErrorListener): () => void;
  addEventListener(
    type: "event" | "open" | "close" | "error",
    listener: EventListener | OpenListener | CloseListener | ErrorListener,
  ): () => void {
    const wrapped = listener as unknown as () => void;
    if (type === "event") this.eventListeners.add(listener as EventListener);
    else if (type === "open") this.openListeners.add(listener as OpenListener);
    else if (type === "close") this.closeListeners.add(listener as CloseListener);
    else if (type === "error") this.errorListeners.add(listener as ErrorListener);
    return () => {
      if (type === "event") this.eventListeners.delete(listener as EventListener);
      else if (type === "open") this.openListeners.delete(listener as OpenListener);
      else if (type === "close") this.closeListeners.delete(listener as CloseListener);
      else if (type === "error") this.errorListeners.delete(listener as ErrorListener);
      void wrapped;
    };
  }

  removeEventListener(
    type: "event" | "open" | "close" | "error",
    listener: EventListener | OpenListener | CloseListener | ErrorListener,
  ) {
    if (type === "event") this.eventListeners.delete(listener as EventListener);
    else if (type === "open") this.openListeners.delete(listener as OpenListener);
    else if (type === "close") this.closeListeners.delete(listener as CloseListener);
    else if (type === "error") this.errorListeners.delete(listener as ErrorListener);
  }
}
