// Holds the WebSocket to the relay and forwards incoming text to the page.
//
// The socket lives here rather than in the content script because page CSP on
// claude.ai can block outbound WebSocket connections made from a content
// script. The extension's service worker has no such restriction.
//
// MV3 service workers idle out after 30s. Two things keep this one alive:
// WebSocket traffic resets the timer (Chrome 116+), and the alarm below pings
// the relay every 20s so there is always traffic.

const TARGETS = [
  "https://claude.ai/*",
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*",
  "https://aistudio.google.com/*",
];

let socket = null;
let state = { connected: false, paired: false, room: "", relay: "" };
let retryDelay = 1500;

async function config() {
  const { room = "", relay = "" } = await chrome.storage.sync.get(["room", "relay"]);
  return { room: room.toUpperCase(), relay: relay.replace(/\/+$/, "") };
}

function wsUrl(relay, room) {
  let base = relay;
  if (base.startsWith("https://")) base = "wss://" + base.slice(8);
  else if (base.startsWith("http://")) base = "ws://" + base.slice(7);
  else base = "wss://" + base;
  return `${base}/?room=${encodeURIComponent(room)}`;
}

function publish() {
  chrome.runtime.sendMessage({ type: "status", state }).catch(() => {});
}

async function deliver(payload) {
  const tabs = await chrome.tabs.query({ url: TARGETS });
  if (!tabs.length) return;

  // Prefer the focused tab, else the most recently active one.
  tabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, payload);
      return;
    } catch {
      // Content script not ready in that tab; try the next.
    }
  }
}

async function connect() {
  const { room, relay } = await config();
  state.room = room;
  state.relay = relay;

  if (!/^[A-Z2-9]{6}$/.test(room) || !relay) {
    state.connected = false;
    state.paired = false;
    publish();
    return;
  }

  if (socket) {
    try { socket.close(); } catch {}
    socket = null;
  }

  try {
    socket = new WebSocket(wsUrl(relay, room));
  } catch {
    scheduleRetry();
    return;
  }

  socket.onopen = () => {
    state.connected = true;
    retryDelay = 1500;
    publish();
  };

  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "keepalive" || msg.type === "pong") return;

    if (msg.type === "presence") {
      state.paired = msg.count >= 2;
      publish();
      return;
    }
    if (msg.type === "text" && typeof msg.text === "string") {
      deliver({ type: "insert", text: msg.text });
      return;
    }
    if (msg.type === "submit") {
      deliver({ type: "submit" });
    }
  };

  socket.onclose = (ev) => {
    state.connected = false;
    state.paired = false;
    publish();
    if (ev.code !== 4000) scheduleRetry();
  };

  socket.onerror = () => {};
}

function scheduleRetry() {
  retryDelay = Math.min(retryDelay * 1.6, 30000);
  setTimeout(connect, retryDelay);
}

// chrome.alarms clamps to a 1-minute floor, which is slower than Chrome's 30s
// idle timeout — so an alarm alone cannot keep this worker alive. It serves only
// to resurrect the worker if it does die. Staying alive is the server's job: it
// pushes a keepalive message every 20s, and inbound WebSocket traffic resets the
// idle timer.
chrome.alarms.create("revive", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(() => {
  if (!socket || socket.readyState > 1) connect();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === "getStatus") {
    respond({ state });
    return true;
  }
  if (msg.type === "reconnect") {
    connect().then(() => respond({ ok: true }));
    return true;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.room || changes.relay) connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

connect();
