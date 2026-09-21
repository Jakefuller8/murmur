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

  // Two devices per room: one phone, one laptop. Reject a third.
  if (peers.size >= 2) {
    ws.close(4001, "Room full");
    return;
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

// Drop dead sockets so rooms don't fill up with ghosts.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._alive) {
      ws.terminate();
      continue;
    }
    ws._alive = false;
    ws.ping();
  }
}, 30000);

process.on("SIGTERM", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Murmur relay listening on port ${PORT}`);
});
