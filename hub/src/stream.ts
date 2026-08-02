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
