# Murmur

Speak quietly into your phone. The text appears in the Claude chat box on your laptop.

Your phone does the listening and the transcribing. Only finished text crosses the
network — no audio streaming, no virtual audio driver, nothing to install on your
laptop except a Chrome extension.

```
phone mic  ->  transcribed on phone  ->  relay  ->  extension  ->  types into Claude
```

Works on claude.ai, chatgpt.com, gemini.google.com, and aistudio.google.com.

---

## What's here

| Path | What it is |
|---|---|
| `server/` | Relay server. Also serves the phone page. Zero dependencies. |
| `server/ws.js` | Hand-rolled WebSocket implementation, so there is nothing to `npm install`. |
| `server/test.js` | Relay integration tests. `npm test` — 22 assertions, all passing. |
| `extension/` | Chrome extension (Manifest V3). |
| `extension/test-page.html` | Open in Chrome to test the text-insertion logic without deploying anything. |

## Test status

The relay is tested and passing: `cd server && npm test` spins up the real
server and drives it over a WebSocket — pairing, presence, relaying, the
two-device room cap, malformed input, unicode, long dictations, oversized
payloads, and reconnects.

The insertion logic is tested in the browser: open `extension/test-page.html`
in Chrome. It loads the real `content.js` against a mock ProseMirror box and
checks that it appends rather than replaces, fires the `beforeinput`/`input`
events frameworks depend on, handles multibyte text, and finds the send button.

Untested, because they need real hardware: iOS Safari speech recognition, the
service worker's WebSocket lifetime under Chrome's idle timer, and whether phone
noise suppression preserves quiet speech. That last one is the important one.

---

## Step 1 — Put the relay online

The phone and the laptop both need to reach the same address, so this has to be
hosted somewhere. Any free Node host works. Render is the least fiddly:

1. Push this repo to GitHub.
2. On [render.com](https://render.com), create a new **Web Service** and point it at the repo.
3. Set **Root Directory** to `server`, leave **Build Command** empty, **Start Command** `npm start`.
4. Deploy. You'll get an address like `murmur-relay.onrender.com`.

Note the free tier sleeps after inactivity, so the first connection of the day
takes 30 seconds or so to wake up. Fine for testing, not for real users.

### Or run it locally first

No install step — the relay has no dependencies.

```bash
cd server
npm start
```

Then open `http://localhost:3000` on your laptop to confirm the page loads. Your
phone won't reach `localhost`, so use your machine's LAN address
(`http://192.168.x.x:3000`) with both devices on the same WiFi. **Caveat:** browsers
only allow microphone access on `https://` or `localhost`, so speech recognition
will not work over a plain LAN address. For phone testing you need either a real
HTTPS deploy or a tunnel like `ngrok http 3000`.

---

## Step 2 — Load the extension

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Click the Murmur icon in the toolbar.
4. Enter your relay address (e.g. `murmur-relay.onrender.com`) and leave the
   generated pairing code as is.
5. Click **Save and connect**. The dot turns amber: connected, waiting for a phone.

---

## Step 3 — Open it on your phone

The popup shows a link like `https://your-relay.onrender.com/#ABC234`. Open that
on your phone — **Safari on iPhone, Chrome on Android**. Other iOS browsers can't
use the speech API.

Allow microphone access when asked. The dot turns green on both devices.

---

## Step 4 — Use it

1. On your laptop, open Claude and **click into the message box once**.
2. On your phone, hold the big button and speak.
3. Release. The text appears in Claude.

The cursor has to be in the message box for the text to land there — once per
session, not once per prompt. Turn on **Send on release** if you want it to submit
automatically, though reading the transcript before sending is usually wiser.

---

## Known limits

**Chrome only, browser only.** An extension can't reach the Claude desktop app,
Word, Notion, or a terminal. Reaching those needs a small native helper that
synthesizes keystrokes — the macOS Accessibility API, or `SendInput` on Windows.
Roughly 300 lines per platform, and a separate build.

**Transcription is the browser's, not yours.** The Web Speech API is free but
literal: it keeps every "um" and false start, and on iOS it routes audio through
Apple's servers. Swapping in a hosted speech model would improve accuracy a lot
and cost roughly a cent or two per minute. That is the single biggest quality
lever in the whole system.

**iOS ends recognition sessions on its own.** The phone page restarts it while the
button is held, which usually hides the seam. Occasionally a word gets clipped at
the restart boundary.

**The screen has to stay on** and the page has to stay in the foreground. iOS
suspends background pages, so there is no always-listening mode.

**The relay is not authenticated.** A six-character code and a two-device room cap
is all that stands between your text and anyone who guesses the code. Fine for
testing with yourself. Before letting anyone else use it, derive a key from the
pairing code and encrypt the payload end to end so the relay can't read it.

**Selectors will break.** `content.js` finds the chat box by CSS selector. When
Claude or ChatGPT reship their UI, the specific selectors go stale — the generic
`div[contenteditable="true"]` fallback is there to absorb most redesigns.

---

## If nothing happens

- **Text goes to the wrong place** — click into the chat box first.
- **Amber dot that never turns green** — the two devices have different pairing codes, or the relay is asleep. Open the relay address in a browser to wake it.
- **Phone says "not supported"** — wrong browser. Safari on iPhone, Chrome on Android.
- **Mic blocked** — the page must be on `https://`. Plain `http://` over LAN will not get microphone permission.
- **Nothing arrives after a while** — Chrome may have idled out the service worker. Open the popup, which wakes it, and check `chrome://extensions` for errors under Murmur.
