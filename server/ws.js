// Minimal RFC 6455 WebSocket server. Text frames, ping/pong, close.
// No dependencies, so the relay runs with plain `node server.js`.
//
// Deliberately does not implement: binary frames, permessage-deflate,
// or continuation frames larger than the buffer. Text-only relay
// doesn't need them.

const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 1 << 20; // 1 MiB

const OP = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const len = data.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode; // FIN set

  return Buffer.concat([header, data]);
}

class Connection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = 1; // OPEN
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOp = null;

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._finish());
    socket.on("error", () => this._finish());
    socket.setTimeout(0);
    socket.setNoDelay(true);
  }

  _finish() {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.emit("close", this._closeCode || 1006, this._closeReason || "");
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);

    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
      if (this.readyState === 3) return;
    }
  }

  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const high = buf.readUInt32BE(offset);
      const low = buf.readUInt32BE(offset + 4);
      if (high !== 0) {
        this.close(1009, "Too large");
        return null;
      }
      len = low;
      offset += 8;
    }

    if (len > MAX_PAYLOAD) {
      this.close(1009, "Too large");
      return null;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;

    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }

    this._buf = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this._closeCode = code;
      this._closeReason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      try {
        this.socket.write(encodeFrame(OP.CLOSE, payload));
      } catch {}
      this.socket.end();
      return;
    }

    if (opcode === OP.PING) {
      this._send(OP.PONG, payload);
      return;
    }

    if (opcode === OP.PONG) {
      this.emit("pong");
      return;
    }

    if (opcode === OP.CONTINUATION) {
      if (this._fragmentOp === null) return;
      this._fragments.push(payload);
    } else {
      if (!fin) {
        this._fragmentOp = opcode;
        this._fragments = [payload];
        return;
      }
      if (opcode === OP.TEXT) this.emit("message", payload.toString("utf8"));
      return;
    }

    if (fin) {
      const full = Buffer.concat(this._fragments);
      const op = this._fragmentOp;
      this._fragments = [];
      this._fragmentOp = null;
      if (op === OP.TEXT) this.emit("message", full.toString("utf8"));
    }
  }

  _send(opcode, payload) {
    if (this.readyState !== 1) return false;
    try {
      this.socket.write(encodeFrame(opcode, payload));
      return true;
    } catch {
      return false;
    }
  }

  send(text) {
    return this._send(OP.TEXT, text);
  }

  ping() {
    return this._send(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = "") {
    if (this.readyState !== 1) return;

    // The frame must go out while readyState is still OPEN — _send refuses to
    // write otherwise, and the peer would see an abnormal 1006 close with no
    // reason instead of the code we meant to send.
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._send(OP.CLOSE, body);

    this.readyState = 2; // CLOSING
    this.socket.end();
  }

  terminate() {
    try {
      this.socket.destroy();
    } catch {}
    this._finish();
  }
}

// Attaches to an http.Server and emits "connection" (conn, req).
function attach(server) {
  const emitter = new EventEmitter();
  emitter.clients = new Set();

  server.on("upgrade", (req, socket, head) => {
    const key = req.headers["sec-websocket-key"];
    const version = req.headers["sec-websocket-version"];
    const upgrade = (req.headers.upgrade || "").toLowerCase();

    if (upgrade !== "websocket" || !key || version !== "13") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );

    const conn = new Connection(socket);
    if (head && head.length) conn._onData(head);

    emitter.clients.add(conn);
    conn.on("close", () => emitter.clients.delete(conn));
    emitter.emit("connection", conn, req);
  });

  return emitter;
}

module.exports = { attach, encodeFrame, acceptKey };
