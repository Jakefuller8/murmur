const els = {
  dot: document.getElementById("dot"),
  status: document.getElementById("status"),
  relay: document.getElementById("relay"),
  room: document.getElementById("room"),
  save: document.getElementById("save"),
  phoneLink: document.getElementById("phoneLink"),
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode() {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function normalizeRelay(value) {
  return value.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function render(tone, text) {
  els.dot.dataset.state = tone;
  els.status.textContent = text;
}

function renderLink(relay, room) {
  if (relay && room) {
    const url = `https://${normalizeRelay(relay)}/#${room}`;
    els.phoneLink.href = url;
    els.phoneLink.innerHTML = `Open on your phone: <b>${url}</b>`;
  } else {
    els.phoneLink.textContent = "";
  }
}

// The content script does the polling now, so the popup only reports health.
async function probe(relay, room) {
  if (!relay || !/^[A-Z2-9]{6}$/.test(room)) {
    render("off", "Enter a relay and code");
    return;
  }
  try {
    const health = await fetch(`https://${normalizeRelay(relay)}/health`, {
      cache: "no-store",
    });
    if (!health.ok) throw new Error();
    const info = await health.json();

    const pres = await fetch(
      `https://${normalizeRelay(relay)}/presence?room=${room}`,
      { cache: "no-store" }
    );
    const p = await pres.json();

    if (p.phone) render("paired", `Phone active · relay ${info.version}`);
    else render("waiting", `Relay up · waiting for phone`);
  } catch {
    render("off", "Can't reach the relay");
  }
}

async function load() {
  const { room, relay } = await chrome.storage.sync.get(["room", "relay"]);
  els.relay.value = relay || "";
  els.room.value = room || newCode();
  if (!room) await chrome.storage.sync.set({ room: els.room.value });
  renderLink(els.relay.value, els.room.value);
  probe(els.relay.value, els.room.value);
}

els.save.addEventListener("click", async () => {
  const relay = normalizeRelay(els.relay.value);
  const room = els.room.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);

  if (room.length !== 6) {
    render("off", "Code must be 6 characters");
    return;
  }

  els.relay.value = relay;
  els.room.value = room;
  await chrome.storage.sync.set({ relay, room });
  renderLink(relay, room);
  render("waiting", "Saved — checking…");
  probe(relay, room);
});

load();
setInterval(() => probe(els.relay.value, els.room.value), 3000);
