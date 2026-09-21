// Integration tests for the long-polling relay. Run with: node test.js

const { spawn } = require("child_process");

const PORT = 39412;
const BASE = `http://127.0.0.1:${PORT}`;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(BASE + path, { cache: "no-store" });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text };
}

async function post(path, payload) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
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
    console.log("\nBasics");
    const health = await get("/health");
    ok("health reports ok", health.status === 200 && health.body.ok === true);
    ok("health reports a version", typeof health.body.version === "string",
      JSON.stringify(health.body));

    const home = await get("/");
    ok("serves the phone page", home.status === 200 && home.text.includes("Hold to talk"));
    ok("404s unknown paths", (await get("/nope.js")).status === 404);
    ok("blocks path traversal", (await get("/../server.js")).status >= 400);

    console.log("\nValidation");
    ok("rejects a bad room on poll", (await get("/poll?room=abc")).status === 400);
    ok("rejects a bad room on say",
      (await post("/say?room=abc", { text: "hi" })).status === 400);
    ok("rejects an empty say",
      (await post("/say?room=ABC234", {})).status === 400);
    ok("rejects oversized text",
      (await post("/say?room=ABC234", { text: "x".repeat(25000) })).status === 413);

    console.log("\nPresence");
    let pres = await get("/presence?room=ZZZ234");
    ok("reports nobody in an unused room",
      pres.body.laptop === false && pres.body.phone === false);

    // Start a poll without awaiting it — this is the laptop arriving.
    let pending = get("/poll?room=ABC234");
    await sleep(200);
    pres = await get("/presence?room=ABC234");
    ok("sees the laptop once it polls", pres.body.laptop === true);

    console.log("\nDelivery");
    const said = await post("/say?room=ABC234", { text: "hello from the cafe" });
    ok("accepts the text", said.status === 200 && said.body.ok === true);
    ok("confirms a laptop was listening", said.body.delivered === true);

    const delivered = await pending;
    ok("the waiting poll returns immediately",
      delivered.body.messages.length === 1 &&
        delivered.body.messages[0].text === "hello from the cafe",
      JSON.stringify(delivered.body));

    console.log("\nQueueing while the laptop is between polls");
    await post("/say?room=QUE234", { text: "first" });
    await post("/say?room=QUE234", { text: "second" });
    const drained = await get("/poll?room=QUE234");
    ok("queues messages sent before the poll arrives",
      drained.body.messages.length === 2 &&
        drained.body.messages[0].text === "first" &&
        drained.body.messages[1].text === "second",
      JSON.stringify(drained.body));

    console.log("\nSubmit");
    pending = get("/poll?room=SUB234");
    await sleep(150);
    await post("/say?room=SUB234", { submit: true });
    const sub = await pending;
    ok("relays a submit instruction",
      sub.body.messages.some((m) => m.type === "submit"),
      JSON.stringify(sub.body));

    console.log("\nUnicode and size");
    pending = get("/poll?room=UNI234");
    await sleep(150);
    const unicode = "café — naïve 你好 🎧";
    await post("/say?room=UNI234", { text: unicode });
    const uni = await pending;
    ok("preserves multibyte characters",
      uni.body.messages[0].text === unicode,
      JSON.stringify(uni.body.messages[0]));

    pending = get("/poll?room=LON234");
    await sleep(150);
    const long = "word ".repeat(600).trim();
    await post("/say?room=LON234", { text: long });
    const big = await pending;
    ok("handles a long dictation intact",
      big.body.messages[0].text.length === long.length,
      `${big.body.messages[0].text.length} of ${long.length}`);

    console.log("\nNo laptop listening");
    const orphan = await post("/say?room=NOB234", { text: "into the void" });
    ok("accepts text with nobody listening", orphan.status === 200);
    ok("but reports it was not delivered", orphan.body.delivered === false);

    console.log("\nLong-poll timing");
    const t0 = Date.now();
    pending = get("/poll?room=TIM234");
    await sleep(600);
    await post("/say?room=TIM234", { text: "quick" });
    await pending;
    const elapsed = Date.now() - t0;
    ok("delivers in well under a second of the text being sent",
      elapsed < 1500, `took ${elapsed}ms`);

    console.log("\nConcurrent rooms");
    const a = get("/poll?room=AAA234");
    const b = get("/poll?room=BBB234");
    await sleep(150);
    await post("/say?room=AAA234", { text: "for A" });
    await post("/say?room=BBB234", { text: "for B" });
    const [ra, rb] = await Promise.all([a, b]);
    ok("keeps rooms isolated",
      ra.body.messages[0].text === "for A" && rb.body.messages[0].text === "for B",
      JSON.stringify([ra.body, rb.body]));

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
