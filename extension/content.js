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

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type === "insert") {
      const ok = insert(msg.text);
      if (!ok) toast("Couldn't find the chat box — click into it once", true);
      respond({ ok });
      return true;
    }
    if (msg.type === "submit") {
      respond({ ok: submit() });
      return true;
    }
  });
})();
