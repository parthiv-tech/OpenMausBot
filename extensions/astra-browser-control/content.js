// Astra Browser Control — content script (page actor).
//
// Injected at document_idle into http(s) pages. Executes DOM-level commands
// relayed from the service worker. Everything here runs in the ISOLATED world;
// page JS is never touched directly (eval runs through the MAIN world from the
// worker via chrome.scripting). Responds only to a well-formed command object.
//
// Supported: ping, click, type, press, scroll, read.

(() => {
  "use strict";

  if (window.__astraBrowserControl) return;
  window.__astraBrowserControl = true;

  const MAX_TEXT = 200_000;
  const MAX_LINKS = 200;
  const MAX_INPUTS = 100;

  function visible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (el.hidden || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findElement({ selector, text, index = 0 }) {
    if (typeof selector !== "string" || !selector) throw new Error("selector is required");
    const candidates = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (text != null) {
      const needle = String(text).toLowerCase();
      const matches = candidates.filter((el) =>
        (el.innerText || el.textContent || "").toLowerCase().includes(needle)
      );
      if (!matches.length) throw new Error(`No visible "${selector}" containing "${text}"`);
      const el = matches[Math.min(Number(index) || 0, matches.length - 1)];
      if (!el) throw new Error("Match index out of range");
      return el;
    }
    const el = candidates[Number(index) || 0];
    if (!el) throw new Error(`No visible element matches "${selector}"`);
    return el;
  }

  function describe(el) {
    const label =
      el.getAttribute?.("aria-label") ||
      (el.labels && el.labels[0]?.innerText) ||
      el.innerText?.slice(0, 120) ||
      el.getAttribute?.("placeholder") ||
      el.tagName?.toLowerCase();
    return { tag: el.tagName?.toLowerCase(), id: el.id || undefined, label: String(label ?? "").trim() };
  }

  function click(args) {
    const el = findElement(args);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.click();
    return { clicked: describe(el) };
  }

  function type(args) {
    if (typeof args.text !== "string") throw new Error("text is required");
    const el = findElement(args);
    const inner =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el
        : el.isContentEditable
          ? el
          : el.querySelector?.("input, textarea, [contenteditable]") || null;
    if (!inner) throw new Error("Element is not typeable");
    inner.focus();
    if (inner.select && args.clear !== false) inner.select();
    if ("value" in inner) {
      const base = args.clear === false ? inner.value : "";
      inner.value = base;
      inner.value = base + args.text;
      inner.dispatchEvent(new Event("input", { bubbles: true }));
      inner.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const sel = window.getSelection();
      sel.selectAllChildren(inner);
      if (args.clear === false) sel.collapseToEnd();
      else sel.deleteFromDocument();
      document.execCommand("insertText", false, args.text);
    }
    return { typed: describe(el), length: args.text.length };
  }

  function press({ key }) {
    if (typeof key !== "string" || key.length > 32) throw new Error("key must be a short string");
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    return { pressed: key, focus: describe(target instanceof HTMLElement ? target : document.body) };
  }

  function scroll({ deltaY }) {
    window.scrollBy({ top: Number(deltaY) || 600, behavior: "instant" });
    return { scrollY: window.scrollY };
  }

  function read() {
    const text = (document.body?.innerText || "").slice(0, MAX_TEXT);
    const links = Array.from(document.querySelectorAll("a[href]"))
      .filter(visible)
      .slice(0, MAX_LINKS)
      .map((a) => ({ text: (a.innerText || "").trim().slice(0, 200), href: a.href }))
      .filter((l) => l.text);
    const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
      .filter(visible)
      .slice(0, MAX_INPUTS)
      .map((el) => ({
        type: el.type || el.tagName.toLowerCase(),
        name: el.name || undefined,
        id: el.id || undefined,
        placeholder: el.placeholder || undefined,
        value: el.type === "password" ? undefined : String(el.value ?? "").slice(0, 500),
      }));
    return { title: document.title, url: location.href, text, links, inputs };
  }

  chrome.runtime.onMessage.addListener((command, _sender, respond) => {
    if (!command || typeof command.action !== "string") return false;
    if (command.action === "ping") {
      respond({ ok: true, url: location.href, title: document.title });
      return true;
    }
    const handlers = { click, type, press, scroll, read };
    const handler = handlers[command.action];
    if (!handler) {
      respond({ ok: false, error: `Unknown page action: ${command.action}` });
      return true;
    }
    try {
      respond({ ok: true, ...handler(command) });
    } catch (error) {
      respond({ ok: false, error: error?.message || String(error) });
    }
    return true;
  });
})();
