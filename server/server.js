// Relay for Murmur. Plain HTTP, no WebSockets, no dependencies.
//
// Why HTTP long-polling instead of WebSockets:
//   1. A Manifest V3 service worker is killed after ~30s idle, which tore down
//      the socket and caused a permanent reconnect flap.
//   2. Content scripts can't reliably open WebSockets — page CSP may block them
//      — but fetch() from a content script uses extension privileges and always
//      works.
// Long-polling gives near-instant delivery with neither problem.
//
// Endpoints
//   GET  /                      phone page
//   GET  /health                deploy check
//   GET  /poll?room=XXXXXX      laptop waits here for text (held up to 25s)
//   POST /say?room=XXXXXX       phone posts {text} or {submit:true}
//   GET  /presence?room=XXXXXX  is the other device around?

const http = require("http");
const fs = require("fs");
const path = require("path");

const VERSION = "0.2.0-longpoll";
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

const HOLD_MS = 25000; // how long a poll waits before returning empty
const PRESENCE_MS = 12000; // treat a device as present if seen within this
const MAX_TEXT = 20000;
const MAX_QUEUE = 20;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const ROOM_RE = /^[A-Z2-9]{6}$/;

// roomId -> { queue: [], waiters: [], lastPoll: 0, lastSay: 0 }
const rooms = new Map();

function room(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { queue: [], waiters: [], lastPoll: 0, lastSay: 0 };
    rooms.set(id, r);
  }
  return r;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function flush(r) {
  if (!r.queue.length || !r.waiters.length) return;
  const batch = r.queue.splice(0, r.queue.length);
  const waiters = r.waiters.splice(0, r.waiters.length);
  for (const w of waiters) {
    clearTimeout(w.timer);
    json(w.res, 200, { messages: batch });
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = "";
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      data += chunk;
      if (data.length > limit) {
        over = true;
        reject(new Error("too large"));
      }
    });
    req.on("end", () => {
      if (!over) resolve(data);
    });
    req.on("error", reject);
  });
}

function serveStatic(res, urlPath) {
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    json(res, 403, { error: "forbidden" });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;

  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  if (route === "/health") {
    json(res, 200, {
      ok: true,
      version: VERSION,
      rooms: rooms.size,
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  const id = (url.searchParams.get("room") || "").toUpperCase();

  if (route === "/poll") {
    if (!ROOM_RE.test(id)) {
      json(res, 400, { error: "bad room" });
      return;
    }
    const r = room(id);
    r.lastPoll = Date.now();

    if (r.queue.length) {
      const batch = r.queue.splice(0, r.queue.length);
      json(res, 200, { messages: batch });
      return;
    }

    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      const i = r.waiters.indexOf(waiter);
      if (i !== -1) r.waiters.splice(i, 1);
      json(res, 200, { messages: [] });
    }, HOLD_MS);

    r.waiters.push(waiter);
    req.on("close", () => {
      clearTimeout(waiter.timer);
      const i = r.waiters.indexOf(waiter);
      if (i !== -1) r.waiters.splice(i, 1);
    });
    return;
  }

  if (route === "/say" && req.method === "POST") {
    if (!ROOM_RE.test(id)) {
      json(res, 400, { error: "bad room" });
      return;
    }

    let body;
    try {
      body = JSON.parse((await readBody(req, MAX_TEXT + 500)) || "{}");
    } catch (err) {
      // Distinguish "you sent too much" from "that wasn't JSON" — the size
      // guard trips before the text-length check below, so without this the
      // caller gets a misleading 400.
      const tooBig = err && err.message === "too large";
      json(res, tooBig ? 413 : 400, { error: tooBig ? "too long" : "bad body" });
      return;
    }

    const r = room(id);
    r.lastSay = Date.now();
    const laptopHere = Date.now() - r.lastPoll < PRESENCE_MS;

    if (body.submit === true) {
      r.queue.push({ type: "submit" });
    } else if (typeof body.text === "string" && body.text.length) {
      if (body.text.length > MAX_TEXT) {
        json(res, 413, { error: "too long" });
        return;
      }
      r.queue.push({ type: "text", text: body.text });
    } else {
      json(res, 400, { error: "nothing to say" });
      return;
    }

    if (r.queue.length > MAX_QUEUE) r.queue.splice(0, r.queue.length - MAX_QUEUE);
    flush(r);
    json(res, 200, { ok: true, delivered: laptopHere });
    return;
  }

  if (route === "/presence") {
    if (!ROOM_RE.test(id)) {
      json(res, 400, { error: "bad room" });
      return;
    }
    const r = rooms.get(id);
    const now = Date.now();
    json(res, 200, {
      laptop: !!r && now - r.lastPoll < PRESENCE_MS,
      phone: !!r && now - r.lastSay < PRESENCE_MS,
    });
    return;
  }

  serveStatic(res, route === "/" ? "/index.html" : route);
});

// Reap rooms nobody has touched in a while.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, r] of rooms) {
    if (r.waiters.length) continue;
    if (r.lastPoll < cutoff && r.lastSay < cutoff) rooms.delete(id);
  }
}, 60000).unref();

server.listen(PORT, () => {
  console.log(`Murmur relay ${VERSION} listening on port ${PORT}`);
});
