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

function render(state) {
  if (!state.relay || !/^[A-Z2-9]{6}$/.test(state.room)) {
    els.dot.dataset.state = "off";
    els.status.textContent = "Enter a relay and code";
  } else if (state.paired) {
    els.dot.dataset.state = "paired";
    els.status.textContent = "Paired with your phone";
  } else if (state.connected) {
    els.dot.dataset.state = "waiting";
    els.status.textContent = "Waiting for phone";
  } else {
    els.dot.dataset.state = "off";
    els.status.textContent = "Can't reach the relay";
  }

  if (state.relay && state.room) {
    const url = `https://${normalizeRelay(state.relay)}/#${state.room}`;
    els.phoneLink.href = url;
    els.phoneLink.innerHTML = `Open on your phone: <b>${url}</b>`;
  } else {
    els.phoneLink.textContent = "";
  }
}

async function load() {
  const { room, relay } = await chrome.storage.sync.get(["room", "relay"]);
  els.relay.value = relay || "";
  els.room.value = room || newCode();
  if (!room) await chrome.storage.sync.set({ room: els.room.value });

  chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
    if (res && res.state) render(res.state);
  });
}

els.save.addEventListener("click", async () => {
  const relay = normalizeRelay(els.relay.value);
  const room = els.room.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);

  if (room.length !== 6) {
    els.status.textContent = "Code must be 6 characters";
    return;
  }

  els.relay.value = relay;
  els.room.value = room;
  await chrome.storage.sync.set({ relay, room });
  chrome.runtime.sendMessage({ type: "reconnect" }, () => {
    chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
      if (res && res.state) render(res.state);
    });
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") render(msg.state);
});

load();
