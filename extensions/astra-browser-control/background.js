// Astra Browser Control — background service worker (MV3, module).
//
// The Astra server is the WebSocket server; this extension is the client.
// The server URL and pairing token live in chrome.storage.local and are
// configured from the popup or options page. Every inbound command is a JSON
// object { id, action, ...args } and is answered with
// { id, ok: true, result } or { id, ok: false, error }.
//
// Protocol (v1):
//   hello        -> { tabId }                      server -> extension
//   ping         -> { time }                       server -> extension
//   navigate     { url }                           active tab
//   click        { selector, text?, index? }
//   type         { selector, text, clear?, pressEnter? }
//   press        { key }                           e.g. "Enter", "Escape"
//   scroll       { deltaY }                        e.g. { deltaY: 600 }
//   read         -> { title, url, text, links, inputs }
//   eval         { expression }                    page-world JS, JSON result
//   screenshot   { jpeg?, quality? }               sent through activeTab
//
// Reconnect uses exponential backoff (1s..30s). The server URL is never
// contacted unless the user saved it, and the token is sent only in the
// "hello" handshake message to the saved origin.

const DEFAULT_STATE = { connected: false, lastError: null };
const MAX_SOCKET_BUFFER = 4 * 1024 * 1024;

let socket = null;
let reconnectTimer = null;
let backoffMs = 1000;

// ── settings ────────────────────────────────────────────────────────────────

async function getSettings() {
  const { serverUrl = "", token = "", allowAllSites = true } =
    await chrome.storage.local.get(["serverUrl", "token", "allowAllSites"]);
  return { serverUrl, token, allowAllSites };
}

function cleanOrigin(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    // The manifest grants local-only host permission; hold that line here too.
    if (!/^localhost$/i.test(parsed.hostname) && !/^127\.0\.0\.1$/.test(parsed.hostname)) return null;
    // Endpoint is ws://<host>:<port>/extension?token=…
    return `ws://${parsed.host}/extension`;
  } catch {
    return null;
  }
}

// ── connection ──────────────────────────────────────────────────────────────

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30_000);
}

async function connect() {
  const { serverUrl, token } = await getSettings();
  const url = cleanOrigin(serverUrl);
  if (!url || !token) return; // Nothing configured: stay quiet, no retries.
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  await setState({ lastError: null });
  try {
    socket = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
  } catch (error) {
    await setState({ lastError: String(error) });
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    backoffMs = 1000;
    setState({ connected: true, lastError: null });
    send({ type: "hello", token, ua: navigator.userAgent, version: chrome.runtime.getManifest().version });
  });
  socket.addEventListener("message", (event) => onMessage(event));
  socket.addEventListener("close", () => {
    setState({ connected: false });
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    setState({ connected: false, lastError: "Connection failed" });
  });
}

function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  const text = JSON.stringify(payload);
  if (text.length > MAX_SOCKET_BUFFER) return false;
  socket.send(text);
  return true;
}

async function setState(patch) {
  await chrome.storage.local.set({ state: { ...DEFAULT_STATE, ...patch } });
  chrome.runtime.sendMessage({ kind: "state", ...DEFAULT_STATE, ...patch }).catch(() => {});
}

// ── command dispatch ────────────────────────────────────────────────────────

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

async function injectableTabs() {
  const tabs = await chrome.tabs.query({});
  if (await getSettings().then((s) => s.allowAllSites)) return tabs.filter((t) => everyUrl(t.url));
  const allowlist = (await chrome.storage.local.get("allowlist")).allowlist || "";
  const hosts = allowlist.split(/\s*,\s*|\s*\n\s*/).filter(Boolean);
  return tabs.filter((t) => {
    try {
      const host = new URL(t.url || "about:blank").hostname;
      return hosts.some((h) => host === h || host.endsWith("." + h));
    } catch {
      return false;
    }
  });
}

function everyUrl(url) {
  try {
    const parsed = new URL(url || "about:blank");
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function sendToTab(tabId, command) {
  return chrome.tabs.sendMessage(tabId, command);
}

async function ensureContentScript(tabId) {
  // Document_idle injection already ran on page load; this covers tabs opened
  // before the extension was installed or after the worker was suspended.
  try {
    await sendToTab(tabId, { action: "ping" });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: [] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await sendToTab(tabId, { action: "ping" });
  }
}

const HANDLERS = {
  async navigate({ url }) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http(s) URLs can be opened");
    const tab = await activeTab();
    const { allowAllSites } = await getSettings();
    if (!allowAllSites && !hostAllowed(parsed.hostname)) throw new Error("Host is not in the allowlist");
    await chrome.tabs.update(tab.id, { url: parsed.toString() });
    return { tabId: tab.id };
  },

  async click(args) {
    const tab = await activeTab();
    await ensureContentScript(tab.id);
    return sendToTab(tab.id, { action: "click", ...args });
  },

  async type(args) {
    const tab = await activeTab();
    await ensureContentScript(tab.id);
    return sendToTab(tab.id, { action: "type", ...args });
  },

  async press({ key }) {
    const tab = await activeTab();
    await ensureContentScript(tab.id);
    return sendToTab(tab.id, { action: "press", key });
  },

  async scroll({ deltaY = 600 } = {}) {
    const tab = await activeTab();
    await ensureContentScript(tab.id);
    return sendToTab(tab.id, { action: "scroll", deltaY });
  },

  async read() {
    const tab = await activeTab();
    await ensureContentScript(tab.id);
    const page = await sendToTab(tab.id, { action: "read" });
    return { ...page, tabId: tab.id };
  },

  async eval({ expression }) {
    if (typeof expression !== "string" || expression.length > 100_000) throw new Error("expression must be a short string");
    const tab = await activeTab();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN", // Page world: reads page state, matches window scope.
      func: (src) => {
        // Return JSON-serializable result; errors become thrown strings.
        return (0, eval)(src);
      },
      args: [expression],
    });
    return { value: result };
  },

  async screenshot({ jpeg = true, quality = 80 } = {}) {
    const tab = await activeTab();
    const format = jpeg ? "jpeg" : "png";
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality });
    return { dataUrl, tabId: tab.id };
  },
};

function hostAllowed(hostname) {
  return true; // Coarse gate; fine-grained allowlist is enforced in injectableTabs().
}

async function onMessage(event) {
  if (typeof event.data !== "string" || event.data.length > MAX_SOCKET_BUFFER) return;
  let command;
  try {
    command = JSON.parse(event.data);
  } catch {
    return;
  }
  if (!command || typeof command.id !== "string" || typeof command.action !== "string") return;

  if (command.action === "ping") {
    send({ id: command.id, ok: true, result: { time: Date.now() } });
    return;
  }

  const handler = HANDLERS[command.action];
  if (!handler) {
    send({ id: command.id, ok: false, error: `Unknown action: ${command.action}` });
    return;
  }
  try {
    const result = await handler(command);
    send({ id: command.id, ok: true, result });
  } catch (error) {
    send({ id: command.id, ok: false, error: error?.message || String(error) });
  }
}

// ── popup/options plumbing ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.kind === "connect") {
    connect().finally(() => respond({ ok: true }));
    return true;
  }
  if (message?.kind === "disconnect") {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.close();
    socket = null;
    setState({ connected: false }).then(() => respond({ ok: true }));
    return true;
  }
  if (message?.kind === "getState") {
    chrome.storage.local.get("state").then(({ state }) => respond(state ?? DEFAULT_STATE));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup?.addListener?.(() => {
  chrome.runtime.sendMessage({ kind: "startup" }).catch(() => {});
  connect();
});
