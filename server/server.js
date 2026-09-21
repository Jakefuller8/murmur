const http = require("http");
const fs = require("fs");
const path = require("path");
const ws = require("./ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

const wss = ws.attach(server);

// roomId -> Set<WebSocket>
const rooms = new Map();

function roomOf(ws) {
  return ws._room;
}

function broadcast(room, sender, payload) {
  const peers = rooms.get(room);
  if (!peers) return 0;
  let sent = 0;
  for (const peer of peers) {
    if (peer !== sender && peer.readyState === 1) {
      peer.send(payload);
      sent++;
    }
  }
  return sent;
}

function announcePresence(room) {
  const peers = rooms.get(room);
  if (!peers) return;
  const msg = JSON.stringify({ type: "presence", count: peers.size });
  for (const peer of peers) {
    if (peer.readyState === 1) peer.send(msg);
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const room = (url.searchParams.get("room") || "").trim().toUpperCase();

  // Room codes are 6 chars, A-Z and 2-9 only. Reject anything else.
  if (!/^[A-Z2-9]{6}$/.test(room)) {
    ws.close(4000, "Invalid room code");
    return;
  }

  ws._room = room;
  ws._alive = true;

  if (!rooms.has(room)) rooms.set(room, new Set());
  const peers = rooms.get(room);

  // Two devices per room: one phone, one laptop. If a third arrives, assume
  // it is a reconnect whose predecessor has not been reaped yet and evict the
  // oldest socket. Rejecting the newcomer instead causes a reconnect loop:
  // Chrome restarts the extension's service worker faster than the heartbeat
  // notices the dead socket, so the fresh connection gets refused every time.
  if (peers.size >= 2) {
    const oldest = peers.values().next().value;
    if (oldest) {
      peers.delete(oldest);
      try {
        oldest.close(4002, "Replaced by a newer connection");
      } catch {
        oldest.terminate();
      }
    }
  }

  peers.add(ws);
  announcePresence(room);

  ws.on("pong", () => {
    ws._alive = true;
  });

  ws.on("message", (raw) => {
    const text = raw.toString();
    if (text.length > 20000) return;

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    // Relay text and control messages straight through. The server never
    // inspects or stores the payload beyond a length check.
    if (msg.type === "text" || msg.type === "submit" || msg.type === "interim") {
      broadcast(room, ws, text);
    }
  });

  ws.on("close", () => {
    const set = rooms.get(room);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) rooms.delete(room);
    else announcePresence(room);
  });
});

// Two jobs here. Dropping dead sockets so rooms don't fill with ghosts, and
// sending a real text message every 20s. That second part matters: Chrome
// terminates an extension service worker after 30s idle, and receiving a
// WebSocket message resets that timer. Protocol-level ping frames are handled
// by the browser and don't reliably count, so this sends an actual message.
const heartbeat = setInterval(() => {
  const keepalive = JSON.stringify({ type: "keepalive", t: Date.now() });
  for (const ws of wss.clients) {
    if (!ws._alive) {
      ws.terminate();
      continue;
    }
    ws._alive = false;
    ws.ping();
    if (ws.readyState === 1) ws.send(keepalive);
  }
}, 20000);

process.on("SIGTERM", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Murmur relay listening on port ${PORT}`);
});
