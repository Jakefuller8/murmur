# Murmur

Speak quietly into your phone. The text appears in the AI chat box on your laptop.

Your phone does the listening and the transcribing. Only finished text crosses the
network — no audio streaming, no virtual audio driver, nothing to install on your
laptop except a Chrome extension.

```
phone mic  ->  transcribed on phone  ->  relay  ->  extension  ->  types into the chat box
```

Works on claude.ai, chatgpt.com, gemini.google.com and aistudio.google.com — in
Chrome, in a browser tab. Not the Claude desktop app.

---

## What's here

| Path | What it is |
|---|---|
| `server/server.js` | Relay. Plain HTTP long-polling, zero dependencies. |
| `server/public/index.html` | The phone page. |
| `server/test.js` | Relay tests. `npm test` — 23 assertions, all passing. |
| `extension/` | Chrome extension (Manifest V3). |
| `extension/test-page.html` | Open in Chrome to test text insertion with no relay needed. |

## How it works

The content script running on the chat page long-polls the relay: it makes a
request that the server holds open for up to 25 seconds, returning the moment
your phone posts some text. Delivery lands in a few hundred milliseconds.

This replaced an earlier WebSocket design for two reasons, both worth knowing if
you ever refactor it:

1. **Manifest V3 service workers are killed after ~30s idle.** A socket held
   there gets torn down, reconnects, and dies again — a permanent flap.
   `chrome.alarms` cannot fix it, because alarms clamp to a 1-minute floor,
   which is slower than the timeout.
2. **Content scripts can't reliably open WebSockets** — page CSP may block them.
   But `fetch()` from a content script runs with extension privileges and is
   never blocked.

Polling from the content script sidesteps both. The loop lives as long as the
tab, and there is no background worker at all.

---

## Step 1 — Put the relay online

No dependencies, so there is nothing to install. Any free Node host works.

1. Push this repo to GitHub.
2. On [render.com](https://render.com), create a **Web Service** pointed at the repo.
3. **Root Directory** `server`, **Build Command** `npm install`, **Start Command** `npm start`.
4. Deploy. Note the address Render gives you — it may differ from the name you
   chose, since subdomains are globally unique.

Check it worked by visiting `https://your-address.onrender.com/health`. You want
`{"ok":true,"version":"0.2.0-longpoll", ...}`.

The free tier sleeps after 15 minutes idle, so the first request of the day takes
about 30 seconds. Fine for testing, not for other people.

### Or run it locally

```bash
cd server
npm start
```

Browsers only grant microphone access on `https://` or `localhost`, so a plain
LAN address will not work for the phone. Use a real deploy or `ngrok http 3000`.

---

## Step 2 — Load the extension

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → pick `extension/`.
2. Click the Murmur icon. Enter your relay address without `https://`.
3. Leave the pairing code as generated. Click **Save and connect**.

---

## Step 3 — Open it on your phone

The popup shows a link ending in `/#ABC234`. Open it in **Safari** on iPhone or
**Chrome** on Android — other iOS browsers cannot transcribe. Allow the mic.

---

## Step 4 — Use it

1. On your laptop, open Claude. Look for the **Murmur linked** pill in the top right.
2. **Click into the message box.**
3. Hold the button on your phone, speak, release.

The cursor has to be in the message box — once per session, not once per prompt.

---

## Test status

Relay: `cd server && npm test`. Covers validation, presence, queueing when the
laptop is between polls, submit relaying, unicode, long dictations, oversized
payloads, delivery latency and room isolation.

Insertion: open `extension/test-page.html` in Chrome. Runs the real `content.js`
against a mock ProseMirror box and checks it appends rather than replaces, fires
the `beforeinput`/`input` events frameworks depend on, and finds the send button.

Untested because it needs real hardware: iOS Safari speech recognition, and
whether phone noise suppression preserves quiet speech. That second one is the
question the whole project exists to answer.

---

## Known limits

**Chrome, browser tabs only.** Reaching the Claude desktop app, Word or a
terminal needs a small native helper that synthesizes keystrokes — the macOS
Accessibility API, or `SendInput` on Windows. Roughly 300 lines per platform.

**Transcription is the browser's.** The Web Speech API is free but literal: it
keeps every "um" and false start, and on iOS it routes audio through Apple's
servers. A hosted speech model would be markedly better at roughly a cent or two
per minute. That is the biggest quality lever in the system.

**iOS ends recognition sessions on its own.** The page restarts it while the
button is held, which usually hides the seam, though a word occasionally clips.

**The screen must stay on** and the page in the foreground. iOS suspends
background pages, so there is no always-listening mode.

**The relay is unauthenticated.** A six-character code is all that protects your
text. Fine for testing alone. Before letting anyone else use it, derive a key
from the pairing code and encrypt end to end so the relay cannot read it.

**Selectors will break.** `content.js` finds the chat box by CSS selector; the
generic `div[contenteditable="true"]` fallback absorbs most redesigns.

---

## If nothing happens

- **No pill in the top right** — reload the chat tab. Content scripts only inject on page load, so any tab open before you installed or reloaded the extension has no script in it.
- **Pill says "Murmur offline"** — wrong relay address, or the service is asleep. Open `/health` in a tab to wake it.
- **Pill says "Murmur not set up"** — open the popup and click Save and connect.
- **Pill says linked, but no text** — you did not click into the chat box.
- **Toast: "Couldn't find the chat box"** — same. Click the box first.
- **Phone says "Sent, but no laptop is listening"** — the codes differ. Make the code on the phone match the extension's exactly.
- **Phone shows no grey preview text** — wrong browser, or mic permission denied.
