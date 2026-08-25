import type { Stream, AnyMessage } from "@agentclientprotocol/sdk";
import type { WebSocket } from "ws";

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
    write(msg) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
      return Promise.resolve();
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

/** 控制帧：announce 声明可用通道 */
export type ControlFrame = {
  channel: "__control__";
  method: "announce";
  hostname?: string;
  channels: { id: string; agent: string; name?: string }[];
};

export function isControlFrame(msg: unknown): msg is ControlFrame {
  return typeof msg === "object" && msg !== null &&
    (msg as Record<string, unknown>).channel === "__control__" &&
    (msg as Record<string, unknown>).method === "announce";
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
      write(msg) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ channel: ch, payload: msg } as MultiplexFrame));
        }
        return Promise.resolve();
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
