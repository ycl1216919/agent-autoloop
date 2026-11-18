// Failure modes: a reconnect starts a fresh session, drops the sequence, or never forwards a real interaction.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { connectGateway } from "../plugins/discord/gateway.ts";

test(
  "the native WebSocket gateway resumes its session and delivers the next interaction",
  { timeout: 12000 },
  async () => {
    const server = createServer();
    const sockets: Duplex[] = [];
    const stop = new AbortController();
    let connections = 0;
    let resumed: unknown;
    let received: unknown;
    let message: unknown;
    let intents: unknown;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `ws://127.0.0.1:${address.port}`;
    server.on("upgrade", (request, socket) => {
      sockets.push(socket);
      const key = request.headers["sec-websocket-key"];
      assert.equal(typeof key, "string");
      const accept = createHash("sha1")
        .update(String(key) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const send = (value: unknown) => {
        const payload = Buffer.from(JSON.stringify(value));
        const header =
          payload.length < 126
            ? Buffer.from([0x81, payload.length])
            : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
        socket.write(Buffer.concat([header, payload]));
      };
      const current = ++connections;
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 6) {
          const code = buffer[0] & 15;
          let length = buffer[1] & 127;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < 8) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          }
          if (buffer.length < offset + 4 + length) return;
          const mask = buffer.subarray(offset, offset + 4);
          const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
          for (let index = 0; index < length; index++) payload[index] ^= mask[index % 4];
          buffer = buffer.subarray(offset + 4 + length);
          if (code === 8) {
            socket.end(Buffer.from([0x88, 0]));
            return;
          }
          if (code !== 1) continue;
          const message = JSON.parse(payload.toString());
          if (message.op === 1) send({ op: 11 });
          if (current === 1 && message.op === 2) {
            intents = message.d.intents;
            send({ op: 0, t: "READY", s: 7, d: { session_id: "durable-session", resume_gateway_url: url } });
            send({ op: 7 });
          }
          if (current === 2 && message.op === 6) {
            resumed = message.d;
            send({ op: 0, t: "INTERACTION_CREATE", s: 8, d: { id: "123", type: 2 } });
            send({ op: 0, t: "MESSAGE_CREATE", s: 9, d: { id: "456", content: "继续开发" } });
          }
        }
      });
      send({ op: 10, d: { heartbeat_interval: 1000 } });
    });
    try {
      await connectGateway({
        url,
        token: "test-token",
        intents: (1 << 9) | (1 << 15),
        receive: async (event) => {
          received = event;
        },
        receiveMessage: async (event) => {
          message = event;
          stop.abort();
        },
        log: () => {},
        signal: stop.signal,
      });
      assert.deepEqual(resumed, { token: "test-token", session_id: "durable-session", seq: 7 });
      assert.deepEqual(received, { id: "123", type: 2 });
      assert.deepEqual(message, { id: "456", content: "继续开发" });
      assert.equal(intents, (1 << 9) | (1 << 15));
    } finally {
      stop.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
