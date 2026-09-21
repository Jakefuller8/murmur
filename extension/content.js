// Receives text from the service worker and inserts it into the page's
// prompt box as though it had been typed.

(function () {
  "use strict";

  // Ordered most-specific first. The generic fallbacks catch UI redesigns.
  const SELECTORS = [
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][role="textbox"]',
    "#prompt-textarea",
    'textarea[data-id="root"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"]',
    "form textarea",
    "textarea",
  ];

  const SEND_SELECTORS = [
    'button[aria-label*="Send" i]',
    'button[data-testid="send-button"]',
    'button[aria-label*="Submit" i]',
    'button[type="submit"]',
  ];

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === "TEXTAREA" || (tag === "INPUT" && /^(text|search)$/i.test(el.type));
  }

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 10) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function findBox() {
    if (isEditable(document.activeElement) && visible(document.activeElement)) {
      return document.activeElement;
    }
    for (const sel of SELECTORS) {
      const matches = Array.from(document.querySelectorAll(sel)).filter(visible);
      if (matches.length) {
        // The prompt box is almost always the lowest one on screen.
        matches.sort(
          (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top
        );
        return matches[0];
      }
    }
    return null;
  }

  function moveCaretToEnd(el) {
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (typeof el.selectionStart === "number") {
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
  }

  function needsSpace(el) {
    const current = el.isContentEditable ? el.innerText : el.value;
    return current && !/\s$/.test(current);
  }

  function insert(text) {
    const box = findBox();
    if (!box) return false;

    box.focus();
    moveCaretToEnd(box);

    const payload = (needsSpace(box) ? " " : "") + text;

    // execCommand fires beforeinput/input, which is what React and ProseMirror
    // listen for. Setting .value or .textContent directly leaves the framework
    // unaware and the send button disabled.
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, payload);
    } catch {
      ok = false;
    }

    if (!ok) {
      if (box.isContentEditable) {
        box.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data: payload,
            bubbles: true,
            cancelable: true,
          })
        );
        box.textContent = (box.innerText || "") + payload;
      } else {
        box.value = (box.value || "") + payload;
      }
      box.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertText",
          data: payload,
          bubbles: true,
        })
      );
    }

    moveCaretToEnd(box);
    return true;
  }

  function submit() {
    for (const sel of SEND_SELECTORS) {
      const btn = Array.from(document.querySelectorAll(sel)).find(
        (b) => visible(b) && !b.disabled
      );
      if (btn) {
        btn.click();
        return true;
      }
    }

    const box = findBox();
    if (!box) return false;
    box.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      box.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }
    return true;
  }

  let toastEl = null;
  let toastTimer = null;

  function toast(message, bad) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      Object.assign(toastEl.style, {
        position: "fixed",
        bottom: "22px",
        left: "50%",
        transform: "translateX(-50%)",
        padding: "8px 14px",
        borderRadius: "999px",
        font: "500 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: "#fff",
        zIndex: "2147483647",
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity .18s",
      });
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.background = bad ? "#b4443c" : "#2f3640";
    toastEl.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = "0";
    }, 1600);
  }

  // ---- status pill -------------------------------------------------------
  // Visible on the page so you can tell at a glance whether the phone is
  // linked, without opening the popup.

  let pill = null;

  function showPill(text, tone) {
    if (!pill) {
      pill = document.createElement("div");
      Object.assign(pill.style, {
        position: "fixed",
        top: "10px",
        right: "12px",
        padding: "5px 11px",
        borderRadius: "999px",
        font: "500 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        zIndex: "2147483646",
        pointerEvents: "none",
        transition: "opacity .2s",
        opacity: "0.92",
      });
      document.documentElement.appendChild(pill);
    }
    const tones = {
      live: ["#1c6b45", "#e4f4ec"],
      wait: ["#7a5a12", "#fdf3da"],
      dead: ["#9c2f26", "#fbe8e6"],
    };
    const [fg, bg] = tones[tone] || tones.dead;
    pill.textContent = text;
    pill.style.color = fg;
    pill.style.background = bg;
  }

  // ---- long-polling loop -------------------------------------------------
  // fetch() from a content script uses extension privileges, so page CSP
  // cannot block it. The loop lives in the page, so it survives as long as
  // the tab does — no service worker to be killed.

  let config = { relay: "", room: "" };
  let running = false;
  let backoff = 1000;

  function base() {
    let host = config.relay.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return "https://" + host;
  }

  function handle(messages) {
    for (const msg of messages) {
      if (msg.type === "text") {
        if (!insert(msg.text)) {
          toast("Couldn't find the chat box — click into it once", true);
        }
      } else if (msg.type === "submit") {
        submit();
      }
    }
  }

  async function loop() {
    if (running) return;
    running = true;

    for (;;) {
      const { relay, room } = config;
      if (!relay || !/^[A-Z2-9]{6}$/.test(room)) {
        showPill("Murmur not set up", "dead");
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      try {
        const res = await fetch(
          `${base()}/poll?room=${encodeURIComponent(room)}`,
          { method: "GET", cache: "no-store" }
        );
        if (!res.ok) throw new Error("status " + res.status);

        const data = await res.json();
        backoff = 1000;
        showPill("Murmur linked", "live");
        if (data.messages && data.messages.length) handle(data.messages);
      } catch {
        showPill("Murmur offline", "dead");
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 1.7, 15000);
      }
    }
  }

  chrome.storage.sync.get(["relay", "room"], (stored) => {
    config.relay = stored.relay || "";
    config.room = (stored.room || "").toUpperCase();
    loop();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.relay) config.relay = changes.relay.newValue || "";
    if (changes.room) config.room = (changes.room.newValue || "").toUpperCase();
  });
})();
