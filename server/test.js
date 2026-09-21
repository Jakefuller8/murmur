// Integration tests for the relay. Run with: node test.js
// Spawns the real server and drives it with Node's built-in WebSocket client.

const { spawn } = require("child_process");
const http = require("http");

const PORT = 39411;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function open(room) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`${WS}/?room=${room}`);
    const inbox = [];
    let closeInfo = null;

    sock.addEventListener("message", (ev) => inbox.push(JSON.parse(ev.data)));
    sock.addEventListener("open", () => resolve({ sock, inbox, info: () => closeInfo }));
    sock.addEventListener("close", (ev) => {
      closeInfo = { code: ev.code, reason: ev.reason };
      resolve({ sock, inbox, info: () => closeInfo, rejectedAtOpen: true });
    });
    sock.addEventListener("error", () => {});
    setTimeout(() => reject(new Error("timeout opening " + room)), 3000);
  });
}

function get(path) {
  return new Promise((resolve) => {
    http.get(BASE + path, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on("error", () => resolve({ status: 0, body: "" }));
  });
}

async function main() {
  const server = spawn("node", ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverErr = "";
  server.stderr.on("data", (d) => (serverErr += d));

  await sleep(700);

  try {
    console.log("\nHTTP");
    const home = await get("/");
    ok("serves the phone page", home.status === 200 && home.body.includes("Hold to talk"));
    ok("sends html content type", /text\/html/.test(home.headers["content-type"] || ""));
    const missing = await get("/nope.js");
    ok("404s unknown paths", missing.status === 404);
    const escape = await get("/../server.js");
    ok("blocks path traversal", escape.status === 404 || escape.status === 403,
      `got ${escape.status}`);

    console.log("\nPairing");
    const bad = await open("abc");
    await sleep(250);
    ok("rejects a malformed room code",
      bad.sock.readyState === 3 && bad.info() && bad.info().code === 4000,
      JSON.stringify(bad.info()));

    const phone = await open("ABC234");
    ok("accepts a valid room code", !phone.rejectedAtOpen);

    await sleep(120);
    ok("reports one device present",
      phone.inbox.some((m) => m.type === "presence" && m.count === 1),
      JSON.stringify(phone.inbox));

    const laptop = await open("ABC234");
    await sleep(150);
    ok("reports two devices once paired",
      phone.inbox.some((m) => m.type === "presence" && m.count === 2));
    ok("tells the laptop it is paired",
      laptop.inbox.some((m) => m.type === "presence" && m.count === 2));

    const third = await open("ABC234");
    await sleep(250);
    ok("refuses a third device",
      third.sock.readyState === 3 && third.info() && third.info().code === 4001,
      JSON.stringify(third.info()));

    console.log("\nRelaying");
    laptop.inbox.length = 0;
    phone.sock.send(JSON.stringify({ type: "text", text: "hello from the cafe" }));
    await sleep(150);
    const got = laptop.inbox.find((m) => m.type === "text");
    ok("forwards text to the laptop", got && got.text === "hello from the cafe",
      JSON.stringify(laptop.inbox));

    phone.inbox.length = 0;
    phone.sock.send(JSON.stringify({ type: "text", text: "echo check" }));
    await sleep(150);
    ok("does not echo back to the sender",
      !phone.inbox.some((m) => m.type === "text"));

    laptop.inbox.length = 0;
    phone.sock.send(JSON.stringify({ type: "submit" }));
    await sleep(150);
    ok("forwards submit", laptop.inbox.some((m) => m.type === "submit"));

    laptop.inbox.length = 0;
    phone.sock.send(JSON.stringify({ type: "evil", text: "should not pass" }));
    await sleep(150);
    ok("drops unknown message types", laptop.inbox.length === 0);

    laptop.inbox.length = 0;
    phone.sock.send("this is not json");
    await sleep(120);
    ok("survives malformed json", laptop.inbox.length === 0 && phone.sock.readyState === 1);

    console.log("\nKeepalive");
    phone.inbox.length = 0;
    phone.sock.send(JSON.stringify({ type: "ping" }));
    await sleep(150);
    ok("answers ping with pong", phone.inbox.some((m) => m.type === "pong"));

    console.log("\nUnicode and size");
    laptop.inbox.length = 0;
    const unicode = "café — naïve 你好 🎧";
    phone.sock.send(JSON.stringify({ type: "text", text: unicode }));
    await sleep(150);
    const uni = laptop.inbox.find((m) => m.type === "text");
    ok("preserves multibyte characters", uni && uni.text === unicode,
      uni ? JSON.stringify(uni.text) : "nothing arrived");

    laptop.inbox.length = 0;
    const long = "word ".repeat(600).trim();
    phone.sock.send(JSON.stringify({ type: "text", text: long }));
    await sleep(200);
    const big = laptop.inbox.find((m) => m.type === "text");
    ok("handles a long dictation (extended frame length)",
      big && big.text.length === long.length,
      big ? `got ${big.text.length} of ${long.length}` : "nothing arrived");

    laptop.inbox.length = 0;
    phone.sock.send(JSON.stringify({ type: "text", text: "x".repeat(25000) }));
    await sleep(200);
    ok("rejects oversized payloads", laptop.inbox.length === 0);

    console.log("\nDisconnect");
    laptop.inbox.length = 0;
    phone.sock.close();
    await sleep(250);
    ok("notifies the survivor when a device leaves",
      laptop.inbox.some((m) => m.type === "presence" && m.count === 1),
      JSON.stringify(laptop.inbox));

    const rejoin = await open("ABC234");
    await sleep(200);
    ok("frees the slot for a reconnect", rejoin.sock.readyState === 1);
    rejoin.sock.close();
    laptop.sock.close();

    ok("server logged no errors", serverErr.trim() === "", serverErr.slice(0, 300));
  } catch (err) {
    failed++;
    console.log("\n  FAIL  harness threw — " + err.message);
  } finally {
    server.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main();
