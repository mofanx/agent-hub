import type { Stream, AnyMessage } from "@agentclientprotocol/sdk";
import type { WebSocket } from "ws";

/** 发送缓冲背压阈值：超过即挂起 write 等对端消费，向 ACP 生产端传导背压 */
const WS_SEND_DRAIN_LIMIT = 8 * 1024 * 1024;
/** 背压等待上限：死连接不永久卡死生产端，超时后维持原语义（消息照发） */
const WS_DRAIN_WAIT_MS = 10_000;

function waitForSendDrain(ws: WebSocket): Promise<void> {
  if (ws.bufferedAmount <= WS_SEND_DRAIN_LIMIT) return Promise.resolve();
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (ws.bufferedAmount <= WS_SEND_DRAIN_LIMIT || ws.readyState !== ws.OPEN) {
        clearInterval(poll);
        clearTimeout(cap);
        resolve();
      }
    }, 25);
    const cap = setTimeout(() => {
      clearInterval(poll);
      resolve();
    }, WS_DRAIN_WAIT_MS);
    poll.unref();
    cap.unref();
  });
}

export function webSocketStream(ws: WebSocket): Stream {
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      let closed = false;
      const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
        const text = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
        try {
          controller.enqueue(JSON.parse(text) as AnyMessage);
        } catch (err) {
          if (!closed) {
            closed = true;
            controller.error(err);
          }
        }
      };
      const onClose = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      const onError = (err: Error) => {
        if (closed) return;
        closed = true;
        controller.error(err);
      };
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", onError);
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(msg) {
      if (ws.readyState === ws.OPEN) {
        await waitForSendDrain(ws);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      }
    },
    close() {
      ws.close();
      return Promise.resolve();
    },
    abort() {
      ws.close();
      return Promise.resolve();
    },
  });

  return { readable, writable };
}

/** 复用帧：{ channel, payload } */
export type MultiplexFrame = {
  channel: string;
  payload: AnyMessage;
};

/** 控制帧：channel=__control__，method 为 announce 等控制方法 */
export type ControlFrame = {
  channel: "__control__";
  method: string;
  hostname?: string;
  channels?: { id: string; agent: string; name?: string }[];
  [key: string]: unknown;
};

export function isControlFrame(msg: unknown): msg is ControlFrame {
  return typeof msg === "object" && msg !== null &&
    (msg as Record<string, unknown>).channel === "__control__" &&
    typeof (msg as Record<string, unknown>).method === "string";
}

/** announce 帧特有判定。 */
export function isAnnounceFrame(msg: unknown): msg is ControlFrame & {
  method: "announce";
  channels: { id: string; agent: string; name?: string }[];
} {
  return isControlFrame(msg) && (msg as Record<string, unknown>).method === "announce" &&
    Array.isArray((msg as Record<string, unknown>).channels);
}

export function isMultiplexFrame(msg: unknown): msg is MultiplexFrame {
  return typeof msg === "object" && msg !== null &&
    typeof (msg as Record<string, unknown>).channel === "string" &&
    (msg as Record<string, unknown>).channel !== "__control__" &&
    typeof (msg as Record<string, unknown>).payload === "object";
}

/**
 * 从一个 WebSocket 创建多个虚拟 Stream，每个绑定一个 channel。
 * 读：从 ws 收消息，按 channel 分发到对应 controller
 * 写：每个子 stream 的写入包装成 { channel, payload } 发回 ws
 */
export function multiplexWebSocketStream(
  ws: WebSocket,
  channels: string[],
  onControl?: (frame: ControlFrame) => void,
): Map<string, Stream> {
  const controllers = new Map<string, ReadableStreamDefaultController<AnyMessage>>();
  const closed = new Set<string>();

  // 读端：监听 ws 消息，按 channel 分发
  const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
    const text = Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data).toString("utf8");
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (isControlFrame(msg)) {
      onControl?.(msg);
      return;
    }
    if (isMultiplexFrame(msg)) {
      const ctrl = controllers.get(msg.channel);
      if (ctrl) {
        try {
          ctrl.enqueue(msg.payload);
        } catch {
          // controller 已关闭
        }
      }
    }
  };

  const onClose = () => {
    for (const [, ctrl] of controllers) {
      try { ctrl.close(); } catch {}
    }
    controllers.clear();
  };

  ws.on("message", onMessage);
  ws.on("close", onClose);
  ws.on("error", onClose);

  const streams = new Map<string, Stream>();
  for (const ch of channels) {
    const readable = new ReadableStream<AnyMessage>({
      start(controller) {
        controllers.set(ch, controller);
      },
      cancel() {
        controllers.delete(ch);
        closed.add(ch);
      },
    });

    const writable = new WritableStream<AnyMessage>({
      async write(msg) {
        if (ws.readyState === ws.OPEN) {
          await waitForSendDrain(ws);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ channel: ch, payload: msg } as MultiplexFrame));
          }
        }
      },
      close() {
        closed.add(ch);
      },
      abort() {
        closed.add(ch);
      },
    });

    streams.set(ch, { readable, writable });
  }

  return streams;
}
